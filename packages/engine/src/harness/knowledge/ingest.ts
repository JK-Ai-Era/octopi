/**
 * KnowledgeIngest — 解析/切块/索引队列（P2 Phase A）
 *
 * 原则：ingest 与对话并发，不作 turn 同步前置；队列背压不丢任务；source 级锁。
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { FormatAdapterRegistry, htmlAdapter, markdownAdapter, textAdapter } from './adapters.js';
import { looksLikeHtml } from './html.js';
import { hashContent, KnowledgeIndexStore } from './index-store.js';
import { KnowledgeSourceStore } from './source-store.js';
import { LocalFsFetcher, UrlFetcher, type SourceFetcher, type VirtualDocument } from './fetchers.js';
import { ConnectorRegistry } from './connectors.js';
import { ConnectorFetcher } from './connector-fetcher.js';
import type { CredentialStore } from '../governance/credentials/store.js';
import type { ResolvedCredential } from '../governance/credentials/types.js';
import type { EmbeddingProvider } from '../memory/sqlite/embedding.js';
import type { KnowledgeSource, KnowledgeChunkId } from './types.js';
import type { DocumentPort } from '../context/capabilities/document/types.js';
import { isDocumentPath } from '../context/capabilities/document/format.js';
import { isDocumentExtractError } from '../context/capabilities/document/errors.js';
import {
  classifyFileKind,
  decideBySize,
  isRetryableSkipReason,
  parseTimeoutForSize,
  resolveKnowledgeFileLimits,
  type KnowledgeFileLimits,
  type KnowledgeFileLimitsInput,
} from './file-limits.js';

export type IngestJobKind = 'parse_file' | 'walk_source' | 'drop_file' | 'embed_source' | 'fetch_doc';

/** 中止/继续 控制面读数（UI 互斥按钮） */
export interface KnowledgeJobControlState {
  aborted: boolean;
  jobsQueued: number;
  jobsRunning: number;
  jobsCancelled: number;
  embedMissing: boolean;
  canAbort: boolean;
  canResume: boolean;
}

export interface IngestProgressEvent {
  type: 'job' | 'source' | 'error' | 'embed';
  sourceId: string;
  path?: string;
  status: string;
  detail?: string;
}

export interface KnowledgeIngestOptions {
  sourceStore: KnowledgeSourceStore;
  indexStore?: KnowledgeIndexStore;
  adapterRegistry?: FormatAdapterRegistry;
  /** parse 并发（默认 4） */
  parseConcurrency?: number;
  /** 队列深度上限（超出只报警，不丢任务） */
  maxQueueDepth?: number;
  /** fs watch debounce ms（默认 2000） */
  debounceMs?: number;
  /** 单文件大小兜底上限（可选；格式分级见 fileLimits） */
  maxFileBytes?: number;
  /**
   * 按格式分级的文件限额 + 部分抽取策略。
   * 机器资源不足时下调 maxBytes / hardMaxFileBytes。
   */
  fileLimits?: KnowledgeFileLimitsInput;
  /** 单文件 parse 超时 ms（默认 45000） */
  parseTimeoutMs?: number;
  /** Phase B embedding（未配则纯关键词） */
  embeddingProvider?: EmbeddingProvider | null;
  /** embed 批大小（默认 32） */
  embedBatch?: number;
  /** embed 最小间隔 ms（限速，默认 0） */
  embedMinIntervalMs?: number;
  /** embed 并发（默认复用 parseConcurrency） */
  embedConcurrency?: number;
  /** 磁盘水位告警（默认 false；仅告警不丢任务） */
  diskWatermarkAlert?: boolean;
  /** 凭证库（source.authRef 解析；可选） */
  credentials?: CredentialStore | null;
  /** 自定义 fetcher 覆盖（测试/扩展） */
  fetchers?: Partial<Record<'local' | 'url' | 'connector', SourceFetcher>>;
  /** connector 注册表（默认含 rest） */
  connectors?: ConnectorRegistry;
  /** poll 调度 tick ms（默认 60s） */
  pollTickMs?: number;
  /** 单源最小 poll 间隔 ms（默认 15min） */
  pollMinIntervalMs?: number;
  /** 每轮 poll 最多处理源数（成本上限，默认 8） */
  maxPollPerTick?: number;
  /**
   * DocumentPort：启用后 PDF/Office 等走抽取 → Markdown 切块
   * （缺省 null = 维持 BINARY skip 语义）
   */
  documentPort?: DocumentPort | null;
}

interface JobRow {
  id: string;
  source_id: string;
  kind: string;
  path: string | null;
  priority: number;
  status: string;
  attempts: number;
}

export class KnowledgeIngest extends EventEmitter {
  private readonly sources: KnowledgeSourceStore;
  private readonly index: KnowledgeIndexStore;
  private readonly adapters: FormatAdapterRegistry;
  private readonly parseConcurrency: number;
  private readonly maxQueueDepth: number;
  private readonly debounceMs: number;
  private readonly maxFileBytes: number;
  private readonly fileLimits: KnowledgeFileLimits;
  /** 单文件 parse/fetch 超时（默认 45s；大 Office 同步抽取会堵事件循环） */
  private readonly parseTimeoutMs: number;
  private readonly embedding: EmbeddingProvider | null;
  private readonly embedBatch: number;
  private readonly embedMinIntervalMs: number;
  private readonly embedConcurrency: number;
  private readonly diskWatermarkAlert: boolean;
  private readonly credentials: CredentialStore | null;
  private readonly localFetcher: SourceFetcher;
  private readonly urlFetcher: SourceFetcher;
  private readonly connectorFetcher: SourceFetcher;
  private readonly pollTickMs: number;
  private readonly pollMinIntervalMs: number;
  private readonly maxPollPerTick: number;
  private readonly documentPort: DocumentPort | null;
  private lastEmbedAt = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** 源级中止控制器（手动 abort / 重建前清场） */
  private abortBySource = new Map<string, AbortController>();
  /** 源任务稳定（无 queued/running）时回调 — 用于 auto-describe 等收尾 */
  onSourceSettled?: (sourceId: string) => void;
  /** 上次 parse 缺口扫描时间 */
  private lastParseGapScanAt = new Map<string, number>();

  private runningParse = 0;
  private runningEmbed = 0;
  private draining = false;
  private kickAgain = false;
  /** source 级锁：同一 source 不并行 walk/parse 冲突写 */
  private sourceLocks = new Set<string>();
  /** walk 发现的文件数（Phase A coverage 分母） */
  private discoveredFiles = new Map<string, number>();
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(options: KnowledgeIngestOptions) {
    super();
    this.sources = options.sourceStore;
    this.index = options.indexStore ?? new KnowledgeIndexStore(options.sourceStore.database);
    this.adapters = options.adapterRegistry ?? new FormatAdapterRegistry();
    this.parseConcurrency = options.parseConcurrency ?? 8;
    this.maxQueueDepth = options.maxQueueDepth ?? 10_000;
    // watch 批量落盘时缩短静默窗，新增文件更快入队
    this.debounceMs = options.debounceMs ?? 800;
    this.fileLimits = resolveKnowledgeFileLimits({
      ...options.fileLimits,
      maxFileBytes: options.fileLimits?.maxFileBytes ?? options.maxFileBytes,
      parseTimeoutMs: options.fileLimits?.parseTimeoutMs ?? options.parseTimeoutMs,
    });
    this.maxFileBytes = this.fileLimits.maxFileBytes;
    this.parseTimeoutMs = this.fileLimits.parseTimeoutMs;
    this.embedding = options.embeddingProvider ?? null;
    this.embedBatch = options.embedBatch ?? 32;
    this.embedMinIntervalMs = options.embedMinIntervalMs ?? 0;
    // embed 与 parse 分槽；缺省 4 路并行打 embedding API
    this.embedConcurrency = options.embedConcurrency ?? 4;
    this.diskWatermarkAlert = options.diskWatermarkAlert ?? false;
    this.credentials = options.credentials ?? null;
    this.documentPort = options.documentPort ?? null;
    this.localFetcher =
      options.fetchers?.local ?? new LocalFsFetcher((p) => this.shouldSkipFile(p));
    this.urlFetcher = options.fetchers?.url ?? new UrlFetcher();
    this.connectorFetcher =
      options.fetchers?.connector ??
      new ConnectorFetcher(options.connectors ?? new ConnectorRegistry());
    this.pollTickMs = options.pollTickMs ?? 60_000;
    this.pollMinIntervalMs = options.pollMinIntervalMs ?? 15 * 60_000;
    this.maxPollPerTick = options.maxPollPerTick ?? 8;
    // 崩溃/重启遗留的 running 会堵住 enqueue 去重并永久显示 indexing
    this.reclaimOrphanRunningJobs();
    // 历史脏行：目录等非文件曾被标成 no_adapter，启动即清
    this.cleanupNonFileIndexRows();
  }

  private lastCleanupAt = 0;

  /**
   * 清掉「非普通文件」误入 knowledge_files 的行（目录曾被标 no_adapter）。
   *
   * 仅处理 skipped/error 且无 chunk 的行：有 chunk 的仍走 pruneMissing/磁盘对齐。
   * 默认 60s 节流，避免每轮 reconcile 扫全表 stat。
   *
   * @param sourceId - 限定源；省略则全部源
   * @param opts.force - 忽略节流
   * @returns 删除行数
   */
  cleanupNonFileIndexRows(sourceId?: string, opts?: { force?: boolean }): number {
    const now = Date.now();
    if (!opts?.force && sourceId == null && now - this.lastCleanupAt < 60_000) {
      return 0;
    }
    this.lastCleanupAt = now;
    const ids = sourceId
      ? [sourceId]
      : this.sources.list().map((s) => s.id);
    let removed = 0;
    for (const id of ids) {
      const rows = this.sources.database.raw
        .prepare(
          `SELECT path FROM knowledge_files
           WHERE source_id = ? AND status IN ('skipped', 'error') AND chunk_count = 0`,
        )
        .all(id) as Array<{ path: string }>;
      for (const r of rows) {
        try {
          const st = statSync(r.path);
          if (!st.isFile()) {
            this.index.removeFile(id, r.path);
            removed += 1;
          }
        } catch {
          // 路径不存在：留给 pruneMissing（磁盘对齐），避免误删有效但暂时不可见的文件
        }
      }
    }
    return removed;
  }

  /**
   * 无跨进程 Lease：本进程启动时把历史 running 收回 queued。
   * 仅构造时调用——运行中同进程的 running 是合法的。
   */
  private reclaimOrphanRunningJobs(): void {
    this.sources.database.raw
      .prepare(`UPDATE knowledge_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'`)
      .run(Date.now());
  }

  get indexStore(): KnowledgeIndexStore {
    return this.index;
  }

  /**
   * 路径过滤：有 DocumentPort 时文档扩展名不再被 BINARY 短路。
   *
   * @param p - 文件路径
   * @returns 是否跳过
   */
  private shouldSkipFile(p: string): boolean {
    if (this.documentPort && isDocumentPath(p)) return false;
    return this.adapters.shouldSkipPath(p);
  }

  /**
   * 全量/增量索引某源（Phase A）
   */
  async ingestSource(sourceId: string, opts?: { full?: boolean }): Promise<void> {
    // 重建 = supersede：以本次磁盘扫描为准，作废本源未完成任务
    this.supersedeSourceWork(sourceId);
    const source = this.sources.get(sourceId);
    if (!source || source.status === 'removed') {
      throw new Error(`knowledge source not found: ${sourceId}`);
    }
    if (
      source.kind !== 'directory' &&
      source.kind !== 'file' &&
      source.kind !== 'workspace' &&
      source.kind !== 'url' &&
      source.kind !== 'connector'
    ) {
      this.sources.update(sourceId, {
        status: 'error',
        errors: [
          {
            message: `kind ${source.kind} not supported`,
            at: Date.now(),
          },
        ],
      });
      return;
    }

    if (this.sourceLocks.has(sourceId)) {
      // 已有同源任务在跑：入队 walk 即可（去重）
      this.enqueue(sourceId, 'walk_source', null, 1, source.location);
      return;
    }
    this.sourceLocks.add(sourceId);
    try {
      this.sources.update(sourceId, { status: 'discovering', coverage: 0 });
      this.emitProgress({ type: 'source', sourceId, status: 'discovering' });

      // full 不再 clearSource：靠本轮 keepPaths 差量 prune，discover 失败不丢库
      if (source.kind === 'url' || source.kind === 'connector') {
        await this.ingestRemoteSource(source);
        return;
      }

      const files = await this.localFetcher.discover(source);
      this.discoveredFiles.set(sourceId, files.length);
      // 差量 prune：磁盘上已消失的 path
      const localKeep = new Set(files.map((f) => f.path));
      this.index.pruneMissing(sourceId, localKeep);

      this.sources.update(sourceId, { status: 'partial', coverage: 0 });
      this.emitProgress({
        type: 'source',
        sourceId,
        status: 'partial',
        detail: `${files.length} files`,
      });

      for (const file of files) {
        this.enqueue(sourceId, 'parse_file', file.path, 2, file.path);
      }
      if (this.embedding) {
        this.enqueue(sourceId, 'embed_source', null, 3);
      }
      this.kick();
    } finally {
      this.sourceLocks.delete(sourceId);
    }
  }

  /**
   * URL / connector 源：discover + fetch + 索引
   */
  private async ingestRemoteSource(source: KnowledgeSource): Promise<void> {
    let cred: ResolvedCredential | null;
    try {
      cred = await this.resolveCred(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // fail-closed：不降级匿名抓取，也不动已有索引
      this.sources.update(source.id, {
        status: 'error',
        errors: [...(source.errors ?? []), { message: msg, at: Date.now() }].slice(-5),
      });
      this.emitProgress({ type: 'error', sourceId: source.id, status: 'credential_failed', detail: msg });
      return;
    }

    const fetcher = source.kind === 'connector' ? this.connectorFetcher : this.urlFetcher;
    let refs;
    try {
      refs = await fetcher.discover(source, cred);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sources.update(source.id, {
        status: 'error',
        errors: [...(source.errors ?? []), { message: msg, at: Date.now() }].slice(-5),
      });
      this.emitProgress({ type: 'error', sourceId: source.id, status: 'discover_failed', detail: msg });
      return;
    }
    // 条件 GET：带上已有 etag/Last-Modified，304 则整文档跳过
    const enriched = refs.map((ref) => {
      const existing = this.index.getFile(source.id, ref.path);
      return {
        ...ref,
        etag: ref.etag ?? existing?.etag,
        lastModified: ref.lastModified ?? existing?.lastModified,
      };
    });
    this.discoveredFiles.set(source.id, enriched.length);
    this.sources.update(source.id, { status: 'partial', coverage: 0 });
    this.emitProgress({
      type: 'source',
      sourceId: source.id,
      status: 'partial',
      detail: `${enriched.length} docs`,
    });

    let okCount = 0;
    let unchanged = 0;
    for (const ref of enriched) {
      try {
        const doc = await fetcher.fetch(source, ref, cred);
        if (!doc) {
          // 304 / 未变：保持原索引
          unchanged += 1;
          okCount += 1;
          continue;
        }
        if (this.indexVirtualDoc(source.id, doc)) {
          okCount += 1;
        }
      } catch (err) {
        this.index.markFileError(
          source.id,
          ref.path,
          err instanceof Error ? err.message : String(err),
        );
        this.emitProgress({
          type: 'error',
          sourceId: source.id,
          path: ref.path,
          status: 'fetch_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 差量 prune：discover 成功后，源上已消失的文档才删
    const keep = new Set(enriched.map((r) => r.path));
    const pruned = this.index.pruneMissing(source.id, keep);
    if (pruned > 0) {
      this.emitProgress({
        type: 'source',
        sourceId: source.id,
        status: 'pruned',
        detail: `removed=${pruned}`,
      });
    }

    if (this.embedding) {
      this.enqueue(source.id, 'embed_source', null, 3);
      this.kick();
    }
    this.refreshCoverage(source.id);
    this.emitProgress({
      type: 'source',
      sourceId: source.id,
      status: 'ready',
      detail: `url docs ok=${okCount}/${enriched.length} unchanged=${unchanged}`,
    });
  }

  /**
   * 解析源凭证；配置了 authRef 时 **fail-closed**（解析失败则本轮不抓，不降级匿名）。
   *
   * @returns 凭证或 null（仅当源未配置 authRef）
   * @throws authRef 配置了但无法解析时抛错，由调用方中止本轮
   */
  private async resolveCred(source: KnowledgeSource): Promise<ResolvedCredential | null> {
    if (!source.authRef) return null;
    if (!this.credentials) {
      throw new Error(
        `source ${source.id} has authRef "${source.authRef}" but CredentialStore is not configured`,
      );
    }
    const resolved = await this.credentials.resolve(source.authRef);
    if (!resolved) {
      throw new Error(
        `credential "${source.authRef}" unavailable (missing secret, expired, or not found)`,
      );
    }
    return resolved;
  }

  /**
   * 将 VirtualDocument 写入索引（外源 / 规范化后文本）
   *
   * @returns 是否成功写入
   */
  indexVirtualDoc(sourceId: string, doc: VirtualDocument): boolean {
    if (!doc.content?.trim()) {
      this.index.markFileSkipped(sourceId, doc.path, 'empty_content');
      return false;
    }
    // 逻辑键可能无扩展名（connector id / URL path）：按 MIME → 扩展名 → 内容形态回退
    let adapter = this.adapters.match(doc.path, doc.contentType);
    if (!adapter) {
      if (looksLikeHtml(doc.content, doc.contentType)) adapter = htmlAdapter;
      else if (/^#{1,6}\s|\n\n/.test(doc.content)) adapter = markdownAdapter;
      else adapter = textAdapter;
    }
    const contentHash = hashContent(doc.content);
    if (this.index.isFresh(sourceId, doc.path, contentHash)) {
      return true;
    }
    try {
      const chunks = adapter.chunk(doc.content, doc.path);
      this.index.upsertFile({
        sourceId,
        path: doc.path,
        contentHash,
        size: doc.size,
        mtime: Math.floor(Date.now() / 1000),
        adapterId: adapter.id,
        chunks,
        externalUrl: doc.externalUrl,
        etag: doc.etag,
        lastModified: doc.lastModified,
      });
      return true;
    } catch (err) {
      this.index.markFileError(
        sourceId,
        doc.path,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /**
   * 单文件急索（P0 快车道；同步完成 parse，不 await 全库）
   */
  async ingestFileNow(sourceId: string, filePath: string): Promise<boolean> {
    const ok = await this.parseOne(sourceId, filePath);
    this.refreshCoverage(sourceId);
    return ok;
  }

  /**
   * 重做指定文件：强制重新 解析 → 分块 → 向量
   *
   * - 失效 contentHash（忽略 isFresh），旧 chunks 保留到 upsert 成功
   * - **源处于中止态时自动 resume**：显式重做 = 意图要跑活，不允许静默丢弃
   * - 目录等非文件：直接清脏行，不假装入队
   * - 入队 parse_file；完成后走既有 embed 链路
   *
   * @param sourceId - 源 id
   * @param paths - 文件路径列表
   * @returns queued=新入队；alreadyActive=已在队列/执行；cleanedNonFiles=清掉的目录脏行
   */
  reprocessFiles(
    sourceId: string,
    paths: string[],
  ): { queued: number; alreadyActive: number; cleanedNonFiles: number; resumed: boolean } {
    if (!paths.length) return { queued: 0, alreadyActive: 0, cleanedNonFiles: 0, resumed: false };
    let resumed = false;
    if (this.isAborted(sourceId)) {
      this.beginAbortEpoch(sourceId);
      resumed = true;
    }
    let queued = 0;
    let alreadyActive = 0;
    let cleanedNonFiles = 0;
    for (const p of paths) {
      // 目录/设备节点：清脏行即可，没有「解析」可跑
      try {
        const st = statSync(p);
        if (!st.isFile()) {
          this.index.removeFile(sourceId, p);
          cleanedNonFiles += 1;
          continue;
        }
      } catch {
        // 路径不存在：仍按文件流程，让 parse 自清理
      }
      // 总是失效 hash：即使已在队列，跑起来也不能 isFresh 跳过
      this.index.invalidateFileForReparse(sourceId, p);
      if (this.enqueue(sourceId, 'parse_file', p, 1, p)) {
        queued += 1;
      } else if (this.hasActiveParseJob(sourceId, p)) {
        alreadyActive += 1;
      }
    }
    this.kick();
    return { queued, alreadyActive, cleanedNonFiles, resumed };
  }

  /** 路径上是否已有 queued/running 的 parse_file */
  private hasActiveParseJob(sourceId: string, path: string): boolean {
    const row = this.sources.database.raw
      .prepare(
        `SELECT id FROM knowledge_jobs
         WHERE source_id = ? AND path = ? AND kind = 'parse_file' AND status IN ('queued','running')
         LIMIT 1`,
      )
      .get(sourceId, path) as { id?: string } | undefined;
    return Boolean(row?.id);
  }

  /**
   * 路径级任务/文件状态（UI 跟踪重做完成）
   *
   * @param sourceId - 源 id
   * @param paths - 路径列表
   */
  jobStateForPaths(
    sourceId: string,
    paths: string[],
  ): Array<{
    path: string;
    jobsActive: number;
    fileStatus: string | null;
    chunkCount: number;
    error: string | null;
    exists: boolean;
  }> {
    return paths.map((p) => {
      const jobs = this.sources.database.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_jobs
           WHERE source_id = ? AND path = ? AND status IN ('queued','running')`,
        )
        .get(sourceId, p) as { n: number };
      const f = this.index.getFile(sourceId, p);
      let exists = false;
      try {
        exists = statSync(p).isFile();
      } catch {
        exists = false;
      }
      return {
        path: p,
        jobsActive: Number(jobs?.n ?? 0),
        fileStatus: f?.status ?? null,
        chunkCount: f?.chunkCount ?? 0,
        error: f?.error ?? null,
        exists,
      };
    });
  }

  /**
   * 按筛选批量重做（当前列表的 status/ext/q 条件）
   *
   * @param sourceId - 源 id
   * @param opts - 与文件列表筛选一致
   * @returns 入队条数
   */
  reprocessByFilter(
    sourceId: string,
    opts?: { status?: 'indexed' | 'skipped' | 'error' | 'all'; ext?: string; q?: string },
  ): { queued: number; alreadyActive: number; cleanedNonFiles: number; resumed: boolean } {
    const paths = this.index.listFilePathsFiltered(sourceId, opts);
    return this.reprocessFiles(sourceId, paths);
  }

  /**
   * 处理 fs 变更（debounce 后入队）
   */
  handleFsChange(sourceId: string, filePath: string, event: 'change' | 'rename'): void {
    if (this.disposed) return;
    const key = `${sourceId}:${filePath}`;
    const prev = this.debounceTimers.get(key);
    if (prev) clearTimeout(prev);
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        // 统一先 stat：目录误报 change 时不得 parse 成 no_adapter
        void stat(filePath)
          .then((st) => {
            if (st.isFile()) {
              this.enqueue(sourceId, 'parse_file', filePath, 1, filePath);
            } else if (event === 'rename' || !st.isDirectory()) {
              // rename 到目录 = 新目录/移出；非文件也走 drop 清残行
              this.enqueue(sourceId, 'drop_file', filePath, 1, filePath);
            } else {
              // 目录上的 change：子文件由各自事件处理；仅清历史脏行
              this.index.removeFile(sourceId, filePath);
            }
            this.kick();
          })
          .catch(() => {
            this.enqueue(sourceId, 'drop_file', filePath, 1, filePath);
            this.kick();
          });
      }, this.debounceMs),
    );
  }

  /**
   * 启动目录 watch（幂等）
   */
  startWatch(sourceId: string): void {
    const source = this.sources.get(sourceId);
    if (!source || source.sync.strategy !== 'watch' || source.sync.enabled === false) return;
    if (this.watchers.has(sourceId)) return;
    if (source.kind !== 'directory' && source.kind !== 'workspace') return;

    try {
      const watcher = watch(source.location, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const abs = join(source.location, filename.toString().split(sep).join(sep));
        if (this.shouldSkipFile(abs)) return;
        this.handleFsChange(sourceId, abs, event === 'rename' ? 'rename' : 'change');
      });
      this.watchers.set(sourceId, watcher);
    } catch (err) {
      this.emitProgress({
        type: 'error',
        sourceId,
        status: 'watch_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  stopWatch(sourceId: string): void {
    const w = this.watchers.get(sourceId);
    if (w) {
      w.close();
      this.watchers.delete(sourceId);
    }
    for (const [key, t] of this.debounceTimers) {
      if (key.startsWith(`${sourceId}:`)) {
        clearTimeout(t);
        this.debounceTimers.delete(key);
      }
    }
  }

  /**
   * 等待队列排空（测试/管理）
   */
  async idle(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (this.runningParse > 0 || this.runningEmbed > 0 || this.hasQueuedJobs()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('knowledge ingest idle timeout');
      }
      this.kick();
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.stopReconciler();
    void this.abortJobs();
    for (const id of this.watchers.keys()) this.stopWatch(id);
  }

  /**
   * 手动中止索引任务（业务完整：停收 + 清队 + 打断在跑）
   *
   * @param opts.sourceId - 仅中止该源；省略则全部源
   * @returns 取消统计
   */
  abortJobs(opts?: { sourceId?: string }): {
    cancelledQueued: number;
    abortedRunning: number;
    runningJobs: number;
  } {
    const sid = opts?.sourceId?.trim();
    const ids = sid ? [sid] : [...this.abortBySource.keys(), ...this.sources.list().map((s) => s.id)];
    const unique = [...new Set(ids)];
    let cancelledQueued = 0;
    let abortedRunning = 0;

    // 1) 清空 queued → cancelled
    for (const id of unique) {
      const res = this.sources.database.raw
        .prepare(
          `UPDATE knowledge_jobs SET status = 'cancelled', last_error = 'aborted', updated_at = ?
           WHERE source_id = ? AND status = 'queued'`,
        )
        .run(Date.now(), id);
      cancelledQueued += Number(res.changes ?? 0);

      // 2) 打断在跑（worker terminate / embed 循环退出）；保持 aborted 直到下次 reindex
      let ctrl = this.abortBySource.get(id);
      if (!ctrl) {
        ctrl = new AbortController();
        this.abortBySource.set(id, ctrl);
      }
      if (!ctrl.signal.aborted) {
        ctrl.abort();
        abortedRunning += 1;
      }
    }

    // 3) 看门狗不要再把 aborted running 收回 queued
    this.sources.database.raw
      .prepare(
        `UPDATE knowledge_jobs SET status = 'cancelled', last_error = 'aborted', updated_at = ?
         WHERE status = 'running' AND last_error = 'aborted'`,
      )
      .run(Date.now());

    const runningRow = this.sources.database.raw
      .prepare(
        sid
          ? `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE source_id = ? AND status = 'running'`
          : `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE status = 'running'`,
      )
      .get(...(sid ? [sid] : [])) as { n: number };
    const runningJobs = Number(runningRow?.n ?? 0);

    this.emitProgress({
      type: 'source',
      sourceId: sid ?? '*',
      status: 'aborted',
      detail: `cancelledQueued=${cancelledQueued} runningTail=${runningJobs}`,
    });
    return { cancelledQueued, abortedRunning, runningJobs };
  }

  /**
   * 恢复/继续索引（相对「重建」更轻）
   *
   * - 清除该源中止态
   * - 把 cancelled 任务放回 queued
   * - 若仍缺向量则排队 embed
   * - 不重新 walk 全量；需要全量对齐请 reindex
   *
   * @param opts.sourceId - 仅恢复该源；省略则全部源
   * @returns 恢复统计
   */
  resumeJobs(opts?: { sourceId?: string }): {
    restoredCancelled: number;
    embedQueued: number;
  } {
    const sid = opts?.sourceId?.trim();
    const ids = sid
      ? [sid]
      : [...new Set([...this.abortBySource.keys(), ...this.sources.list().map((s) => s.id)])];

    let restoredCancelled = 0;
    let embedQueued = 0;
    for (const id of ids) {
      // 1) 清除中止纪元
      this.beginAbortEpoch(id);

      // 2) cancelled → queued（用户中止时被杀的活）
      const res = this.sources.database.raw
        .prepare(
          `UPDATE knowledge_jobs SET status = 'queued', updated_at = ?
           WHERE source_id = ? AND status = 'cancelled'`,
        )
        .run(Date.now(), id);
      restoredCancelled += Number(res.changes ?? 0);

      // 3) 仍缺向量则确保 embed 在队
      if (this.embedding) {
        const missing = this.index.listChunksMissingEmbedding(id, 1).length > 0;
        const active = this.countActiveJobs(id);
        if (missing && active.embed === 0) {
          this.ensureEmbedJob(id);
          embedQueued += 1;
        }
      }
    }

    this.kick();
    this.emitProgress({
      type: 'source',
      sourceId: sid ?? '*',
      status: 'resumed',
      detail: `restoredCancelled=${restoredCancelled} embedQueued=${embedQueued}`,
    });
    return { restoredCancelled, embedQueued };
  }

  /** 开启新的中止纪元（abort 后新任务不受旧信号影响） */
  private beginAbortEpoch(sourceId: string): void {
    this.abortBySource.set(sourceId, new AbortController());
  }

  /**
   * 重建前作废本源未完成任务（supersede）
   *
   * - queued → cancelled（superseded_by_reindex）
   * - running 打断（worker/循环退出）
   * - 随后 beginAbortEpoch，本轮重建可继续写
   */
  private supersedeSourceWork(sourceId: string): void {
    this.sources.database.raw
      .prepare(
        `UPDATE knowledge_jobs SET status = 'cancelled', last_error = 'superseded_by_reindex', updated_at = ?
         WHERE source_id = ? AND status = 'queued'`,
      )
      .run(Date.now(), sourceId);

    // 打断在跑 parse/embed；再开新纪元，避免 walk 自己被 abort 卡死
    let ctrl = this.abortBySource.get(sourceId);
    if (!ctrl) {
      ctrl = new AbortController();
      this.abortBySource.set(sourceId, ctrl);
    }
    if (!ctrl.signal.aborted) {
      ctrl.abort();
    }
    this.beginAbortEpoch(sourceId);

    this.emitProgress({
      type: 'source',
      sourceId,
      status: 'superseded',
      detail: 'reindex will resync from disk',
    });
  }

  private async ensureParseCoverage(sourceId: string): Promise<number> {
    const source = this.sources.get(sourceId);
    if (!source || source.status === 'removed' || source.status === 'disabled') return 0;
    if (source.kind !== 'directory' && source.kind !== 'workspace') return 0;
    if (this.isAborted(sourceId)) return 0;
    // 已有 parse 积压则不重复扫
    if (this.countQueuedKinds(['parse_file', 'walk_source']) > 0) return 0;

    let found: Awaited<ReturnType<typeof this.localFetcher.discover>>;
    try {
      found = await this.localFetcher.discover(source);
    } catch {
      return 0;
    }
    const byPath = new Map(this.index.listFiles(sourceId).map((f) => [f.path, f]));
    let added = 0;
    let retriedSkipped = 0;
    for (const f of found) {
      const existing = byPath.get(f.path);
      // 缺文件必补；已 skipped 的 oversize/空内容在限额可接受时重试（配置调宽后能进索引）
      const need =
        !existing ||
        (existing.status === 'skipped' &&
          isRetryableSkipReason(existing.error ?? null, existing.size, this.fileLimits));
      if (!need) continue;
      this.enqueue(sourceId, 'parse_file', f.path, 2, f.path);
      added += 1;
      if (existing) retriedSkipped += 1;
    }
    if (added > 0) {
      this.emitProgress({
        type: 'source',
        sourceId,
        status: 'parse_gap_found',
        detail: `missing_files=${added - retriedSkipped} retry_skipped=${retriedSkipped}`,
      });
      this.kick();
    }
    return added;
  }

  /**
   * 磁盘↔索引对齐：删掉已不存在的文件（含 chunks/embeddings）
   *
   * 目录源用一次 discover walk 得 keep 集（快）；失败退回并行 stat。
   * embed 前调用，避免给已移出文件的残 chunks 上向量。
   *
   * @param sourceId - 知识源 id
   * @returns 删除的文件数
   */
  async pruneMissingOnDisk(sourceId: string): Promise<number> {
    const source = this.sources.get(sourceId);
    if (!source || source.kind === 'url' || source.kind === 'connector') return 0;

    let removed = 0;
    if (source.kind === 'directory' || source.kind === 'workspace') {
      try {
        const found = await this.localFetcher.discover(source);
        const keep = new Set(found.map((f) => f.path));
        // walk 成功：即使空目录也可清空（与逐文件 stat 语义一致）
        removed = this.index.pruneMissing(sourceId, keep, { allowEmptyKeep: true });
      } catch {
        removed = await this.pruneByStatScan(sourceId);
      }
    } else {
      removed = await this.pruneByStatScan(sourceId);
    }

    if (removed > 0) {
      this.emitProgress({
        type: 'source',
        sourceId,
        status: 'pruned_missing',
        detail: `removed_files=${removed}`,
      });
      this.refreshCoverage(sourceId);
    }
    return removed;
  }

  /** 逐文件 stat（file 源 / walk 失败回退）；并行限流 */
  private async pruneByStatScan(sourceId: string, concurrency = 32): Promise<number> {
    const files = this.index.listFiles(sourceId);
    let removed = 0;
    let i = 0;
    const worker = async () => {
      for (;;) {
        if (this.isAborted(sourceId)) return;
        const idx = i++;
        if (idx >= files.length) return;
        const f = files[idx];
        let exists = true;
        try {
          const st = await stat(f.path);
          exists = st.isFile();
        } catch {
          exists = false;
        }
        if (!exists) {
          this.index.removePathTree(sourceId, f.path);
          removed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length || 1) }, () => worker()));
    return removed;
  }

  private abortSignalFor(sourceId: string): AbortSignal {
    let ac = this.abortBySource.get(sourceId);
    if (!ac) {
      ac = new AbortController();
      this.abortBySource.set(sourceId, ac);
    }
    return ac.signal;
  }

  private isAborted(sourceId: string): boolean {
    return this.abortSignalFor(sourceId).aborted;
  }

  /**
   * 中止/继续 控制面读数（互斥按钮用）
   *
   * @param sourceId - 源 id
   * @returns 队列计数 + 是否已中止 + 是否仍缺向量
   */
  jobControlState(sourceId: string): KnowledgeJobControlState {
    const row = this.sources.database.raw
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS q,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS r,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS c
         FROM knowledge_jobs WHERE source_id = ?`,
      )
      .get(sourceId) as { q: number | null; r: number | null; c: number | null };
    const jobsQueued = Number(row?.q ?? 0);
    const jobsRunning = Number(row?.r ?? 0);
    const jobsCancelled = Number(row?.c ?? 0);
    const aborted = this.isAborted(sourceId);
    const embedMissing = this.embedding
      ? this.index.listChunksMissingEmbedding(sourceId, 1).length > 0
      : false;
    const active = jobsQueued + jobsRunning > 0;
    // 可中止：还有活在排队/执行，且当前未处于中止态
    const canAbort = active && !aborted;
    // 可继续：被中止过、有 cancelled 可捞，或缺向量且当前无活
    const canResume = aborted || jobsCancelled > 0 || (embedMissing && !active);
    return {
      aborted,
      jobsQueued,
      jobsRunning,
      jobsCancelled,
      embedMissing,
      canAbort,
      canResume,
    };
  }

  /**
   * 任务对账（看门狗）— 不依赖单次 ensureEmbedJob
   *
   * 解决「续跑被去重吞掉 / 进程中断 / 状态卡 partial」等静默停摆：
   * 1. 回收超时 running（崩溃/挂死孤儿）
   * 2. 有缺向量且无 active embed → 自动排队
   * 3. 无队列、无缺口 → 刷 coverage/status
   */
  startReconciler(intervalMs = 15_000): void {
    if (this.reconcileTimer || this.disposed) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileJobs().catch((err) => {
        this.emitProgress({
          type: 'error',
          sourceId: '*',
          status: 'reconcile_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
    this.reconcileTimer.unref?.();
  }

  stopReconciler(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /** 对账入口（也可手工调用） */
  async reconcileJobs(): Promise<void> {
    if (this.disposed) return;
    this.reclaimStaleRunningJobs(5 * 60_000);
    // 目录脏行等历史误入项（轻量；非每轮全表）
    this.cleanupNonFileIndexRows();
    // 存量向量回填：小批量 + 让出事件循环，禁止 2000 条同步写（会堵死 abort）
    await this.index.backfillVecFromEmbeddings(25);
    for (const s of this.sources.list()) {
      if (s.status === 'removed' || s.status === 'disabled') continue;
      if (this.isAborted(s.id)) continue;
      // watch 漏事件 / skip 可重试时补齐 parse（与是否配置 embedding 无关）
      const lastGap = this.lastParseGapScanAt.get(s.id) ?? 0;
      if (Date.now() - lastGap > 60_000) {
        this.lastParseGapScanAt.set(s.id, Date.now());
        await this.ensureParseCoverage(s.id);
      }
      if (this.embedding) {
        const missing = this.index.listChunksMissingEmbedding(s.id, 1).length > 0;
        const active = this.countActiveJobs(s.id);
        if (missing && active.embed === 0) {
          this.ensureEmbedJob(s.id);
        } else if (!missing && active.total === 0) {
          this.refreshCoverage(s.id);
          // 稳定态收尾（auto-describe 等）；回调不得抛出打断对账
          try {
            this.onSourceSettled?.(s.id);
          } catch {
            /* ignore settle hook errors */
          }
        }
      } else {
        this.refreshCoverage(s.id);
      }
    }
    this.kick();
  }

  /** running 超时（无 heartbeat）→ 收回 queued；多次失败的直接标 failed，防毒文件死循环 */
  private reclaimStaleRunningJobs(staleMs: number): void {
    const cutoff = Date.now() - staleMs;
    // 先放弃重试过多的
    this.sources.database.raw
      .prepare(
        `UPDATE knowledge_jobs SET status = 'failed', last_error = COALESCE(last_error, 'stale_give_up'), updated_at = ?
         WHERE status = 'running' AND updated_at < ? AND attempts >= 2`,
      )
      .run(Date.now(), cutoff);
    this.sources.database.raw
      .prepare(
        `UPDATE knowledge_jobs SET status = 'queued', attempts = attempts + 1, updated_at = ?
         WHERE status = 'running' AND updated_at < ? AND attempts < 2`,
      )
      .run(Date.now(), cutoff);
  }

  private countActiveJobs(sourceId: string): { total: number; embed: number } {
    const row = this.sources.database.raw
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN kind = 'embed_source' THEN 1 ELSE 0 END) AS embed
         FROM knowledge_jobs
         WHERE source_id = ? AND status IN ('queued', 'running')`,
      )
      .get(sourceId) as { total: number; embed: number | null };
    return { total: row?.total ?? 0, embed: row?.embed ?? 0 };
  }

  /**
   * 启动 poll 调度（幂等）；仅处理 sync.strategy=poll 且 enabled 的源
   */
  startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(() => {
      void this.pollDueSources().catch((err) => {
        this.emitProgress({
          type: 'error',
          sourceId: '*',
          status: 'poll_tick_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.pollTickMs);
    // 不阻止进程退出
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 扫描到期 poll 源并入队刷新（内容未变由 content-hash / 304 短路）
   *
   * @returns 本轮实际触发的 sourceId 列表
   */
  async pollDueSources(): Promise<string[]> {
    if (this.disposed) return [];
    const now = Date.now();
    const due = this.sources
      .list()
      .filter((s) => {
        if (s.status === 'removed' || s.status === 'disabled') return false;
        if (s.sync.enabled === false) return false;
        if (s.sync.strategy !== 'poll') return false;
        const interval = s.sync.intervalMs ?? this.pollMinIntervalMs;
        const last = s.lastPolledAt ?? 0;
        return now - last >= Math.max(interval, this.pollMinIntervalMs);
      })
      .slice(0, this.maxPollPerTick);

    const triggered: string[] = [];
    for (const source of due) {
      triggered.push(source.id);
      this.sources.update(source.id, { lastPolledAt: now });
      this.emitProgress({
        type: 'source',
        sourceId: source.id,
        status: 'poll_due',
        detail: source.sync.intervalMs?.toString(),
      });
      // 异步入队，不阻塞 tick
      void this.ingestSource(source.id).catch((err) => {
        this.emitProgress({
          type: 'error',
          sourceId: source.id,
          status: 'poll_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return triggered;
  }

  // ── 内部 ──

  private hasQueuedJobs(): boolean {
    const row = this.sources.database.raw
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_jobs WHERE status = 'queued'`)
      .get() as { n: number };
    return (row?.n ?? 0) > 0;
  }

  private enqueue(
    sourceId: string,
    kind: IngestJobKind,
    path: string | null,
    priority: number,
    _detail?: string,
  ): boolean {
    if (this.isAborted(sourceId)) return false;
    // 同 source+kind 去重（queued + running，避免并发重复 embed）
    const activeStatuses = ['queued', 'running'];
    if (path != null) {
      const placeholders = activeStatuses.map(() => '?').join(',');
      const dup = this.sources.database.raw
        .prepare(
          `SELECT id FROM knowledge_jobs
           WHERE source_id = ? AND kind = ? AND path = ? AND status IN (${placeholders})`,
        )
        .get(sourceId, kind, path, ...activeStatuses) as { id?: string } | undefined;
      if (dup?.id) return false;
    } else {
      const placeholders = activeStatuses.map(() => '?').join(',');
      const dup = this.sources.database.raw
        .prepare(
          `SELECT id FROM knowledge_jobs
           WHERE source_id = ? AND kind = ? AND path IS NULL AND status IN (${placeholders})`,
        )
        .get(sourceId, kind, ...activeStatuses) as { id?: string } | undefined;
      if (dup?.id) return false;
    }

    const now = Date.now();
    const depth = this.sources.database.raw
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_jobs WHERE status = 'queued'`)
      .get() as { n: number };
    if ((depth?.n ?? 0) >= this.maxQueueDepth) {
      this.emitProgress({
        type: 'error',
        sourceId,
        status: 'queue_backpressure',
        detail: `queued=${depth.n} (delay only, jobs kept)`,
      });
    }
    if (this.diskWatermarkAlert) {
      void this.warnDiskWatermark(sourceId);
    }

    this.sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      )
      .run(`kj_${randomUUID().slice(0, 12)}`, sourceId, kind, path, priority, now, now);
    return true;
  }

  private kick(): void {
    if (this.disposed) return;
    if (this.draining) {
      // 等待中的 drain 会再 kick；标记一次避免丢信号
      this.kickAgain = true;
      return;
    }
    this.draining = true;
    queueMicrotask(() => {
      this.draining = false;
      this.drain();
      if (this.kickAgain) {
        this.kickAgain = false;
        this.kick();
      }
    });
  }

  private drain(): void {
    for (;;) {
      const allowParse = this.runningParse < this.parseConcurrency;
      const allowEmbed = this.runningEmbed < this.embedConcurrency;
      if (!allowParse && !allowEmbed) return;

      const parsePending = this.countQueuedKinds([
        'parse_file',
        'walk_source',
        'drop_file',
        'fetch_doc',
      ]);

      const kinds: IngestJobKind[] = [];
      if (allowParse) kinds.push('parse_file', 'drop_file', 'walk_source', 'fetch_doc');
      // 业务优先级：解析/分块做完即可关键词搜；embedding 仅在无 parse 积压时占槽
      if (allowEmbed && parsePending === 0) kinds.push('embed_source');
      if (kinds.length === 0) {
        if (!allowParse && allowEmbed && parsePending === 0) return;
        // parse 槽满但仍有 parse 积压 → 等 parse，不抢 embed
        if (parsePending > 0 && !allowParse) return;
        return;
      }

      const job = this.claimJob(kinds);
      if (!job) return;

      const isEmbed = job.kind === 'embed_source';
      if (isEmbed) this.runningEmbed += 1;
      else this.runningParse += 1;

      void this.runJob(job)
        .catch((err) => {
          this.emitProgress({
            type: 'error',
            sourceId: job.source_id,
            path: job.path ?? undefined,
            status: 'job_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          if (isEmbed) this.runningEmbed -= 1;
          else this.runningParse -= 1;
          this.kick();
        });
    }
  }

  private countQueuedKinds(kinds: IngestJobKind[]): number {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => '?').join(',');
    const row = this.sources.database.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE status = 'queued' AND kind IN (${placeholders})`,
      )
      .get(...kinds) as { n: number };
    return row?.n ?? 0;
  }

  private claimJob(kinds: IngestJobKind[]): JobRow | null {
    if (kinds.length === 0) return null;
    const placeholders = kinds.map(() => '?').join(',');
    const row = this.sources.database.raw
      .prepare(
        `SELECT * FROM knowledge_jobs
         WHERE status = 'queued' AND kind IN (${placeholders})
         ORDER BY priority ASC, created_at ASC
         LIMIT 1`,
      )
      .get(...kinds) as JobRow | undefined;
    if (!row) return null;
    const res = this.sources.database.raw
      .prepare(
        `UPDATE knowledge_jobs SET status = 'running', updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(Date.now(), row.id);
    if (Number(res.changes ?? 0) === 0) return null;
    return row;
  }

  private async runJob(job: JobRow): Promise<void> {
    const now = Date.now();
    if (this.isAborted(job.source_id)) {
      this.sources.database.raw
        .prepare(
          `UPDATE knowledge_jobs SET status = 'cancelled', last_error = 'aborted', updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(Date.now(), job.id);
      return;
    }
    try {
      if (job.kind === 'parse_file' && job.path) {
        // 单文件解析硬超时：大 xlsx/pdf 同步抽取会堵死事件循环；超时随体积放大
        let parseTimeoutMs = this.parseTimeoutMs;
        try {
          const st = await stat(job.path);
          if (st.isFile()) parseTimeoutMs = parseTimeoutForSize(st.size, this.fileLimits);
        } catch {
          // 路径已删时交给 parseOne 自清理
        }
        await this.withTimeout(
          this.parseOne(job.source_id, job.path),
          parseTimeoutMs,
          `parse_timeout:${job.path}`,
        );
        if (this.isAborted(job.source_id)) {
          throw new Error('aborted');
        }
        this.refreshCoverage(job.source_id);
        if (this.embedding) {
          this.enqueue(job.source_id, 'embed_source', null, 3);
          this.kick();
        }
      } else if (job.kind === 'fetch_doc' && job.path) {
        await this.withTimeout(
          this.fetchDocJob(job.source_id, job.path),
          this.parseTimeoutMs,
          `fetch_timeout:${job.path}`,
        );
        this.refreshCoverage(job.source_id);
        if (this.embedding) {
          this.enqueue(job.source_id, 'embed_source', null, 3);
          this.kick();
        }
      } else if (job.kind === 'drop_file' && job.path) {
        // 目录移出/删除：连同子路径一并清（否则只剩空目录节点）
        this.index.removePathTree(job.source_id, job.path);
        this.refreshCoverage(job.source_id);
      } else if (job.kind === 'walk_source') {
        await this.ingestSource(job.source_id);
      } else if (job.kind === 'embed_source') {
        if (!this.embedding) {
          const stillMissing = this.index.listChunksMissingEmbedding(job.source_id, 1).length > 0;
          if (stillMissing) {
            // 禁止空跑标 done：迁移后缺向量却显示 queue=0
            throw new Error('embedding_provider_missing');
          }
          return;
        }
        await this.embedPending(job.source_id, 50, job.id);
      }
      this.sources.database.raw
        .prepare(
          `UPDATE knowledge_jobs SET status = 'done', updated_at = ? WHERE id = ?`,
        )
        .run(now, job.id);
      this.emitProgress({
        type: 'job',
        sourceId: job.source_id,
        path: job.path ?? undefined,
        status: 'done',
      });
      // 标 done 后再续跑：否则 enqueue 去重会把「自己」当成 active 而丢掉下一棒
      if (job.kind === 'embed_source' && !this.isAborted(job.source_id)) {
        this.ensureEmbedJob(job.source_id);
        this.refreshCoverage(job.source_id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = message === 'aborted' || this.isAborted(job.source_id);
      if (job.kind === 'parse_file' && job.path && !aborted) {
        this.index.markFileError(job.source_id, job.path, message);
      }
      this.sources.database.raw
        .prepare(
          `UPDATE knowledge_jobs
           SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(aborted ? 'cancelled' : 'failed', aborted ? 'aborted' : message, now, job.id);
      if (job.kind === 'embed_source' && !aborted) {
        this.ensureEmbedJob(job.source_id);
      }
      throw err;
    }
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 外源单文档 job：按逻辑键 fetch + 索引
   */
  private async fetchDocJob(sourceId: string, path: string): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source || source.status === 'removed') return;
    const cred = await this.resolveCred(source);
    const existing = this.index.getFile(sourceId, path);
    const ref = {
      path,
      externalUrl: existing?.externalUrl ?? source.location,
      etag: existing?.etag,
      lastModified: existing?.lastModified,
    };
    const fetcher =
      source.kind === 'url'
        ? this.urlFetcher
        : source.kind === 'connector'
          ? this.connectorFetcher
          : this.localFetcher;
    const doc = await fetcher.fetch(source, ref, cred);
    if (doc) this.indexVirtualDoc(sourceId, doc);
  }

  private async parseOne(sourceId: string, filePath: string): Promise<boolean> {
    if (this.shouldSkipFile(filePath)) {
      this.index.markFileSkipped(sourceId, filePath, 'ignored_path');
      return false;
    }

    // 先确认是普通文件：目录/设备节点不得进 knowledge_files（历史上曾误标 no_adapter）
    let st;
    try {
      st = await stat(filePath);
    } catch {
      this.index.removeFile(sourceId, filePath);
      return false;
    }
    if (!st.isFile()) {
      this.index.removeFile(sourceId, filePath);
      return false;
    }

    const adapter = this.adapters.match(filePath);
    if (!adapter) {
      if (this.documentPort && isDocumentPath(filePath)) {
        return this.parseDocumentFile(sourceId, filePath);
      }
      this.index.markFileSkipped(sourceId, filePath, 'no_adapter', st.size);
      return false;
    }

    const kind = classifyFileKind(filePath);
    const sizeDecision = decideBySize(st.size, kind, this.fileLimits);
    if (sizeDecision.action === 'skip') {
      this.index.markFileSkipped(sourceId, filePath, sizeDecision.reason, st.size);
      return false;
    }

    // 软超限 partial：只索引头部，全文 hash 保新鲜度
    const maxTextChars = this.fileLimits.partial.maxTextChars;
    const content = await readFile(filePath, 'utf8');
    const contentHash = hashContent(content);
    if (this.index.isFresh(sourceId, filePath, contentHash)) {
      return true;
    }
    const text =
      sizeDecision.action === 'partial' && content.length > maxTextChars
        ? `${content.slice(0, maxTextChars)}\n\n…[truncated: ${content.length - maxTextChars} chars omitted]`
        : content;

    try {
      const chunks = adapter.chunk(text, filePath);
      this.index.upsertFile({
        sourceId,
        path: filePath,
        contentHash,
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        adapterId: adapter.id,
        chunks,
      });
      return true;
    } catch (err) {
      this.index.markFileError(
        sourceId,
        filePath,
        err instanceof Error ? err.message : String(err),
        st.size,
      );
      return false;
    }
  }

  /**
   * PDF/Office：DocumentPort 抽取为 Markdown 后走 markdownAdapter 切块。
   * 新鲜度以原件字节 hash 为准。
   *
   * @param sourceId - 知识源 id
   * @param filePath - 本地文件路径
   * @returns 是否成功入索引
   */
  private async parseDocumentFile(sourceId: string, filePath: string): Promise<boolean> {
    const port = this.documentPort;
    if (!port) return false;

    let st;
    try {
      st = await stat(filePath);
    } catch {
      this.index.removeFile(sourceId, filePath);
      return false;
    }
    if (!st.isFile()) return false;

    const kind = classifyFileKind(filePath);
    const sizeDecision = decideBySize(st.size, kind, this.fileLimits);
    if (sizeDecision.action === 'skip') {
      this.index.markFileSkipped(sourceId, filePath, sizeDecision.reason, st.size);
      return false;
    }

    const raw = await readFile(filePath);
    const contentHash = hashContent(raw);
    if (this.index.isFresh(sourceId, filePath, contentHash)) {
      return true;
    }

    try {
      // worker 抽取：同步 xlsx/pdf 不堵主循环；超时/中止可 terminate
      const result = await this.extractDocument(filePath, sourceId, st.size);
      const markdown = result.markdown?.trim();
      if (!markdown) {
        this.index.markFileSkipped(sourceId, filePath, 'empty_content', st.size);
        return false;
      }
      const chunks = markdownAdapter.chunk(markdown, filePath);
      this.index.upsertFile({
        sourceId,
        path: filePath,
        contentHash,
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        adapterId: `document:${result.backend}`,
        chunks,
      });
      return true;
    } catch (err) {
      if (isDocumentExtractError(err)) {
        // 结构化跳过（密码/老格式/超大等），不挡整库
        this.index.markFileSkipped(sourceId, filePath, err.code.toLowerCase(), st.size);
        return false;
      }
      this.index.markFileError(
        sourceId,
        filePath,
        err instanceof Error ? err.message : String(err),
        st.size,
      );
      return false;
    }
  }

  /** 优先 worker 抽取；worker 不可用时退回进程内 port */
  private async extractDocument(filePath: string, sourceId: string, fileSize = 0) {
    const signal = this.abortSignalFor(sourceId);
    const timeoutMs = parseTimeoutForSize(fileSize, this.fileLimits);
    const extractOpts = {
      timeoutMs,
      // knowledge 走 hardMax：软超限仍可 partial 抽取
      maxFileBytes: this.fileLimits.hardMaxFileBytes,
      maxSheets: this.fileLimits.partial.maxSheets,
      maxRowsPerSheet: this.fileLimits.partial.maxRowsPerSheet,
      maxPages: this.fileLimits.partial.maxPdfPages,
      maxTextChars: this.fileLimits.partial.maxTextChars,
    };
    try {
      const { extractDocumentInWorker } = await import('./extract-document.js');
      return await extractDocumentInWorker(filePath, {
        ...extractOpts,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'extract_aborted' || signal.aborted) {
        throw new Error('aborted');
      }
      if (msg.includes('Cannot find module') || msg.includes('ERR_MODULE')) {
        return this.documentPort!.extract({ path: filePath, name: filePath }, extractOpts);
      }
      throw err;
    }
  }

  /**
   * Phase B：嵌入待处理 chunk
   *
   * 单 job 内按 embedConcurrency **并行**多批调用 API；
   * 失败/超时也 re-enqueue，避免 job 标 done 后 coverage 永久卡住。
   */
  private async embedPending(sourceId: string, maxRounds = 20, jobId?: string): Promise<void> {
    if (!this.embedding) {
      if (this.index.listChunksMissingEmbedding(sourceId, 1).length > 0) {
        throw new Error('embedding_provider_missing');
      }
      return;
    }
    // 磁盘对齐在 reindex/walk 做；embed 任务内不再全量 prune（曾拖慢解析）

    const lanes = Math.max(1, this.embedConcurrency);
    const batchSize = Math.max(1, this.embedBatch);

    for (let round = 0; round < maxRounds; round++) {
      if (this.isAborted(sourceId)) return;
      const pending = this.index.listChunksMissingEmbedding(sourceId, batchSize * lanes);
      if (pending.length === 0) {
        this.refreshCoverage(sourceId);
        return;
      }
      if (jobId) this.heartbeatJob(jobId);

      // 轮次限速（并行片共享同一闸门）
      if (this.embedMinIntervalMs > 0) {
        const wait = this.lastEmbedAt + this.embedMinIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }

      const slices: typeof pending[] = [];
      for (let i = 0; i < pending.length; i += batchSize) {
        slices.push(pending.slice(i, i + batchSize));
      }

      const settled = await Promise.allSettled(
        slices.map((slice) => this.embedOneSlice(sourceId, slice)),
      );

      let ok = 0;
      let failed = false;
      for (const s of settled) {
        if (s.status === 'fulfilled') ok += s.value;
        else failed = true;
      }
      this.lastEmbedAt = Date.now();
      this.emitProgress({
        type: 'embed',
        sourceId,
        status: 'batch_done',
        detail: `embedded=${ok}/${pending.length} lanes=${slices.length}`,
      });
      if (failed) {
        // 至少一片失败：交给 done 后的 ensureEmbedJob 续跑，不把整 job 打成 failed
        return;
      }
    }
    this.refreshCoverage(sourceId);
  }

  /** 单片 embedding；返回成功写入条数。成功条立即落库，禁止被同片失败拖丢 */
  private async embedOneSlice(
    sourceId: string,
    slice: Array<{ id: KnowledgeChunkId; text: string }>,
  ): Promise<number> {
    if (slice.length === 0) return 0;
    // 超时随片长放大：远程串行 Ollama 单条 1–3s，32 条会顶穿旧 120s 整片超时
    const timeoutMs = 60_000 + 20_000 * slice.length;
    let vectors: number[][] = [];
    if (!this.isAborted(sourceId)) {
      try {
        vectors = await Promise.race([
          this.embedding!.embedBatch(slice.map((p) => p.text)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('embed_batch_timeout')), timeoutMs),
          ),
        ]);
      } catch {
        vectors = [];
      }
    }

    let ok = 0;
    const batch: Array<[string, number[]]> = [];
    const flush = () => {
      if (batch.length > 0) {
        this.index.setChunkEmbeddings(batch.splice(0, batch.length));
      }
    };

    for (let i = 0; i < slice.length; i++) {
      // 中止后立刻停，不把整片跑完（用户点「中止」要能感知）
      if (this.isAborted(sourceId)) {
        flush();
        return ok;
      }
      let vec = vectors[i];
      if (!vec?.length) {
        // 批量空槽 / 长度不对齐：按条补（provider 内含上下文截断回退）
        try {
          vec = await this.embedding!.embed(slice[i]!.text);
        } catch {
          vec = [];
        }
      }
      if (vec?.length) {
        batch.push([slice[i]!.id, vec]);
        ok += 1;
        if (batch.length >= 8) flush();
      }
    }
    flush();
    return ok;
  }

  /** 仍有缺向量则排队下一个 embed_source（须在当前 job 标 done 之后调用） */
  private ensureEmbedJob(sourceId: string): void {
    if (!this.embedding) return;
    if (this.isAborted(sourceId)) return;
    if (this.index.listChunksMissingEmbedding(sourceId, 1).length === 0) return;
    this.enqueue(sourceId, 'embed_source', null, 3);
    this.kick();
  }

  private heartbeatJob(jobId: string): void {
    this.sources.database.raw
      .prepare(`UPDATE knowledge_jobs SET updated_at = ? WHERE id = ? AND status = 'running'`)
      .run(Date.now(), jobId);
  }

  private refreshCoverage(sourceId: string): void {
    const stats = this.index.sourceStats(sourceId);
    const source = this.sources.get(sourceId);
    if (!source) return;
    const discovered = this.discoveredFiles.get(sourceId) ?? 0;
    // Phase A：已落库文件（indexed+skipped+error）/ walk 发现数
    const phaseA =
      discovered > 0
        ? Math.min(1, stats.files / discovered)
        : stats.files > 0
          ? 1
          : 0;
    const embCov = this.embedding ? this.index.embeddingCoverage(sourceId) : 1;
    const blended =
      discovered === 0 && stats.files === 0 && stats.chunks === 0
        ? source.coverage ?? 0
        : this.embedding
          ? phaseA * 0.5 + embCov * 0.5
          : phaseA;
    const stillQueued = this.sources.database.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE source_id = ? AND status = 'queued'`,
      )
      .get(sourceId) as { n: number };
    const stillRunning = this.sources.database.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE source_id = ? AND status = 'running'`,
      )
      .get(sourceId) as { n: number };
    const busy = (stillQueued?.n ?? 0) > 0 || (stillRunning?.n ?? 0) > 0;
    const status = busy
      ? 'partial'
      : stats.chunks > 0 || stats.files > 0
        ? 'ready'
        : source.status;
    this.sources.update(sourceId, {
      status: status as KnowledgeSource['status'],
      coverage: blended,
    });
    this.emitProgress({
      type: 'source',
      sourceId,
      status,
      detail: `files=${stats.files} chunks=${stats.chunks} emb=${embCov.toFixed(2)}`,
    });
  }

  private emitProgress(evt: IngestProgressEvent): void {
    this.emit('progress', evt);
    this.emit('knowledge.index.progress', evt);
  }

  /** 磁盘水位告警（仅告警，不丢任务） */
  private async warnDiskWatermark(sourceId: string): Promise<void> {
    try {
      const { statfs } = await import('node:fs/promises');
      const root = process.env.OCTOPI_HOME || process.cwd();
      const st = await statfs(root);
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      const freeMb = freeBytes / (1024 * 1024);
      if (freeMb < 100) {
        this.emitProgress({
          type: 'error',
          sourceId,
          status: 'disk_watermark',
          detail: `free≈${Math.round(freeMb)}MB (jobs kept)`,
        });
      }
    } catch {
      // statfs 不可用时静默
    }
  }
}
