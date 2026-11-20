/**
 * 连通性探测的 `/models` 缺失回退
 *
 * 背景：OpenAI 兼容面并不承诺 `GET /models`。Mistral 官方 OpenAI 端点
 * （`https://api.mistral.ai/openai/v1`）与 Gemini 的 `/v1beta/openai` 都只提供
 * `chat/completions`，`/models` 返回 404。此前探测把 404 直接判成「不可用」，
 * 正确 key 也过不了向导测通与 Web「测试连接」。
 *
 * 本文件用真实本地 HTTP 服务验证两条探测路径（不使用 mock 类内部实现）：
 * - `discoverProviderModels`（Web / config-apply 路径，模型清单 + 连通）
 * - `OpenAIProvider.isAvailable()`（向导测通路径）
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverProviderModels } from '../packages/engine/src/config-admin/discover.js';
import { OpenAIProvider } from '../packages/engine/src/integration/providers/openai.js';

/** 每个用例设置一次的服务端行为（undefined 表示该路由不存在 → 404） */
interface Behavior {
  modelsStatus?: number;
  chatStatus?: number;
}

let behavior: Behavior = {};
let chatCalls = 0;
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (url.endsWith('/models')) {
      const status = behavior.modelsStatus;
      if (status === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'no Route matched with those values' }));
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'listed-model' }] }));
      return;
    }
    if (url.endsWith('/chat/completions')) {
      chatCalls += 1;
      const status = behavior.chatStatus ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { id: 'x', choices: [] } : { error: 'nope' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterEach(() => {
  behavior = {};
  chatCalls = 0;
});

describe('discoverProviderModels：/models 404 时的对话探针回退', () => {
  it('/models 404 + 对话 200 → 连通成立，标记 degraded 并如实说明', async () => {
    behavior = { chatStatus: 200 };
    const res = await discoverProviderModels({
      baseUrl,
      apiKey: 'sk-test',
      api: 'openai-completions',
      probeModel: 'mistral-large-4',
    });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(true);
    expect(res.models).toEqual([{ id: 'mistral-large-4' }]);
    expect(res.note).toContain('无 /models 路由');
  });

  it('/models 404 + 对话 401 → 仍判失败，reason 指向鉴权（不掩盖真错）', async () => {
    behavior = { chatStatus: 401 };
    const res = await discoverProviderModels({
      baseUrl,
      apiKey: 'sk-wrong',
      api: 'openai-completions',
      probeModel: 'mistral-large-4',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('404');
    expect(res.error).toContain('鉴权');
  });

  it('/models 404 且无探针模型 → 按原样报 404（不猜测模型）', async () => {
    const res = await discoverProviderModels({ baseUrl, apiKey: 'sk-test', api: 'openai-completions' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('HTTP 404');
    expect(chatCalls).toBe(0);
  });

  it('/models 200 → 正常返回清单，不触发对话探针', async () => {
    behavior = { modelsStatus: 200 };
    const res = await discoverProviderModels({
      baseUrl,
      apiKey: 'sk-test',
      api: 'openai-completions',
      probeModel: 'ignored',
    });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBeUndefined();
    expect(res.models).toEqual([{ id: 'listed-model' }]);
    expect(chatCalls).toBe(0);
  });
});

describe('OpenAIProvider.isAvailable：/models 404 时的对话探针回退', () => {
  const providers: OpenAIProvider[] = [];
  const make = (model: string) => {
    const p = new OpenAIProvider({ apiKey: 'sk-test', baseUrl, models: [model] });
    providers.push(p);
    return p;
  };

  afterEach(async () => {
    await Promise.all(providers.map((p) => p.dispose()));
    providers.length = 0;
  });

  it('/models 404 + 对话 200 → 可用（mistral / gemini 形态）', async () => {
    behavior = { chatStatus: 200 };
    await expect(make('mistral-large-4').isAvailable()).resolves.toBe(true);
    expect(chatCalls).toBe(1);
  });

  it('/models 404 + 对话 401 → 不可用（正确 key 才回 true）', async () => {
    behavior = { chatStatus: 401 };
    await expect(make('mistral-large-4').isAvailable()).resolves.toBe(false);
  });

  it('/models 200 → 可用且不发对话请求', async () => {
    behavior = { modelsStatus: 200 };
    await expect(make('gpt-6.2-astra').isAvailable()).resolves.toBe(true);
    expect(chatCalls).toBe(0);
  });
});
