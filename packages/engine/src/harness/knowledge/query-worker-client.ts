/**
 * WorkerQueryService — Engine 侧 Query Worker RPC 客户端
 *
 * 只读操作转发到独立线程；写路径永不经过这里。
 */
import { Worker } from 'node:worker_threads';
import { resolveWorkerUrl } from '../../worker-path.js';
import type {
  KnowledgeQueryService,
  SearchQuery,
  ListSourcesQuery,
  QueryIdentity,
  PrincipalStats,
  ReadChunkResult,
  SourceStatsBundle,
  SourceDetail,
  ListJobsQuery,
  ReadySnapshot,
  QueryWorkerRole,
} from './query-service.js';
import type { PromotionCandidate } from './hit-log.js';
import type { HybridSearchResult } from './retriever.js';
import type { KnowledgeSource, KnowledgeSourceId } from './types.js';
import type { KnowledgeCatalogItem } from './catalog-types.js';
import type { IndexedFileRecord } from './index-store.js';

interface WorkerReply {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export class WorkerQueryService implements KnowledgeQueryService {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private disposed = false;
  private bootSettled = false;
  private bootResolve: (() => void) | null = null;
  private bootReject: ((e: Error) => void) | null = null;
  private readonly bootPromise: Promise<void>;

  private constructor(
    private readonly worker: Worker,
    private readonly queryTimeoutMs: number,
  ) {
    this.bootPromise = new Promise<void>((resolve, reject) => {
      this.bootResolve = resolve;
      this.bootReject = reject;
    });
    worker.on('message', (msg: WorkerReply) => {
      if (!msg || typeof msg !== 'object' || msg.id == null) return;
      // id:0 = worker 握手（ready / boot error）；勿等业务 RPC 超时才发现
      if (msg.id === 0) {
        if (this.bootSettled) return;
        this.bootSettled = true;
        if (msg.ok) this.bootResolve?.();
        else this.bootReject?.(new Error(msg.error ?? 'knowledge_query_worker_boot_failed'));
        return;
      }
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      clearTimeout(slot.timer);
      if (msg.ok) slot.resolve(msg.data);
      else slot.reject(new Error(msg.error ?? 'knowledge_query_failed'));
    });
    worker.on('error', (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!this.bootSettled) {
        this.bootSettled = true;
        this.bootReject?.(e);
      }
      this.failAll(e);
    });
    worker.on('exit', () => {
      const e = new Error('knowledge_query_worker_exit');
      if (!this.bootSettled) {
        this.bootSettled = true;
        this.bootReject?.(e);
      }
      this.failAll(e);
    });
  }

  /**
   * 启动 Query Worker。
   *
   * @param opts - dbPath / embeddingModels（provider 闭包不跨线程，Worker 内重建）
   */
  static async start(opts: {
    dbPath: string;
    sqliteVecExtensionPath?: string;
    queryTimeoutMs?: number;
    role?: QueryWorkerRole;
    embeddingModels?: {
      providers?: Record<string, unknown>;
      embedding?: unknown;
    } | null;
  }): Promise<WorkerQueryService> {
    const worker = new Worker(resolveWorkerUrl('./query-worker.js', import.meta.url), {
      workerData: {
        dbPath: opts.dbPath,
        sqliteVecExtensionPath: opts.sqliteVecExtensionPath,
        embeddingModels: opts.embeddingModels ?? null,
        role: opts.role ?? 'all',
      },
    });
    const client = new WorkerQueryService(worker, opts.queryTimeoutMs ?? 15_000);
    const bootTimer = setTimeout(() => {
      if (!client.bootSettled) {
        client.bootSettled = true;
        client.bootReject?.(new Error('knowledge_query_worker_boot_timeout'));
      }
    }, 30_000);
    try {
      await client.bootPromise;
      await client.call({ method: 'dbStats' }, 15_000);
    } finally {
      clearTimeout(bootTimer);
    }
    return client;
  }

  private failAll(err: Error): void {
    for (const [, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(err);
    }
    this.pending.clear();
  }

  private call(payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error('knowledge_query_disposed'));
    }
    const id = this.nextId++;
    const ms = timeoutMs ?? this.queryTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`knowledge_query_timeout after ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, ...payload });
    });
  }

  async search(query: SearchQuery): Promise<HybridSearchResult> {
    return (await this.call({ method: 'search', query })) as HybridSearchResult;
  }

  async listSources(query: ListSourcesQuery): Promise<KnowledgeSource[]> {
    return (await this.call({ method: 'listSources', query })) as KnowledgeSource[];
  }

  async listProjects(identity?: QueryIdentity): Promise<Array<Record<string, unknown>>> {
    return (await this.call({ method: 'listProjects', identity })) as Array<
      Record<string, unknown>
    >;
  }

  async getSource(
    sourceId: string,
    identity?: QueryIdentity,
  ): Promise<{ source: KnowledgeSource; stats: SourceStatsBundle } | null> {
    return (await this.call({ method: 'getSource', sourceId, identity })) as {
      source: KnowledgeSource;
      stats: SourceStatsBundle;
    } | null;
  }

  async listFiles(sourceId: string, identity?: QueryIdentity): Promise<IndexedFileRecord[]> {
    return (await this.call({ method: 'listFiles', sourceId, identity })) as IndexedFileRecord[];
  }

  async listFilesPaged(
    sourceId: string,
    opts?: {
      status?: 'indexed' | 'skipped' | 'error' | 'all';
      ext?: string;
      q?: string;
      page?: number;
      pageSize?: number;
    },
    identity?: QueryIdentity,
  ): Promise<{
    items: Array<IndexedFileRecord & { ext: string }>;
    total: number;
    page: number;
    pageSize: number;
    statusCounts: { indexed: number; skipped: number; error: number };
    extCounts: Array<{ ext: string; n: number }>;
  }> {
    return (await this.call({ method: 'listFilesPaged', sourceId, opts, identity })) as {
      items: Array<IndexedFileRecord & { ext: string }>;
      total: number;
      page: number;
      pageSize: number;
      statusCounts: { indexed: number; skipped: number; error: number };
      extCounts: Array<{ ext: string; n: number }>;
    };
  }

  async principalStats(agentId: string, identity?: QueryIdentity): Promise<PrincipalStats> {
    return (await this.call({ method: 'principalStats', agentId, identity })) as PrincipalStats;
  }

  async catalog(agentId: string, identity?: QueryIdentity): Promise<KnowledgeCatalogItem[]> {
    return (await this.call({ method: 'catalog', agentId, identity })) as KnowledgeCatalogItem[];
  }

  async listChunks(
    agentId: string,
    sourceId: string,
    path: string,
    identity?: QueryIdentity,
    sessionId?: string,
  ): Promise<
    | Array<{ id: string; text: string; startLine: number; endLine: number; ordinal: number; path: string }>
    | null
  > {
    return (await this.call({
      method: 'listChunks',
      agentId,
      sourceId,
      path,
      identity,
      sessionId,
    })) as Array<{
      id: string;
      text: string;
      startLine: number;
      endLine: number;
      ordinal: number;
      path: string;
    }> | null;
  }

  async read(
    agentId: string,
    body: { chunkId?: string; sourceId?: string; path?: string },
    identity?: QueryIdentity,
    sessionId?: string,
  ): Promise<ReadChunkResult> {
    return (await this.call({ method: 'read', agentId, body, identity, sessionId })) as ReadChunkResult;
  }

  async visibility(
    agentId: string,
    identity?: QueryIdentity,
  ): Promise<{ assignedProjects: string[]; hiddenSourceIds: string[] }> {
    return (await this.call({ method: 'visibility', agentId, identity })) as {
      assignedProjects: string[];
      hiddenSourceIds: string[];
    };
  }

  async sessionVisibility(
    agentId: string,
    sessionId: string,
    identity?: QueryIdentity,
  ): Promise<Array<Record<string, unknown>>> {
    return (await this.call({
      method: 'sessionVisibility',
      agentId,
      sessionId,
      identity,
    })) as Array<Record<string, unknown>>;
  }

  async dbStats(): Promise<Record<string, number>> {
    return (await this.call({ method: 'dbStats' })) as Record<string, number>;
  }

  async getSourceDetail(
    sourceId: string,
    identity?: QueryIdentity,
  ): Promise<SourceDetail | null> {
    return (await this.call({ method: 'getSourceDetail', sourceId, identity })) as SourceDetail | null;
  }

  async getPrincipal(
    identity: QueryIdentity,
    agentId: string,
  ): Promise<Record<string, unknown> | null> {
    return (await this.call({ method: 'getPrincipal', identity, agentId })) as Record<
      string,
      unknown
    > | null;
  }

  async isPrincipalForeign(identity: QueryIdentity, agentId: string): Promise<boolean> {
    return (await this.call({ method: 'isPrincipalForeign', identity, agentId })) as boolean;
  }

  async isSourceOwner(sourceId: string, gatewayId: string): Promise<boolean> {
    return (await this.call({ method: 'isSourceOwner', sourceId, gatewayId })) as boolean;
  }

  async ready(): Promise<ReadySnapshot> {
    return (await this.call({ method: 'ready' })) as ReadySnapshot;
  }

  async listJobs(query: ListJobsQuery): Promise<Array<Record<string, unknown>>> {
    return (await this.call({ method: 'listJobs', query })) as Array<Record<string, unknown>>;
  }

  async promotionCandidates(): Promise<PromotionCandidate[]> {
    return (await this.call({ method: 'promotionCandidates' })) as PromotionCandidate[];
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    // 必须先发 shutdown 再置 disposed：call() 在 disposed 后会立刻 reject
    try {
      await this.call({ method: 'shutdown' }, 5_000);
    } catch {
      /* worker 可能已退 */
    }
    this.disposed = true;
    this.failAll(new Error('knowledge_query_disposed'));
    await this.worker.terminate();
  }
}
