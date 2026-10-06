/**
 * KnowledgeIngest ?解析/切块/索引队列（P2 Phase A?
 *
 * 原则：ingest 话并发，不作 turn 前置；队列背压不务；source 级锁?
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { statSync, realpathSync } from 'node:fs';
import { watch, type FSWatcher } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { FormatAdapterRegistry, htmlAdapter, markdownAdapter, textAdapter } from './adapters.js';
import { looksLikeHtml } from './html.js';
import { hashContent, KnowledgeIndexStore } from './index-store.js';
import {
  identifyLocalFile,
  urlIdentityKey,
  normalizePathLexical,
} from './file-identity.js';
import { KnowledgeJobControl } from './job-control.js';
import { KnowledgeSourceStore } from './source-store.js';
import {
  LocalFsFetcher,
  UrlFetcher,
  type DiscoverResult,
  type SourceFetcher,
  type VirtualDocument,
} from './fetchers.js';
import { ConnectorRegistry } from './connectors.js';
import { ConnectorFetcher } from './connector-fetcher.js';
import type { CredentialStore } from '../governance/credentials/store.js';
import type { ResolvedCredential } from '../governance/credentials/types.js';
import type { EmbeddingProvider } from '../memory/sqlite/embedding.js';
import type { KnowledgeSource, KnowledgeChunkId } from './types.js';
import type { DocumentPort } from '../capabilities/document/types.js';
import { isDocumentPath } from '../capabilities/document/format.js';
import { isDocumentExtractError } from '../capabilities/document/errors.js';
import {
  classifyFileKind,
  decideBySize,
  isRetryableSkipReason,
  parseTimeoutForSize,
  resolveKnowledgeFileLimits,
  type KnowledgeFileLimits,
  type KnowledgeFileLimitsInput,
} from './file-limits.js';
import { EmbedRunner, type EmbedSecretPolicy } from './embed-runner.js';
import { JobQueue, type IngestJobKind as JobKind, type JobRow } from './job-queue.js';

export type { EmbedSecretPolicy };
export type IngestJobKind = JobKind;

/** /继续 控制数（UI 互斥按钮?*/
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
  /** parse 并发（默?8?*/
  parseConcurrency?: number;
  /** 队列深度上限（超出只，不务） */
  maxQueueDepth?: number;
  /** fs watch debounce ms（默?2000?*/
  debounceMs?: number;
  /** 单文件大小兜底上限（格式分级?fileLimits?*/
  maxFileBytes?: number;
  /**
   * 按格式分级的文件 + 部分抽取策略?
   * 机器资源不足时下?maxBytes / hardMaxFileBytes?
   */
  fileLimits?: KnowledgeFileLimitsInput;
  /** 单文?parse 超时 ms（默?45000?*/
  parseTimeoutMs?: number;
  /** Phase B embedding（未配则?*/
  embeddingProvider?: EmbeddingProvider | null;
  /** embed 批大小（ 32?*/
  embedBatch?: number;
  /** embed 小间?ms（限速， 0?*/
  embedMinIntervalMs?: number;
  /** embed 并发（默?parseConcurrency?*/
  embedConcurrency?: number;
  /** 磁盘水位（默?false；仅不丢任务?*/
  diskWatermarkAlert?: boolean;
  /** 库（source.authRef 解析；可选） */
  credentials?: CredentialStore | null;
  /** ?fetcher 覆盖（测?扩展?*/
  fetchers?: Partial<Record<'local' | 'url' | 'connector', SourceFetcher>>;
  /** connector 注册?rest?*/
  connectors?: ConnectorRegistry;
  /** poll 调度 tick ms（默?60s?*/
  pollTickMs?: number;
  /** 单源?poll 间隔 ms（默?15min?*/
  pollMinIntervalMs?: number;
  /** 每轮 poll 理源数（成本上限，默?8?*/
  maxPollPerTick?: number;
  /**
   * DocumentPort：启用后 PDF/Office 等走抽取 ?Markdown 切块
   * （缺?null = 维持 BINARY skip ?
   */
  documentPort?: DocumentPort | null;
  /**
   * documents.* 配置 — 与 Gateway 同源；worker 抽取与 legacy/soffice 共用
   */
  documentConfig?: import('../capabilities/document/factory.js').DocumentCapabilityConfig | null;
  /**
   * embedding 外发前敏感形态策略（ redact?
   * - allow：原发（内网/模型?
   * - redact：命 [REDACTED:rule] ?embed
   * - skip：命不写向量（关仍可搜）
   */
  embedSecretPolicy?: EmbedSecretPolicy;
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
  /** 单文?parse/fetch 超时（默?45s；大 Office 抽取会堵事件?*/
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
  private readonly documentConfig: import('../capabilities/document/factory.js').DocumentCapabilityConfig | null;
  private readonly embedSecretPolicy: EmbedSecretPolicy;
  private readonly embedRunner: EmbedRunner;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** 源级：DB 权威 + ?AbortSignal（跨重启?*/
  private readonly jobControl: KnowledgeJobControl;
  private readonly jobQueue: JobQueue;
  /** 源任务稳定（?queued/running）时回调 ?用于 auto-describe 等收?*/
  onSourceSettled?: (sourceId: string) => void;
  /**  parse 缺口时间 */
  private lastParseGapScanAt = new Map<string, number>();

  private runningParse = 0;
  private runningEmbed = 0;
  private draining = false;
  private kickAgain = false;
  /** source 级锁：同 source 不并?walk/parse 冲突?*/
  private sourceLocks = new Set<string>();
  /** walk 发现的文件数（Phase A coverage 分母?*/
  private discoveredFiles = new Map<string, number>();
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(options: KnowledgeIngestOptions) {
    super();
    this.sources = options.sourceStore;
    this.maxQueueDepth = options.maxQueueDepth ?? 10_000;
    this.jobControl = new KnowledgeJobControl(options.sourceStore.database);
    this.jobQueue = new JobQueue({
      db: options.sourceStore.database,
      maxQueueDepth: this.maxQueueDepth,
      isAborted: (id) => this.isAborted(id),
      onBackpressure: (sourceId, queued) => {
        this.emitProgress({
          type: 'error',
          sourceId,
          status: 'queue_backpressure',
          detail: `queued=${queued} (delay only, jobs kept)`,
        });
      },
    });
    this.index = options.indexStore ?? new KnowledgeIndexStore(options.sourceStore.database);
    this.adapters = options.adapterRegistry ?? new FormatAdapterRegistry();
    this.parseConcurrency = options.parseConcurrency ?? 8;
    // watch 批量落盘时缩默窗，新增文件更?
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
    // embed ?parse 分槽；缺?4 行打 embedding API
    this.embedConcurrency = options.embedConcurrency ?? 4;
    this.diskWatermarkAlert = options.diskWatermarkAlert ?? false;
    this.credentials = options.credentials ?? null;
    this.documentPort = options.documentPort ?? null;
    this.documentConfig = options.documentConfig ?? null;
    this.embedSecretPolicy = options.embedSecretPolicy ?? 'redact';
    this.embedRunner = new EmbedRunner({
      index: this.index,
      embedding: this.embedding,
      embedBatch: this.embedBatch,
      embedConcurrency: this.embedConcurrency,
      embedMinIntervalMs: this.embedMinIntervalMs,
      embedSecretPolicy: this.embedSecretPolicy,
      isAborted: (id) => this.isAborted(id),
      heartbeatJob: (id) => this.heartbeatJob(id),
      refreshCoverage: (id) => this.refreshCoverage(id),
      emitProgress: (evt) => this.emitProgress(evt),
      recordSecretHit: (input) => this.recordEmbedSecretHit(input),
    });
    // embedding 外发（合规可查；非权量）
    this.sources.database.raw.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_embed_secret_log (
        id         TEXT PRIMARY KEY,
        source_id  TEXT NOT NULL,
        chunk_id   TEXT NOT NULL,
        action     TEXT NOT NULL,
        hits_json  TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.localFetcher =
      options.fetchers?.local ?? new LocalFsFetcher((p) => this.shouldSkipFile(p));
    this.urlFetcher = options.fetchers?.url ?? new UrlFetcher();
    this.connectorFetcher =
      options.fetchers?.connector ??
      new ConnectorFetcher(options.connectors ?? new ConnectorRegistry());
    this.pollTickMs = options.pollTickMs ?? 60_000;
    this.pollMinIntervalMs = options.pollMinIntervalMs ?? 15 * 60_000;
    this.maxPollPerTick = options.maxPollPerTick ?? 8;
    // 崩溃/重启遗留?running 会堵?enqueue 去重并永久显?indexing
    this.reclaimOrphanRunningJobs();
    // 历史：目录等非文件曾?no_adapter，启动即?
    this.cleanupNonFileIndexRows();
  }

  private lastCleanupAt = 0;

  /**
   * 清掉「非?knowledge_files （目录曾 no_adapter?
   *
   * ?skipped/error 且无 chunk ：有 chunk 的仍?pruneMissing/磁盘对齐?
   *  60s 节流，避免每?reconcile ?stat?
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
          `SELECT m.logical_path AS path
           FROM knowledge_memberships m
           JOIN knowledge_files f ON f.id = m.file_id
           WHERE m.source_id = ? AND f.status IN ('skipped', 'error') AND f.chunk_count = 0`,
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
          // 不存留给 pruneMissing齐），避删有效但暂时不可见的文件
        }
      }
    }
    return removed;
  }

  /**
   * 无跨进程 Lease：本进程时把历史 running 收回 queued?
   * 仅构造时调用行中同进程的 running 法的?
   */
  private reclaimOrphanRunningJobs(): void {
    this.jobQueue.reclaimOrphanRunning();
  }

  get indexStore(): KnowledgeIndexStore {
    return this.index;
  }

  /**
   * 过滤：文档扩展名交给 worker 抽取，不 BINARY ?
   *
   * @param p - 文件
   * @returns 跳过
   */
  private shouldSkipFile(p: string): boolean {
    if (isDocumentPath(p)) return false;
    return this.adapters.shouldSkipPath(p);
  }

  /** 尽量拿真实 identity；失败返回 undefined（退回 path: 降级键） */
  private async identityKeyFor(filePath: string): Promise<string | undefined> {
    try {
      return (await identifyLocalFile(filePath)).key;
    } catch {
      return undefined;
    }
  }

  /**
   * 归属：`parse_file` / 读文件只读源 root 内的?
   * ?**realpath** 比较，防符号链接逃出 root?
   *
   * @param source - 知识?
   * @param path - 请求（本地绝对路径，
   */
  private sourceOwnsPath(source: KnowledgeSource, path: string): boolean {
    if (source.kind === 'url' || source.kind === 'connector') {
      return Boolean(this.index.getFile(source.id, path));
    }
    const root = resolve(source.location);
    const target = resolve(path);
    const eq = (a: string, b: string) =>
      process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    // 词法（路径不存在时也拒绝明显越界?
    if (!eq(root, target)) {
      const relLex = relative(root, target);
      if (!relLex || relLex.startsWith('..') || isAbsolute(relLex)) return false;
    }
    // realpath ?symlink stat 失败回词法结果）
    try {
      const rootReal = realpathSync(root);
      const targetReal = realpathSync(target);
      if (eq(rootReal, targetReal)) return true;
      const rel = relative(rootReal, targetReal);
      return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
    } catch {
      return true; // 词法；文件尚在时交给后续 stat
    }
  }

  /**
   * 全量/增量索引某源（Phase A?
   *
   * @param opts.full - 显式重建（supersede 成任务）；poll/增量不打?
   * @param opts.incremental - 增量（poll）：?active 任务则跳过本?
   */
  async ingestSource(
    sourceId: string,
    opts?: { full?: boolean; incremental?: boolean; fromQueue?: boolean },
  ): Promise<void> {
    // fromQueue（walk_source）：不 supersede、不跳过 active；reindex 才作废队列
    if (opts?.fromQueue) {
      // fall through to walk
    } else if (opts?.full !== false && !opts?.incremental) {
      this.supersedeSourceWork(sourceId);
    } else if (this.countActiveJobs(sourceId).total > 0) {
      this.emitProgress({
        type: 'source',
        sourceId,
        status: 'poll_skipped',
        detail: 'active jobs in flight',
      });
      return;
    }
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
      // 已有同源任务在跑：入?walk 即可（去重）
      this.enqueue(sourceId, 'walk_source', null, 1, source.location);
      return;
    }
    this.sourceLocks.add(sourceId);
    try {
      this.sources.update(sourceId, { status: 'discovering', coverage: 0 });
      this.emitProgress({ type: 'source', sourceId, status: 'discovering' });

      // full 不再 clearSource：靠 keepPaths  prune，discover 失败不丢?
      if (source.kind === 'url' || source.kind === 'connector') {
        await this.ingestRemoteSource(source);
        return;
      }

      // watch 策略索引同时挂上 fs 监听（幂等；否则后续变更静默丢失?
      this.startWatch(sourceId);

      const localDiscovery = await this.localFetcher.discover(source);
      const files = localDiscovery.docs;
      this.discoveredFiles.set(sourceId, files.length);
      // 后不 prune、不入队（半?keep 删）
      if (this.isAborted(sourceId)) return;
      //  prune：仅 walk 完整时执行；出错/?keep 不完整会
      if (localDiscovery.complete) {
        const localKeep = new Set(files.map((f) => f.path));
        // walk 成功且目录为??清空 Membership?.2?
        this.index.pruneMissing(sourceId, localKeep, { allowEmptyKeep: true });
      }

      this.sources.update(sourceId, { status: 'partial', coverage: 0 });
      this.emitProgress({
        type: 'source',
        sourceId,
        status: 'partial',
        detail: `${files.length} files`,
      });

      for (const file of files) {
        if (this.isAborted(sourceId)) return;
        this.enqueue(sourceId, 'parse_file', file.path, 2, file.path);
      }
      if (this.embedding && !this.isAborted(sourceId)) {
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
    let discovered: DiscoverResult;
    try {
      discovered = await fetcher.discover(source, cred);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sources.update(source.id, {
        status: 'error',
        errors: [...(source.errors ?? []), { message: msg, at: Date.now() }].slice(-5),
      });
      this.emitProgress({ type: 'error', sourceId: source.id, status: 'discover_failed', detail: msg });
      return;
    }
    const refs = discovered.docs;
    // 条件 GET：带上已?etag/Last-Modified?04 则整文档跳过
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
      // 后立刻停：不再写索引
      if (this.isAborted(source.id)) {
        this.emitProgress({
          type: 'source',
          sourceId: source.id,
          status: 'aborted',
          detail: `stopped after ${okCount + unchanged}/${enriched.length}`,
        });
        return;
      }
      try {
        const doc = await fetcher.fetch(source, ref, cred);
        if (!doc) {
          // 304 / ：保持原索引
          unchanged += 1;
          okCount += 1;
          continue;
        }
        if (this.indexVirtualDoc(source.id, doc, source.authRef)) {
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

    //  prune：仅?discover **完整** 时才；截?walk 失败?keep 不完整，prune ?
    // 后不?prune：半?keep 删已入库文档
    if (!this.isAborted(source.id) && discovered.complete) {
      const keep = new Set(enriched.map((r) => r.path));
      const pruned = this.index.pruneMissing(source.id, keep, { allowEmptyKeep: true });
      if (pruned > 0) {
        this.emitProgress({
          type: 'source',
          sourceId: source.id,
          status: 'pruned',
          detail: `removed=${pruned}`,
        });
      }
    }

    if (this.embedding && !this.isAborted(source.id)) {
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
   * 解析源凭证；配置?authRef ?**fail-closed**（解析失败则不抓，不降级匿名?
   *
   * @returns ?null（仅当源?authRef?
   * @throws authRef 配置了但无法解析时抛错，由调用方
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
   * ?VirtualDocument 写入索引?/ 规范化后文本?
   *
   * @returns 成功写入
   */
  indexVirtualDoc(sourceId: string, doc: VirtualDocument, authRef?: string | null): boolean {
    if (!doc.content?.trim()) {
      this.index.markFileSkipped(sourceId, doc.path, 'empty_content');
      return false;
    }
    // 逻辑能无扩展名（connector id / URL path）：?MIME ?扩展??
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
      let identityKey: string;
      if (doc.externalUrl) {
        identityKey = urlIdentityKey(doc.externalUrl, authRef);
      } else {
        try {
          identityKey = `path:${normalizePathLexical(doc.path)}`;
        } catch {
          identityKey = `path:${doc.path.replace(/\\/g, '/')}`;
        }
      }
      this.index.upsertFile({
        sourceId,
        path: doc.path,
        contentHash,
        size: doc.size,
        mtime: Math.floor(Date.now() / 1000),
        adapterId: adapter.id,
        chunks,
        identityKey,
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
   * 单文（P0 道；完成 parse，不 await 全库?
   */
  async ingestFileNow(sourceId: string, filePath: string): Promise<boolean> {
    const ok = await this.parseOne(sourceId, filePath);
    this.refreshCoverage(sourceId);
    return ok;
  }

  /**
   * 重做指定文件：强制重?解析 ?分块 ?向量
   *
   * - 必须归属（防越权读盘）；外源逻辑 fetch_doc 重取
   * - 失效 contentHash（忽?isFresh），?chunks 保留?upsert 成功
   * - **于中 resume**：显式重?= 意图要跑活，不允许静默丢?
   * - 等非文件：直接清，不入队
   * - 完成后走既有 embed 链路
   *
   * @param sourceId - ?id
   * @param paths - 文件列表
   * @returns queued=新入队；alreadyActive=已在队列/；cleanedNonFiles=清掉的目录脏行；rejected=越权/不属
   */
  reprocessFiles(
    sourceId: string,
    paths: string[],
  ): {
    queued: number;
    alreadyActive: number;
    cleanedNonFiles: number;
    resumed: boolean;
    rejected: number;
  } {
    if (!paths.length) {
      return { queued: 0, alreadyActive: 0, cleanedNonFiles: 0, resumed: false, rejected: 0 };
    }
    const source = this.sources.get(sourceId);
    if (!source) {
      return { queued: 0, alreadyActive: 0, cleanedNonFiles: 0, resumed: false, rejected: paths.length };
    }
    let resumed = false;
    if (this.isAborted(sourceId)) {
      this.beginAbortEpoch(sourceId);
      resumed = true;
    }
    let queued = 0;
    let alreadyActive = 0;
    let cleanedNonFiles = 0;
    let rejected = 0;
    const isRemote = source.kind === 'url' || source.kind === 'connector';
    for (const p of paths) {
      if (!this.sourceOwnsPath(source, p)) {
        rejected += 1;
        continue;
      }
      if (isRemote) {
        // 外源：path 重做 = 重新 fetch + 索引（不读本地盘?
        this.index.invalidateFileForReparse(sourceId, p);
        if (this.enqueue(sourceId, 'fetch_doc', p, 1, p)) {
          queued += 1;
        } else if (this.hasActiveParseJob(sourceId, p)) {
          alreadyActive += 1;
        }
        continue;
      }
      // /节点：清即可，没?
      try {
        const st = statSync(p);
        if (!st.isFile()) {
          this.index.removeFile(sourceId, p);
          cleanedNonFiles += 1;
          continue;
        }
      } catch {
        // 不存仍按文件流程 parse ?
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
    return { queued, alreadyActive, cleanedNonFiles, resumed, rejected };
  }

  /** 上是否已?queued/running ?parse/fetch 任务 */
  private hasActiveParseJob(sourceId: string, path: string): boolean {
    return this.jobQueue.hasActivePathJob(sourceId, path);
  }

  /**
   * 级任?文件UI 跟踪重做完成?
   *
   * @param sourceId - ?id
   * @param paths - 列表
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
   * 按筛选批量重做（当前列表?status/ext/q 条件?
   *
   * @param sourceId - ?id
   * @param opts - 与文件列表筛选一?
   * @returns 入队条数
   */
  reprocessByFilter(
    sourceId: string,
    opts?: { status?: 'indexed' | 'skipped' | 'error' | 'all'; ext?: string; q?: string },
  ): {
    queued: number;
    alreadyActive: number;
    cleanedNonFiles: number;
    resumed: boolean;
    rejected: number;
  } {
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
        // 统一?stat：目?change 时不?parse ?no_adapter
        void stat(filePath)
          .then((st) => {
            if (st.isFile()) {
              this.enqueue(sourceId, 'parse_file', filePath, 1, filePath);
            } else if (event === 'rename' || !st.isDirectory()) {
              // rename 到目?= 新目?移出；非文件也走 drop 清残?
              this.enqueue(sourceId, 'drop_file', filePath, 1, filePath);
            } else {
              // 上的 change：子文件由各理；仅清历史
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
   *  watch（幂等）
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
   * 等待队列排空（测?管理?
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
   * 手动索引任务（业务完整：停收 + 清队 + 打断在跑?
   *
   * @param opts.sourceId - 仅中源；省略则全部源
   * @returns 取消
   */
  abortJobs(opts?: { sourceId?: string }): {
    cancelledQueued: number;
    abortedRunning: number;
    runningJobs: number;
  } {
    const sid = opts?.sourceId?.trim();
    const ids = sid
      ? [sid]
      : [
          ...this.jobControl.listAbortedSourceIds(),
          ...this.sources.list().map((s) => s.id),
        ];
    const unique = [...new Set(ids)];
    let cancelledQueued = 0;
    let abortedRunning = 0;

    for (const id of unique) {
      // 1) DB 落中跨重+ 打断程信?
      const newly = this.jobControl.markAborted(id);
      if (newly) abortedRunning += 1;

      // 2) 清空 queued ?cancelled（共?File ?parse 不杀：仍领则保留?
      const res = this.sources.database.raw
        .prepare(
          `UPDATE knowledge_jobs SET status = 'cancelled', last_error = 'aborted', updated_at = ?
           WHERE source_id = ? AND status = 'queued'
             AND (
               file_id IS NULL
               OR kind IN ('walk_source', 'embed_source')
               OR NOT EXISTS (
                 SELECT 1 FROM knowledge_memberships m
                 WHERE m.file_id = knowledge_jobs.file_id AND m.source_id != ?
               )
             )`,
        )
        .run(Date.now(), id, id);
      cancelledQueued += Number(res.changes ?? 0);
    }

    // 3) 看门狗不要再?aborted running 收回 queued（限定本次涉及的源）
    if (sid) {
      this.sources.database.raw
        .prepare(
          `UPDATE knowledge_jobs SET status = 'cancelled', last_error = 'aborted', updated_at = ?
           WHERE source_id = ? AND status = 'running' AND last_error = 'aborted'`,
        )
        .run(Date.now(), sid);
    } else {
      this.sources.database.raw
        .prepare(
          `UPDATE knowledge_jobs SET status = 'cancelled', last_error = 'aborted', updated_at = ?
           WHERE status = 'running' AND last_error = 'aborted'`,
        )
        .run(Date.now());
    }

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
   * /继续索引（相轻）
   *
   * - 清除该源?
   * - ?cancelled 任务放回 queued
   * - 若仍缺向量则排队 embed
   * - 不重?walk 全量；需要全 reindex
   *
   * @param opts.sourceId - 仅恢源；省略则全部源
   * @returns 
   */
  resumeJobs(opts?: { sourceId?: string }): {
    restoredCancelled: number;
    embedQueued: number;
  } {
    const sid = opts?.sourceId?.trim();
    const ids = sid
      ? [sid]
      : [
          ...new Set([
            ...this.jobControl.listAbortedSourceIds(),
            ...this.sources.list().map((s) => s.id),
          ]),
        ];

    let restoredCancelled = 0;
    let embedQueued = 0;
    for (const id of ids) {
      // 1) 清除态（DB + 新纪元信号）
      this.beginAbortEpoch(id);

      // 2) cancelled ?queued（用户中止时的活?
      const res = this.sources.database.raw
        .prepare(
          `UPDATE knowledge_jobs SET status = 'queued', last_error = NULL, updated_at = ?
           WHERE source_id = ? AND status = 'cancelled' AND (last_error IS NULL OR last_error = 'aborted')`,
        )
        .run(Date.now(), id);
      restoredCancelled += Number(res.changes ?? 0);

      // 3) 仍缺向量则确?embed 在队
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

  /** 的未（resume / supersede 后用；清 DB 态） */
  private beginAbortEpoch(sourceId: string): void {
    this.jobControl.beginEpoch(sourceId);
  }

  /**
   * 重建前作废本源未完成任务（supersede?
   *
   * - queued ?cancelled（superseded_by_reindex?
   * - running 打断（worker/出）
   * - 随后 beginAbortEpoch，本建可继续?
   */
  private supersedeSourceWork(sourceId: string): void {
    this.sources.database.raw
      .prepare(
        `UPDATE knowledge_jobs SET status = 'cancelled', last_error = 'superseded_by_reindex', updated_at = ?
         WHERE source_id = ? AND status = 'queued'`,
      )
      .run(Date.now(), sourceId);

    // 打断在跑 parse/embed；再新纪元（清中，避?walk ?abort 
    this.jobControl.markAborted(sourceId);
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
    // 已有 parse 则不全局互斥其他源的缺口补扫?
    if (this.countQueuedKinds(['parse_file', 'walk_source'], sourceId) > 0) return 0;

    let found: DiscoverResult;
    try {
      found = await this.localFetcher.discover(source);
    } catch {
      return 0;
    }
    const byPath = new Map(this.index.listFiles(sourceId).map((f) => [f.path, f]));
    let added = 0;
    let retriedSkipped = 0;
    for (const f of found.docs) {
      const existing = byPath.get(f.path);
      // 缺文件必补；?skipped ?oversize/空内容在受时重试（配宽后能进索引?
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
   * 磁盘↔索齐：删掉已不存在的文件（?chunks/embeddings?
   *
   * 源用?discover walk ?keep 集（；失回并?stat?
   * embed 前调避免给已移出文件的残 chunks 上向?
   *
   * @param sourceId - 知识?id
   * @returns 删除的文件数
   */
  async pruneMissingOnDisk(sourceId: string): Promise<number> {
    const source = this.sources.get(sourceId);
    if (!source || source.kind === 'url' || source.kind === 'connector') return 0;

    let removed = 0;
    if (source.kind === 'directory' || source.kind === 'workspace') {
      try {
        const found = await this.localFetcher.discover(source);
        if (!found.complete) {
          // walk 不完整：?stat止用残缺 keep 清库
          removed = await this.pruneByStatScan(sourceId);
        } else {
          const keep = new Set(found.docs.map((f) => f.path));
          // walk 完整：即使空也可清空（与逐文?stat 致）
          removed = this.index.pruneMissing(sourceId, keep, { allowEmptyKeep: true });
        }
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

  /** 逐文?stat（file ?/ walk 失败）；限流 */
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
    return this.jobControl.signalFor(sourceId);
  }

  private isAborted(sourceId: string): boolean {
    return this.jobControl.isAborted(sourceId);
  }

  /**
   * /继续 控制数（互斥按钮
   *
   * @param sourceId - ?id
   * @returns 队列计数 + 已中?+ 仍缺向量
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
    // 还有活在排队/，且当前于中?
    const canAbort = active && !aborted;
    // 止过、有 cancelled ，或缺向量且当前无活
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
   * 任务对账（看门狗?不依赖单?ensureEmbedJob
   *
   * 解决「续去重吞掉 / 进程 /  partial」等静默停摆?
   * 1. 回收超时 running（崩?孤儿?
   * 2. 有缺向量且无 active embed ?排队
   * 3. 无队缺口 ??coverage/status
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

  /** 对账入口（也工调 */
  async reconcileJobs(): Promise<void> {
    if (this.disposed) return;
    // stale ?**大于** 时，否则合法的长 parse 收回后双?
    this.reclaimStaleRunningJobs(this.fileLimits.maxParseTimeoutMs + 60_000);
    // path: 与 win:/unix: 身份分裂的零认领残留
    this.index.purgeOrphanPathIdentityFiles();
    // 等历入项（轻量；非每
    this.cleanupNonFileIndexRows();
    // ?job 定期清理，防表无?
    this.cleanupTerminalJobs();
    // 存量 FTS 后台补齐（分出事件循 rebuild?
    void this.index.ensureFtsBackfill();
    // 存量向量回填：小批量 + 让出事件?2000 条同步写（会 abort?
    await this.index.backfillVecFromEmbeddings(25);
    for (const s of this.sources.list()) {
      if (s.status === 'removed' || s.status === 'disabled') continue;
      if (this.isAborted(s.id)) continue;
      const active = this.countActiveJobs(s.id);
      // discovering 卡死（注册 kick 失败 / file 源 walk 中断）：无任务则 re-kick，不 supersede
      if (
        active.total === 0 &&
        (s.status === 'pending' || s.status === 'discovering') &&
        (s.kind === 'file' || s.kind === 'directory' || s.kind === 'workspace')
      ) {
        void this.ingestSource(s.id, { fromQueue: true }).catch(() => undefined);
      }
      // 稳定态收尾（auto-describe 等）关键词部署同触发
      // 先看 active，再 gap ；避免刚入队?gap job 挡住 settled
      if (active.total === 0) {
        this.refreshCoverage(s.id);
        try {
          this.onSourceSettled?.(s.id);
        } catch {
          /* ignore settle hook errors */
        }
      } else {
        this.flushCoverageDirty(s.id);
      }
      // watch 漏事?/ skip 试时补齐 parse（与配置 embedding 无关?
      const lastGap = this.lastParseGapScanAt.get(s.id) ?? 0;
      if (Date.now() - lastGap > 60_000) {
        this.lastParseGapScanAt.set(s.id, Date.now());
        await this.ensureParseCoverage(s.id);
      }
      const missingEmbed = this.embedding
        ? this.index.listChunksMissingEmbedding(s.id, 1).length > 0
        : false;
      if (this.embedding && missingEmbed && active.embed === 0) {
        this.ensureEmbedJob(s.id);
      }
    }
    this.kick();
  }

  /** ?job 清理（done/failed/cancelled 超过保留期） */
  private cleanupTerminalJobs(retainMs = 24 * 60 * 60_000): void {
    this.jobQueue.cleanupTerminal(retainMs);
  }

  /** running 超时（无 heartbeat）→ 收回 queued次失败的直接?failed，防毒文 */
  private reclaimStaleRunningJobs(staleMs: number): void {
    this.jobQueue.reclaimStaleRunning(staleMs);
  }

  private countActiveJobs(sourceId: string): { total: number; embed: number } {
    return this.jobQueue.countActiveJobs(sourceId);
  }

  /**
   *  poll 调度（幂等）；仅处理 sync.strategy=poll ?enabled 的源
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
    // 不阻止进?
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 到期 poll 源并入队刷新（内容未变由 content-hash / 304 ?
   *
   * @returns 实际触发?sourceId 列表
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
      // 入队，不 tick量：?active 则跳过， supersede 打断
      void this.ingestSource(source.id, { incremental: true }).catch((err) => {
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

  //  内部 

  private hasQueuedJobs(): boolean {
    return this.jobQueue.hasQueuedJobs();
  }

  private enqueue(
    sourceId: string,
    kind: IngestJobKind,
    path: string | null,
    priority: number,
    _detail?: string,
  ): boolean {
    const ok = this.jobQueue.enqueue(sourceId, kind, path, priority);
    if (ok && this.diskWatermarkAlert) {
      void this.warnDiskWatermark(sourceId);
    }
    return ok;
  }

  private kick(): void {
    if (this.disposed) return;
    if (this.draining) {
      // 等待 drain 会再 kick；标记一次避免丢信号
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
    if (this.disposed) return;
    for (;;) {
      if (this.disposed) return;
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
      // 业务优先级：解析/分块做完即可关键词搜；embedding 仅在?parse 时占?
      if (allowEmbed && parsePending === 0) kinds.push('embed_source');
      if (kinds.length === 0) {
        if (!allowParse && allowEmbed && parsePending === 0) return;
        // parse 槽满但仍?parse  ??parse，不?embed
        if (parsePending > 0 && !allowParse) return;
        return;
      }

      const job = this.claimJob(kinds);
      if (!job) {
        // 队列清空：合并刷 parse/drop 标脏?coverage，避免每文件?COUNT
        this.flushCoverageDirty();
        return;
      }

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

  private countQueuedKinds(kinds: IngestJobKind[], sourceId?: string): number {
    if (this.disposed) return 0;
    return this.jobQueue.countQueuedKinds(kinds, sourceId);
  }

  private claimJob(kinds: IngestJobKind[]): JobRow | null {
    return this.jobQueue.claimJob(kinds);
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
      // 归属闸门：任何会碰本地盘 / 外源逻辑 path 任务都必须属于本?
      if (job.path && (job.kind === 'parse_file' || job.kind === 'fetch_doc')) {
        const owner = this.sources.get(job.source_id);
        if (owner && !this.sourceOwnsPath(owner, job.path)) {
          throw new Error(`path not owned by source: ${job.path}`);
        }
      }
      if (job.kind === 'parse_file' && job.path) {
        // 单文件解析硬超时：大 xlsx/pdf 抽取会堵死事件循超时随体?
        let parseTimeoutMs = this.parseTimeoutMs;
        try {
          const st = await stat(job.path);
          if (st.isFile()) parseTimeoutMs = parseTimeoutForSize(st.size, this.fileLimits);
        } catch {
          // 已删时交?parseOne ?
        }
        this.heartbeatJob(job.id);
        await this.withTimeout(
          (signal) => this.parseOne(job.source_id, job.path!, signal),
          parseTimeoutMs,
          `parse_timeout:${job.path}`,
          this.abortSignalFor(job.source_id),
        );
        if (this.isAborted(job.source_id)) {
          throw new Error('aborted');
        }
        this.markCoverageDirty(job.source_id);
        if (this.embedding) {
          this.enqueue(job.source_id, 'embed_source', null, 3);
          this.kick();
        }
      } else if (job.kind === 'fetch_doc' && job.path) {
        this.heartbeatJob(job.id);
        await this.withTimeout(
          (signal) => this.fetchDocJob(job.source_id, job.path!, signal),
          this.parseTimeoutMs,
          `fetch_timeout:${job.path}`,
          this.abortSignalFor(job.source_id),
        );
        if (this.isAborted(job.source_id)) {
          throw new Error('aborted');
        }
        this.markCoverageDirty(job.source_id);
        if (this.embedding) {
          this.enqueue(job.source_id, 'embed_source', null, 3);
          this.kick();
        }
      } else if (job.kind === 'drop_file' && job.path) {
        // 移出/删除：连同子并清（否则只剩空节点?
        this.index.removePathTree(job.source_id, job.path);
        this.markCoverageDirty(job.source_id);
      } else if (job.kind === 'walk_source') {
        await this.ingestSource(job.source_id, { fromQueue: true });
        if (this.isAborted(job.source_id)) {
          throw new Error('aborted');
        }
      } else if (job.kind === 'embed_source') {
        if (!this.embedding) {
          const stillMissing = this.index.listChunksMissingEmbedding(job.source_id, 1).length > 0;
          if (stillMissing) {
            // 空跑?done：迁移后缺向量却显示 queue=0
            throw new Error('embedding_provider_missing');
          }
          return;
        }
        await this.embedPending(job.source_id, 50, job.id);
        if (this.isAborted(job.source_id)) {
          throw new Error('aborted');
        }
      }
      // 统一收尾闸门：任?kind 后都不得?done
      if (this.isAborted(job.source_id)) {
        throw new Error('aborted');
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
      // ?done 后再：否?enqueue 去重会把「自?active 而丢掉下?
      if (job.kind === 'embed_source' && !this.isAborted(job.source_id)) {
        this.ensureEmbedJob(job.source_id);
        this.refreshCoverage(job.source_id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = message === 'aborted' || this.isAborted(job.source_id);
      // 归属拒绝不是「文件解析失不得写入 knowledge_files
      const ownership = message.includes('not owned by source');
      if (job.kind === 'parse_file' && job.path && !aborted && !ownership) {
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

  /**
   * 带截止时间的消执行：超时?abort signal，工作侧必须在副作用?
   * 再用 Promise.race 包不消的 Promise会在超时后留下僵尸写?
   */
  private async withTimeout<T>(
    work: (signal: AbortSignal) => Promise<T>,
    ms: number,
    label: string,
    parent?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    parent?.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await work(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'aborted' || msg.includes('abort')) throw new Error(label);
        throw new Error(label);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    }
  }

  /**
   * 外源单文?job：按逻辑?fetch + 索引
   */
  private async fetchDocJob(sourceId: string, path: string, signal?: AbortSignal): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source || source.status === 'removed') return;
    if (signal?.aborted) throw new Error('aborted');
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
    if (doc) this.indexVirtualDoc(sourceId, doc, source.authRef);
  }

  private async parseOne(
    sourceId: string,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const source = this.sources.get(sourceId);
    // 防御深度：即使队污染，也?root 外的文件
    if (source && !this.sourceOwnsPath(source, filePath)) {
      throw new Error(`path not owned by source: ${filePath}`);
    }
    if (signal?.aborted) throw new Error('aborted');
    if (this.shouldSkipFile(filePath)) {
      this.index.markFileSkipped(sourceId, filePath, 'ignored_path');
      return false;
    }

    // 先确认是件：/节点不得?knowledge_files（历史上?no_adapter?
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
      // worker  DocumentPort；注?port 仅作 worker 不可用时的回
      if (isDocumentPath(filePath)) {
        return this.parseDocumentFile(sourceId, filePath, signal);
      }
      this.index.markFileSkipped(
        sourceId,
        filePath,
        'no_adapter',
        st.size,
        await this.identityKeyFor(filePath),
      );
      return false;
    }

    const kind = classifyFileKind(filePath);
    const sizeDecision = decideBySize(st.size, kind, this.fileLimits);
    if (sizeDecision.action === 'skip') {
      this.index.markFileSkipped(
        sourceId,
        filePath,
        sizeDecision.reason,
        st.size,
        await this.identityKeyFor(filePath),
      );
      return false;
    }

    // ?partial：只索引头部，全?hash 保新鲜度
    const maxTextChars = this.fileLimits.partial.maxTextChars;
    const content = await readFile(filePath, 'utf8');
    const contentHash = hashContent(content);
    if (this.index.isFresh(sourceId, filePath, contentHash)) {
      return true;
    }
    // 用前再查次：超时/后不得把僵尸结果写进索引
    if (signal?.aborted) throw new Error('aborted');
    const text =
      sizeDecision.action === 'partial' && content.length > maxTextChars
        ? `${content.slice(0, maxTextChars)}\n\ntruncated: ${content.length - maxTextChars} chars omitted]`
        : content;

    try {
      const chunks = adapter.chunk(text, filePath);
      const ident = await identifyLocalFile(filePath);
      this.index.upsertFile({
        sourceId,
        path: filePath,
        contentHash,
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        adapterId: adapter.id,
        chunks,
        identityKey: ident.key,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'aborted' || msg.startsWith('parse_timeout') || signal?.aborted) {
        throw err;
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

  /**
   * PDF/Office：DocumentPort 抽取?Markdown 后走 markdownAdapter 切块?
   * 新鲜度以原件字节 hash 为准?
   *
   * @param sourceId - 知识?id
   * @param filePath - 文件
   * @returns 成功入索?
   */
  private async parseDocumentFile(
    sourceId: string,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) throw new Error('aborted');

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
      // worker 抽取：同?xlsx/pdf 不堵主循超时/?terminate
      const result = await this.extractDocument(filePath, sourceId, st.size, signal);
      const markdown = result.markdown?.trim();
      if (!markdown) {
        this.index.markFileSkipped(sourceId, filePath, 'empty_content', st.size);
        return false;
      }
      if (signal?.aborted) throw new Error('aborted');
      const chunks = markdownAdapter.chunk(markdown, filePath);
      const ident = await identifyLocalFile(filePath);
      this.index.upsertFile({
        sourceId,
        path: filePath,
        contentHash,
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        adapterId: `document:${result.backend}`,
        chunks,
        identityKey: ident.key,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // /超时不是「这件解析失必须上抛?job ?failed止静?done
      if (msg === 'aborted' || msg.startsWith('parse_timeout') || signal?.aborted) {
        throw err;
      }
      if (isDocumentExtractError(err)) {
        // 结构化跳过（密码/老格?超大等），不挡整?
        const identKey = await this.identityKeyFor(filePath);
        this.index.markFileSkipped(
          sourceId,
          filePath,
          err.code.toLowerCase(),
          st.size,
          identKey,
        );
        return false;
      }
      this.index.markFileError(
        sourceId,
        filePath,
        err instanceof Error ? err.message : String(err),
        st.size,
        await this.identityKeyFor(filePath),
      );
      return false;
    }
  }

  /** 优先 worker 抽取；worker 不可用时回进程内 port */
  private async extractDocument(
    filePath: string,
    sourceId: string,
    fileSize = 0,
    extraSignal?: AbortSignal,
  ) {
    const sourceSignal = this.abortSignalFor(sourceId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    sourceSignal.addEventListener('abort', abort, { once: true });
    extraSignal?.addEventListener('abort', abort, { once: true });
    const signal = controller.signal;
    const timeoutMs = parseTimeoutForSize(fileSize, this.fileLimits);
    const extractOpts = {
      timeoutMs,
      // knowledge ?hardMax：软超限仍可 partial 抽取
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
        documentConfig: this.documentConfig,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'extract_aborted' || signal.aborted) {
        throw new Error('aborted');
      }
      if (msg.includes('Cannot find module') || msg.includes('ERR_MODULE')) {
        if (signal.aborted) throw new Error('aborted');
        if (this.documentPort) {
          // 必须 await：return promise 会立刻跑 finally 拆掉 abort 监听
          return await this.documentPort.extract(
            { path: filePath, name: filePath },
            { ...extractOpts, signal },
          );
        }
        throw err;
      }
      throw err;
    } finally {
      sourceSignal.removeEventListener('abort', abort);
      extraSignal?.removeEventListener('abort', abort);
    }
  }

  /**
   * Phase B：嵌入待处理 chunk
   *
   * ?job 内按 embedConcurrency ****多批调用 API?
   * 失败/超时?re-enqueue，避?job ?done ?coverage 永久卡住?
   */
  private async embedPending(sourceId: string, maxRounds = 20, jobId?: string): Promise<void> {
    await this.embedRunner.embedPending(sourceId, maxRounds, jobId);
  }

  private recordEmbedSecretHit(input: {
    sourceId: string;
    chunkId: string;
    action: string;
    hits: string[];
  }): void {
    this.sources.database.raw
      .prepare(
        `INSERT INTO knowledge_embed_secret_log (id, source_id, chunk_id, action, hits_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `kes_${randomUUID().slice(0, 12)}`,
        input.sourceId,
        input.chunkId,
        input.action,
        JSON.stringify(input.hits),
        Date.now(),
      );
  }

  /** 仍有缺向量则排队下一?embed_source（须在当?job ?done 之后调用?*/
  private ensureEmbedJob(sourceId: string): void {
    if (!this.embedding) return;
    if (this.isAborted(sourceId)) return;
    if (this.index.listChunksMissingEmbedding(sourceId, 1).length === 0) return;
    this.enqueue(sourceId, 'embed_source', null, 3);
    this.kick();
  }

  private heartbeatJob(jobId: string): void {
    this.jobQueue.heartbeat(jobId);
  }

  /** parse 完成不立刻刷 coverage（O(N) 写放大）；标脏，drain/reconcile 时合并刷?*/
  private coverageDirty = new Set<string>();

  private markCoverageDirty(sourceId: string): void {
    this.coverageDirty.add(sourceId);
  }

  private flushCoverageDirty(sourceId?: string): void {
    const ids = sourceId ? [sourceId] : [...this.coverageDirty];
    if (sourceId) this.coverageDirty.delete(sourceId);
    else this.coverageDirty.clear();
    for (const id of ids) this.refreshCoverage(id);
  }

  private refreshCoverage(sourceId: string): void {
    const stats = this.index.sourceStats(sourceId);
    const source = this.sources.get(sourceId);
    if (!source) return;
    const discovered = this.discoveredFiles.get(sourceId) ?? 0;
    // Phase A：已落库文件（indexed+skipped+error? walk 发现?
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

  /** 磁盘水位（仅，不务） */
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
          detail: `free?{Math.round(freeMb)}MB (jobs kept)`,
        });
      }
    } catch {
      // statfs 不可用时静默
    }
  }
}
