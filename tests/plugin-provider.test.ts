/**
 * P5a — Plugin Provider contributions.
 *
 * Covers: manifest↔register contract, createProviderFromConfig plugin routing,
 * built-in adapters' thinkingLevel mapping (deferred item), the real example
 * plugin (examples/plugins/openai-compat-dialect) over a real local HTTP server,
 * and the daemon-equivalent default path through Gateway.discoverPlugins().
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PluginManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/manager.js';
import { createProviderFromConfig } from '@octopi-agent/engine/config.js';
import type { ModelProviderConfig } from '@octopi-agent/engine/config.js';
import type { ModelProvider, LLMRequest } from '@octopi-agent/core/interfaces/model-provider.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';

const EXAMPLE_PLUGINS_DIR = fileURLToPath(new URL('../examples/plugins', import.meta.url));

let root: string;
const servers: Server[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octopi-plugin-provider-'));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(root, { recursive: true, force: true });
});

/** 真实本地 HTTP 服务：记录请求并按 handler 回复（e2e 级证据） */
async function mockServer(
  handler: (req: { url: string; headers: Record<string, unknown>; body: Record<string, unknown> }, res: import('node:http').ServerResponse) => void,
): Promise<{ url: string; requests: Array<{ url: string; headers: Record<string, unknown>; body: Record<string, unknown> }> }> {
  const requests: Array<{ url: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { raw };
      }
      const record = { url: req.url ?? '', headers: req.headers as Record<string, unknown>, body };
      requests.push(record);
      handler(record, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

function writePlugin(dir: string, id: string, body: string, providers?: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'octopi.plugin.json'), JSON.stringify({
    id,
    apiVersion: '1',
    version: '1.0.0',
    name: id,
    entry: './index.mjs',
    engine: { octopi: '>=0.1.0' },
    configSchema: { type: 'object' },
    ...(providers ? { contributes: { providers } } : {}),
  }));
  writeFileSync(join(dir, 'index.mjs'), body);
}

function makeManager(loadPaths: string[], entries: Record<string, { enabled: boolean }>): PluginManager {
  return new PluginManager({ loadPaths, entries });
}

const req: LLMRequest = {
  messages: [{ role: 'user', content: 'hi', tool_calls: undefined }],
};

// ─────────────────────────────────────────────────────────────
// 1. manifest ↔ register 契约（与 services 同语义）
// ─────────────────────────────────────────────────────────────

describe('plugin provider contributions — loader contract', () => {
  it('declared + registered loads and resolves the factory', async () => {
    const loadRoot = join(root, 'plugins');
    writePlugin(join(loadRoot, 'p1'), 'p1', `
      export default { id: 'p1', register(api) {
        api.registerProvider('prov-a', (ctx) => ({ name: ctx.providerName }));
      } };`, ['prov-a']);
    const manager = makeManager([loadRoot], { p1: { enabled: true } });
    await manager.discover();
    expect(manager.getDiagnostics().find((d) => d.id === 'p1')?.status).toBe('registered');
    expect(manager.resolveProviderFactory('prov-a')?.pluginId).toBe('p1');
  });

  it('declared but not registered fails the plugin', async () => {
    const loadRoot = join(root, 'plugins');
    writePlugin(join(loadRoot, 'p1'), 'p1', `export default { id: 'p1', register() {} };`, ['prov-a']);
    const manager = makeManager([loadRoot], { p1: { enabled: true } });
    await manager.discover();
    const diagnostic = manager.getDiagnostics().find((d) => d.id === 'p1');
    expect(diagnostic?.status).toBe('failed');
    expect(diagnostic?.reason).toContain('Declared provider "prov-a" was not registered');
  });

  it('registered but not declared fails the plugin', async () => {
    const loadRoot = join(root, 'plugins');
    writePlugin(join(loadRoot, 'p1'), 'p1', `
      export default { id: 'p1', register(api) {
        api.registerProvider('prov-a', () => ({}));
      } };`);
    const manager = makeManager([loadRoot], { p1: { enabled: true } });
    await manager.discover();
    const diagnostic = manager.getDiagnostics().find((d) => d.id === 'p1');
    expect(diagnostic?.status).toBe('failed');
    expect(diagnostic?.reason).toContain('Provider "prov-a" is not declared in manifest');
  });

  it('cross-plugin duplicate provider id rejects both plugins', async () => {
    const loadRoot = join(root, 'plugins');
    for (const id of ['p1', 'p2']) {
      writePlugin(join(loadRoot, id), id, `
        export default { id: '${id}', register(api) {
          api.registerProvider('prov-shared', () => ({}));
        } };`, ['prov-shared']);
    }
    const manager = makeManager([loadRoot], { p1: { enabled: true }, p2: { enabled: true } });
    await manager.discover();
    for (const id of ['p1', 'p2']) {
      const diagnostic = manager.getDiagnostics().find((d) => d.id === id);
      expect(diagnostic?.status).toBe('failed');
      expect(diagnostic?.reason).toContain('conflicts');
    }
    expect(manager.resolveProviderFactory('prov-shared')).toBeUndefined();
  });

  it('duplicate registerProvider within one plugin throws', async () => {
    const loadRoot = join(root, 'plugins');
    writePlugin(join(loadRoot, 'p1'), 'p1', `
      export default { id: 'p1', register(api) {
        api.registerProvider('prov-a', () => ({}));
        api.registerProvider('prov-a', () => ({}));
      } };`, ['prov-a']);
    const manager = makeManager([loadRoot], { p1: { enabled: true } });
    await manager.discover();
    const diagnostic = manager.getDiagnostics().find((d) => d.id === 'p1');
    expect(diagnostic?.status).toBe('failed');
    expect(diagnostic?.reason).toContain('duplicate provider');
  });
});

// ─────────────────────────────────────────────────────────────
// 2. createProviderFromConfig：api | plugin 路由
// ─────────────────────────────────────────────────────────────

describe('createProviderFromConfig — plugin routing', () => {
  const base: ModelProviderConfig = {
    baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'm1', maxTokens: 100 }],
  };

  it('rejects neither api nor plugin', async () => {
    await expect(createProviderFromConfig('p', { ...base })).rejects.toThrow(/exactly one of api \| plugin/);
  });

  it('rejects both api and plugin', async () => {
    await expect(
      createProviderFromConfig('p', { ...base, api: 'openai-completions', plugin: 'x' }),
    ).rejects.toThrow(/exactly one of api \| plugin/);
  });

  it('fails loud when the plugin provider is not registered', async () => {
    await expect(
      createProviderFromConfig('p', { ...base, plugin: 'ghost' }, { resolvePluginProvider: () => undefined }),
    ).rejects.toThrow(/plugin provider "ghost" is not registered/);
  });

  it('builds the factory context from config and returns the factory result', async () => {
    let captured: unknown;
    const fake: ModelProvider = {
      name: 'p',
      chat: async () => ({ content: '', model: 'm1', finishReason: 'stop' }),
      stream: async function* () {},
      isAvailable: async () => true,
      getModelInfo: () => null,
      getModelInfos: () => [],
    };
    const provider = await createProviderFromConfig(
      'p',
      {
        ...base,
        plugin: 'dialect',
        apiKey: '${KEY}',
        timeoutSeconds: 7,
        options: { thinking: { field: 'enable_thinking' } },
        models: [{ id: 'm1', name: 'model-one', maxTokens: 100, contextWindow: 2000, reasoning: true }],
      },
      {
        resolvePluginProvider: (ref) =>
          ref === 'dialect'
            ? {
                pluginId: 'demo',
                id: 'dialect',
                factory: (ctx) => {
                  captured = ctx;
                  return fake;
                },
              }
            : undefined,
      },
    );
    expect(provider).toBe(fake);
    expect(captured).toStrictEqual({
      providerName: 'p',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: '${KEY}',
      models: [{ name: 'model-one', contextWindow: 2000, maxOutputTokens: 100, reasoning: true }],
      defaultModel: 'model-one',
      timeoutMs: 7000,
      options: { thinking: { field: 'enable_thinking' } },
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 3. 内置适配器 thinkingLevel 映射（P4 延期项）
// ─────────────────────────────────────────────────────────────

describe('built-in adapters — thinkingLevel mapping', () => {
  it('openai: maps thinkingLevel to reasoning_effort; off/undefined send nothing', async () => {
    const provider = await createProviderFromConfig('o', {
      baseUrl: 'http://127.0.0.1:1',
      api: 'openai-completions',
      models: [{ id: 'gpt-5', reasoning: true }],
    });
    const wire = provider as unknown as { wireBodyFor(r: LLMRequest, mode: 'chat' | 'stream'): Record<string, unknown> };
    expect(wire.wireBodyFor({ ...req, thinkingLevel: 'high' }, 'chat').reasoning_effort).toBe('high');
    expect(wire.wireBodyFor({ ...req, thinkingLevel: 'off' }, 'chat').reasoning_effort).toBeUndefined();
    expect(wire.wireBodyFor(req, 'chat').reasoning_effort).toBeUndefined();
  });

  it('openai: rejects thinkingLevel for models declaring no reasoning support', async () => {
    const provider = await createProviderFromConfig('o', {
      baseUrl: 'http://127.0.0.1:1',
      api: 'openai-completions',
      models: [{ id: 'plain', reasoning: false }],
    });
    const wire = provider as unknown as { wireBodyFor(r: LLMRequest, mode: 'chat' | 'stream'): Record<string, unknown> };
    expect(() => wire.wireBodyFor({ ...req, model: 'plain', thinkingLevel: 'low' }, 'chat')).toThrow(/no reasoning support/);
  });

  it('anthropic: maps thinkingLevel to thinking.budget_tokens on the real wire', async () => {
    const { url, requests } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } }));
    });
    const provider = await createProviderFromConfig('a', {
      baseUrl: url,
      api: 'anthropic-messages',
      models: [{ id: 'claude-x', reasoning: true }],
    });
    await provider.chat({ ...req, thinkingLevel: 'high', maxTokens: 50000 });
    expect(requests[0].body.thinking).toEqual({ type: 'enabled', budget_tokens: 24576 });
    // extended thinking 下模型级 temperature 被抑制（未显式指定时不发送）
    expect(requests[0].body.temperature).toBeUndefined();
  });

  it('anthropic: rejects temperature != 1 and budget >= maxTokens', async () => {
    const { url } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } }));
    });
    const provider = await createProviderFromConfig('a', {
      baseUrl: url,
      api: 'anthropic-messages',
      models: [{ id: 'claude-x', reasoning: true }],
    });
    await expect(
      provider.chat({ ...req, thinkingLevel: 'low', temperature: 0.5 }),
    ).rejects.toThrow(/requires temperature 1/);
    await expect(
      provider.chat({ ...req, thinkingLevel: 'low', maxTokens: 1024 }),
    ).rejects.toThrow(/budgets 2048 tokens but max_tokens is 1024/);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. 真实插件 examples/plugins/openai-compat-dialect（wire 级）
// ─────────────────────────────────────────────────────────────

describe('openai-compat-dialect example plugin (real wire)', () => {
  async function loadDialect(url: string, options: Record<string, unknown>): Promise<ModelProvider> {
    const manager = makeManager([EXAMPLE_PLUGINS_DIR], { 'openai-compat-dialect': { enabled: true } });
    await manager.discover();
    expect(manager.getDiagnostics().find((d) => d.id === 'openai-compat-dialect')?.status).toBe('registered');
    return createProviderFromConfig(
      'gw',
      {
        baseUrl: url,
        plugin: 'openai-compat',
        apiKey: 'SECRET-KEY',
        models: [{ id: 'kimi-k2', reasoning: true, maxTokens: 200 }],
        options,
      },
      { resolvePluginProvider: (ref) => manager.resolveProviderFactory(ref) },
    );
  }

  it('chat: custom auth header, extra headers, extraBody under standard fields, thinking boolean, reasoningField', async () => {
    const { url, requests } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'kimi-k2',
        choices: [{ message: { content: 'answer', thinking_content: 'hmm' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }));
    });
    const provider = await loadDialect(url, {
      auth: { header: 'X-Api-Key' },
      extraHeaders: { 'X-Tenant': 'acme' },
      extraBody: { chat_template_kwargs: { enable_thinking: true }, model: 'hijacked' },
      thinking: { field: 'enable_thinking', mode: 'boolean' },
      reasoningField: 'thinking_content',
    });
    const response = await provider.chat({ ...req, thinkingLevel: 'medium' });
    const sent = requests[0];
    expect(sent.headers['x-api-key']).toBe('SECRET-KEY');
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers['x-tenant']).toBe('acme');
    expect(sent.body.chat_template_kwargs).toEqual({ enable_thinking: true });
    // extraBody 合并于标准字段之下：model 标准字段必须获胜
    expect(sent.body.model).toBe('kimi-k2');
    expect(sent.body.enable_thinking).toBe(true);
    expect(response.content).toBe('answer');
    expect(response.reasoning).toBe('hmm');
    expect(response.usage?.outputTokens).toBe(4);
  });

  it('thinking value mode sends the level; off sends nothing', async () => {
    const { url, requests } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: '' }, finish_reason: 'stop' }] }));
    });
    const provider = await loadDialect(url, { thinking: { field: 'reasoning_effort', values: { high: 'max' } } });
    await provider.chat({ ...req, thinkingLevel: 'high' });
    await provider.chat({ ...req, thinkingLevel: 'off' });
    expect(requests[0].body.reasoning_effort).toBe('max');
    expect(requests[1].body.reasoning_effort).toBeUndefined();
  });

  it('stream: content/reasoning/tool_call/done chunks with usage over SSE', async () => {
    const { url } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { thinking_content: 'deep ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 2 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const provider = await loadDialect(url, { reasoningField: 'thinking_content' });
    const chunks = [];
    for await (const chunk of provider.stream(req)) chunks.push(chunk);
    expect(chunks.filter((c) => c.type === 'reasoning').map((c) => c.content).join('')).toBe('deep ');
    expect(chunks.filter((c) => c.type === 'content').map((c) => c.content).join('')).toBe('hello');
    const toolChunk = chunks.find((c) => c.type === 'tool_call');
    expect(toolChunk?.toolCall?.name).toBe('lookup');
    // 分片 arguments 按原文拼接交给 Loop（不丢中间帧）
    expect(toolChunk?.toolCall?.arguments).toBe('{"q":1}');
    const done = chunks.find((c) => c.type === 'done');
    expect(done?.finishReason).toBe('tool_calls');
    expect(done?.usage?.inputUncachedTokens).toBe(1);
  });

  it('isAvailable probes /models; dispose aborts in-flight requests', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { url, requests } = await mockServer(async (record, res) => {
      if (record.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      await gate;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: 'late' }, finish_reason: 'stop' }] }));
    });
    const provider = await loadDialect(url, {});
    expect(await provider.isAvailable()).toBe(true);

    const inflight = provider.chat(req);
    expect(typeof provider.dispose).toBe('function');
    const dispose = provider.dispose?.();
    await expect(inflight).rejects.toThrow(/disposed|abort/i);
    await dispose;
    release?.();
    expect(requests.some((r) => r.url === '/models')).toBe(true);
  });

  it('rejects unknown options at factory time (fail loud)', async () => {
    const manager = makeManager([EXAMPLE_PLUGINS_DIR], { 'openai-compat-dialect': { enabled: true } });
    await manager.discover();
    await expect(
      createProviderFromConfig(
        'gw',
        {
          baseUrl: 'http://127.0.0.1:1',
          plugin: 'openai-compat',
          models: [{ id: 'm' }],
          options: { mystery: true },
        },
        { resolvePluginProvider: (ref) => manager.resolveProviderFactory(ref) },
      ),
    ).rejects.toThrow(/unknown option\(s\): mystery/);
  });

  it('options validation rejects wrong shapes at factory time (m7)', async () => {
    const manager = makeManager([EXAMPLE_PLUGINS_DIR], { 'openai-compat-dialect': { enabled: true } });
    await manager.discover();
    const build = (options: Record<string, unknown>) =>
      createProviderFromConfig(
        'gw',
        { baseUrl: 'http://127.0.0.1:1', plugin: 'openai-compat', models: [{ id: 'm' }], options },
        { resolvePluginProvider: (ref) => manager.resolveProviderFactory(ref) },
      );
    await expect(build({ extraHeaders: 'abc' })).rejects.toThrow(/extraHeaders must be an object/);
    await expect(build({ reasoningField: 7 })).rejects.toThrow(/reasoningField/);
    await expect(build({ thinking: { field: 'x', mode: 'object', values: { high: 'not-an-object' } } })).rejects.toThrow(/does not match mode/);
  });

  it('cache-aware usage does not double-count cached input (M6)', async () => {
    const { url } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'm',
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
      }));
    });
    const provider = await loadDialect(url, {});
    const response = await provider.chat(req);
    expect(response.usage).toStrictEqual({
      outputTokens: 5,
      inputUncachedTokens: 60,
      inputCachedTokens: 40,
      inputCacheWriteTokens: 0,
      cacheAware: true,
      inputReportedTokens: 100,
      raw: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
    });
  });

  it('unknown finish_reason maps to error, never stop (M7)', async () => {
    const { url } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: 'filtered' }, finish_reason: 'content_filter' }] }));
    });
    const provider = await loadDialect(url, {});
    const response = await provider.chat(req);
    expect(response.finishReason).toBe('error');
  });

  it('trailing [DONE] without a newline is still parsed (m4)', async () => {
    const { url } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'last' } }] })}\n\n`);
      res.end('data: [DONE]'); // 无尾随换行：手写兼容服务常见
    });
    const provider = await loadDialect(url, {});
    const chunks = [];
    for await (const chunk of provider.stream(req)) chunks.push(chunk);
    expect(chunks.filter((c) => c.type === 'content').map((c) => c.content).join('')).toBe('last');
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });

  it('tool_calls without index are kept separate by id (m5)', async () => {
    const { url } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'fa', arguments: '{}' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'fb', arguments: '{}' } }] } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const provider = await loadDialect(url, {});
    const chunks = [];
    for await (const chunk of provider.stream(req)) chunks.push(chunk);
    const toolNames = chunks.filter((c) => c.type === 'tool_call').map((c) => c.toolCall?.name);
    expect(toolNames).toEqual(['fa', 'fb']);
  });

  it('dispose aborts an in-flight streaming body (m3)', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { url } = await mockServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`);
      await gate;
      res.end('data: [DONE]\n\n');
    });
    const provider = await loadDialect(url, {});
    const iterator = provider.stream(req)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.content).toBe('first');
    const pending = iterator.next(); // 挂在未结束的 body 上
    await provider.dispose?.();
    await expect(pending).rejects.toThrow(/disposed|abort/i);
    release?.();
  });
});

// ─────────────────────────────────────────────────────────────
// 5. Gateway 发现 + 工厂解析 + registerProvider 接线
// ─────────────────────────────────────────────────────────────

describe('Gateway discover + factory resolution + registerProvider wiring', () => {
  it('discoverPlugins → resolvePluginProviderFactory → createProviderFromConfig → real chat', async () => {
    const { url, requests } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    });
    const agent: AgentDefinition = {
      id: 'tester',
      home: join(root, 'agent'),
      workspace: join(root, 'workspace'),
      persona: { name: 'T', description: '', systemPrompt: 'S' },
      model: { provider: 'mock', model: 'm' },
      tools: { allow: [] },
    };
    const gateway = new Gateway(
      {
        agents: [agent],
        knowledge: { service: { manageLocal: false } },
        plugins: {
          loadPaths: [EXAMPLE_PLUGINS_DIR],
          entries: { 'openai-compat-dialect': { enabled: true } },
        },
      },
      new InMemorySessionStore(),
    );
    try {
      // daemon 顺序：provider 创建前先发现插件
      await gateway.discoverPlugins();
      const provider = await createProviderFromConfig(
        'gw',
        {
          baseUrl: url,
          plugin: 'openai-compat',
          models: [{ id: 'm' }],
        },
        { resolvePluginProvider: (ref) => gateway.resolvePluginProviderFactory(ref) },
      );
      gateway.registerProvider(provider);
      const response = await provider.chat(req);
      expect(response.content).toBe('ok');
      expect(requests[0].url).toBe('/chat/completions');
    } finally {
      await gateway.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 6. 评审修复回归锁（B1/M5/n4）
// ─────────────────────────────────────────────────────────────

describe('review-fix regression locks', () => {
  it('B1: wire dump decoration forwards dispose', async () => {
    const provider = await createProviderFromConfig(
      'o',
      { baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', models: [{ id: 'm' }] },
      { wireDump: { capture: () => undefined } as never },
    );
    expect(typeof provider.dispose).toBe('function');
    await expect(Promise.resolve(provider.dispose?.())).resolves.not.toThrow();
  });

  it('M5: factory result name must equal the config key', async () => {
    const fake = {
      name: 'wrong',
      chat: async () => ({ content: '', model: 'm', finishReason: 'stop' as const }),
      stream: async function* () {},
      isAvailable: async () => true,
      getModelInfo: () => null,
      getModelInfos: () => [],
    };
    await expect(
      createProviderFromConfig(
        'gw',
        { baseUrl: 'http://127.0.0.1:1', plugin: 'openai-compat', models: [{ id: 'm' }] },
        {
          resolvePluginProvider: (ref) =>
            ref === 'openai-compat' ? { pluginId: 'demo', id: 'openai-compat', factory: () => fake } : undefined,
        },
      ),
    ).rejects.toThrow(/must equal the config key/);
  });

  it('M5: factory result must implement the minimal contract', async () => {
    await expect(
      createProviderFromConfig(
        'gw',
        { baseUrl: 'http://127.0.0.1:1', plugin: 'openai-compat', models: [{ id: 'm' }] },
        {
          resolvePluginProvider: (ref) =>
            ref === 'openai-compat'
              ? { pluginId: 'demo', id: 'openai-compat', factory: () => ({ name: 'gw' }) as never }
              : undefined,
        },
      ),
    ).rejects.toThrow(/missing chat/);
  });

  it('n4: default request bodies carry no thinking fields (openai byte-stable)', async () => {
    const provider = await createProviderFromConfig('o', {
      baseUrl: 'http://127.0.0.1:1',
      api: 'openai-completions',
      models: [{ id: 'gpt-5', reasoning: true }],
    });
    const wire = provider as unknown as { wireBodyFor(r: LLMRequest, mode: 'chat' | 'stream'): Record<string, unknown> };
    const body = wire.wireBodyFor(req, 'chat');
    expect(Object.keys(body).sort()).toEqual(['messages', 'model']);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('n4: default request bodies carry no thinking fields (anthropic wire)', async () => {
    const { url, requests } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } }));
    });
    const provider = await createProviderFromConfig('a', {
      baseUrl: url,
      api: 'anthropic-messages',
      models: [{ id: 'claude-x', reasoning: true }],
    });
    await provider.chat(req);
    expect(requests[0].body.thinking).toBeUndefined();
    expect(requests[0].body.temperature).toBeUndefined();
    expect(requests[0].body.max_tokens).toBe(4096);
  });
});
