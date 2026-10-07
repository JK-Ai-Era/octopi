/**
 * Knowledge Service HTTP — 契约 arch/knowledge-service-http.md v2.1
 *
 * 唯一写者；鉴权 token → (tenantId, gatewayId)；业务键不用 body 伪造。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { KnowledgeDatabase } from './db.js';
import { KnowledgeSourceStore } from './source-store.js';
import { KnowledgeIndexStore } from './index-store.js';
import { MembershipStore } from './membership-store.js';
import { KnowledgeIngest } from './ingest.js';
import { KnowledgeRetriever } from './retriever.js';
import { KnowledgeHitLog } from './hit-log.js';
import { generateKnowledgeDescription } from './describe.js';
import { matchKnowledgeToken } from './http-bridge.js';

export interface KnowledgeServiceToken {
  token: string;
  tenantId: string;
  gatewayId: string;
}

export interface KnowledgeServiceOptions {
  db: KnowledgeDatabase;
  tokens: KnowledgeServiceToken[];
  /** 单机 dev：未注册 principal 自动建 */
  autoRegisterPrincipals?: boolean;
  /** documents.* — Document 抽取/legacy 与 Gateway 同源 */
  documentConfig?: import('../capabilities/document/factory.js').DocumentCapabilityConfig | null;
  /** Phase B embedding；未配则 embed_source 不写向量 */
  embeddingProvider?: import('../memory/sqlite/embedding.js').EmbeddingProvider | null;
  embed?: {
    enabled?: boolean;
    embedBatch?: number;
    embedMinIntervalMs?: number;
    embedConcurrency?: number;
    embedSecretPolicy?: 'allow' | 'redact' | 'skip';
  } | null;
}

export interface AuthContext {
  tenantId: string;
  gatewayId: string;
  agentId?: string;
  sessionId?: string;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthContext,
  params: Record<string, string>,
  body: unknown,
) => Promise<void> | void;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.byteLength,
  });
  res.end(buf);
}

function err(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  json(res, status, {
    error: { code, message, details },
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export class KnowledgeHttpApp {
  private readonly routes: Route[] = [];

  constructor(private readonly opts: KnowledgeServiceOptions) {
    this.registerRoutes();
  }

  private get db(): KnowledgeDatabase {
    return this.opts.db;
  }

  private sources = new Map<string, KnowledgeSourceStore>();
  private indexes = new Map<string, KnowledgeIndexStore>();
  private memberships = new Map<string, MembershipStore>();
  private ingests = new Map<string, KnowledgeIngest>();
  private retrievers = new Map<string, KnowledgeRetriever>();

  /** 懒绑定（单库单实例即可；键保留扩展空间） */
  private bundle(key = 'default'): {
    sources: KnowledgeSourceStore;
    index: KnowledgeIndexStore;
    memberships: MembershipStore;
    ingest: KnowledgeIngest;
    retriever: KnowledgeRetriever;
  } {
    let sources = this.sources.get(key);
    if (!sources) {
      sources = new KnowledgeSourceStore(this.db);
      this.sources.set(key, sources);
    }
    let index = this.indexes.get(key);
    if (!index) {
      index = new KnowledgeIndexStore(this.db);
      this.indexes.set(key, index);
    }
    let memberships = this.memberships.get(key);
    if (!memberships) {
      memberships = new MembershipStore(this.db);
      this.memberships.set(key, memberships);
    }
    let ingest = this.ingests.get(key);
    if (!ingest) {
      // 生产路径只给 documentConfig：抽取走 extractDocumentInWorker（CPU 隔离）
      // documentPort 留给测试/宿主注入自定义后端，不在 Service 内再拼一份进程内 port
      const embed = this.opts.embed ?? null;
      ingest = new KnowledgeIngest({
        sourceStore: sources,
        indexStore: index,
        documentConfig: this.opts.documentConfig ?? null,
        embeddingProvider: embed?.enabled === false ? null : (this.opts.embeddingProvider ?? null),
        ...(embed?.embedBatch != null ? { embedBatch: embed.embedBatch } : {}),
        ...(embed?.embedMinIntervalMs != null
          ? { embedMinIntervalMs: embed.embedMinIntervalMs }
          : {}),
        ...(embed?.embedConcurrency != null ? { embedConcurrency: embed.embedConcurrency } : {}),
        ...(embed?.embedSecretPolicy != null
          ? { embedSecretPolicy: embed.embedSecretPolicy }
          : {}),
      });
      this.ingests.set(key, ingest);
    }
    let retriever = this.retrievers.get(key);
    if (!retriever) {
      retriever = new KnowledgeRetriever({ sourceStore: sources, indexStore: index });
      this.retrievers.set(key, retriever);
    }
    return { sources, index, memberships, ingest, retriever };
  }

  private route(method: string, pattern: string, handler: Handler): void {
    const keys: string[] = [];
    const rx = pattern.replace(/:([a-zA-Z]+)/g, (_m, name: string) => {
      keys.push(name);
      return '([^/]+)';
    });
    this.routes.push({
      method,
      regex: new RegExp(`^${rx}$`),
      keys,
      handler,
    });
  }

  private registerRoutes(): void {
    this.route('GET', '/health', (_req, res) => {
      json(res, 200, { ok: true, service: 'knowledge', version: '0.60.0' });
    });

    this.route('GET', '/v1/ready', (_req, res) => {
      const { index } = this.bundle();
      const stats = this.db.stats();
      const chunks = Number(stats.chunks ?? 0);
      const ftsRows = Number(stats.ftsChunks ?? 0);
      json(res, 200, {
        ready: true,
        sqliteVec: this.db.sqliteVecEnabled,
        fts: index.ftsAvailable,
        ftsBackfill: {
          running: index.ftsBackfillRunning,
          pendingChunks: Math.max(0, chunks - ftsRows),
        },
        writeLocked: false,
        stats,
      });
    });

    this.route('PUT', '/v1/principals/:agentId', (req, res, ctx, params, body) => {
      const agentId = params.agentId!;
      this.upsertPrincipal(ctx, agentId, (body as { displayName?: string; status?: string }) ?? {});
      json(res, 200, {
        ok: true,
        data: {
          tenantId: ctx.tenantId,
          gatewayId: ctx.gatewayId,
          localAgentId: agentId,
          ...(body as object),
        },
      });
    });

    this.route('GET', '/v1/principals/:agentId', (_req, res, ctx, params) => {
      const row = this.db.raw
        .prepare(
          `SELECT * FROM knowledge_principals
           WHERE tenant_id = ? AND gateway_id = ? AND local_agent_id = ?`,
        )
        .get(ctx.tenantId, ctx.gatewayId, params.agentId) as Record<string, unknown> | undefined;
      if (!row) return err(res, 404, 'principal_not_registered', 'principal not found');
      json(res, 200, { ok: true, data: row });
    });

    this.route('GET', '/v1/projects', (_req, res, ctx) => {
      const { sources } = this.bundle();
      json(res, 200, {
        ok: true,
        data: sources.listProjects({
          tenantId: ctx.tenantId,
          gatewayId: ctx.gatewayId,
        }),
      });
    });

    this.route('POST', '/v1/projects', (_req, res, ctx, _p, body) => {
      const b = body as { projectKey?: string; displayName?: string; visibility?: string };
      if (!b?.projectKey) return err(res, 400, 'bad_request', 'projectKey required');
      const existing = this.db.raw
        .prepare(
          `SELECT registered_by FROM knowledge_projects
           WHERE tenant_id = ? AND project_key = ?`,
        )
        .get(ctx.tenantId, b.projectKey) as { registered_by?: string } | undefined;
      if (existing?.registered_by && existing.registered_by !== ctx.gatewayId) {
        return err(res, 403, 'not_resource_owner', 'project owned by another gateway');
      }
      const { sources } = this.bundle();
      sources.createProject(b.projectKey, b.displayName, {
        tenantId: ctx.tenantId,
        registeredBy: ctx.gatewayId,
      });
      this.db.raw
        .prepare(
          `UPDATE knowledge_projects SET registered_by = ?, visibility = ?
           WHERE tenant_id = ? AND project_key = ?`,
        )
        .run(
          ctx.gatewayId,
          b.visibility === 'public' ? 'public' : 'private',
          ctx.tenantId,
          b.projectKey,
        );
      json(res, 201, {
        ok: true,
        data: {
          projectKey: b.projectKey,
          displayName: b.displayName ?? null,
          registeredBy: ctx.gatewayId,
          visibility: b.visibility === 'public' ? 'public' : 'private',
        },
      });
    });

    this.route('DELETE', '/v1/projects/:projectKey', (_req, res, ctx, params) => {
      const key = params.projectKey!;
      const row = this.db.raw
        .prepare(
          `SELECT registered_by FROM knowledge_projects
           WHERE tenant_id = ? AND project_key = ?`,
        )
        .get(ctx.tenantId, key) as { registered_by?: string } | undefined;
      if (row?.registered_by && row.registered_by !== ctx.gatewayId) {
        return err(res, 403, 'not_resource_owner', 'not project owner');
      }
      const { sources } = this.bundle();
      try {
        const removed = sources.removeProject(key, { tenantId: ctx.tenantId });
        json(res, 200, { ok: true, data: { projectKey: key, removed } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not empty|non-empty|仍有/i.test(msg)) {
          return err(res, 409, 'project_not_empty', msg);
        }
        err(res, 400, 'bad_request', msg);
      }
    });

    this.route('GET', '/v1/events', (req, res, ctx) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send('hello', { tenantId: ctx.tenantId, gatewayId: ctx.gatewayId, ts: Date.now() });
      const { ingest } = this.bundle();
      const onProgress = (evt: unknown) => {
        const p = evt as { sourceId?: string };
        // 与 list/search 同一可见性：owner 或 public（不是只给注册方）
        if (p?.sourceId) {
          const src = this.bundle().sources.get(p.sourceId);
          if (src && !this.sourceVisibleToGateway(src, ctx)) return;
        }
        send('knowledge.index.progress', evt);
      };
      // KnowledgeIngest EventEmitter
      (ingest as unknown as { on?: (n: string, f: (e: unknown) => void) => void }).on?.(
        'knowledge.index.progress',
        onProgress,
      );
      req.on('close', () => {
        (
          ingest as unknown as { off?: (n: string, f: (e: unknown) => void) => void }
        ).off?.('knowledge.index.progress', onProgress);
        res.end();
      });
    });

    this.route('GET', '/v1/sources', (req, res, ctx) => {
      const { sources } = this.bundle();
      const url = new URL(req.url ?? '/v1/sources', 'http://internal');
      const scopeLevel = url.searchParams.get('scopeLevel');
      const projectKey = url.searchParams.get('projectKey') ?? undefined;
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      let list = sources.list().filter((s) => this.sourceVisibleToGateway(s, ctx));
      if (scopeLevel === 'global' || scopeLevel === 'project' || scopeLevel === 'session') {
        list = list.filter((s) => s.scopeRef.level === scopeLevel);
      }
      if (projectKey != null && projectKey !== '') {
        list = list.filter((s) => s.scopeRef.key === projectKey);
      }
      if (sessionId != null && sessionId !== '') {
        // 会话过滤必须真过滤：session 级源只保留本会话；其余按 overlay/base
        list = list.filter((s) => {
          if (s.scopeRef.level === 'session') return s.scopeRef.key === sessionId;
          return true;
        });
      }
      json(res, 200, { ok: true, data: list });
    });

    this.route('POST', '/v1/sources', async (_req, res, ctx, _p, body) => {
      const input = body as Record<string, unknown>;
      if (!input || typeof input !== 'object') {
        return err(res, 400, 'bad_request', 'body required');
      }
      const { sources } = this.bundle();
      try {
        // 禁止客户端注入 id / registered_by / tenant_id
        const input = body as Record<string, unknown>;
        delete input.id;
        delete input.registeredBy;
        delete input.registered_by;
        delete input.tenantId;
        delete input.tenant_id;
        const src = sources.register(
          input as unknown as import('./types.js').KnowledgeSourceInput,
        );
        // 标记注册方 / 可见性（schema 列）
        this.db.raw
          .prepare(
            `UPDATE knowledge_sources SET registered_by = ?, visibility = ?, tenant_id = ?
             WHERE id = ?`,
          )
          .run(
            ctx.gatewayId,
            typeof input.visibility === 'string' ? input.visibility : 'private',
            ctx.tenantId,
            src.id,
          );
        // 注册即开索引：否则源永远停在 pending、jobs=0（重建按钮才是唯一入口）
        const { ingest } = this.bundle();
        void ingest.ingestSource(src.id, { full: true }).catch((e) => {
          // 禁止静默吞掉：否则源卡 pending/discovering、jobs=0
          console.warn(
            `[Knowledge] auto-ingest after register failed (${src.id}): ${e instanceof Error ? e.message : String(e)}`,
          );
        });
        json(res, 201, {
          ok: true,
          data: {
            ...src,
            registeredBy: ctx.gatewayId,
          },
        });
      } catch (e) {
        err(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
      }
    });

    this.route('GET', '/v1/sources/:sid', (_req, res, ctx, params) => {
      const { sources, index, ingest } = this.bundle();
      const src = sources.get(params.sid!);
      if (!src || !this.sourceVisibleToGateway(src, ctx)) {
        return err(res, 404, 'source_not_found', 'source not found');
      }
      const identity = { tenantId: ctx.tenantId, gatewayId: ctx.gatewayId };
      const assignedAgentIds =
        src.scopeRef.level === 'project' ? sources.listProjectAgents(src.scopeRef.key) : [];
      json(res, 200, {
        ok: true,
        data: {
          ...src,
          stats: index.sourceStats(src.id),
          jobControl: ingest.jobControlState(src.id),
          assignedAgentIds,
          hiddenForAgentIds: sources.listAgentsHidingSource(src.id, identity),
        },
      });
    });

    this.route('PATCH', '/v1/sources/:sid', (_req, res, ctx, params, body) => {
      const { sources } = this.bundle();
      const sid = params.sid!;
      const row = this.db.raw
        .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
        .get(sid) as { registered_by?: string } | undefined;
      if (row?.registered_by && row.registered_by !== ctx.gatewayId) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      try {
        const updated = sources.update(sid, body as never);
        if (!updated) return err(res, 404, 'source_not_found', 'source not found');
        if (typeof (body as { visibility?: string })?.visibility === 'string') {
          this.db.raw
            .prepare('UPDATE knowledge_sources SET visibility = ? WHERE id = ?')
            .run((body as { visibility: string }).visibility, sid);
        }
        json(res, 200, { ok: true, data: updated });
      } catch (e) {
        err(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
      }
    });

    this.route('DELETE', '/v1/sources/:sid', (_req, res, ctx, params) => {
      const { sources, index, memberships } = this.bundle();
      const sid = params.sid!;
      const src = sources.get(sid);
      if (!src) return err(res, 404, 'source_not_found', 'source not found');
      const row = this.db.raw
        .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
        .get(sid) as { registered_by?: string } | undefined;
      if (row?.registered_by && row.registered_by !== ctx.gatewayId) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      const purged = memberships.unclaimAllForSource(sid, (fileId) => index.purgeFile(fileId));
      sources.remove(sid);
      json(res, 200, { ok: true, data: { id: sid, purgedFiles: purged } });
    });

    this.route('POST', '/v1/sources/:sid/reindex', (_req, res, ctx, params) => {
      if (!this.assertSourceOwner(ctx, params.sid!)) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      const { ingest } = this.bundle();
      void ingest.ingestSource(params.sid!, { full: true }).catch((e) => {
        console.warn(
          `[Knowledge] reindex kick failed (${params.sid}): ${e instanceof Error ? e.message : String(e)}`,
        );
      });
      json(res, 202, { ok: true, data: { sourceId: params.sid, accepted: true } });
    });

    this.route('POST', '/v1/sources/:sid/abort', (_req, res, ctx, params) => {
      if (!this.assertSourceOwner(ctx, params.sid!)) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      const { ingest } = this.bundle();
      const stats = ingest.abortJobs({ sourceId: params.sid! });
      json(res, 200, {
        ok: true,
        data: { ...stats, ...ingest.jobControlState(params.sid!) },
      });
    });

    this.route('POST', '/v1/sources/:sid/resume', (_req, res, ctx, params) => {
      if (!this.assertSourceOwner(ctx, params.sid!)) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      const { ingest } = this.bundle();
      ingest.resumeJobs({ sourceId: params.sid! });
      json(res, 200, { ok: true, data: ingest.jobControlState(params.sid!) });
    });

    this.route('POST', '/v1/sources/:sid/describe', async (_req, res, ctx, params) => {
      if (!this.assertSourceOwner(ctx, params.sid!)) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      const { sources } = this.bundle();
      const src = sources.get(params.sid!);
      if (!src) return err(res, 404, 'source_not_found', 'source not found');
      const paths = this.db.raw
        .prepare(
          'SELECT logical_path FROM knowledge_memberships WHERE source_id = ? ORDER BY logical_path LIMIT 20',
        )
        .all(src.id) as Array<{ logical_path: string }>;
      const sample = paths.map((p) => p.logical_path).join('\n') || src.location;
      const r = await generateKnowledgeDescription(src, sample, { enabled: true });
      sources.update(src.id, { generatedDescription: r.description });
      json(res, 200, {
        ok: true,
        data: { generatedDescription: r.description, source: r.source },
      });
    });

    /** 全局中止/继续：仅作用于本 Gateway 注册的源（与单源 ACL 同口径） */
    const runJobsOpForOwned = (
      ctx: AuthContext,
      op: 'abort' | 'resume',
    ): { ok: true; data: Record<string, number> } => {
      const { ingest, sources } = this.bundle();
      const owned = sources.list().filter((s) => this.assertSourceOwner(ctx, s.id));
      let cancelledQueued = 0;
      let abortedRunning = 0;
      let runningJobs = 0;
      let restoredCancelled = 0;
      let embedQueued = 0;
      for (const s of owned) {
        if (op === 'abort') {
          const st = ingest.abortJobs({ sourceId: s.id });
          cancelledQueued += st.cancelledQueued;
          abortedRunning += st.abortedRunning;
          runningJobs += st.runningJobs;
        } else {
          const st = ingest.resumeJobs({ sourceId: s.id });
          restoredCancelled += st.restoredCancelled;
          embedQueued += st.embedQueued;
        }
      }
      return {
        ok: true,
        data:
          op === 'abort'
            ? { cancelledQueued, abortedRunning, runningJobs }
            : { restoredCancelled, embedQueued },
      };
    };

    this.route('POST', '/v1/jobs/abort', (_req, res, ctx) => {
      json(res, 200, runJobsOpForOwned(ctx, 'abort'));
    });
    this.route('POST', '/v1/jobs/resume', (_req, res, ctx) => {
      json(res, 200, runJobsOpForOwned(ctx, 'resume'));
    });

    this.route('GET', '/v1/sources/:sid/files', (_req, res, ctx, params) => {
      if (!this.assertSourceOwner(ctx, params.sid!)) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      const { index } = this.bundle();
      json(res, 200, { ok: true, data: index.listFiles(params.sid!) });
    });

    this.route('GET', '/v1/principals/:agentId/search', async (req, res, ctx, params) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const q = url.searchParams.get('q') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 8);
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const agentId = params.agentId!;
      this.ensurePrincipal(ctx, agentId);
      const { retriever } = this.bundle();
      const result = await retriever.search(q, {
        agentId,
        sessionId,
        limit,
        tenantId: ctx.tenantId,
        gatewayId: ctx.gatewayId,
      });
      json(res, 200, { ok: true, data: result });
    });

    this.route('GET', '/v1/principals/:agentId/stats', (_req, res, ctx, params) => {
      const agentId = params.agentId!;
      this.ensurePrincipal(ctx, agentId);
      const { sources, index } = this.bundle();
      const visible = sources.listVisible(agentId);
      const stats = this.db.stats();
      json(res, 200, {
        ok: true,
        data: {
          ...stats,
          visibility: {
            assignedProjects: sources
              .list()
              .filter((s) => s.scopeRef.level === 'project' && sources.isVisible(s, agentId))
              .map((s) => s.scopeRef.key),
            hiddenSourceIds: sources.listHidden(agentId, {
              tenantId: ctx.tenantId,
              gatewayId: ctx.gatewayId,
            }),
          },
          visibleSources: visible.length,
        },
      });
      void index;
    });

    this.route('GET', '/v1/principals/:agentId/catalog', (_req, res, ctx, params) => {
      const agentId = params.agentId!;
      this.ensurePrincipal(ctx, agentId);
      const { sources } = this.bundle();
      const items = sources.catalogFor(agentId);
      json(res, 200, { ok: true, data: items });
    });

    this.route('GET', '/v1/principals/:agentId/chunks', (req, res, ctx, params) => {
      const agentId = params.agentId!;
      this.ensurePrincipal(ctx, agentId);
      const url = new URL(req.url ?? '/', 'http://local');
      const sourceId = url.searchParams.get('sourceId') ?? '';
      const path = url.searchParams.get('path') ?? '';
      if (!sourceId || !path) {
        return err(res, 400, 'bad_request', 'sourceId and path required');
      }
      const { index, sources } = this.bundle();
      const src = sources.get(sourceId);
      if (!src || !this.sourceVisibleToGateway(src, ctx) || !sources.isVisible(src, agentId, ctx.sessionId)) {
        return err(res, 404, 'file_not_found', 'source not found');
      }
      json(res, 200, { ok: true, data: index.listChunksByPath(sourceId, path) });
    });

    this.route('POST', '/v1/principals/:agentId/read', (_req, res, ctx, params, body) => {
      const agentId = params.agentId!;
      this.ensurePrincipal(ctx, agentId);
      const b = body as {
        chunkId?: string;
        sourceId?: string;
        path?: string;
      };
      const { index, sources } = this.bundle();
      if (b?.chunkId) {
        const row = index.getChunk(b.chunkId);
        if (!row) return err(res, 404, 'file_not_found', 'chunk not found');
        const src = sources.get(row.sourceId);
        if (!src || !sources.isVisible(src, agentId, ctx.sessionId)) {
          return err(res, 404, 'file_not_found', 'chunk not found');
        }
        return json(res, 200, {
          ok: true,
          data: {
            found: true,
            path: row.path,
            startLine: row.startLine,
            endLine: row.endLine,
            text: row.text,
          },
        });
      }
      if (!b?.sourceId || !b?.path) {
        return err(res, 400, 'bad_request', 'chunkId or (sourceId+path) required');
      }
      const src = sources.get(b.sourceId);
      if (!src || !sources.isVisible(src, agentId, ctx.sessionId)) {
        return err(res, 404, 'source_not_found', 'source not found');
      }
      const chunks = index.listChunksByPath(b.sourceId, b.path);
      json(res, 200, {
        ok: true,
        data: {
          found: chunks.length > 0,
          path: b.path,
          chunkCount: chunks.length,
          text: chunks.map((c) => c.text).join('\n\n'),
          chunks,
        },
      });
    });

    this.route('GET', '/v1/principals/:agentId/visibility', (_req, res, ctx, params) => {
      const agentId = params.agentId!;
      this.ensurePrincipal(ctx, agentId);
      const { sources } = this.bundle();
      const identity = { tenantId: ctx.tenantId, gatewayId: ctx.gatewayId };
      const assigned = sources
        .list()
        .filter(
          (s) => s.scopeRef.level === 'project' && sources.isVisible(s, agentId, undefined, identity),
        )
        .map((s) => s.scopeRef.key);
      json(res, 200, {
        ok: true,
        data: {
          assignedProjects: [...new Set(assigned)],
          hiddenSourceIds: sources.listHidden(agentId, identity),
        },
      });
    });

    this.route('POST', '/v1/principals/:agentId/visibility', (_req, res, ctx, params, body) => {
      const agentId = params.agentId!;
      this.ensurePrincipal(ctx, agentId);
      this.assertOwnPrincipal(ctx, agentId);
      const { sources } = this.bundle();
      const identity = { tenantId: ctx.tenantId, gatewayId: ctx.gatewayId };
      const op = (body as { op?: string })?.op;
      const projectKey = (body as { projectKey?: string })?.projectKey;
      const sourceId = (body as { sourceId?: string })?.sourceId;
      if (op === 'assignProject' && projectKey) sources.assignProject(projectKey, agentId, identity);
      else if (op === 'unassignProject' && projectKey)
        sources.unassignProject(projectKey, agentId, identity);
      else if (op === 'hide' && sourceId) sources.hideSource(agentId, sourceId, identity);
      else if (op === 'unhide' && sourceId) sources.unhideSource(agentId, sourceId, identity);
      else return err(res, 400, 'bad_request', 'unknown visibility op');
      json(res, 200, { ok: true, data: { op, projectKey, sourceId } });
    });

    this.route(
      'GET',
      '/v1/principals/:agentId/session-visibility',
      (req, res, ctx, params) => {
        const agentId = params.agentId!;
        this.ensurePrincipal(ctx, agentId);
        this.assertOwnPrincipal(ctx, agentId);
        const url = new URL(req.url ?? '/', 'http://local');
        const sessionId = url.searchParams.get('sessionId') ?? '';
        if (!sessionId) return err(res, 400, 'session_required', 'sessionId required');
        const { sources } = this.bundle();
        json(res, 200, {
          ok: true,
          data: sources.listSessionVisibility(sessionId),
        });
      },
    );

    this.route(
      'PUT',
      '/v1/principals/:agentId/session-visibility',
      (_req, res, ctx, params, body) => {
        const agentId = params.agentId!;
        this.ensurePrincipal(ctx, agentId);
        this.assertOwnPrincipal(ctx, agentId);
        const b = body as {
          sessionId?: string;
          items?: Array<{ targetType?: string; targetId?: string; op?: string }>;
        };
        const sessionId = b?.sessionId;
        if (!sessionId) return err(res, 400, 'bad_request', 'sessionId required');
        const { sources } = this.bundle();
        // replace 语义：先清后写，禁止残留旧 include/exclude
        sources.clearSessionVisibility(sessionId);
        const items: Array<{ targetType: 'project' | 'source'; targetId: string; op: 'include' | 'exclude' }> = [];
        for (const raw of b.items ?? []) {
          const targetType = raw?.targetType as 'project' | 'source' | undefined;
          const targetId = typeof raw?.targetId === 'string' ? raw.targetId : '';
          const op = raw?.op as 'include' | 'exclude' | undefined;
          if (!targetId || (targetType !== 'project' && targetType !== 'source') || (op !== 'include' && op !== 'exclude')) {
            return err(res, 400, 'bad_request', 'items[] invalid');
          }
          items.push({ targetType, targetId, op });
          sources.setSessionVisibility(sessionId, { targetType, targetId, op });
        }
        json(res, 200, { ok: true, data: { sessionId, count: items.length } });
      },
    );

    this.route(
      'POST',
      '/v1/principals/:agentId/session-visibility',
      (_req, res, ctx, params, body) => {
        const agentId = params.agentId!;
        this.ensurePrincipal(ctx, agentId);
        this.assertOwnPrincipal(ctx, agentId);
        const { sources } = this.bundle();
        const item = body as {
          sessionId?: string;
          targetType?: 'project' | 'source';
          targetId?: string;
          op?: 'include' | 'exclude';
        };
        if (!item?.sessionId || !item.targetType || !item.targetId || !item.op) {
          return err(res, 400, 'bad_request', 'sessionId/targetType/targetId/op required');
        }
        sources.setSessionVisibility(item.sessionId, {
          targetType: item.targetType,
          targetId: item.targetId,
          op: item.op,
        });
        json(res, 200, { ok: true, data: item });
      },
    );

    this.route(
      'DELETE',
      '/v1/principals/:agentId/session-visibility',
      (req, res, ctx, params) => {
        const agentId = params.agentId!;
        this.ensurePrincipal(ctx, agentId);
        this.assertOwnPrincipal(ctx, agentId);
        const url = new URL(req.url ?? '/', 'http://local');
        const sessionId = url.searchParams.get('sessionId') ?? '';
        if (!sessionId) return err(res, 400, 'session_required', 'sessionId required');
        const targetType = url.searchParams.get('targetType');
        const targetId = url.searchParams.get('targetId');
        const { sources } = this.bundle();
        if (targetType && targetId) {
          sources.clearSessionVisibility(sessionId, {
            targetType: targetType as 'project' | 'source',
            targetId,
          });
          json(res, 200, { ok: true, data: { sessionId, targetType, targetId } });
          return;
        }
        sources.clearSessionVisibility(sessionId);
        json(res, 200, { ok: true, data: { sessionId, cleared: true } });
      },
    );

    this.route('GET', '/v1/jobs', (req, res, ctx) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const sourceId = url.searchParams.get('sourceId') ?? undefined;
      const status = url.searchParams.get('status') ?? undefined;
      const where: string[] = [
        `source_id IN (SELECT id FROM knowledge_sources WHERE tenant_id = ? AND (registered_by = ? OR visibility = 'public'))`,
      ];
      const args: unknown[] = [ctx.tenantId, ctx.gatewayId];
      if (sourceId) {
        where.push('source_id = ?');
        args.push(sourceId);
      }
      if (status) {
        where.push('status = ?');
        args.push(status);
      }
      const rows = this.db.raw
        .prepare(
          `SELECT * FROM knowledge_jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
        )
        .all(...(args as never[]));
      json(res, 200, { ok: true, data: rows });
    });

    this.route('GET', '/v1/jobs/control', (req, res, ctx) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const sourceId = url.searchParams.get('sourceId') ?? '';
      if (!sourceId) return err(res, 400, 'bad_request', 'sourceId required');
      if (!this.assertSourceOwner(ctx, sourceId)) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      const { ingest } = this.bundle();
      json(res, 200, { ok: true, data: ingest.jobControlState(sourceId) });
    });

    this.route('GET', '/v1/promotion-candidates', (_req, res) => {
      const hitLog = new KnowledgeHitLog(this.db);
      json(res, 200, { ok: true, data: hitLog.promotionCandidates() });
    });
  }

  private assertOwnPrincipal(ctx: AuthContext, localAgentId: string): void {
    const row = this.db.raw
      .prepare(
        `SELECT gateway_id FROM knowledge_principals
         WHERE tenant_id = ? AND gateway_id = ? AND local_agent_id = ?`,
      )
      .get(ctx.tenantId, ctx.gatewayId, localAgentId) as { gateway_id?: string } | undefined;
    if (row?.gateway_id && row.gateway_id !== ctx.gatewayId) {
      throw Object.assign(new Error('not principal owner'), { code: 'not_principal_owner' });
    }
    // 未注册 principal 时 autoRegister 已处理；此处仅防跨 gateway 误用
  }

  /** 源是否由本 Gateway 注册（管理写操作） */
  private assertSourceOwner(ctx: AuthContext, sourceId: string): boolean {
    const row = this.db.raw
      .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string } | undefined;
    if (!row) return false;
    if (row.registered_by && row.registered_by !== ctx.gatewayId) return false;
    return true;
  }

  private sourceVisibleToGateway(
    src: { id: string; registeredBy?: string },
    ctx: AuthContext,
  ): boolean {
    const row = this.db.raw
      .prepare('SELECT registered_by, visibility FROM knowledge_sources WHERE id = ?')
      .get(src.id) as { registered_by?: string; visibility?: string } | undefined;
    if (!row) return true;
    if (row.registered_by === ctx.gatewayId) return true;
    return row.visibility === 'public';
  }

  private upsertPrincipal(
    ctx: AuthContext,
    localAgentId: string,
    body: { displayName?: string; status?: string },
  ): void {
    const now = Date.now();
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_principals
           (tenant_id, gateway_id, local_agent_id, display_name, status, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, gateway_id, local_agent_id) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, knowledge_principals.display_name),
           status = excluded.status,
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        ctx.tenantId,
        ctx.gatewayId,
        localAgentId,
        body.displayName ?? null,
        body.status ?? 'active',
        now,
        now,
        now,
      );
  }

  private ensurePrincipal(ctx: AuthContext, localAgentId: string): void {
    const row = this.db.raw
      .prepare(
        `SELECT status FROM knowledge_principals
         WHERE tenant_id = ? AND gateway_id = ? AND local_agent_id = ?`,
      )
      .get(ctx.tenantId, ctx.gatewayId, localAgentId) as { status?: string } | undefined;
    if (row) return;
    if (this.opts.autoRegisterPrincipals) {
      this.upsertPrincipal(ctx, localAgentId, {});
      return;
    }
    throw Object.assign(new Error('principal not registered'), {
      code: 'principal_not_registered',
    });
  }

  /**
   * 拉起 ingest 运行时（Service 进程入口调用一次）。
   *
   * - 恢复 watch 源的 fs 监听
   * - 补跑从未开索引的 pending 源（注册后崩溃 / 历史遗留）
   * - 启动 reconciler / poll 看门狗（否则任务静默停摆无人捡）
   */
  startIngestRuntime(): void {
    const { sources, ingest } = this.bundle();
    // 源任务稳定后补 generatedDescription（Service 无 LLM 时走启发式，不再空转）
    ingest.onSourceSettled = (sourceId) => {
      void (async () => {
        try {
          const src = sources.get(sourceId);
          if (!src || src.description?.trim()) return;
          const paths = this.db.raw
            .prepare(
              'SELECT logical_path FROM knowledge_memberships WHERE source_id = ? ORDER BY logical_path LIMIT 20',
            )
            .all(sourceId) as Array<{ logical_path: string }>;
          const sample = paths.map((p) => p.logical_path).join('\n') || src.location;
          const r = await generateKnowledgeDescription(src, sample, { enabled: true });
          sources.update(sourceId, { generatedDescription: r.description });
        } catch {
          /* describe 失败不影响索引 */
        }
      })();
    };
    for (const s of sources.list()) {
      if (s.status === 'removed' || s.status === 'disabled') continue;
      if (s.sync.enabled !== false && s.sync.strategy === 'watch') {
        ingest.startWatch(s.id);
      }
      // 仅 pending：已 discovering/partial 的缺口交给 reconciler 的 gap 扫描
      if (s.status === 'pending') {
        void ingest.ingestSource(s.id, { full: true }).catch((e) => {
          console.warn(
            `[Knowledge] recover pending failed (${s.id}): ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }
    }
    ingest.startReconciler();
    ingest.startPolling();
  }

  /** 停 ingest 定时器 / watch（Service 关闭） */
  dispose(): void {
    for (const ingest of this.ingests.values()) {
      ingest.dispose();
    }
    this.ingests.clear();
  }

  /**
   * node:http 入口。
   */
  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const auth = this.authenticate(req);
      if (!auth && path !== '/health') {
        return err(res, 401, 'unauthorized', 'missing or invalid token');
      }
      const ctx: AuthContext = auth ?? {
        tenantId: 'anonymous',
        gatewayId: 'anonymous',
      };
      const headerAgent = req.headers['x-octopi-agent'];
      const headerSession = req.headers['x-octopi-session'];
      if (typeof headerAgent === 'string' && headerAgent) ctx.agentId = headerAgent;
      if (typeof headerSession === 'string' && headerSession) ctx.sessionId = headerSession;

      for (const r of this.routes) {
        if (r.method !== method) continue;
        const m = r.regex.exec(path);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => {
          params[k] = m[i + 1] ?? '';
        });
        const body = await readBody(req);
        await r.handler(req, res, ctx, params, body);
        return;
      }
      err(res, 404, 'not_found', `no route ${method} ${path}`);
    } catch (e) {
      const code =
        (e as { code?: string }).code ??
        (e instanceof Error ? e.message : 'internal_error');
      if (code === 'principal_not_registered') {
        return err(res, 403, code, 'principal not registered');
      }
      if (code === 'not_principal_owner') {
        return err(res, 403, code, 'not principal owner');
      }
      if (code === 'not_resource_owner') {
        return err(res, 403, code, 'not resource owner');
      }
      err(res, 500, 'internal_error', e instanceof Error ? e.message : String(e));
    }
  };

  private authenticate(req: IncomingMessage): AuthContext | null {
    const hit = matchKnowledgeToken(this.opts.tokens, req.headers.authorization);
    if (!hit) return null;
    return { tenantId: hit.tenantId, gatewayId: hit.gatewayId };
  }
}

/**
 * 修正 route 参数名：注册时把 :name 存进 handler 元数据。
 */
export function createKnowledgeHttpApp(opts: KnowledgeServiceOptions): KnowledgeHttpApp {
  const app = new KnowledgeHttpApp(opts);
  return app;
}
