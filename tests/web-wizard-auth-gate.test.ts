/**
 * Web 向导面在默认全新部署上的可达性回归锚。
 *
 * 根因（v0.121.12 修复）：init 默认生成随机 `channels[type=http].apiKey`（B-1），
 * 于是 `HttpChannelAdapter` 的 Bearer 闸开启；而 Web 向导只带 `X-Setup-Token`。
 * 闸门在 `onRequest`（router 的 setup-token 闸）之前判 401，向导面在它唯一该生效的
 * 场景（全新部署）上永远不可达，报错文案是 `Unauthorized: invalid or missing API key`。
 *
 * 修法：自鉴权面（`apiKeyExemptPaths`）由 router 声明、adapter 消费；该面由 §7
 * setup-token 闸独自把关，其他 /api/v1 面仍强制 Bearer。
 */
import { describe, test, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { HttpChannelAdapter, isSameOrSubPath } from '@octopi-agent/gateway/protocols/http.js';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const address = srv.address();
  if (typeof address === 'string' || address === null) throw new Error('expected TCP address');
  const { port } = address;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe('Web 向导面鉴权（自鉴权豁免）', () => {
  let adapter: HttpChannelAdapter | null = null;
  afterEach(async () => {
    await adapter?.stop();
    adapter = null;
  });

  async function startWithWizardExempt(): Promise<{ port: number; hits: string[] }> {
    const port = await freePort();
    const hits: string[] = [];
    adapter = new HttpChannelAdapter({
      port,
      host: '127.0.0.1',
      enableWebSocket: false,
      apiKey: 'scaffolded-random-key',
      apiKeyExemptPaths: ['/api/v1/onboarding'],
      onRequest: (req, res) => {
        hits.push(req.url ?? '');
        if (req.url?.startsWith('/api/v1/onboarding')) {
          // 模拟 router：该面自己判凭证（loopback 免闸 / 远程验 setup token）
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, data: { available: true } }));
          return true;
        }
        if (req.url?.startsWith('/api/v1/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return true;
        }
        return false;
      },
    });
    await adapter.start(async () => {});
    return { port, hits };
  }

  test('X-Setup-Token 请求能到达 router（不再被 Bearer 闸 401）', async () => {
    const { port, hits } = await startWithWizardExempt();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/onboarding/availability`, {
      headers: { 'X-Setup-Token': 'tok-from-terminal' },
    });
    expect(res.status).toBe(200);
    expect(hits).toEqual(['/api/v1/onboarding/availability']);
  });

  test('豁免面之外的 /api/v1 仍需 Bearer（豁免不外溢）', async () => {
    const { port } = await startWithWizardExempt();
    const denied = await fetch(`http://127.0.0.1:${port}/api/v1/agents`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/api/v1/agents`, {
      headers: { Authorization: 'Bearer scaffolded-random-key' },
    });
    expect(ok.status).toBe(200);
  });

  test('未登记豁免路径的适配器行为不变（默认空列表）', async () => {
    const port = await freePort();
    adapter = new HttpChannelAdapter({
      port,
      host: '127.0.0.1',
      enableWebSocket: false,
      apiKey: 'k',
      onRequest: (_req, res) => {
        res.writeHead(200);
        res.end('{}');
        return true;
      },
    });
    await adapter.start(async () => {});
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/onboarding/availability`);
    expect(res.status).toBe(401);
  });

  test('router 声明的自鉴权前缀从 basePath 派生（单源，无硬编码漂移）', () => {
    const router = new WebApiRouter({
      gateway: { getRegisteredAgents: () => [] } as unknown as ConstructorParameters<typeof WebApiRouter>[0]['gateway'],
        basePath: '/api/v1',
    });
    expect(router.selfAuthPathPrefixes()).toEqual(['/api/v1/onboarding']);
  });
});

describe('isSameOrSubPath（豁免匹配按路径段，不允许旁路）', () => {
  const PREFIX = '/api/v1/onboarding';

  test('命中：自身与子路径（query 不影响判定）', () => {
    expect(isSameOrSubPath('/api/v1/onboarding', PREFIX)).toBe(true);
    expect(isSameOrSubPath('/api/v1/onboarding?setup=tok', PREFIX)).toBe(true);
    expect(isSameOrSubPath('/api/v1/onboarding/availability', PREFIX)).toBe(true);
    expect(isSameOrSubPath('/api/v1/onboarding/session/event', PREFIX)).toBe(true);
  });

  test('不命中：同前缀异名路径（豁免不得随命名扩散）', () => {
    expect(isSameOrSubPath('/api/v1/onboardingX', PREFIX)).toBe(false);
    expect(isSameOrSubPath('/api/v1/onboarding-admin', PREFIX)).toBe(false);
  });

  test('不命中：路径穿越（含编码与反斜杠形态）', () => {
    expect(isSameOrSubPath('/api/v1/onboarding/../agents', PREFIX)).toBe(false);
    expect(isSameOrSubPath('/api/v1/onboarding/%2E%2E/agents', PREFIX)).toBe(false);
    expect(isSameOrSubPath('/api/v1/onboardingX/../agents', PREFIX)).toBe(false);
    // P0 回归锚：WHATWG URL 把 `\` 当 `/`（归一化成 /api/v1/agents），
    // 若按 '/' 拆段判定则看不到 `..` 段 → 曾放行到全部 /api/v1 面。
    expect(isSameOrSubPath('/api/v1/onboarding/..\\agents', PREFIX)).toBe(false);
    expect(isSameOrSubPath('/api/v1/onboarding%5c..%5cagents', PREFIX)).toBe(false);
  });

  test('不命中：大小写不同与非法输入（fail-closed 走正常鉴权）', () => {
    expect(isSameOrSubPath('/API/V1/ONBOARDING', PREFIX)).toBe(false);
    expect(isSameOrSubPath('/api/v1/onboarding/%E0%A4%A', PREFIX)).toBe(false);
  });

  test('绝对 URL 只按 pathname 命中（不是凭整串豁免）', () => {
    // req.url 在 Node HTTP 里是 origin-form；即便有人塞绝对 URL，判据仍只认 pathname，
    // prefix 吻合就豁免、不吻合就挡——host 不参与判定，因此不构成旁路。
    expect(isSameOrSubPath('http://evil.example/api/v1/onboarding', PREFIX)).toBe(true);
    expect(isSameOrSubPath('http://evil.example/api/v1/agents', PREFIX)).toBe(false);
  });
});

describe('裸 socket 复现：反斜杠穿越不得借豁免通过', () => {
  let adapter: HttpChannelAdapter | null = null;
  afterEach(async () => {
    await adapter?.stop();
    adapter = null;
  });

  /**
   * 用 node:net 直接写 request-line（fetch/curl 会在客户端归一化 `..\\`，测不出来）。
   *
   * @returns 状态码
   */
  async function rawGet(port: number, rawPath: string): Promise<number> {
    const { connect } = await import('node:net');
    return await new Promise<number>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      sock.once('data', (chunk) => {
        const line = chunk.toString().split('\r\n')[0] ?? '';
        const code = Number(line.split(' ')[1]);
        sock.destroy();
        resolve(code);
      });
      sock.once('error', reject);
    });
  }

  test('GET /api/v1/onboarding/..\\\\agents 必须 401（不是 200）', async () => {
    const port = await freePort();
    adapter = new HttpChannelAdapter({
      port,
      host: '127.0.0.1',
      enableWebSocket: false,
      apiKey: 'k',
      apiKeyExemptPaths: ['/api/v1/onboarding'],
      onRequest: (_req, res) => {
        // 模拟 router：真实 router 会把 `..\agents` 归一化成 /api/v1/agents 并放行进业务面
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return true;
      },
    });
    await adapter.start(async () => {});
    expect(await rawGet(port, '/api/v1/onboarding/..\\agents')).toBe(401);
  });
});
