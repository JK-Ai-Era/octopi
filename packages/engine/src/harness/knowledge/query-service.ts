/**
 * KnowledgeQueryService — 只读查询面（search / list / stats / catalog…）
 *
 * 生产：Query Worker + 独立只读连接（WAL 一写多读），与 ingest 写路径线程分离。
 * 测试 / :memory:：LocalKnowledgeQueryService（同连接，小库可接受）。
 *
 * **禁止**在此接口上实现任何写路径（唯一写者是 Writer Worker / LocalKnowledgeWriteService）。
 */

import type { KnowledgeDatabase } from './db.js';
import type { KnowledgeSourceStore } from './source-store.js';
import type { KnowledgeIndexStore, IndexedFileRecord } from './index-store.js';
import type {
  KnowledgeRetriever,
  HybridSearchResult,
  AutoGroundDecision,
  KnowledgeRecallMode,
} from './retriever.js';
import type { KnowledgeSource, KnowledgeSourceId } from './types.js';
import type { KnowledgeCatalogItem } from './catalog-types.js';
import {
  readJobControlState,
  type KnowledgeJobControlState,
} from './job-control-state.js';
import { KnowledgeHitLog, type PromotionCandidate } from './hit-log.js';

export interface QueryIdentity {
  tenantId?: string;
  gatewayId?: string;
}

export interface SearchQuery {
  agentId: string;
  q: string;
  sessionId?: string;
  limit?: number;
  keywordOnly?: boolean;
  sourceIds?: string[];
  source?: string;
  identity?: QueryIdentity;
}

export interface AutoGroundQuery {
  agentId: string;
  q: string;
  sessionId?: string;
  limit?: number;
  /** 覆盖全局/实例 recall */
  recall?: KnowledgeRecallMode;
  identity?: QueryIdentity;
}

export interface ListSourcesQuery {
  scopeLevel?: 'global' | 'project' | 'session';
  projectKey?: string;
  sessionId?: string;
  /** 管理面全量（不过滤 agent 可见）+ gateway 可见 */
  identity?: QueryIdentity;
  agentId?: string;
}

export interface SourceStatsBundle {
  files: number;
  chunks: number;
  embeddableChunks: number;
  embeddings: number;
  errors: number;
  skipped: number;
}

export interface SourceDetail {
  source: KnowledgeSource;
  stats: SourceStatsBundle;
  jobControl: KnowledgeJobControlState;
  assignedAgentIds: string[];
  hiddenForAgentIds: string[];
}

export interface ListJobsQuery {
  identity: QueryIdentity;
  sourceId?: string;
  status?: string;
  limit?: number;
}

export interface ReadySnapshot {
  ready: true;
  sqliteVec: boolean;
  fts: boolean;
  ftsBackfill: { running: boolean; pendingChunks: number };
  stats: Record<string, number>;
}

export interface PrincipalStats {
  stats: Record<string, number>;
  visibility: {
    assignedProjects: string[];
    hiddenSourceIds: string[];
  };
  visibleSources: number;
}

export interface ReadChunkResult {
  found: boolean;
  path?: string;
  startLine?: number;
  endLine?: number;
  text?: string;
  chunkCount?: number;
  chunks?: Array<{
    id: string;
    text: string;
    startLine: number;
    endLine: number;
    ordinal: number;
    path: string;
  }>;
}

/**
 * 只读查询门面。实现必须无写副作用。
 */
export interface KnowledgeQueryService {
  search(query: SearchQuery): Promise<HybridSearchResult>;
  /** turn 级自动召回分档（GroundingAssembler / client grounding） */
  autoGround(query: AutoGroundQuery): Promise<AutoGroundDecision>;
  listSources(query: ListSourcesQuery): Promise<KnowledgeSource[]>;
  listProjects(identity?: QueryIdentity): Promise<Array<Record<string, unknown>>>;
  getSource(
    sourceId: string,
    identity?: QueryIdentity,
  ): Promise<{ source: KnowledgeSource; stats: SourceStatsBundle } | null>;
  listFiles(sourceId: string, identity?: QueryIdentity): Promise<IndexedFileRecord[]>;
  listFilesPaged(
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
  }>;
  principalStats(
    agentId: string,
    identity?: QueryIdentity,
  ): Promise<PrincipalStats>;
  catalog(agentId: string, identity?: QueryIdentity): Promise<KnowledgeCatalogItem[]>;
  listChunks(
    agentId: string,
    sourceId: string,
    path: string,
    identity?: QueryIdentity,
    sessionId?: string,
  ): Promise<
    | Array<{ id: string; text: string; startLine: number; endLine: number; ordinal: number; path: string }>
    | null
  >;
  read(
    agentId: string,
    body: { chunkId?: string; sourceId?: string; path?: string },
    identity?: QueryIdentity,
    sessionId?: string,
  ): Promise<ReadChunkResult>;
  visibility(
    agentId: string,
    identity?: QueryIdentity,
  ): Promise<{ assignedProjects: string[]; hiddenSourceIds: string[] }>;
  sessionVisibility(
    agentId: string,
    sessionId: string,
    identity?: QueryIdentity,
  ): Promise<Array<Record<string, unknown>>>;
  dbStats(): Promise<Record<string, number>>;
  /** 源详情（stats + jobControl + 项目/隐藏 agent）— 禁止走写连接 */
  getSourceDetail(
    sourceId: string,
    identity?: QueryIdentity,
  ): Promise<SourceDetail | null>;
  getPrincipal(
    identity: QueryIdentity,
    agentId: string,
  ): Promise<Record<string, unknown> | null>;
  /** 是否被**其他** gateway 登记了同名 principal（只读鉴权用） */
  isPrincipalForeign(identity: QueryIdentity, agentId: string): Promise<boolean>;
  isSourceOwner(sourceId: string, gatewayId: string): Promise<boolean>;
  ready(): Promise<ReadySnapshot>;
  listJobs(query: ListJobsQuery): Promise<Array<Record<string, unknown>>>;
  promotionCandidates(): Promise<PromotionCandidate[]>;
  dispose(): Promise<void> | void;
}

export interface LocalQueryDeps {
  db: KnowledgeDatabase;
  sources: KnowledgeSourceStore;
  index: KnowledgeIndexStore;
  retriever: KnowledgeRetriever;
  /** jobControl.embedMissing 语义：无 embedding provider 时应 false */
  embeddingEnabled?: boolean;
}

/**
 * 进程内只读实现（测试 / 共享 :memory:）。
 * 与 Worker 实现同接口；生产 Engine 线程应使用 Worker 以隔离写阻塞。
 */
export class LocalKnowledgeQueryService implements KnowledgeQueryService {
  constructor(private readonly deps: LocalQueryDeps) {}

  async search(query: SearchQuery): Promise<HybridSearchResult> {
    return this.deps.retriever.search(query.q, {
      agentId: query.agentId,
      sessionId: query.sessionId,
      limit: query.limit,
      keywordOnly: query.keywordOnly,
      tenantId: query.identity?.tenantId,
      gatewayId: query.identity?.gatewayId,
      sourceIds: query.sourceIds,
      source: query.source,
    });
  }

  async autoGround(query: AutoGroundQuery): Promise<AutoGroundDecision> {
    return this.deps.retriever.autoGround(query.q, {
      agentId: query.agentId,
      sessionId: query.sessionId,
      limit: query.limit,
      tenantId: query.identity?.tenantId,
      gatewayId: query.identity?.gatewayId,
      ...(query.recall ? { recall: query.recall } : {}),
    });
  }

  async listSources(query: ListSourcesQuery): Promise<KnowledgeSource[]> {
    const { sources } = this.deps;
    let list = sources.list();
    if (query.identity) {
      list = list.filter((s) => this.gatewayVisible(s, query.identity!));
    }
    if (query.scopeLevel === 'global' || query.scopeLevel === 'project' || query.scopeLevel === 'session') {
      list = list.filter((s) => s.scopeRef.level === query.scopeLevel);
    }
    if (query.projectKey != null && query.projectKey !== '') {
      list = list.filter((s) => s.scopeRef.key === query.projectKey);
    }
    if (query.sessionId != null && query.sessionId !== '') {
      list = list.filter((s) => {
        if (s.scopeRef.level === 'session') return s.scopeRef.key === query.sessionId;
        return true;
      });
    }
    return list;
  }

  async listProjects(identity?: QueryIdentity): Promise<Array<Record<string, unknown>>> {
    return this.deps.sources.listProjects({
      tenantId: identity?.tenantId,
      gatewayId: identity?.gatewayId,
    }) as unknown as Array<Record<string, unknown>>;
  }

  async getSource(
    sourceId: string,
    identity?: QueryIdentity,
  ): Promise<{ source: KnowledgeSource; stats: SourceStatsBundle } | null> {
    const src = this.deps.sources.get(sourceId);
    if (!src) return null;
    if (identity && !this.gatewayVisible(src, identity)) return null;
    return { source: src, stats: this.deps.index.sourceStats(sourceId) };
  }

  async listFiles(sourceId: string, identity?: QueryIdentity): Promise<IndexedFileRecord[]> {
    if (identity) {
      const src = this.deps.sources.get(sourceId);
      if (!src || !this.gatewayVisible(src, identity)) return [];
    }
    return this.deps.index.listFiles(sourceId);
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
    if (identity) {
      const src = this.deps.sources.get(sourceId);
      if (!src || !this.gatewayVisible(src, identity)) {
        return {
          items: [],
          total: 0,
          page: opts?.page ?? 1,
          pageSize: opts?.pageSize ?? 50,
          statusCounts: { indexed: 0, skipped: 0, error: 0 },
          extCounts: [],
        };
      }
    }
    return this.deps.index.listFilesPaged(sourceId, opts);
  }

  async principalStats(agentId: string, identity?: QueryIdentity): Promise<PrincipalStats> {
    const { sources, db } = this.deps;
    const visible = sources.listVisible(agentId, undefined, identity).filter((s) => {
      return !identity || this.gatewayVisible(s, identity);
    });
    const stats = db.stats();
    return {
      stats,
      visibility: {
        assignedProjects: sources
          .list()
          .filter(
            (s) =>
              s.scopeRef.level === 'project' &&
              sources.isVisible(s, agentId, undefined, identity) &&
              (!identity || this.gatewayVisible(s, identity)),
          )
          .map((s) => s.scopeRef.key),
        hiddenSourceIds: sources.listHidden(agentId, identity ?? {}),
      },
      visibleSources: visible.length,
    };
  }

  async catalog(agentId: string, identity?: QueryIdentity): Promise<KnowledgeCatalogItem[]> {
    const items = this.deps.sources.catalogFor(agentId, { identity });
    if (!identity) return items;
    return items.filter((item) => {
      const src = this.deps.sources.get(item.id as KnowledgeSourceId);
      return !src || this.gatewayVisible(src, identity);
    });
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
    const { sources, index } = this.deps;
    const src = sources.get(sourceId);
    if (!src) return null;
    if (identity && !this.gatewayVisible(src, identity)) return null;
    if (!sources.isVisible(src, agentId, sessionId, identity)) return null;
    return index.listChunksByPath(sourceId, path);
  }

  async read(
    agentId: string,
    body: { chunkId?: string; sourceId?: string; path?: string },
    identity?: QueryIdentity,
    sessionId?: string,
  ): Promise<ReadChunkResult> {
    const { sources, index } = this.deps;
    const visible = (src: KnowledgeSource | null): boolean => {
      if (!src) return false;
      if (identity && !this.gatewayVisible(src, identity)) return false;
      return sources.isVisible(src, agentId, sessionId, identity);
    };
    if (body.chunkId) {
      const row = index.getChunk(body.chunkId);
      if (!row) return { found: false };
      const src = sources.get(row.sourceId as KnowledgeSourceId);
      if (!visible(src)) return { found: false };
      return {
        found: true,
        path: row.path,
        startLine: row.startLine,
        endLine: row.endLine,
        text: row.text,
      };
    }
    if (!body.sourceId || !body.path) return { found: false };
    const src = sources.get(body.sourceId);
    if (!visible(src)) return { found: false };
    const chunks = index.listChunksByPath(body.sourceId, body.path);
    return {
      found: chunks.length > 0,
      path: body.path,
      chunkCount: chunks.length,
      text: chunks.map((c) => c.text).join('\n\n'),
      chunks: chunks.map((c) => ({
        id: c.id,
        text: c.text,
        startLine: c.startLine,
        endLine: c.endLine,
        ordinal: c.ordinal,
        path: c.path,
      })),
    };
  }

  async visibility(
    agentId: string,
    identity?: QueryIdentity,
  ): Promise<{ assignedProjects: string[]; hiddenSourceIds: string[] }> {
    const { sources } = this.deps;
    const assigned = sources
      .list()
      .filter(
        (s) =>
          s.scopeRef.level === 'project' &&
          sources.isVisible(s, agentId, undefined, identity) &&
          (!identity || this.gatewayVisible(s, identity)),
      )
      .map((s) => s.scopeRef.key);
    return {
      assignedProjects: [...new Set(assigned)],
      hiddenSourceIds: sources.listHidden(agentId, identity ?? {}),
    };
  }

  async sessionVisibility(
    agentId: string,
    sessionId: string,
    identity?: QueryIdentity,
  ): Promise<Array<Record<string, unknown>>> {
    void agentId;
    const list = this.deps.sources.listSessionVisibility(sessionId, identity);
    if (!identity) return list as unknown as Array<Record<string, unknown>>;
    return (list as Array<{ targetId: string; targetType: string }>).filter((item) => {
      if (item.targetType !== 'source') return true;
      const src = this.deps.sources.get(item.targetId);
      return !src || this.gatewayVisible(src, identity);
    }) as unknown as Array<Record<string, unknown>>;
  }

  async dbStats(): Promise<Record<string, number>> {
    return this.deps.db.stats();
  }

  async getSourceDetail(
    sourceId: string,
    identity?: QueryIdentity,
  ): Promise<SourceDetail | null> {
    const { sources, index, db } = this.deps;
    const src = sources.get(sourceId);
    if (!src) return null;
    if (identity && !this.gatewayVisible(src, identity)) return null;
    const jobControl = readJobControlState(db, index, sourceId, {
      embeddingEnabled: this.deps.embeddingEnabled ?? true,
    });
    return {
      source: src,
      stats: index.sourceStats(sourceId),
      jobControl,
      assignedAgentIds:
        src.scopeRef.level === 'project'
          ? sources.listProjectAgents(src.scopeRef.key, identity)
          : [],
      hiddenForAgentIds: sources.listAgentsHidingSource(sourceId, identity),
    };
  }

  async getPrincipal(
    identity: QueryIdentity,
    agentId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = this.deps.db.raw
      .prepare(
        `SELECT * FROM knowledge_principals
         WHERE tenant_id = ? AND gateway_id = ? AND local_agent_id = ?`,
      )
      .get(identity.tenantId ?? 'default', identity.gatewayId ?? 'default', agentId) as
      | Record<string, unknown>
      | undefined;
    return row ?? null;
  }

  async isPrincipalForeign(identity: QueryIdentity, agentId: string): Promise<boolean> {
    const row = this.deps.db.raw
      .prepare(
        `SELECT 1 AS ok FROM knowledge_principals
         WHERE tenant_id = ? AND local_agent_id = ? AND gateway_id != ?
         LIMIT 1`,
      )
      .get(
        identity.tenantId ?? 'default',
        agentId,
        identity.gatewayId ?? 'default',
      ) as { ok?: number } | undefined;
    return Boolean(row);
  }

  async isSourceOwner(sourceId: string, gatewayId: string): Promise<boolean> {
    const row = this.deps.db.raw
      .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string } | undefined;
    if (!row) return false;
    if (row.registered_by && row.registered_by !== gatewayId) return false;
    return true;
  }

  async ready(): Promise<ReadySnapshot> {
    const { db, index } = this.deps;
    const stats = db.stats();
    const chunks = Number(stats.chunks ?? 0);
    const ftsRows = Number(stats.ftsChunks ?? 0);
    return {
      ready: true,
      sqliteVec: db.sqliteVecEnabled,
      fts: index.ftsAvailable,
      ftsBackfill: {
        running: index.ftsBackfillRunning,
        pendingChunks: Math.max(0, chunks - ftsRows),
      },
      stats,
    };
  }

  async listJobs(query: ListJobsQuery): Promise<Array<Record<string, unknown>>> {
    const where: string[] = [
      `source_id IN (SELECT id FROM knowledge_sources WHERE tenant_id = ? AND (registered_by = ? OR visibility = 'public'))`,
    ];
    const args: unknown[] = [query.identity.tenantId ?? 'default', query.identity.gatewayId ?? 'default'];
    if (query.sourceId) {
      where.push('source_id = ?');
      args.push(query.sourceId);
    }
    if (query.status) {
      where.push('status = ?');
      args.push(query.status);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
    return this.deps.db.raw
      .prepare(
        `SELECT * FROM knowledge_jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...(args as never[]), limit) as Array<Record<string, unknown>>;
  }

  async promotionCandidates(): Promise<PromotionCandidate[]> {
    return new KnowledgeHitLog(this.deps.db).promotionCandidates();
  }

  dispose(): void {
    /* 只读；连接由调用方持有 */
  }

  private gatewayVisible(src: { id: string; registeredBy?: string }, identity: QueryIdentity): boolean {
    const row = this.deps.db.raw
      .prepare('SELECT registered_by, visibility FROM knowledge_sources WHERE id = ?')
      .get(src.id) as { registered_by?: string; visibility?: string } | undefined;
    if (!row) return true;
    if (!identity.gatewayId) return true;
    if (row.registered_by === identity.gatewayId) return true;
    return row.visibility === 'public';
  }
}

/**
 * 组装只读服务。
 *
 * - `mode: 'worker'`：文件库 + 独立线程（生产 Engine）；WAL 一写多读，与 ingest 写隔离。
 * - `mode: 'local'`：同连接进程内实现。**`:memory:` 必须用 local**——内存库无法跨连接共享，
 *   Worker 会各自打开空库导致检索为空。
 *
 * @param opts - dbPath / 本地 deps / embeddingModels（Worker 内重建 provider）
 */
export type QueryWorkerRole = 'meta' | 'search' | 'all';

export async function createKnowledgeQueryService(opts: {
  dbPath: string;
  mode: 'worker' | 'local';
  local?: LocalQueryDeps;
  embeddingModels?: {
    providers?: Record<string, unknown>;
    embedding?: unknown;
  } | null;
  sqliteVecExtensionPath?: string;
  /** Worker 角色：meta=列表/控制面，search=检索/catalog，all=单 Worker 全量 */
  role?: QueryWorkerRole;
  queryTimeoutMs?: number;
}): Promise<KnowledgeQueryService> {
  if (opts.mode === 'local' || opts.dbPath === ':memory:') {
    if (!opts.local) throw new Error('local query service requires local deps');
    return new LocalKnowledgeQueryService(opts.local);
  }
  const { WorkerQueryService } = await import('./query-worker-client.js');
  return WorkerQueryService.start({
    dbPath: opts.dbPath,
    embeddingModels: opts.embeddingModels ?? null,
    sqliteVecExtensionPath: opts.sqliteVecExtensionPath,
    role: opts.role ?? 'all',
    queryTimeoutMs: opts.queryTimeoutMs,
  });
}
