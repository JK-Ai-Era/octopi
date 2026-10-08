/**
 * Knowledge Service HTTP — 契约 arch/knowledge-service-http.md v2.1
 *
 * API 线程只编排：写走 KnowledgeWriteService（Writer Worker / Local），
 * 读走 KnowledgeQueryService。**禁止**在此打开 knowledge.db。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { matchKnowledgeToken } from './http-bridge.js';
import type { KnowledgeQueryService, QueryIdentity } from './query-service.js';
import type { KnowledgeWriteService, WriteIdentity } from './writer-service.js';

export interface KnowledgeServiceToken {
  token: string;
  tenantId: string;
  gatewayId: string;
}

export interface KnowledgeServiceOptions {
  /** 唯一写者端口（Writer Worker RPC 或 Local） */
  write: KnowledgeWriteService;
  /** 只读查询面（Meta/Search Worker 或 Local） */
  query: KnowledgeQueryService;
  tokens: KnowledgeServiceToken[];
  /** 单机 dev：未注册 principal 自动建（写路径才注册） */
  autoRegisterPrincipals?: boolean;
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
  json(res, status, { error: { code, message, details } });
}

function mapWriteError(res: ServerResponse, e: unknown): boolean {
  const code = (e as { code?: string }).code ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  if (code === 'not_resource_owner' || /not resource owner|not source owner|not project owner/i.test(msg)) {
    err(res, 403, 'not_resource_owner', msg);
    return true;
  }
  if (code === 'not_principal_owner' || /not principal owner/i.test(msg)) {
    err(res, 403, 'not_principal_owner', msg);
    return true;
  }
  if (code === 'principal_not_registered' || /principal not registered/i.test(msg)) {
    err(res, 403, 'principal_not_registered', msg);
    return true;
  }
  if (code === 'source_not_found' || /source not found/i.test(msg)) {
    err(res, 404, 'source_not_found', msg);
    return true;
  }
  if (code === 'project_not_empty' || /not empty|non-empty|仍有/i.test(msg)) {
    err(res, 409, 'project_not_empty', msg);
    return true;
  }
  return false;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
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
  private progressOff: (() => void) | null = null;

  constructor(private readonly opts: KnowledgeServiceOptions) {
    this.registerRoutes();
  }

  private get write(): KnowledgeWriteService {
    return this.opts.write;
  }

  private query(): KnowledgeQueryService {
    return this.opts.query;
  }

  private identityOf(ctx: AuthContext): WriteIdentity & QueryIdentity {
    return { tenantId: ctx.tenantId, gatewayId: ctx.gatewayId };
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

    this.route('GET', '/v1/ready', async (_req, res) => {
      json(res, 200, await this.query().ready());
    });

    this.route('PUT', '/v1/principals/:agentId', async (_req, res, ctx, params, body) => {
      const agentId = params.agentId!;
      await this.write.upsertPrincipal(
        this.identityOf(ctx),
        agentId,
        (body as { displayName?: string; status?: string }) ?? {},
      );
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

    this.route('GET', '/v1/principals/:agentId', async (_req, res, ctx, params) => {
      const row = await this.query().getPrincipal(this.identityOf(ctx), params.agentId!);
      if (!row) return err(res, 404, 'principal_not_registered', 'principal not found');
      json(res, 200, { ok: true, data: row });
    });

    this.route('GET', '/v1/projects', async (_req, res, ctx) => {
      json(res, 200, {
        ok: true,
        data: await this.query().listProjects(this.identityOf(ctx)),
      });
    });

    this.route('POST', '/v1/projects', async (_req, res, ctx, _p, body) => {
      const b = body as { projectKey?: string; displayName?: string; visibility?: string };
      if (!b?.projectKey) return err(res, 400, 'bad_request', 'projectKey required');
      try {
        const data = await this.write.createProject(this.identityOf(ctx), {
          projectKey: b.projectKey,
          displayName: b.displayName,
          visibility: b.visibility,
        });
        json(res, 201, { ok: true, data });
      } catch (e) {
        if (!mapWriteError(res, e)) {
          err(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
        }
      }
    });

    this.route('DELETE', '/v1/projects/:projectKey', async (_req, res, ctx, params) => {
      try {
        const data = await this.write.removeProject(this.identityOf(ctx), params.projectKey!);
        json(res, 200, { ok: true, data });
      } catch (e) {
        if (!mapWriteError(res, e)) {
          err(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
        }
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
      const off = this.write.onProgress((evt) => {
        const p = evt as {
          sourceId?: string;
          tenantId?: string;
          registeredBy?: string;
          visibility?: string;
        };
        if (p?.sourceId && p.registeredBy != null) {
          // 事件自带归属：禁止再 RPC Writer（重索引期会堵 abort）
          if (p.tenantId && p.tenantId !== ctx.tenantId) return;
          if (p.registeredBy !== ctx.gatewayId && p.visibility !== 'public') return;
          send('knowledge.index.progress', evt);
          return;
        }
        if (p?.sourceId) {
          void this.write
            .sourceVisibleToGateway(p.sourceId, ctx.gatewayId)
            .then((ok) => {
              if (ok) send('knowledge.index.progress', evt);
            })
            .catch(() => undefined);
          return;
        }
        send('knowledge.index.progress', evt);
      });
      req.on('close', () => {
        off();
        res.end();
      });
    });

    this.route('GET', '/v1/sources', async (req, res, ctx) => {
      const url = new URL(req.url ?? '/v1/sources', 'http://internal');
      const scopeLevel = url.searchParams.get('scopeLevel');
      const projectKey = url.searchParams.get('projectKey') ?? undefined;
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const list = await this.query().listSources({
        ...(scopeLevel === 'global' || scopeLevel === 'project' || scopeLevel === 'session'
          ? { scopeLevel }
          : {}),
        ...(projectKey != null && projectKey !== '' ? { projectKey } : {}),
        ...(sessionId != null && sessionId !== '' ? { sessionId } : {}),
        identity: this.identityOf(ctx),
      });
      json(res, 200, { ok: true, data: list });
    });

    this.route('POST', '/v1/sources', async (_req, res, ctx, _p, body) => {
      if (!body || typeof body !== 'object') {
        return err(res, 400, 'bad_request', 'body required');
      }
      try {
        const data = await this.write.registerSource(
          this.identityOf(ctx),
          body as Record<string, unknown>,
        );
        json(res, 201, { ok: true, data });
      } catch (e) {
        if (!mapWriteError(res, e)) {
          err(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
        }
      }
    });

    this.route('GET', '/v1/sources/:sid', async (_req, res, ctx, params) => {
      const detail = await this.query().getSourceDetail(params.sid!, this.identityOf(ctx));
      if (!detail) {
        return err(res, 404, 'source_not_found', 'source not found');
      }
      json(res, 200, {
        ok: true,
        data: {
          ...detail.source,
          stats: detail.stats,
          jobControl: detail.jobControl,
          assignedAgentIds: detail.assignedAgentIds,
          hiddenForAgentIds: detail.hiddenForAgentIds,
        },
      });
    });

    this.route('PATCH', '/v1/sources/:sid', async (_req, res, ctx, params, body) => {
      try {
        const updated = await this.write.updateSource(
          this.identityOf(ctx),
          params.sid!,
          (body as Record<string, unknown>) ?? {},
        );
        if (!updated) return err(res, 404, 'source_not_found', 'source not found');
        json(res, 200, { ok: true, data: updated });
      } catch (e) {
        if (!mapWriteError(res, e)) {
          err(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
        }
      }
    });

    this.route('DELETE', '/v1/sources/:sid', async (_req, res, ctx, params) => {
      try {
        const data = await this.write.removeSource(this.identityOf(ctx), params.sid!);
        json(res, 200, { ok: true, data });
      } catch (e) {
        if (!mapWriteError(res, e)) {
          err(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
        }
      }
    });

    this.route('POST', '/v1/sources/:sid/reindex', async (_req, res, ctx, params) => {
      if (!(await this.write.isSourceOwner(params.sid!, ctx.gatewayId))) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      await this.write.reindexSource(params.sid!);
      json(res, 202, { ok: true, data: { sourceId: params.sid, accepted: true } });
    });

    this.route('POST', '/v1/sources/:sid/abort', async (_req, res, ctx, params) => {
      if (!(await this.write.isSourceOwner(params.sid!, ctx.gatewayId))) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      json(res, 200, { ok: true, data: await this.write.abortSource(params.sid!) });
    });

    this.route('POST', '/v1/sources/:sid/resume', async (_req, res, ctx, params) => {
      if (!(await this.write.isSourceOwner(params.sid!, ctx.gatewayId))) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      json(res, 200, { ok: true, data: await this.write.resumeSource(params.sid!) });
    });

    this.route('POST', '/v1/sources/:sid/describe', async (_req, res, ctx, params) => {
      try {
        const data = await this.write.describeSource(this.identityOf(ctx), params.sid!);
        if (!data) return err(res, 404, 'source_not_found', 'source not found');
        json(res, 200, { ok: true, data });
      } catch (e) {
        if (!mapWriteError(res, e)) {
          err(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
        }
      }
    });

    this.route('POST', '/v1/jobs/abort', async (_req, res, ctx) => {
      json(res, 200, { ok: true, data: await this.write.abortAllOwned(this.identityOf(ctx)) });
    });
    this.route('POST', '/v1/jobs/resume', async (_req, res, ctx) => {
      json(res, 200, { ok: true, data: await this.write.resumeAllOwned(this.identityOf(ctx)) });
    });

    this.route('GET', '/v1/sources/:sid/files', async (req, res, ctx, params) => {
      if (!(await this.write.isSourceOwner(params.sid!, ctx.gatewayId))) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      const url = new URL(req.url ?? '/', 'http://local');
      const paged =
        url.searchParams.has('page') ||
        url.searchParams.has('pageSize') ||
        url.searchParams.has('status') ||
        url.searchParams.has('ext') ||
        url.searchParams.has('q');
      if (paged) {
        const status = url.searchParams.get('status') ?? undefined;
        const data = await this.query().listFilesPaged(
          params.sid!,
          {
            ...(status === 'indexed' || status === 'skipped' || status === 'error' || status === 'all'
              ? { status }
              : {}),
            ...(url.searchParams.get('ext') ? { ext: url.searchParams.get('ext')! } : {}),
            ...(url.searchParams.get('q') ? { q: url.searchParams.get('q')! } : {}),
            ...(url.searchParams.get('page')
              ? { page: Number(url.searchParams.get('page')) }
              : {}),
            ...(url.searchParams.get('pageSize')
              ? { pageSize: Number(url.searchParams.get('pageSize')) }
              : {}),
          },
          this.identityOf(ctx),
        );
        return json(res, 200, { ok: true, data });
      }
      json(res, 200, {
        ok: true,
        data: await this.query().listFiles(params.sid!, this.identityOf(ctx)),
      });
    });

    this.route('GET', '/v1/principals/:agentId/search', async (req, res, ctx, params) => {
      const url = new URL(req.url ?? '/', 'http://local');
      await this.write.ensurePrincipal(
        this.identityOf(ctx),
        params.agentId!,
        this.opts.autoRegisterPrincipals ?? true,
      );
      const result = await this.query().search({
        agentId: params.agentId!,
        q: url.searchParams.get('q') ?? '',
        sessionId: url.searchParams.get('sessionId') ?? undefined,
        limit: Number(url.searchParams.get('limit') ?? 8),
        identity: this.identityOf(ctx),
      });
      json(res, 200, { ok: true, data: result });
    });

    this.route('GET', '/v1/principals/:agentId/stats', async (_req, res, ctx, params) => {
      await this.write.ensurePrincipal(
        this.identityOf(ctx),
        params.agentId!,
        this.opts.autoRegisterPrincipals ?? true,
      );
      const principal = await this.query().principalStats(params.agentId!, this.identityOf(ctx));
      json(res, 200, {
        ok: true,
        data: {
          ...principal.stats,
          visibility: principal.visibility,
          visibleSources: principal.visibleSources,
        },
      });
    });

    this.route('GET', '/v1/principals/:agentId/catalog', async (_req, res, ctx, params) => {
      await this.write.ensurePrincipal(
        this.identityOf(ctx),
        params.agentId!,
        this.opts.autoRegisterPrincipals ?? true,
      );
      json(res, 200, {
        ok: true,
        data: await this.query().catalog(params.agentId!, this.identityOf(ctx)),
      });
    });

    this.route('GET', '/v1/principals/:agentId/chunks', async (req, res, ctx, params) => {
      await this.write.ensurePrincipal(
        this.identityOf(ctx),
        params.agentId!,
        this.opts.autoRegisterPrincipals ?? true,
      );
      const url = new URL(req.url ?? '/', 'http://local');
      const sourceId = url.searchParams.get('sourceId') ?? '';
      const path = url.searchParams.get('path') ?? '';
      if (!sourceId || !path) {
        return err(res, 400, 'bad_request', 'sourceId and path required');
      }
      const data = await this.query().listChunks(
        params.agentId!,
        sourceId,
        path,
        this.identityOf(ctx),
        ctx.sessionId,
      );
      if (data == null) {
        return err(res, 404, 'file_not_found', 'source not found');
      }
      json(res, 200, { ok: true, data });
    });

    this.route('POST', '/v1/principals/:agentId/read', async (_req, res, ctx, params, body) => {
      await this.write.ensurePrincipal(
        this.identityOf(ctx),
        params.agentId!,
        this.opts.autoRegisterPrincipals ?? true,
      );
      const b = body as { chunkId?: string; sourceId?: string; path?: string };
      if (!b?.chunkId && (!b?.sourceId || !b?.path)) {
        return err(res, 400, 'bad_request', 'chunkId or (sourceId+path) required');
      }
      if (b.chunkId) {
        const data = await this.query().read(
          params.agentId!,
          b,
          this.identityOf(ctx),
          ctx.sessionId,
        );
        if (!data.found) {
          return err(res, 404, 'file_not_found', 'chunk not found');
        }
        return json(res, 200, { ok: true, data });
      }
      const chunks = await this.query().listChunks(
        params.agentId!,
        b.sourceId!,
        b.path!,
        this.identityOf(ctx),
        ctx.sessionId,
      );
      if (chunks == null) {
        return err(res, 404, 'source_not_found', 'source not found');
      }
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

    this.route('GET', '/v1/principals/:agentId/visibility', async (_req, res, ctx, params) => {
      await this.write.ensurePrincipal(
        this.identityOf(ctx),
        params.agentId!,
        this.opts.autoRegisterPrincipals ?? true,
      );
      json(res, 200, {
        ok: true,
        data: await this.query().visibility(params.agentId!, this.identityOf(ctx)),
      });
    });

    this.route('POST', '/v1/principals/:agentId/visibility', async (_req, res, ctx, params, body) => {
      const agentId = params.agentId!;
      await this.write.ensurePrincipal(this.identityOf(ctx), agentId, this.opts.autoRegisterPrincipals ?? true);
      await this.write.assertOwnPrincipal(this.identityOf(ctx), agentId);
      const identity = this.identityOf(ctx);
      const op = (body as { op?: string })?.op;
      const projectKey = (body as { projectKey?: string })?.projectKey;
      const sourceId = (body as { sourceId?: string })?.sourceId;
      try {
        if (op === 'assignProject' && projectKey) {
          await this.write.assignProject(identity, agentId, projectKey);
        } else if (op === 'unassignProject' && projectKey) {
          await this.write.unassignProject(identity, agentId, projectKey);
        } else if (op === 'hide' && sourceId) {
          await this.write.hideSource(identity, agentId, sourceId);
        } else if (op === 'unhide' && sourceId) {
          await this.write.unhideSource(identity, agentId, sourceId);
        } else {
          return err(res, 400, 'bad_request', 'unknown visibility op');
        }
        json(res, 200, { ok: true, data: { op, projectKey, sourceId } });
      } catch (e) {
        if (!mapWriteError(res, e)) {
          err(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
        }
      }
    });

    this.route(
      'GET',
      '/v1/principals/:agentId/session-visibility',
      async (req, res, ctx, params) => {
        const agentId = params.agentId!;
        await this.write.ensurePrincipal(this.identityOf(ctx), agentId, this.opts.autoRegisterPrincipals ?? true);
        await this.write.assertOwnPrincipal(this.identityOf(ctx), agentId);
        const url = new URL(req.url ?? '/', 'http://local');
        const sessionId = url.searchParams.get('sessionId') ?? '';
        if (!sessionId) return err(res, 400, 'session_required', 'sessionId required');
        json(res, 200, {
          ok: true,
          data: await this.query().sessionVisibility(agentId, sessionId, this.identityOf(ctx)),
        });
      },
    );

    this.route(
      'PUT',
      '/v1/principals/:agentId/session-visibility',
      async (_req, res, ctx, params, body) => {
        const agentId = params.agentId!;
        await this.write.ensurePrincipal(this.identityOf(ctx), agentId, this.opts.autoRegisterPrincipals ?? true);
        await this.write.assertOwnPrincipal(this.identityOf(ctx), agentId);
        const b = body as {
          sessionId?: string;
          items?: Array<{ targetType?: string; targetId?: string; op?: string }>;
        };
        const sessionId = b?.sessionId;
        if (!sessionId) return err(res, 400, 'bad_request', 'sessionId required');
        try {
          const count = await this.write.replaceSessionVisibility(
            this.identityOf(ctx),
            agentId,
            sessionId,
            (b.items ?? []) as Array<{ targetType: string; targetId: string; op: string }>,
          );
          json(res, 200, { ok: true, data: { sessionId, count } });
        } catch (e) {
          if (!mapWriteError(res, e)) {
            err(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
          }
        }
      },
    );

    this.route(
      'POST',
      '/v1/principals/:agentId/session-visibility',
      async (_req, res, ctx, params, body) => {
        const agentId = params.agentId!;
        await this.write.ensurePrincipal(this.identityOf(ctx), agentId, this.opts.autoRegisterPrincipals ?? true);
        await this.write.assertOwnPrincipal(this.identityOf(ctx), agentId);
        const item = body as {
          sessionId?: string;
          targetType?: 'project' | 'source';
          targetId?: string;
          op?: 'include' | 'exclude';
        };
        if (!item?.sessionId || !item.targetType || !item.targetId || !item.op) {
          return err(res, 400, 'bad_request', 'sessionId/targetType/targetId/op required');
        }
        await this.write.setSessionVisibilityItem(this.identityOf(ctx), item.sessionId, {
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
      async (req, res, ctx, params) => {
        const agentId = params.agentId!;
        await this.write.ensurePrincipal(this.identityOf(ctx), agentId, this.opts.autoRegisterPrincipals ?? true);
        await this.write.assertOwnPrincipal(this.identityOf(ctx), agentId);
        const url = new URL(req.url ?? '/', 'http://local');
        const sessionId = url.searchParams.get('sessionId') ?? '';
        if (!sessionId) return err(res, 400, 'session_required', 'sessionId required');
        const targetType = url.searchParams.get('targetType');
        const targetId = url.searchParams.get('targetId');
        if (targetType && targetId) {
          await this.write.clearSessionVisibility(this.identityOf(ctx), sessionId, {
            targetType: targetType as 'project' | 'source',
            targetId,
          });
          json(res, 200, { ok: true, data: { sessionId, targetType, targetId } });
          return;
        }
        await this.write.clearSessionVisibility(this.identityOf(ctx), sessionId);
        json(res, 200, { ok: true, data: { sessionId, cleared: true } });
      },
    );

    this.route('GET', '/v1/jobs', async (req, res, ctx) => {
      const url = new URL(req.url ?? '/', 'http://local');
      json(res, 200, {
        ok: true,
        data: await this.query().listJobs({
          identity: this.identityOf(ctx),
          sourceId: url.searchParams.get('sourceId') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
        }),
      });
    });

    this.route('GET', '/v1/jobs/control', async (req, res, ctx) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const sourceId = url.searchParams.get('sourceId') ?? '';
      if (!sourceId) return err(res, 400, 'bad_request', 'sourceId required');
      if (!(await this.write.isSourceOwner(sourceId, ctx.gatewayId))) {
        return err(res, 403, 'not_resource_owner', 'not source owner');
      }
      const detail = await this.query().getSourceDetail(sourceId, this.identityOf(ctx));
      if (!detail) return err(res, 404, 'source_not_found', 'source not found');
      json(res, 200, { ok: true, data: detail.jobControl });
    });

    this.route('GET', '/v1/promotion-candidates', async (_req, res) => {
      json(res, 200, { ok: true, data: await this.query().promotionCandidates() });
    });
  }

  /** 拉起 ingest 运行时（Service 入口调用一次；实现落在 Writer） */
  startIngestRuntime(): void {
    void this.write.startIngestRuntime().catch((e) => {
      console.warn(
        `[Knowledge] startIngestRuntime failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  dispose(): void | Promise<void> {
    this.progressOff?.();
    this.progressOff = null;
    return this.write.dispose();
  }

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
      if (mapWriteError(res, e)) return;
      const code = (e as { code?: string }).code ?? (e instanceof Error ? e.message : 'internal_error');
      err(res, 500, 'internal_error', String(code));
    }
  };

  private authenticate(req: IncomingMessage): AuthContext | null {
    const hit = matchKnowledgeToken(this.opts.tokens, req.headers.authorization);
    if (!hit) return null;
    return { tenantId: hit.tenantId, gatewayId: hit.gatewayId };
  }
}

/**
 * 创建 HTTP 编排层（写/读端口注入；不碰 SQLite）。
 */
export function createKnowledgeHttpApp(opts: KnowledgeServiceOptions): KnowledgeHttpApp {
  return new KnowledgeHttpApp(opts);
}
