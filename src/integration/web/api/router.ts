/**
 * Web API Router for Gateway HTTP Channel
 *
 * 第一版 REST 骨架，用于 Web Runtime。
 * 优先覆盖：health、agents、sessions、messages、abort、providers、approvals、memory。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Gateway } from '../../gateway/gateway.js';

export interface WebApiRouterOptions {
  gateway: Gateway;
  basePath?: string;
  /** JSON 请求体大小上限（字节），默认 1MB。文件上传应使用独立端点。 */
  maxBodyBytes?: number;
}

export class WebApiRouter {
  private gateway: Gateway;
  private basePath: string;
  private maxBodyBytes: number;

  constructor(options: WebApiRouterOptions) {
    this.gateway = options.gateway;
    this.basePath = options.basePath ?? '/api/v1';
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Debug 面（不在 /api/v1 下）：Observer Run Observatory
    if (path.startsWith('/debug/run/')) {
      return this.handleDebugRun(req, res, url);
    }

    if (!path.startsWith(this.basePath)) {
      return false;
    }

    const relativePath = decodeURIComponent(path.slice(this.basePath.length) || '/');
    const method = req.method?.toUpperCase() ?? 'GET';

    try {
      if (relativePath === '/health' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: {
            status: 'ok',
            agents: this.gateway.getRegisteredAgents(),
          },
        });
      }

      if (relativePath === '/agents' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.getRegisteredAgents(),
        });
      }

      if (relativePath === '/models' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.getModelCatalog(),
        });
      }

      if (relativePath === '/providers' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.getProviderSummaries(),
        });
      }

      if (relativePath === '/commands' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.getCommandCatalog(),
        });
      }

      if (relativePath === '/issues' && method === 'GET') {
        const status = url.searchParams.get('status') as 'open' | 'resolved' | 'dismissed' | null;
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.listSystemIssues(status ?? undefined),
        });
      }

      const issueDismissMatch = relativePath.match(/^\/issues\/([^/]+)\/dismiss$/);
      if (issueDismissMatch && method === 'POST') {
        this.gateway.getIssueRegistry().dismiss(issueDismissMatch[1]);
        return this.json(res, 200, { ok: true, data: { id: issueDismissMatch[1], status: 'dismissed' } });
      }

      if (relativePath === '/sessions' && method === 'GET') {
        const agentId = url.searchParams.get('agentId') ?? undefined;
        const sessions = await this.gateway.listSessions(agentId);
        return this.json(res, 200, { ok: true, data: sessions });
      }

      if (relativePath === '/sessions' && method === 'POST') {
        const body = await this.readBody(req);
        if (!body?.agentId) {
          return this.json(res, 400, { ok: false, error: 'agentId is required' });
        }

        const metadata = { ...(body.metadata ?? {}) };
        if (typeof body.model === 'string' && body.model) {
          metadata.model = body.model;
        }

        const session = await this.gateway.createSession({
          agentId: body.agentId,
          sessionId: body.sessionId,
          metadata,
        });

        // 与 setSessionModel 同源校验/规范化 model 引用
        if (typeof body.model === 'string' && body.model) {
          try {
            await this.gateway.setSessionModel(session.id, body.model, body.agentId);
          } catch (err) {
            return this.json(res, 400, {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return this.json(res, 201, { ok: true, data: session });
      }

      const sessionMatch = relativePath.match(/^\/sessions\/([^/]+)$/);
      if (sessionMatch && method === 'GET') {
        const session = await this.gateway.getSessionView(sessionMatch[1]);
        if (!session) {
          return this.json(res, 404, { ok: false, error: 'Session not found' });
        }

        return this.json(res, 200, { ok: true, data: session });
      }

      const messageMatch = relativePath.match(/^\/sessions\/([^/]+)\/messages$/);
      if (messageMatch && method === 'GET') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50'), 1), 200);
        const cursor = url.searchParams.get('cursor') ?? undefined;
        const page = await this.gateway.getSessionMessages(messageMatch[1], { limit, cursor });
        return this.json(res, 200, { ok: true, data: page });
      }

      const tasksMatch = relativePath.match(/^\/sessions\/([^/]+)\/tasks$/);
      if (tasksMatch && method === 'GET') {
        const agentId = url.searchParams.get('agentId') ?? undefined;
        try {
          const tasks = await this.gateway.getSessionTasks(tasksMatch[1], agentId ?? undefined);
          return this.json(res, 200, { ok: true, data: tasks ?? [] });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) {
            return this.json(res, 404, { ok: false, error: message });
          }
          throw err;
        }
      }

      const abortMatch = relativePath.match(/^\/sessions\/([^/]+)\/abort$/);
      if (abortMatch && method === 'POST') {
        this.gateway.abortSession(abortMatch[1]);
        return this.json(res, 200, { ok: true, data: { aborted: true } });
      }

      const sessionModelMatch = relativePath.match(/^\/sessions\/([^/]+)\/model$/);
      if (sessionModelMatch && method === 'GET') {
        const agentId = url.searchParams.get('agentId') ?? undefined;
        const view = await this.gateway.getSessionModel(sessionModelMatch[1], agentId);
        if (!view) {
          return this.json(res, 404, { ok: false, error: 'Session not found' });
        }
        return this.json(res, 200, { ok: true, data: view });
      }

      if (sessionModelMatch && (method === 'POST' || method === 'PUT')) {
        const body = await this.readBody(req);
        const agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
        const modelRef = body.model === null || body.model === undefined
          ? null
          : String(body.model);
        try {
          const view = await this.gateway.setSessionModel(sessionModelMatch[1], modelRef, agentId);
          return this.json(res, 200, { ok: true, data: view });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) {
            return this.json(res, 404, { ok: false, error: message });
          }
          return this.json(res, 400, { ok: false, error: message });
        }
      }

      const compactMatch = relativePath.match(/^\/sessions\/([^/]+)\/compact$/);
      if (compactMatch && method === 'POST') {
        const body = await this.readBody(req);
        const agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
        try {
          const result = await this.gateway.compactSession(compactMatch[1], agentId);
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) {
            return this.json(res, 404, { ok: false, error: message });
          }
          return this.json(res, 400, { ok: false, error: message });
        }
      }

      const contextLayersMatch = relativePath.match(/^\/sessions\/([^/]+)\/context\/layers$/);
      if (contextLayersMatch && method === 'GET') {
        const snapshot = this.gateway.getSessionContextLayers(contextLayersMatch[1]);
        return this.json(res, 200, { ok: true, data: snapshot });
      }

      // 旧 run 路径已迁 /debug/run/...（调试面，非稳定产品 API）
      const agentHealthMatch = relativePath.match(/^\/agents\/([^/]+)\/context\/health$/);
      if (agentHealthMatch && method === 'GET') {
        const health = await this.gateway.getAgentContextHealth(agentHealthMatch[1]);
        return this.json(res, 200, { ok: true, data: health });
      }

      // ── Knowledge sources（Host 管理面；arch/knowledge-layer.md §6 / knowledge-admin-ui.md §4）──
      const knowledgeStatsMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/stats$/);
      if (knowledgeStatsMatch && method === 'GET') {
        const stats = await this.gateway.getKnowledgeStats();
        return this.json(res, 200, { ok: true, data: stats });
      }

      const knowledgeProjectsMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/projects$/);
      if (knowledgeProjectsMatch && method === 'GET') {
        const projects = await this.gateway.listKnowledgeProjects();
        return this.json(res, 200, { ok: true, data: projects });
      }
      if (knowledgeProjectsMatch && method === 'POST') {
        const body = await this.readBody(req);
        const projectKey = typeof body?.projectKey === 'string' ? body.projectKey.trim() : '';
        if (!projectKey) {
          return this.json(res, 400, { ok: false, error: 'projectKey is required' });
        }
        await this.gateway.createKnowledgeProject(
          projectKey,
          typeof body?.displayName === 'string' ? body.displayName : undefined,
        );
        return this.json(res, 201, { ok: true, data: { projectKey } });
      }

      const knowledgeProjectMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/projects\/([^/]+)$/,
      );
      if (knowledgeProjectMatch && method === 'DELETE') {
        try {
          const removed = await this.gateway.removeKnowledgeProject(knowledgeProjectMatch[2]);
          return this.json(res, 200, {
            ok: true,
            data: { projectKey: knowledgeProjectMatch[2], removed },
          });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const knowledgeSearchMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/search$/);
      if (knowledgeSearchMatch && method === 'GET') {
        const q = url.searchParams.get('q')?.trim() ?? '';
        if (!q) return this.json(res, 400, { ok: false, error: 'q is required' });
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const limitRaw = Number(url.searchParams.get('limit') ?? '');
        const result = await this.gateway.searchKnowledge(q, {
          agentId: knowledgeSearchMatch[1],
          sessionId,
          limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 20) : 8,
        });
        return this.json(res, 200, {
          ok: true,
          data: {
            usedVector: result.usedVector,
            coverage: result.coverage,
            keywordHits: result.keywordHits,
            vectorHits: result.vectorHits,
            hits: result.hits.map((h) => ({
              sourceId: h.sourceId,
              path: h.path,
              startLine: h.startLine,
              endLine: h.endLine,
              score: h.score,
              snippet: h.text.slice(0, 400),
            })),
          },
        });
      }

      const knowledgeSessionVisMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/session-visibility$/,
      );
      if (knowledgeSessionVisMatch && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          return this.json(res, 400, { ok: false, error: 'sessionId is required' });
        }
        const items = await this.gateway.getKnowledgeSessionVisibility(sessionId);
        return this.json(res, 200, { ok: true, data: items });
      }
      if (knowledgeSessionVisMatch && method === 'PUT') {
        const body = await this.readBody(req);
        const sessionId = String(body?.sessionId ?? '');
        if (!sessionId) return this.json(res, 400, { ok: false, error: 'sessionId is required' });
        const rawItems = Array.isArray(body?.items) ? body.items : [];
        const items: Array<{
          targetType: 'project' | 'source';
          targetId: string;
          op: 'include' | 'exclude';
        }> = [];
        for (const raw of rawItems) {
          const targetType = raw?.targetType as 'project' | 'source' | undefined;
          const targetId = typeof raw?.targetId === 'string' ? raw.targetId : '';
          const op = raw?.op as 'include' | 'exclude' | undefined;
          if (
            !targetId ||
            (targetType !== 'project' && targetType !== 'source') ||
            (op !== 'include' && op !== 'exclude')
          ) {
            return this.json(res, 400, {
              ok: false,
              error: 'items[].targetType(project|source), targetId, op(include|exclude) required',
            });
          }
          items.push({ targetType, targetId, op });
        }
        await this.gateway.replaceKnowledgeSessionVisibility(sessionId, items);
        return this.json(res, 200, { ok: true, data: { sessionId, count: items.length } });
      }
      if (knowledgeSessionVisMatch && method === 'POST') {
        const body = await this.readBody(req);
        const sessionId = String(body?.sessionId ?? '');
        const targetType = body?.targetType as 'project' | 'source' | undefined;
        const targetId = typeof body?.targetId === 'string' ? body.targetId : '';
        const op = body?.op as 'include' | 'exclude' | undefined;
        if (
          !sessionId ||
          !targetId ||
          (targetType !== 'project' && targetType !== 'source') ||
          (op !== 'include' && op !== 'exclude')
        ) {
          return this.json(res, 400, {
            ok: false,
            error:
              'sessionId, targetType(project|source), targetId, op(include|exclude) are required',
          });
        }
        await this.gateway.setKnowledgeSessionVisibility(sessionId, { targetType, targetId, op });
        return this.json(res, 200, { ok: true, data: { sessionId, targetType, targetId, op } });
      }
      if (knowledgeSessionVisMatch && method === 'DELETE') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          return this.json(res, 400, { ok: false, error: 'sessionId is required' });
        }
        const targetType = url.searchParams.get('targetType') as 'project' | 'source' | null;
        const targetId = url.searchParams.get('targetId');
        if (targetType && targetId) {
          await this.gateway.clearKnowledgeSessionVisibility(sessionId, {
            targetType,
            targetId,
          });
        } else {
          await this.gateway.clearKnowledgeSessionVisibility(sessionId);
        }
        return this.json(res, 200, { ok: true, data: { sessionId } });
      }

      const knowledgeVisibilitySummaryMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/visibility$/,
      );
      if (knowledgeVisibilitySummaryMatch && method === 'GET') {
        const summary = await this.gateway.getKnowledgeVisibility(knowledgeVisibilitySummaryMatch[1]);
        return this.json(res, 200, { ok: true, data: summary });
      }

      const knowledgePromoMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/promotion-candidates$/,
      );
      if (knowledgePromoMatch && method === 'GET') {
        const candidates = await this.gateway.getKnowledgePromotionCandidates();
        // 只返回严格门槛（≥minSessions 且 ≥minHits）；宽松命中见 meetsThreshold 字段
        const strict = candidates.filter((c) => c.meetsThreshold);
        return this.json(res, 200, {
          ok: true,
          data: { strict, all: candidates },
        });
      }

      const knowledgeSourcesMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/sources$/);
      if (knowledgeSourcesMatch && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const scopeLevel = url.searchParams.get('scopeLevel') as
          | 'global'
          | 'project'
          | 'session'
          | null;
        const projectKey = url.searchParams.get('projectKey') ?? undefined;
        if (scopeLevel === 'session' && !sessionId?.trim()) {
          return this.json(res, 400, {
            ok: false,
            error: 'sessionId is required when scopeLevel=session',
          });
        }
        try {
          const sources = await this.gateway.listKnowledgeSources(knowledgeSourcesMatch[1], {
            sessionId,
            scopeLevel: scopeLevel ?? undefined,
            projectKey,
          });
          return this.json(res, 200, { ok: true, data: sources });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (knowledgeSourcesMatch && method === 'POST') {
        const body = await this.readBody(req);
        const kind = body?.kind as string | undefined;
        const level = body?.scopeRef?.level as string | undefined;
        const allowedKinds = new Set(['workspace', 'directory', 'file', 'url', 'connector']);
        const allowedLevels = new Set(['global', 'project', 'session']);
        if (!kind || !allowedKinds.has(kind) || !body?.location || !level || !allowedLevels.has(level) || !body?.scopeRef?.key) {
          return this.json(res, 400, {
            ok: false,
            error:
              'kind(workspace|directory|file|url|connector), location, scopeRef.level(global|project|session), scopeRef.key are required',
          });
        }
        try {
          const source = await this.gateway.createKnowledgeSource(body);
          return this.json(res, 201, { ok: true, data: source });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const knowledgeSourceFilesMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)\/files$/,
      );
      if (knowledgeSourceFilesMatch && method === 'GET') {
        const files = await this.gateway.listKnowledgeSourceFiles(knowledgeSourceFilesMatch[2]);
        return this.json(res, 200, { ok: true, data: files });
      }

      const knowledgeChunksMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/chunks$/);
      if (knowledgeChunksMatch && method === 'GET') {
        const sourceId = url.searchParams.get('sourceId') ?? '';
        const path = url.searchParams.get('path') ?? '';
        if (!sourceId || !path) {
          return this.json(res, 400, { ok: false, error: 'sourceId and path are required' });
        }
        const chunks = await this.gateway.listKnowledgeChunks(sourceId, path);
        return this.json(res, 200, { ok: true, data: chunks });
      }

      const knowledgeSourceMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)$/,
      );
      if (knowledgeSourceMatch && method === 'GET') {
        const detail = await this.gateway.getKnowledgeSourceDetail(knowledgeSourceMatch[2]);
        if (!detail) return this.json(res, 404, { ok: false, error: 'source not found' });
        return this.json(res, 200, { ok: true, data: detail });
      }
      if (knowledgeSourceMatch && method === 'PATCH') {
        const body = await this.readBody(req);
        const updated = await this.gateway.updateKnowledgeSource(knowledgeSourceMatch[2], body ?? {});
        if (!updated) return this.json(res, 404, { ok: false, error: 'source not found' });
        return this.json(res, 200, { ok: true, data: updated });
      }
      if (knowledgeSourceMatch && method === 'DELETE') {
        const removed = await this.gateway.removeKnowledgeSource(knowledgeSourceMatch[2]);
        if (!removed) return this.json(res, 404, { ok: false, error: 'source not found' });
        return this.json(res, 200, { ok: true, data: { id: knowledgeSourceMatch[2], removed: true } });
      }

      const knowledgeReindexMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)\/reindex$/,
      );
      if (knowledgeReindexMatch && method === 'POST') {
        const body = await this.readBody(req).catch(() => ({}));
        try {
          const result = await this.gateway.reindexKnowledgeSource(knowledgeReindexMatch[2], {
            full: Boolean(body?.full),
            watch: body?.watch !== false,
          });
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const knowledgeVisibilityMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/visibility$/,
      );
      if (knowledgeVisibilityMatch && method === 'POST') {
        const body = await this.readBody(req);
        const op = body?.op as 'assignProject' | 'unassignProject' | 'hide' | 'unhide' | undefined;
        if (!op || !['assignProject', 'unassignProject', 'hide', 'unhide'].includes(op)) {
          return this.json(res, 400, {
            ok: false,
            error: 'op must be assignProject|unassignProject|hide|unhide',
          });
        }
        try {
          await this.gateway.setKnowledgeVisibility({
            op,
            agentId: knowledgeVisibilityMatch[1],
            projectKey: typeof body.projectKey === 'string' ? body.projectKey : undefined,
            sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
          });
          return this.json(res, 200, { ok: true, data: { op } });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (relativePath === '/approvals' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.listPendingApprovals(),
        });
      }

      const approvalMatch = relativePath.match(/^\/approvals\/([^/]+)$/);
      if (approvalMatch && method === 'POST') {
        const body = await this.readBody(req);
        if (!body?.action || !['approve', 'reject'].includes(body.action)) {
          return this.json(res, 400, { ok: false, error: 'action must be approve or reject' });
        }

        const resolved = this.gateway.resolvePendingApproval(approvalMatch[1], {
          action: body.action,
          reason: body.reason,
        });

        if (!resolved) {
          return this.json(res, 404, { ok: false, error: 'Approval not found' });
        }

        return this.json(res, 200, { ok: true, data: resolved });
      }

      if (relativePath === '/memory/stats' && method === 'GET') {
        const stats = await this.gateway.getMemoryStats();
        if (!stats) {
          return this.json(res, 200, {
            ok: true,
            data: { configured: false },
          });
        }

        return this.json(res, 200, { ok: true, data: { configured: true, ...stats } });
      }

      if (relativePath === '/memory/query' && method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '10'), 1), 50);
        const page = await this.gateway.queryMemory({ q, limit });
        if (!page) {
          return this.json(res, 200, {
            ok: true,
            data: { configured: false },
          });
        }

        return this.json(res, 200, { ok: true, data: { configured: true, ...page } });
      }

      return this.json(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.json(res, 500, { ok: false, error: message });
    }
  }

  /**
   * Debug 面：Observer Run Observatory
   *
   * 路径（根路径，不在 /api/v1 下）：
   * - GET /debug/run/:sessionId/scope
   * - GET /debug/run/:sessionId/messages?phase=&runId=&view=
   *
   * 非稳定产品 API；受 observer.level / webPanel 门控。
   */
  private async handleDebugRun(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = (_req.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      return this.json(res, 405, { ok: false, error: 'Method not allowed' });
    }
    const match = url.pathname.match(/^\/debug\/run\/([^/]+)\/(scope|messages)$/);
    if (!match) {
      return this.json(res, 404, { ok: false, error: 'Not found' });
    }
    const sessionId = decodeURIComponent(match[1]!);
    const kind = match[2];
    try {
      const hub = this.gateway.getObserverHub();
      if (kind === 'scope') {
        const snapshot = this.gateway.getSessionRunObservatory(sessionId);
        return this.json(res, 200, {
          ok: true,
          data: snapshot,
          observer: hub.getStatus(),
        });
      }
      const phaseParam = url.searchParams.get('phase');
      const runId = url.searchParams.get('runId') ?? undefined;
      const viewParam = url.searchParams.get('view');
      const view = viewParam === 'llm' ? 'llm' : 'workspace';
      const phase = view === 'llm' ? 'llm' : phaseParam === 'entry' ? 'entry' : 'final';
      const snapshot = this.gateway.getSessionRunMessages(sessionId, {
        phase: phase as 'entry' | 'final' | 'llm',
        runId,
        view,
      });
      return this.json(res, 200, {
        ok: true,
        data: snapshot,
        observer: hub.getStatus(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.json(res, 500, { ok: false, error: message });
    }
  }

  private async readBody(req: IncomingMessage): Promise<any> {
    const maxBytes = this.maxBodyBytes;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > maxBytes) {
        throw new Error(`Request body too large (limit: ${Math.round(maxBytes / 1024)}KB)`);
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) {
      return {};
    }

    return JSON.parse(raw);
  }

  private json(res: ServerResponse, status: number, payload: unknown): boolean {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
    return true;
  }
}
