/**
 * HTTP Channel Adapter 鉴权闸门 — 设置 apiKey 后，
 * 除 OPTIONS / GET /health 外的一切请求（含 onRequest 扩展路由）必须过鉴权。
 */
import { describe, test, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpChannelAdapter } from '@octopi-agent/gateway/protocols/http.js';

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const address = srv.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('expected TCP address');
  }
  const { port } = address;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe('HttpChannelAdapter auth gate', () => {
  let adapter: HttpChannelAdapter | null = null;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = null;
    }
  });

  async function startWithAuth(opts?: {
    onRequest?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
  }): Promise<{ port: number; onRequestHits: string[] }> {
    const port = await freePort();
    const onRequestHits: string[] = [];
    adapter = new HttpChannelAdapter({
      port,
      host: '127.0.0.1',
      enableWebSocket: false,
      apiKey: 'secret-key',
      onRequest: opts?.onRequest
        ? (req, res) => {
            onRequestHits.push(req.url ?? '');
            return opts.onRequest!(req, res);
          }
        : (req, res) => {
            onRequestHits.push(req.url ?? '');
            if (req.url?.startsWith('/api/v1/')) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
              return true;
            }
            return false;
          },
    });
    await adapter.start(async () => {});
    return { port, onRequestHits };
  }

  test('GET /health stays public', async () => {
    const { port } = await startWithAuth();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; auth: boolean };
    expect(body.status).toBe('ok');
    expect(body.auth).toBe(true);
  });

  test('onRequest /api/v1 is rejected without token', async () => {
    const { port, onRequestHits } = await startWithAuth();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/agents`);
    expect(res.status).toBe(401);
    // 闸门在 onRequest 之前：扩展路由不得先跑业务
    expect(onRequestHits).toHaveLength(0);
  });

  test('onRequest /api/v1 accepts valid Bearer token', async () => {
    const { port, onRequestHits } = await startWithAuth();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/agents`, {
      headers: { Authorization: 'Bearer secret-key' },
    });
    expect(res.status).toBe(200);
    expect(onRequestHits).toEqual(['/api/v1/agents']);
  });

  test('onRequest /debug/run also requires token', async () => {
    const { port, onRequestHits } = await startWithAuth();
    const res = await fetch(`http://127.0.0.1:${port}/debug/run/abc`);
    expect(res.status).toBe(401);
    expect(onRequestHits).toHaveLength(0);
  });

  test('/metrics requires token', async () => {
    const { port } = await startWithAuth();
    const denied = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Authorization: 'Bearer secret-key' },
    });
    expect(ok.status).toBe(200);
  });

  test('POST /messages requires token', async () => {
    const { port } = await startWithAuth();
    const denied = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(denied.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-key',
      },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(ok.status).toBe(202);
  });

  test('without apiKey all routes stay open', async () => {
    const port = await freePort();
    adapter = new HttpChannelAdapter({
      port,
      host: '127.0.0.1',
      enableWebSocket: false,
      onRequest: (req, res) => {
        if (req.url?.startsWith('/api/v1/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return true;
        }
        return false;
      },
    });
    await adapter.start(async () => {});
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/agents`);
    expect(res.status).toBe(200);
  });
});
