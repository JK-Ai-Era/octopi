/**
 * 连通性探测：`/models` 不可用时的对话探针回退
 *
 * 背景（两条都是真实故障）：
 * - MiMo 的 Anthropic 端点 `https://api.xiaomimimo.com/anthropic` 没有 `/v1/models` → 404；
 * - 火山方舟 `https://ark.cn-beijing.volces.com/api/plan` **先鉴权后路由**，
 *   任何路径未带 key 都回 401，401 并不能证明 key 无效。
 *
 * 设置页「测试连通并拉取模型列表」走 `discoverProviderModels`，向导测通走
 * `provider.isAvailable()`——两条路径都必须把「清单不可用」与「端点/鉴权不可用」分开报。
 *
 * 本文件用真实本地 HTTP 服务验证（不 mock provider/discover 内部实现）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverProviderModels } from '../packages/engine/src/config-admin/discover.js';
import { OpenAIProvider } from '../packages/engine/src/integration/providers/openai.js';
import { AnthropicProvider } from '../packages/engine/src/integration/providers/anthropic.js';

interface Behavior {
  /** GET .../models 的状态码；undefined = 该路由不存在（404） */
  modelsStatus?: number;
  /** POST 对话类路由的状态码，缺省 200 */
  chatStatus?: number;
}

interface Call {
  path: string;
  method: string;
  authorization?: string;
  apiKeyHeader?: string;
  anthropicVersion?: string;
  body?: string;
}

let behavior: Behavior = {};
let calls: Call[] = [];
let server: Server;
let origin = '';

const json = (res: ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    const path = req.url ?? '';
    calls.push({
      path,
      method: req.method ?? '',
      authorization: req.headers.authorization as string | undefined,
      apiKeyHeader: req.headers['x-api-key'] as string | undefined,
      anthropicVersion: req.headers['anthropic-version'] as string | undefined,
      body,
    });

    if (path.endsWith('/models')) {
      if (behavior.modelsStatus === undefined) {
        return json(res, 404, { message: 'no Route matched with those values' });
      }
      return json(res, behavior.modelsStatus, { data: [{ id: 'listed-model' }] });
    }
    if (path.endsWith('/chat/completions') || path.endsWith('/v1/messages')) {
      const status = behavior.chatStatus ?? 200;
      return json(res, status, status === 200 ? { id: 'x', choices: [] } : { error: 'nope' });
    }
    return json(res, 404, { message: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterEach(() => {
  behavior = {};
  calls = [];
});

const chatCalls = () => calls.filter((c) => !c.path.endsWith('/models'));

describe('discoverProviderModels：openai-completions', () => {
  const baseUrl = () => `${origin}/v1`;

  it('/models 404 + 对话 200 → 连通成立，回填已知模型清单', async () => {
    behavior = { chatStatus: 200 };
    const res = await discoverProviderModels({
      baseUrl: baseUrl(),
      apiKey: 'sk-test',
      api: 'openai-completions',
      probeModel: 'mistral-large-4',
      knownModels: [
        { id: 'mistral-large-4', name: 'Mistral Large 4' },
        { id: 'mistral-small-4' },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(true);
    expect(res.models.map((m) => m.id)).toEqual(['mistral-large-4', 'mistral-small-4']);
    expect(res.note).toContain('最小对话请求');
  });

  it('/models 401 + 对话 200 → 连通成立（先鉴权后路由的网关，如火山方舟）', async () => {
    behavior = { modelsStatus: 401, chatStatus: 200 };
    const res = await discoverProviderModels({
      baseUrl: baseUrl(),
      apiKey: 'sk-test',
      api: 'openai-completions',
      probeModel: 'deepseek-v4.1-flash',
    });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(true);
    expect(res.models).toEqual([{ id: 'deepseek-v4.1-flash' }]);
  });

  it('/models 401 + 对话 401 → 真鉴权失败，reason 指向 key', async () => {
    behavior = { modelsStatus: 401, chatStatus: 401 };
    const res = await discoverProviderModels({
      baseUrl: baseUrl(),
      apiKey: 'sk-wrong',
      api: 'openai-completions',
      probeModel: 'm',
    });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBeUndefined();
    expect(res.error).toContain('鉴权失败');
  });

  it('清单不可用且无探针模型 → 原样报错，不发对话请求', async () => {
    const res = await discoverProviderModels({ baseUrl: baseUrl(), apiKey: 'sk-test', api: 'openai-completions' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('HTTP 404');
    expect(chatCalls()).toHaveLength(0);
  });

  it('/models 200 → 正常返回清单，不触发对话探针', async () => {
    behavior = { modelsStatus: 200 };
    const res = await discoverProviderModels({
      baseUrl: baseUrl(),
      apiKey: 'sk-test',
      api: 'openai-completions',
      probeModel: 'ignored',
    });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBeUndefined();
    expect(res.models).toEqual([{ id: 'listed-model' }]);
    expect(chatCalls()).toHaveLength(0);
  });

  it('5xx 不被对话探针掩盖（端点自身故障照实报）', async () => {
    behavior = { modelsStatus: 503, chatStatus: 200 };
    const res = await discoverProviderModels({
      baseUrl: baseUrl(),
      apiKey: 'sk-test',
      api: 'openai-completions',
      probeModel: 'm',
    });
    expect(res.ok).toBe(false);
    expect(chatCalls()).toHaveLength(0);
  });
});

describe('discoverProviderModels：anthropic-messages', () => {
  const baseUrl = () => `${origin}/anthropic`;

  it('/v1/models 404 + messages 200 → 连通成立（MiMo 形态），用 x-api-key 鉴权', async () => {
    behavior = { chatStatus: 200 };
    const res = await discoverProviderModels({
      baseUrl: baseUrl(),
      apiKey: 'mm-key',
      api: 'anthropic-messages',
      probeModel: 'mimo-v2.6-pro',
      knownModels: [
        { id: 'mimo-v2.6-pro' },
        { id: 'mimo-v2.6-flash' },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(true);
    expect(res.models.map((m) => m.id)).toEqual(['mimo-v2.6-pro', 'mimo-v2.6-flash']);

    const [probe] = chatCalls();
    expect(probe?.path).toBe('/anthropic/v1/messages');
    expect(probe?.apiKeyHeader).toBe('mm-key');
    expect(probe?.anthropicVersion).toBe('2023-06-01');
    expect(probe?.authorization).toBeUndefined();
  });

  it('/v1/models 401 + messages 200 → 连通成立（方舟先鉴权后路由形态）', async () => {
    behavior = { modelsStatus: 401, chatStatus: 200 };
    const res = await discoverProviderModels({
      baseUrl: baseUrl(),
      apiKey: 'ark-key',
      api: 'anthropic-messages',
      probeModel: 'kimi-k3.1-pro',
    });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(true);
  });

  it('/v1/models 401 + messages 401 → 真鉴权失败', async () => {
    behavior = { modelsStatus: 401, chatStatus: 401 };
    const res = await discoverProviderModels({
      baseUrl: baseUrl(),
      apiKey: 'bad',
      api: 'anthropic-messages',
      probeModel: 'kimi-k3.1-pro',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('鉴权失败');
  });

  it('/v1/models 200 → 正常返回 anthropic 清单形态 { models: [...] }', async () => {
    behavior = { modelsStatus: 200 };
    const res = await discoverProviderModels({
      baseUrl: baseUrl(),
      apiKey: 'k',
      api: 'anthropic-messages',
    });
    expect(res.ok).toBe(true);
    expect(res.models).toEqual([{ id: 'listed-model' }]);
    expect(chatCalls()).toHaveLength(0);
  });
});

describe('provider.isAvailable()：向导测通路径', () => {
  const openaiProviders: OpenAIProvider[] = [];
  const anthropicProviders: AnthropicProvider[] = [];

  afterEach(async () => {
    await Promise.all(openaiProviders.map((p) => p.dispose()));
    await Promise.all(anthropicProviders.map((p) => p.dispose()));
    openaiProviders.length = 0;
    anthropicProviders.length = 0;
  });

  const openai = (baseUrl: string, model: string) => {
    const p = new OpenAIProvider({ apiKey: 'sk-test', baseUrl, models: [model] });
    openaiProviders.push(p);
    return p;
  };
  const anthropic = (baseUrl: string, model: string) => {
    const p = new AnthropicProvider({ apiKey: 'an-key', baseUrl, models: [model] });
    anthropicProviders.push(p);
    return p;
  };

  it('openai：/models 404 + 对话 200 → 可用（mistral / gemini 形态）', async () => {
    behavior = { chatStatus: 200 };
    await expect(openai(`${origin}/v1`, 'mistral-large-4').isAvailable()).resolves.toBe(true);
  });

  it('openai：/models 401 + 对话 200 → 可用（方舟形态）', async () => {
    behavior = { modelsStatus: 401, chatStatus: 200 };
    await expect(openai(`${origin}/v1`, 'deepseek-v4.1-flash').isAvailable()).resolves.toBe(true);
  });

  it('openai：/models 401 + 对话 401 → 不可用', async () => {
    behavior = { modelsStatus: 401, chatStatus: 401 };
    await expect(openai(`${origin}/v1`, 'm').isAvailable()).resolves.toBe(false);
  });

  it('openai：对话 400（模型名被拒但鉴权已过）→ 可用', async () => {
    behavior = { chatStatus: 400 };
    await expect(openai(`${origin}/v1`, 'm').isAvailable()).resolves.toBe(true);
  });

  it('anthropic：messages 200 → 可用（MiMo 形态，无 /v1/models 也通过）', async () => {
    behavior = { chatStatus: 200 };
    await expect(anthropic(`${origin}/anthropic`, 'mimo-v2.6-pro').isAvailable()).resolves.toBe(true);
    expect(chatCalls()[0]?.path).toBe('/anthropic/v1/messages');
  });

  it('anthropic：messages 401 → 不可用', async () => {
    behavior = { chatStatus: 401 };
    await expect(anthropic(`${origin}/anthropic`, 'mimo-v2.6-pro').isAvailable()).resolves.toBe(false);
  });
});
