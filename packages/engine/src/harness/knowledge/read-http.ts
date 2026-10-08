/**
 * Knowledge 只读 HTTP — 主线程直达 Meta/Search Query Worker
 *
 * 禁止在此碰写连接或同步 SQLite。鉴权后的纯读请求不再进 Engine Worker，
 * ingest 占死写线程时列表/详情仍应答。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  KnowledgeQueryService,
  QueryIdentity,
  ListSourcesQuery,
} from './query-service.js';
import type { KnowledgeServiceToken } from './http-app.js';
import { matchKnowledgeToken } from './http-bridge.js';

export interface ReadHttpDeps {
  /** meta：projects / sources / detail / jobs / ready */
  meta: KnowledgeQueryService;
  /** search：search / catalog / chunks / files */
  search: KnowledgeQueryService;
  tokens: KnowledgeServiceToken[];
  /** autoRegister=false 时 principal 必须已登记；只读路径永不写库 */
  autoRegisterPrincipals?: boolean;
}

type AuthContext = {
  tenantId: string;
  gatewayId: string;
  agentId?: string;
  sessionId?: string;
};

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

function identityOf(ctx: AuthContext): QueryIdentity {
  return { tenantId: ctx.tenantId, gatewayId: ctx.gatewayId };
}

/** 纯读路由表（method + path pattern）— 与 serve 分类共用 */
export function isPureReadRoute(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/v1/ready') return true;
    if (path === '/v1/projects') return true;
    if (path === '/v1/sources') return true;
    if (/^\/v1\/sources\/[^/]+$/.test(path)) return true;
    if (/^\/v1\/sources\/[^/]+\/files$/.test(path)) return true;
    if (/^\/v1\/principals\/[^/]+$/.test(path)) return true;
    if (/^\/v1\/principals\/[^/]+\/search$/.test(path)) return true;
    if (/^\/v1\/principals\/[^/]+\/ground$/.test(path)) return true;
    if (/^\/v1\/principals\/[^/]+\/stats$/.test(path)) return true;
    if (/^\/v1\/principals\/[^/]+\/catalog$/.test(path)) return true;
    if (/^\/v1\/principals\/[^/]+\/chunks$/.test(path)) return true;
    if (/^\/v1\/principals\/[^/]+\/visibility$/.test(path)) return true;
    if (/^\/v1\/principals\/[^/]+\/session-visibility$/.test(path)) return true;
    if (path === '/v1/jobs') return true;
    if (path === '/v1/jobs/control') return true;
    if (path === '/v1/promotion-candidates') return true;
    return false;
  }
  // POST read 是语义只读
  if (method === 'POST' && /^\/v1\/principals\/[^/]+\/read$/.test(path)) return true;
  return false;
}

/**
 * 处理纯读请求。
 *
 * @returns 是否已应答（false = 非只读路由，调用方应转 Engine）
 */
export async function handleKnowledgeReadHttp(
  deps: ReadHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext,
): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://internal');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!isPureReadRoute(method, path)) return false;

  const ctx: AuthContext = { ...auth };
  const headerAgent = req.headers['x-octopi-agent'];
  const headerSession = req.headers['x-octopi-session'];
  if (typeof headerAgent === 'string' && headerAgent) ctx.agentId = headerAgent;
  if (typeof headerSession === 'string' && headerSession) ctx.sessionId = headerSession;

  const { meta, search } = deps;

  try {
    if (path === '/v1/ready') {
      json(res, 200, await meta.ready());
      return true;
    }

    if (path === '/v1/projects') {
      json(res, 200, { ok: true, data: await meta.listProjects(identityOf(ctx)) });
      return true;
    }

    if (path === '/v1/sources') {
      const scopeLevel = url.searchParams.get('scopeLevel');
      const projectKey = url.searchParams.get('projectKey') ?? undefined;
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const query: ListSourcesQuery = {
        ...(scopeLevel === 'global' || scopeLevel === 'project' || scopeLevel === 'session'
          ? { scopeLevel }
          : {}),
        ...(projectKey != null && projectKey !== '' ? { projectKey } : {}),
        ...(sessionId != null && sessionId !== '' ? { sessionId } : {}),
        identity: identityOf(ctx),
      };
      json(res, 200, { ok: true, data: await meta.listSources(query) });
      return true;
    }

    const sourceMatch = /^\/v1\/sources\/([^/]+)$/.exec(path);
    if (sourceMatch) {
      const detail = await meta.getSourceDetail(sourceMatch[1]!, identityOf(ctx));
      if (!detail) {
        err(res, 404, 'source_not_found', 'source not found');
        return true;
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
      return true;
    }

    const filesMatch = /^\/v1\/sources\/([^/]+)\/files$/.exec(path);
    if (filesMatch) {
      const sid = filesMatch[1]!;
      const owned = await meta.isSourceOwner(sid, ctx.gatewayId);
      if (!owned) {
        err(res, 403, 'not_resource_owner', 'not source owner');
        return true;
      }
      const paged =
        url.searchParams.has('page') ||
        url.searchParams.has('pageSize') ||
        url.searchParams.has('status') ||
        url.searchParams.has('ext') ||
        url.searchParams.has('q');
      if (paged) {
        const status = url.searchParams.get('status') ?? undefined;
        const data = await search.listFilesPaged(
          sid,
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
          identityOf(ctx),
        );
        json(res, 200, { ok: true, data });
        return true;
      }
      json(res, 200, { ok: true, data: await search.listFiles(sid, identityOf(ctx)) });
      return true;
    }

    const principalMatch = /^\/v1\/principals\/([^/]+)$/.exec(path);
    if (principalMatch) {
      const row = await meta.getPrincipal(identityOf(ctx), principalMatch[1]!);
      if (!row) {
        err(res, 404, 'principal_not_registered', 'principal not found');
        return true;
      }
      json(res, 200, { ok: true, data: row });
      return true;
    }

    const agentPath = /^\/v1\/principals\/([^/]+)(\/.*)?$/.exec(path);
    if (agentPath) {
      const agentId = agentPath[1]!;
      const sub = agentPath[2] ?? '';
      const principal = await meta.getPrincipal(identityOf(ctx), agentId);
      if (!principal && deps.autoRegisterPrincipals === false) {
        err(res, 403, 'principal_not_registered', 'principal not registered');
        return true;
      }
      // 只读路径不得写库，但仍须拒绝他方已登记的同名 principal（session-visibility 等）
      if (
        (sub === '/session-visibility' || sub === '/visibility') &&
        (await meta.isPrincipalForeign(identityOf(ctx), agentId))
      ) {
        err(res, 403, 'not_principal_owner', 'not principal owner');
        return true;
      }

      if (sub === '/search') {
        const q = url.searchParams.get('q') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 8);
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        json(res, 200, {
          ok: true,
          data: await search.search({
            agentId,
            q,
            sessionId,
            limit,
            identity: identityOf(ctx),
          }),
        });
        return true;
      }
      if (sub === '/ground') {
        const q = url.searchParams.get('q') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 8);
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const recallRaw = url.searchParams.get('recall');
        const recall =
          recallRaw === 'off' || recallRaw === 'hint' || recallRaw === 'hybrid' || recallRaw === 'inject'
            ? recallRaw
            : undefined;
        json(res, 200, {
          ok: true,
          data: await search.autoGround({
            agentId,
            q,
            sessionId,
            limit,
            ...(recall ? { recall } : {}),
            identity: identityOf(ctx),
          }),
        });
        return true;
      }
      if (sub === '/stats') {
        const principalStats = await search.principalStats(agentId, identityOf(ctx));
        json(res, 200, {
          ok: true,
          data: {
            ...principalStats.stats,
            visibility: principalStats.visibility,
            visibleSources: principalStats.visibleSources,
          },
        });
        return true;
      }
      if (sub === '/catalog') {
        json(res, 200, {
          ok: true,
          data: await search.catalog(agentId, identityOf(ctx)),
        });
        return true;
      }
      if (sub === '/chunks') {
        const sourceId = url.searchParams.get('sourceId') ?? '';
        const pathParam = url.searchParams.get('path') ?? '';
        if (!sourceId || !pathParam) {
          err(res, 400, 'bad_request', 'sourceId and path required');
          return true;
        }
        const data = await search.listChunks(
          agentId,
          sourceId,
          pathParam,
          identityOf(ctx),
          ctx.sessionId,
        );
        if (data == null) {
          err(res, 404, 'file_not_found', 'source not found');
          return true;
        }
        json(res, 200, { ok: true, data });
        return true;
      }
      if (sub === '/visibility' && method === 'GET') {
        json(res, 200, {
          ok: true,
          data: await meta.visibility(agentId, identityOf(ctx)),
        });
        return true;
      }
      if (sub === '/session-visibility' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        if (!sessionId) {
          err(res, 400, 'session_required', 'sessionId required');
          return true;
        }
        json(res, 200, {
          ok: true,
          data: await meta.sessionVisibility(agentId, sessionId, identityOf(ctx)),
        });
        return true;
      }
      if (sub === '/read' && method === 'POST') {
        const raw = await readJsonBody(req);
        const b = raw as { chunkId?: string; sourceId?: string; path?: string };
        if (!b?.chunkId && (!b?.sourceId || !b?.path)) {
          err(res, 400, 'bad_request', 'chunkId or (sourceId+path) required');
          return true;
        }
        if (b.chunkId) {
          const data = await search.read(agentId, b, identityOf(ctx), ctx.sessionId);
          if (!data.found) {
            err(res, 404, 'file_not_found', 'chunk not found');
            return true;
          }
          json(res, 200, { ok: true, data });
          return true;
        }
        const chunks = await search.listChunks(
          agentId,
          b.sourceId!,
          b.path!,
          identityOf(ctx),
          ctx.sessionId,
        );
        if (chunks == null) {
          err(res, 404, 'source_not_found', 'source not found');
          return true;
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
        return true;
      }
    }

    if (path === '/v1/jobs') {
      json(res, 200, {
        ok: true,
        data: await meta.listJobs({
          identity: identityOf(ctx),
          sourceId: url.searchParams.get('sourceId') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
        }),
      });
      return true;
    }

    if (path === '/v1/jobs/control') {
      const sourceId = url.searchParams.get('sourceId') ?? '';
      if (!sourceId) {
        err(res, 400, 'bad_request', 'sourceId required');
        return true;
      }
      const owned = await meta.isSourceOwner(sourceId, ctx.gatewayId);
      if (!owned) {
        err(res, 403, 'not_resource_owner', 'not source owner');
        return true;
      }
      const detail = await meta.getSourceDetail(sourceId, identityOf(ctx));
      if (!detail) {
        err(res, 404, 'source_not_found', 'source not found');
        return true;
      }
      json(res, 200, { ok: true, data: detail.jobControl });
      return true;
    }

    if (path === '/v1/promotion-candidates') {
      json(res, 200, { ok: true, data: await meta.promotionCandidates() });
      return true;
    }

    err(res, 404, 'not_found', `no route ${method} ${path}`);
    return true;
  } catch (e) {
    err(res, 500, 'internal_error', e instanceof Error ? e.message : String(e));
    return true;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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

/** 主线程鉴权（与 Engine 同一 token 表） */
export function authenticateRead(
  tokens: KnowledgeServiceToken[],
  req: IncomingMessage,
): AuthContext | null {
  const hit = matchKnowledgeToken(tokens, req.headers.authorization);
  if (!hit) return null;
  return { tenantId: hit.tenantId, gatewayId: hit.gatewayId };
}
