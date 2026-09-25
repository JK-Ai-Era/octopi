/**
 * KnowledgeIngest — 解析/切块/索引队列（P2 Phase A）
 *
 * 原则：ingest 与对话并发，不作 turn 同步前置；队列背压不丢任务；source 级锁。
 */

import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { FormatAdapterRegistry } from './adapters.js';
import { hashContent, KnowledgeIndexStore } from './index-store.js';
import { KnowledgeSourceStore } from './source-store.js';
import type { EmbeddingProvider } from '../memory/sqlite/embedding.js';
import type { KnowledgeSource } from './types.js';

export type IngestJobKind = 'parse_file' | 'walk_source' | 'drop_file' | 'embed_source';

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
  /** 单文件大小上限（默认 5MB；超出 skip） */
  maxFileBytes?: number;
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
  private readonly embedding: EmbeddingProvider | null;
  private readonly embedBatch: number;
  private readonly embedMinIntervalMs: number;
  private readonly embedConcurrency: number;
  private readonly diskWatermarkAlert: boolean;
  private lastEmbedAt = 0;

  private running = 0;
  private runningEmbed = 0;
  private draining = false;
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
    this.parseConcurrency = options.parseConcurrency ?? 4;
    this.maxQueueDepth = options.maxQueueDepth ?? 10_000;
    this.debounceMs = options.debounceMs ?? 2000;
    this.maxFileBytes = options.maxFileBytes ?? 5_000_000;
    this.embedding = options.embeddingProvider ?? null;
    this.embedBatch = options.embedBatch ?? 32;
    this.embedMinIntervalMs = options.embedMinIntervalMs ?? 0;
    this.embedConcurrency = options.embedConcurrency ?? options.parseConcurrency ?? 2;
    this.diskWatermarkAlert = options.diskWatermarkAlert ?? false;
  }

  get indexStore(): KnowledgeIndexStore {
    return this.index;
  }

  /**
   * 全量/增量索引某源（Phase A）
   */
  async ingestSource(sourceId: string, opts?: { full?: boolean }): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source || source.status === 'removed') {
      throw new Error(`knowledge source not found: ${sourceId}`);
    }
    if (source.kind !== 'directory' && source.kind !== 'file' && source.kind !== 'workspace') {
      // url/connector 由后续 adapter/同步策略处理
      this.sources.update(sourceId, { status: 'error', errors: [{ message: `kind ${source.kind} not supported in P2 local ingest`, at: Date.now() }] });
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

      const files = await this.walk(source.location);
      this.discoveredFiles.set(sourceId, files.length);
      if (opts?.full) {
        this.index.clearSource(sourceId);
      }

      this.sources.update(sourceId, { status: 'partial', coverage: 0 });
      this.emitProgress({
        type: 'source',
        sourceId,
        status: 'partial',
        detail: `${files.length} files`,
      });

      for (const filePath of files) {
        this.enqueue(sourceId, 'parse_file', filePath, 2, filePath);
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
   * 单文件急索（P0 快车道；同步完成 parse，不 await 全库）
   */
  async ingestFileNow(sourceId: string, filePath: string): Promise<boolean> {
    const ok = await this.parseOne(sourceId, filePath);
    this.refreshCoverage(sourceId);
    return ok;
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
        if (event === 'rename') {
          // inotify：create/move 也报 rename — 按存在性分支，勿一律 drop
          void stat(filePath)
            .then((st) => {
              if (st.isFile()) {
                this.enqueue(sourceId, 'parse_file', filePath, 1, filePath);
              } else {
                this.enqueue(sourceId, 'drop_file', filePath, 1, filePath);
              }
              this.kick();
            })
            .catch(() => {
              this.enqueue(sourceId, 'drop_file', filePath, 1, filePath);
              this.kick();
            });
          return;
        }
        this.enqueue(sourceId, 'parse_file', filePath, 1, filePath);
        this.kick();
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
        if (this.adapters.shouldSkipPath(abs)) return;
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
    while (this.running > 0 || this.hasQueuedJobs()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('knowledge ingest idle timeout');
      }
      this.kick();
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.watchers.keys()) this.stopWatch(id);
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
  ): void {
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
      if (dup?.id) return;
    } else {
      const placeholders = activeStatuses.map(() => '?').join(',');
      const dup = this.sources.database.raw
        .prepare(
          `SELECT id FROM knowledge_jobs
           WHERE source_id = ? AND kind = ? AND path IS NULL AND status IN (${placeholders})`,
        )
        .get(sourceId, kind, ...activeStatuses) as { id?: string } | undefined;
      if (dup?.id) return;
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
  }

  private kick(): void {
    if (this.disposed || this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      this.draining = false;
      this.drain();
    });
  }

  private drain(): void {
    while (this.running < this.parseConcurrency) {
      const job = this.claimJob();
      if (!job) return;
      const isEmbed = job.kind === 'embed_source';
      if (isEmbed && this.runningEmbed >= this.embedConcurrency) {
        this.sources.database.raw
          .prepare(`UPDATE knowledge_jobs SET status = 'queued' WHERE id = ? AND status = 'running'`)
          .run(job.id);
        // embed 满：本轮不再认领，避免空转把同一 job 抢来抢去
        return;
      }
      this.running += 1;
      if (isEmbed) this.runningEmbed += 1;
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
          this.running -= 1;
          if (isEmbed) this.runningEmbed -= 1;
          this.kick();
        });
    }
  }

  private claimJob(): JobRow | null {
    const row = this.sources.database.raw
      .prepare(
        `SELECT * FROM knowledge_jobs
         WHERE status = 'queued'
         ORDER BY priority ASC, created_at ASC
         LIMIT 1`,
      )
      .get() as JobRow | undefined;
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
    try {
      if (job.kind === 'parse_file' && job.path) {
        await this.parseOne(job.source_id, job.path);
        this.refreshCoverage(job.source_id);
        if (this.embedding) {
          this.enqueue(job.source_id, 'embed_source', null, 3);
          this.kick();
        }
      } else if (job.kind === 'drop_file' && job.path) {
        this.index.removeFile(job.source_id, job.path);
        this.refreshCoverage(job.source_id);
      } else if (job.kind === 'walk_source') {
        await this.ingestSource(job.source_id);
      } else if (job.kind === 'embed_source') {
        await this.embedPending(job.source_id);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sources.database.raw
        .prepare(
          `UPDATE knowledge_jobs
           SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(message, now, job.id);
      throw err;
    }
  }

  private async parseOne(sourceId: string, filePath: string): Promise<boolean> {
    if (this.adapters.shouldSkipPath(filePath)) {
      this.index.markFileSkipped(sourceId, filePath, 'ignored_path');
      return false;
    }
    const adapter = this.adapters.match(filePath);
    if (!adapter) {
      this.index.markFileSkipped(sourceId, filePath, 'no_adapter');
      return false;
    }

    let st;
    try {
      st = await stat(filePath);
    } catch {
      this.index.removeFile(sourceId, filePath);
      return false;
    }
    if (!st.isFile()) return false;
    if (st.size > this.maxFileBytes) {
      this.index.markFileSkipped(sourceId, filePath, 'oversize');
      return false;
    }

    const content = await readFile(filePath, 'utf8');
    const contentHash = hashContent(content);
    if (this.index.isFresh(sourceId, filePath, contentHash)) {
      return true;
    }

    try {
      const chunks = adapter.chunk(content, filePath);
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
      );
      return false;
    }
  }

  private async walk(root: string): Promise<string[]> {
    const out: string[] = [];
    const walkDir = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const abs = join(dir, ent.name);
        // 目录噪音在 walk 期跳过；文件交给 parse（无 adapter/二进制会记 skipped）
        if (ent.isDirectory()) {
          if (this.adapters.shouldSkipPath(abs)) continue;
          await walkDir(abs);
        } else if (ent.isFile()) {
          const base = ent.name;
          if (base === 'knowledge.db' || base.endsWith('.db')) continue;
          out.push(abs);
        }
      }
    };

    const st = await stat(root).catch(() => null);
    if (!st) return out;
    if (st.isFile()) {
      out.push(root);
      return out;
    }
    await walkDir(root);
    return out;
  }

  /**
   * Phase B：嵌入待处理 chunk（批 + 限速；失败不丢，下次再补）
   */
  private async embedPending(sourceId: string): Promise<void> {
    if (!this.embedding) return;
    const pending = this.index.listChunksMissingEmbedding(sourceId, this.embedBatch);
    if (pending.length === 0) return;

    if (this.embedMinIntervalMs > 0) {
      const wait = this.lastEmbedAt + this.embedMinIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    try {
      const vectors = await this.embedding.embedBatch(pending.map((p) => p.text));
      for (let i = 0; i < pending.length; i++) {
        const vec = vectors[i];
        if (vec?.length) this.index.setChunkEmbedding(pending[i].id, vec);
      }
      this.lastEmbedAt = Date.now();
      this.emitProgress({
        type: 'embed',
        sourceId,
        status: 'batch_done',
        detail: `embedded=${pending.length}`,
      });
    } catch (err) {
      this.emitProgress({
        type: 'error',
        sourceId,
        status: 'embed_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // 仍有 pending 则继续排队
    if (this.index.listChunksMissingEmbedding(sourceId, 1).length > 0) {
      this.enqueue(sourceId, 'embed_source', null, 3);
      this.kick();
    }
    this.refreshCoverage(sourceId);
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
