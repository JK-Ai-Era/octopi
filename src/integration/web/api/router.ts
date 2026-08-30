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
}

export class WebApiRouter {
  private gateway: Gateway;
  private basePath: string;

  constructor(options: WebApiRouterOptions) {
    this.gateway = options.gateway;
    this.basePath = options.basePath ?? '/api/v1';
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

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

      if (relativePath === '/providers' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.getProviderSummaries(),
        });
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

        const session = await this.gateway.createSession({
          agentId: body.agentId,
          sessionId: body.sessionId,
          metadata: body.metadata,
        });

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

      const abortMatch = relativePath.match(/^\/sessions\/([^/]+)\/abort$/);
      if (abortMatch && method === 'POST') {
        this.gateway.abortSession(abortMatch[1]);
        return this.json(res, 200, { ok: true, data: { aborted: true } });
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

  private async readBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
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
