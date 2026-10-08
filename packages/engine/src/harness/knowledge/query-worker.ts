/**
 * Query Worker — Knowledge 只读查询线程
 *
 * 独立 DatabaseSync 连接 + WAL：Engine 写事务阻塞时本线程仍可应答 search/list/stats。
 * 无任何写路径。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { KnowledgeDatabase } from './db.js';
import { KnowledgeSourceStore } from './source-store.js';
import { KnowledgeIndexStore } from './index-store.js';
import { KnowledgeRetriever } from './retriever.js';
import {
  LocalKnowledgeQueryService,
  type SearchQuery,
  type ListSourcesQuery,
  type QueryIdentity,
  type ListJobsQuery,
  type QueryWorkerRole,
} from './query-service.js';

interface QueryBoot {
  dbPath: string;
  sqliteVecExtensionPath?: string;
  role?: QueryWorkerRole;
  embeddingModels?: {
    providers?: Record<string, unknown>;
    embedding?: unknown;
  } | null;
}

/** meta：列表/控制面（UI 轮询必须稳）；search：检索/catalog（可慢） */
const META_METHODS = new Set([
  'listProjects',
  'listSources',
  'getSource',
  'getSourceDetail',
  'getPrincipal',
  'isPrincipalForeign',
  'isSourceOwner',
  'ready',
  'listJobs',
  'jobControlState',
  'visibility',
  'sessionVisibility',
  'dbStats',
  'promotionCandidates',
]);

const SEARCH_METHODS = new Set([
  'search',
  'catalog',
  'listChunks',
  'read',
  'listFiles',
  'listFilesPaged',
  'principalStats',
  // boot 握手探活（WorkerQueryService.start）
  'dbStats',
]);

type QueryCall =
  | { id: number; method: 'search'; query: SearchQuery }
  | { id: number; method: 'listSources'; query: ListSourcesQuery }
  | { id: number; method: 'listProjects'; identity?: QueryIdentity }
  | { id: number; method: 'getSource'; sourceId: string; identity?: QueryIdentity }
  | { id: number; method: 'listFiles'; sourceId: string; identity?: QueryIdentity }
  | {
      id: number;
      method: 'listFilesPaged';
      sourceId: string;
      opts?: {
        status?: 'indexed' | 'skipped' | 'error' | 'all';
        ext?: string;
        q?: string;
        page?: number;
        pageSize?: number;
      };
      identity?: QueryIdentity;
    }
  | { id: number; method: 'principalStats'; agentId: string; identity?: QueryIdentity }
  | { id: number; method: 'catalog'; agentId: string; identity?: QueryIdentity }
  | {
      id: number;
      method: 'listChunks';
      agentId: string;
      sourceId: string;
      path: string;
      identity?: QueryIdentity;
      sessionId?: string;
    }
  | {
      id: number;
      method: 'read';
      agentId: string;
      body: { chunkId?: string; sourceId?: string; path?: string };
      identity?: QueryIdentity;
      sessionId?: string;
    }
  | { id: number; method: 'visibility'; agentId: string; identity?: QueryIdentity }
  | {
      id: number;
      method: 'sessionVisibility';
      agentId: string;
      sessionId: string;
      identity?: QueryIdentity;
    }
  | { id: number; method: 'dbStats' }
  | { id: number; method: 'getSourceDetail'; sourceId: string; identity?: QueryIdentity }
  | { id: number; method: 'getPrincipal'; identity: QueryIdentity; agentId: string }
  | { id: number; method: 'isPrincipalForeign'; identity: QueryIdentity; agentId: string }
  | { id: number; method: 'isSourceOwner'; sourceId: string; gatewayId: string }
  | { id: number; method: 'ready' }
  | { id: number; method: 'listJobs'; query: ListJobsQuery }
  | { id: number; method: 'promotionCandidates' }
  | { id: number; method: 'shutdown' };

async function main(): Promise<void> {
  const boot = workerData as QueryBoot;
  const port = parentPort;
  if (!port) throw new Error('knowledge query worker requires parentPort');
  const role: QueryWorkerRole = boot.role ?? 'all';
  const allowed =
    role === 'meta'
      ? META_METHODS
      : role === 'search'
        ? SEARCH_METHODS
        : new Set([...META_METHODS, ...SEARCH_METHODS]);

  // 只读连接：跳过 DDL，不与 Writer 争写锁；唯一写者是 Writer Worker
  const db = await KnowledgeDatabase.create({
    dbPath: boot.dbPath,
    readOnly: true,
    skipMigrate: true,
    sqliteVec: boot.sqliteVecExtensionPath
      ? { extensionPath: boot.sqliteVecExtensionPath }
      : true,
  });

  let embeddingProvider: unknown = null;
  if (boot.embeddingModels) {
    const { resolveEmbeddingRuntime } = await import(
      '../memory/sqlite/embedding-from-models.js'
    );
    const runtime = resolveEmbeddingRuntime(
      boot.embeddingModels as Parameters<typeof resolveEmbeddingRuntime>[0],
    );
    embeddingProvider = runtime?.provider ?? null;
  }

  const sources = new KnowledgeSourceStore(db);
  const index = new KnowledgeIndexStore(db);
  const retriever = new KnowledgeRetriever({
    sourceStore: sources,
    indexStore: index,
    embeddingProvider: embeddingProvider as never,
  });
  const svc = new LocalKnowledgeQueryService({
    db,
    sources,
    index,
    retriever,
    embeddingEnabled: Boolean(embeddingProvider),
  });

  port.on('message', (msg: QueryCall) => {
    void (async () => {
      const id = msg?.id;
      if (id == null) return;
      try {
        let data: unknown;
        if (msg.method === 'shutdown') {
          try {
            db.close();
          } catch {
            /* already closed */
          }
          port.postMessage({ id, ok: true, data: null });
          port.close();
          return;
        }
        if (!allowed.has(msg.method)) {
          throw new Error(`query_method_not_in_role:${msg.method}:${role}`);
        }
        switch (msg.method) {
          case 'search':
            data = await svc.search(msg.query);
            break;
          case 'listSources':
            data = await svc.listSources(msg.query);
            break;
          case 'listProjects':
            data = await svc.listProjects(msg.identity);
            break;
          case 'getSource':
            data = await svc.getSource(msg.sourceId, msg.identity);
            break;
          case 'listFiles':
            data = await svc.listFiles(msg.sourceId, msg.identity);
            break;
          case 'listFilesPaged':
            data = await svc.listFilesPaged(msg.sourceId, msg.opts, msg.identity);
            break;
          case 'principalStats':
            data = await svc.principalStats(msg.agentId, msg.identity);
            break;
          case 'catalog':
            data = await svc.catalog(msg.agentId, msg.identity);
            break;
          case 'listChunks':
            data = await svc.listChunks(msg.agentId, msg.sourceId, msg.path, msg.identity, msg.sessionId);
            break;
          case 'read':
            data = await svc.read(msg.agentId, msg.body, msg.identity, msg.sessionId);
            break;
          case 'visibility':
            data = await svc.visibility(msg.agentId, msg.identity);
            break;
          case 'sessionVisibility':
            data = await svc.sessionVisibility(msg.agentId, msg.sessionId, msg.identity);
            break;
          case 'dbStats':
            data = await svc.dbStats();
            break;
          case 'getSourceDetail':
            data = await svc.getSourceDetail(msg.sourceId, msg.identity);
            break;
          case 'getPrincipal':
            data = await svc.getPrincipal(msg.identity, msg.agentId);
            break;
          case 'isPrincipalForeign':
            data = await svc.isPrincipalForeign(msg.identity, msg.agentId);
            break;
          case 'isSourceOwner':
            data = await svc.isSourceOwner(msg.sourceId, msg.gatewayId);
            break;
          case 'ready':
            data = await svc.ready();
            break;
          case 'listJobs':
            data = await svc.listJobs(msg.query);
            break;
          case 'promotionCandidates':
            data = await svc.promotionCandidates();
            break;
          default:
            throw new Error(`unknown_query_method`);
        }
        port.postMessage({ id, ok: true, data });
      } catch (err) {
        port.postMessage({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  port.postMessage({ id: 0, ok: true, data: { type: 'ready' } });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  parentPort?.postMessage({ id: 0, ok: false, error: message });
});
