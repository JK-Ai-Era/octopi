/**
 * HTTP Channel Adapter CORS — 浏览器跨域预检必须放行 Web UI 实际使用的动词。
 */
import { describe, test, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
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

describe('HttpChannelAdapter CORS', () => {
  let adapter: HttpChannelAdapter | null = null;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = null;
    }
  });

  test('OPTIONS preflight allows PATCH/DELETE used by knowledge admin', async () => {
    const port = await freePort();
    adapter = new HttpChannelAdapter({
      port,
      host: '127.0.0.1',
      enableWebSocket: false,
    });
    await adapter.start(async () => {});

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/agents/default/knowledge/sources/ks_1`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:8180',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'content-type',
      },
    });

    expect(res.status).toBe(204);
    const allowMethods = res.headers.get('access-control-allow-methods') ?? '';
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) {
      expect(allowMethods.toUpperCase()).toContain(method);
    }
    const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    expect(allowHeaders).toContain('content-type');
    expect(allowHeaders).toContain('authorization');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
