/**
 * P5b — Plugin Channel contributions (Feishu).
 *
 * Covers: manifest↔register contract, createChannelAdapterFromConfig routing
 * (type | plugin), Gateway factory resolution + registerChannel hardening, and
 * the real example plugin (examples/plugins/feishu-channel) normalization over
 * an injected SDK fake (the real long connection is exercised in live testing;
 * the committed suite must not depend on the example's node_modules).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PluginManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/manager.js';
import { ChannelConfigSchema } from '@octopi-agent/engine/config-schema/agent.js';
import { createChannelAdapterFromConfig } from '@octopi-agent/engine/config.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import type { ChannelMessage, ChannelReply } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/channel-types.js';
import {
  createFeishuChannelAdapter,
  parseOptions,
  toChannelMessage,
} from '../examples/plugins/feishu-channel/index.mjs';

const EXAMPLE_PLUGINS_DIR = fileURLToPath(new URL('../examples/plugins', import.meta.url));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octopi-plugin-channel-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePlugin(dir: string, id: string, body: string, channels?: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'octopi.plugin.json'), JSON.stringify({
    id,
    apiVersion: '1',
    version: '1.0.0',
    name: id,
    entry: './index.mjs',
    engine: { octopi: '>=0.1.0' },
    configSchema: { type: 'object' },
    ...(channels ? { contributes: { channels } } : {}),
  }));
  writeFileSync(join(dir, 'index.mjs'), body);
}

function makeManager(loadPaths: string[], entries: Record<string, { enabled: boolean }>): PluginManager {
  return new PluginManager({ loadPaths, entries });
}

/** Fake SDK module driving the real feishu adapter code. */
function fakeLark() {
  const calls: {
    created: Array<Record<string, unknown>>;
    connect: number;
    disconnect: number;
    send: Array<{ to: string; input: unknown; opts: unknown }>;
  } = { created: [], connect: 0, disconnect: 0, send: [] };
  const handlers = new Map<string, (payload: unknown) => void>();
  const channel = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(name: string, handler: (payload: unknown) => void) {
      handlers.set(name, handler);
    },
    async connect() { calls.connect += 1; },
    async disconnect() { calls.disconnect += 1; },
    async send(to: string, input: unknown, opts: unknown) {
      calls.send.push({ to, input, opts });
      return { messageId: 'om-out' };
    },
  };
  const lark = {
    createLarkChannel(opts: Record<string, unknown>) {
      calls.created.push(opts);
      return channel;
    },
  };
  return { lark, calls, handlers, channel };
}

function normalizedMessage(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    messageId: 'om-1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: '大哥',
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1700000000000,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────
// 1. manifest ↔ register 契约（与 providers 同语义）
// ─────────────────────────────────────────────────────────────

describe('plugin channel contributions — loader contract', () => {
  it('declared + registered loads and resolves the factory', async () => {
    const loadRoot = join(root, 'plugins');
    writePlugin(join(loadRoot, 'p1'), 'p1', `
      export default { id: 'p1', register(api) {
        api.registerChannel('chan-a', () => ({ name: 'chan-a' }));
      } };`, ['chan-a']);
    const manager = makeManager([loadRoot], { p1: { enabled: true } });
    await manager.discover();
    expect(manager.getDiagnostics().find((d) => d.id === 'p1')?.status).toBe('registered');
    expect(manager.resolveChannelFactory('chan-a')?.pluginId).toBe('p1');
  });

  it('declared but not registered fails the plugin', async () => {
    const loadRoot = join(root, 'plugins');
    writePlugin(join(loadRoot, 'p1'), 'p1', `export default { id: 'p1', register() {} };`, ['chan-a']);
    const manager = makeManager([loadRoot], { p1: { enabled: true } });
    await manager.discover();
    const diagnostic = manager.getDiagnostics().find((d) => d.id === 'p1');
    expect(diagnostic?.status).toBe('failed');
    expect(diagnostic?.reason).toContain('Declared channel "chan-a" was not registered');
  });

  it('registered but not declared fails the plugin', async () => {
    const loadRoot = join(root, 'plugins');
    writePlugin(join(loadRoot, 'p1'), 'p1', `
      export default { id: 'p1', register(api) {
        api.registerChannel('chan-a', () => ({ name: 'chan-a' }));
      } };`);
    const manager = makeManager([loadRoot], { p1: { enabled: true } });
    await manager.discover();
    const diagnostic = manager.getDiagnostics().find((d) => d.id === 'p1');
    expect(diagnostic?.status).toBe('failed');
    expect(diagnostic?.reason).toContain('Channel "chan-a" is not declared in manifest');
  });

  it('two plugins declaring the same channel id reject the second', async () => {
    const loadRoot = join(root, 'plugins');
    writePlugin(join(loadRoot, 'p1'), 'p1', `
      export default { id: 'p1', register(api) {
        api.registerChannel('chan-a', () => ({ name: 'chan-a' }));
      } };`, ['chan-a']);
    writePlugin(join(loadRoot, 'p2'), 'p2', `
      export default { id: 'p2', register(api) {
        api.registerChannel('chan-a', () => ({ name: 'chan-a' }));
      } };`, ['chan-a']);
    const manager = makeManager([loadRoot], { p1: { enabled: true }, p2: { enabled: true } });
    await manager.discover();
    expect(manager.getDiagnostics().find((d) => d.id === 'p2')?.status).toBe('failed');
    expect(manager.getDiagnostics().find((d) => d.id === 'p2')?.reason).toContain('conflicts');
  });

  it('registerChannel rejects built-in message labels (http, ws) and invalid ids', async () => {
    for (const reserved of ['http', 'ws']) {
      const loadRoot = join(root, `plugins-${reserved}`);
      writePlugin(join(loadRoot, 'p1'), 'p1', `
        export default { id: 'p1', register(api) {
          api.registerChannel('${reserved}', () => ({ name: '${reserved}' }));
        } };`, [reserved]);
      const manager = makeManager([loadRoot], { p1: { enabled: true } });
      await manager.discover();
      const diagnostic = manager.getDiagnostics().find((d) => d.id === 'p1');
      expect(diagnostic?.status, `reserved id ${reserved}`).toBe('failed');
      expect(diagnostic?.reason).toContain('reserved by built-in adapters');
    }
    const loadRoot = join(root, 'plugins-bad');
    writePlugin(join(loadRoot, 'p1'), 'p1', `
      export default { id: 'p1', register(api) {
        api.registerChannel('Bad Name', () => ({ name: 'Bad Name' }));
      } };`);
    const manager = makeManager([loadRoot], { p1: { enabled: true } });
    await manager.discover();
    const diagnostic = manager.getDiagnostics().find((d) => d.id === 'p1');
    expect(diagnostic?.status).toBe('failed');
    expect(diagnostic?.reason).toContain('invalid channel contribution');
  });

  it('registerChannel rejects duplicates and invalid ids', async () => {
    const loadRoot = join(root, 'plugins');
    writePlugin(join(loadRoot, 'p1'), 'p1', `
      export default { id: 'p1', register(api) {
        api.registerChannel('chan-a', () => ({ name: 'chan-a' }));
        api.registerChannel('chan-a', () => ({ name: 'chan-a' }));
      } };`, ['chan-a']);
    const manager = makeManager([loadRoot], { p1: { enabled: true } });
    await manager.discover();
    expect(manager.getDiagnostics().find((d) => d.id === 'p1')?.status).toBe('failed');
    expect(manager.getDiagnostics().find((d) => d.id === 'p1')?.reason).toContain('duplicate channel');
  });

  it('real example manifest registers the feishu channel contribution', async () => {
    const manager = makeManager([EXAMPLE_PLUGINS_DIR], { feishu: { enabled: true } });
    await manager.discover();
    expect(manager.getDiagnostics().find((d) => d.id === 'feishu')?.status).toBe('registered');
    expect(manager.resolveChannelFactory('feishu')?.id).toBe('feishu');
  });
});

// ─────────────────────────────────────────────────────────────
// 2. createChannelAdapterFromConfig：type | plugin 路由
// ─────────────────────────────────────────────────────────────

describe('createChannelAdapterFromConfig — plugin routing', () => {
  const goodAdapter = (name: string) => ({
    name,
    start: async () => {},
    send: async () => {},
    stop: async () => {},
  });

  const resolve = (record: unknown) => () => record as never;

  it('exactly one of type | plugin must be set (both / neither)', async () => {
    await expect(createChannelAdapterFromConfig({}, resolve(goodAdapter('x')))).rejects.toThrow(/exactly one of type \| plugin/);
    await expect(createChannelAdapterFromConfig({ type: 'http', plugin: 'x' }, resolve(goodAdapter('x')))).rejects.toThrow(/exactly one of type \| plugin/);
  });

  it('unknown built-in type fails loud with the built-in list', async () => {
    await expect(createChannelAdapterFromConfig({ type: 'telegram' }, resolve(goodAdapter('x')))).rejects.toThrow(/no built-in adapter/);
  });

  it('unresolved plugin contribution fails closed with the real reason', async () => {
    await expect(
      createChannelAdapterFromConfig({ plugin: 'feishu' }, resolve(undefined)),
    ).rejects.toThrow(/not registered \(plugin disabled, failed, or not discovered\)/);
  });

  it('factory result must implement the minimal contract', async () => {
    await expect(
      createChannelAdapterFromConfig(
        { plugin: 'feishu' },
        resolve({ pluginId: 'demo', id: 'feishu', factory: () => ({ name: 'feishu', start: async () => {} }) }),
      ),
    ).rejects.toThrow(/missing send/);
  });

  it('factory result name must equal the contribution id', async () => {
    await expect(
      createChannelAdapterFromConfig(
        { plugin: 'feishu' },
        resolve({ pluginId: 'demo', id: 'feishu', factory: () => goodAdapter('wrong') }),
      ),
    ).rejects.toThrow(/must equal the contribution id/);
  });

  it('passes channelName / apiKey / options through verbatim and binds the name', async () => {
    let seen: Record<string, unknown> | undefined;
    const adapter = await createChannelAdapterFromConfig(
      { plugin: 'feishu', apiKey: 'secret-ref', options: { appId: 'cli_1', policy: { dmMode: 'open' } } },
      resolve({
        pluginId: 'demo',
        id: 'feishu',
        factory: (ctx: Record<string, unknown>) => {
          seen = ctx;
          return goodAdapter(ctx.channelName as string);
        },
      }),
    );
    expect(adapter.name).toBe('feishu');
    expect(seen).toEqual({
      channelName: 'feishu',
      apiKey: 'secret-ref',
      options: { appId: 'cli_1', policy: { dmMode: 'open' } },
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Gateway 发现 + 工厂解析 + registerChannel 加固
// ─────────────────────────────────────────────────────────────

describe('Gateway discover + channel factory resolution', () => {
  it('discoverPlugins → resolvePluginChannelFactory → registerChannel (duplicate rejected)', async () => {
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
          entries: { feishu: { enabled: true } },
        },
      },
      new InMemorySessionStore(),
    );
    try {
      await gateway.discoverPlugins();
      expect(gateway.resolvePluginChannelFactory('feishu')?.id).toBe('feishu');
      const adapter = {
        name: 'demo-chan',
        start: async () => {},
        send: async () => {},
        stop: async () => {},
      };
      gateway.registerChannel(adapter);
      expect(() => gateway.registerChannel(adapter)).toThrow(/already registered/);
    } finally {
      await gateway.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 4. 飞书适配器（注入 SDK fake 的真实插件代码）
// ─────────────────────────────────────────────────────────────

describe('feishu example plugin — options validation', () => {
  it('requires appId and rejects unknown / malformed options (fail loud)', () => {
    expect(() => parseOptions({})).toThrow(/appId is required/);
    expect(() => parseOptions({ appId: 'cli_1', mystery: 1 })).toThrow(/unknown option\(s\): mystery/);
    expect(() => parseOptions({ appId: 'cli_1', policy: { nope: true } })).toThrow(/unknown policy key\(s\): nope/);
    expect(() => parseOptions({ appId: 'cli_1', policy: { dmMode: 'everyone' } })).toThrow(/dmMode must be one of/);
    expect(() => parseOptions({ appId: 'cli_1', policy: { dmAllowlist: [1] } })).toThrow(/must be an array of non-empty strings/);
    expect(() => parseOptions({ appId: 'cli_1', policy: { requireMention: 'yes' } })).toThrow(/must be a boolean/);
  });

  it('rejects dmMode "pair" — the SDK would silently treat it as open', () => {
    expect(() => parseOptions({ appId: 'cli_1', policy: { dmMode: 'pair' } })).toThrow(/not implemented by the SDK/);
  });

  it('defaults: requireMention true, respondToMentionAll false; explicit values win', () => {
    expect(parseOptions({ appId: 'cli_1' }).policy).toEqual({
      requireMention: true,
      respondToMentionAll: false,
    });
    expect(parseOptions({ appId: 'cli_1', policy: { requireMention: false } }).policy.requireMention).toBe(false);
  });
});

describe('feishu example plugin — adapter behavior', () => {
  const ctx = { channelName: 'feishu', apiKey: 'app-secret', options: { appId: 'cli_1' } };

  it('requires apiKey through the credential channel', () => {
    const { lark } = fakeLark();
    expect(() => createFeishuChannelAdapter({ ...ctx, apiKey: '' }, lark)).toThrow(/apiKey is required/);
  });

  it('start wires events, awaits connect, and maps messages to ChannelMessage', async () => {
    const { lark, calls, handlers } = fakeLark();
    const adapter = createFeishuChannelAdapter(ctx, lark);
    const got: ChannelMessage[] = [];
    await adapter.start(async (msg) => { got.push(msg); });
    expect(calls.connect).toBe(1);
    expect(calls.created[0]).toMatchObject({
      appId: 'cli_1',
      appSecret: 'app-secret',
      transport: 'websocket',
      source: 'octopi-plugin:feishu',
      policy: { requireMention: true, respondToMentionAll: false },
    });

    handlers.get('message')?.(normalizedMessage());
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([{
      id: 'om-1',
      channel: 'feishu',
      senderId: 'ou_user',
      senderName: '大哥',
      content: 'hello',
      conversationId: 'oc_chat',
      timestamp: 1700000000000,
      metadata: { chatType: 'p2p' },
    }]);
  });

  it('keeps thread/reply metadata when present', async () => {
    const { lark, handlers } = fakeLark();
    const adapter = createFeishuChannelAdapter(ctx, lark);
    const got: ChannelMessage[] = [];
    await adapter.start(async (msg) => { got.push(msg); });
    handlers.get('message')?.(normalizedMessage({
      threadId: 'omt_1', rootId: 'om_root', replyToMessageId: 'om_parent',
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(got[0]?.metadata).toEqual({ chatType: 'p2p', threadId: 'omt_1', rootId: 'om_root', replyToMessageId: 'om_parent' });
  });

  it('skips media/card messages — SDK placeholder text is never fabricated as user input', async () => {
    const { lark, handlers } = fakeLark();
    const adapter = createFeishuChannelAdapter(ctx, lark);
    const got: ChannelMessage[] = [];
    await adapter.start(async (msg) => { got.push(msg); });
    // 真实 SDK 形状：image 归一化为 `![image](img_key)`（非空 content）+ resources
    handlers.get('message')?.(normalizedMessage({ content: '![image](img_v3_key)', rawContentType: 'image' }));
    handlers.get('message')?.(normalizedMessage({ content: '[file]', rawContentType: 'file', resources: [{ type: 'file', fileKey: 'f1' }] }));
    handlers.get('message')?.(normalizedMessage({ content: '   ', rawContentType: 'text' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(0);
    // post（富文本）真实文字照常转发
    handlers.get('message')?.(normalizedMessage({ content: '真实文字', rawContentType: 'post' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(1);
  });

  it('isolates handler errors from the SDK event chain', async () => {
    const { lark, handlers } = fakeLark();
    const adapter = createFeishuChannelAdapter(ctx, lark);
    await adapter.start(async () => { throw new Error('boom'); });
    expect(() => handlers.get('message')?.(normalizedMessage())).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('reject and error events never throw into the SDK', () => {
    const { lark, handlers } = fakeLark();
    const adapter = createFeishuChannelAdapter(ctx, lark);
    void adapter.start(async () => {});
    expect(() => handlers.get('reject')?.({ messageId: 'om-1', chatId: 'oc', senderId: 'ou', reason: 'no_mention' })).not.toThrow();
    expect(() => handlers.get('error')?.(Object.assign(new Error('ws down'), { code: 'unknown' }))).not.toThrow();
  });

  it('send maps ChannelReply to (chat, markdown, replyTo)', async () => {
    const { lark, calls } = fakeLark();
    const adapter = createFeishuChannelAdapter(ctx, lark);
    await adapter.start(async () => {});
    const reply: ChannelReply = { channel: 'feishu', conversationId: 'oc_chat', content: '**line1**\nline2', replyToId: 'om-1' };
    await adapter.send(reply);
    expect(calls.send).toEqual([{ to: 'oc_chat', input: { markdown: '**line1**\nline2' }, opts: { replyTo: 'om-1' } }]);
    await adapter.send({ channel: 'feishu', conversationId: 'oc_chat', content: 'plain' });
    expect(calls.send[1]?.opts).toBeUndefined();
  });

  it('send before start fails loud; stop is idempotent', async () => {
    const { lark, calls } = fakeLark();
    const adapter = createFeishuChannelAdapter(ctx, lark);
    await expect(adapter.send({ channel: 'feishu', conversationId: 'oc', content: 'x' })).rejects.toThrow(/not started/);
    await adapter.start(async () => {});
    await adapter.stop();
    await adapter.stop();
    expect(calls.disconnect).toBe(1);
  });

  it('start twice fails loud', async () => {
    const { lark } = fakeLark();
    const adapter = createFeishuChannelAdapter(ctx, lark);
    await adapter.start(async () => {});
    await expect(adapter.start(async () => {})).rejects.toThrow(/already started/);
  });

  it('connect failure cleans up the SDK side and rethrows (stop() after failed start is safe)', async () => {
    const { lark, calls, channel } = fakeLark();
    channel.connect = async () => { calls.connect += 1; throw new Error('handshake failed'); };
    const adapter = createFeishuChannelAdapter(ctx, lark);
    await expect(adapter.start(async () => {})).rejects.toThrow(/handshake failed/);
    expect(calls.disconnect).toBe(1);
    // 失败后状态复位：可重新 start
    channel.connect = async () => { calls.connect += 1; };
    await adapter.start(async () => {});
    expect(calls.connect).toBe(2);
  });

  it('events arriving after stop are ignored explicitly (no stale handler calls)', async () => {
    const { lark, handlers, channel } = fakeLark();
    const adapter = createFeishuChannelAdapter(ctx, lark);
    const got: ChannelMessage[] = [];
    await adapter.start(async (msg) => { got.push(msg); });
    await adapter.stop();
    handlers.get('message')?.(normalizedMessage());
    handlers.get('reject')?.({ messageId: 'om-1', chatId: 'oc', senderId: 'ou', reason: 'no_mention' });
    handlers.get('error')?.(new Error('late'));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(0);
  });

  it('stop keeps state on disconnect failure so stop can be retried', async () => {
    const { lark, calls, channel } = fakeLark();
    let fail = true;
    channel.disconnect = async () => {
      calls.disconnect += 1;
      if (fail) throw new Error('disconnect failed');
    };
    const adapter = createFeishuChannelAdapter(ctx, lark);
    await adapter.start(async () => {});
    fail = true;
    await expect(adapter.stop()).rejects.toThrow(/disconnect failed/);
    // 状态保留：重试 stop 成功后才清态，绝不产生第二连接
    fail = false;
    await adapter.stop();
    expect(calls.disconnect).toBe(2);
    await adapter.stop();
    expect(calls.disconnect).toBe(2);
  });
});

describe('feishu example plugin — message mapping unit', () => {
  it('toChannelMessage returns null without text and maps ids/labels', () => {
    expect(toChannelMessage('feishu', normalizedMessage({ content: '' }))).toBeNull();
    const mapped = toChannelMessage('feishu', normalizedMessage({ senderName: undefined }));
    expect(mapped).not.toBeNull();
    expect(mapped?.channel).toBe('feishu');
    expect(mapped?.senderName).toBeUndefined();
    expect(mapped?.metadata).toEqual({ chatType: 'p2p' });
  });
});

// ─────────────────────────────────────────────────────────────
// 5. 配置闸 / 会话作用域 / Gateway 生命周期（评审 #5 补强）
// ─────────────────────────────────────────────────────────────

describe('ChannelConfigSchema — type | plugin first gate', () => {
  it('accepts exactly one of type | plugin', () => {
    expect(ChannelConfigSchema.parse({ type: 'http', port: 18180 }).type).toBe('http');
    const pluginEntry = ChannelConfigSchema.parse({ plugin: 'feishu', apiKey: 'k', options: { appId: 'cli_1' } });
    expect(pluginEntry.plugin).toBe('feishu');
    expect(() => ChannelConfigSchema.parse({})).toThrow();
    expect(() => ChannelConfigSchema.parse({ type: 'http', plugin: 'feishu' })).toThrow();
  });
});

describe('Gateway buildSessionKey — dmScope (incl. per-conversation)', () => {
  const msg = (over: Partial<ChannelMessage> = {}): ChannelMessage => ({
    id: 'om-1',
    channel: 'feishu',
    senderId: 'ou_1',
    content: 'hi',
    conversationId: 'oc_1',
    timestamp: 1,
    ...over,
  });

  const keyFor = (dmScope: 'main' | 'per-peer' | 'per-channel-peer' | 'per-conversation', message: ChannelMessage = msg()): string => {
    const gateway = new Gateway(
      {
        agents: [{
          id: 'tester',
          home: join(root, 'agent'),
          workspace: join(root, 'workspace'),
          persona: { name: 'T', description: '', systemPrompt: 'S' },
          model: { provider: 'mock', model: 'm' },
          tools: { allow: [] },
        }],
        knowledge: { service: { manageLocal: false } },
        session: { dmScope },
      },
      new InMemorySessionStore(),
    );
    return (gateway as unknown as {
      buildSessionKey: (agent: { id: string }, m: ChannelMessage) => string;
    }).buildSessionKey({ id: 'tester' }, message);
  };

  it('maps all four scopes', () => {
    expect(keyFor('main')).toBe('tester:main');
    expect(keyFor('per-peer')).toBe('tester:ou_1');
    expect(keyFor('per-channel-peer')).toBe('tester:feishu:ou_1');
    expect(keyFor('per-conversation')).toBe('tester:feishu:oc_1');
  });

  it('client sessionId always wins', () => {
    expect(keyFor('per-conversation', msg({ metadata: { sessionId: 'sess-x' } }))).toBe('sess-x');
  });
});

describe('Gateway channel lifecycle — startup buffer + reverse stop (P5b review)', () => {
  const makeAgent = () => ({
    id: 'tester',
    home: join(root, 'agent'),
    workspace: join(root, 'workspace'),
    persona: { name: 'T', description: '', systemPrompt: 'S' },
    model: { provider: 'mock', model: 'm' },
    tools: { allow: [] },
  });
  const gatewayConfig = () => ({
    agents: [makeAgent()],
    knowledge: { service: { manageLocal: false } } as never,
  });

  it('stops channels in reverse registration order', async () => {
    const order: string[] = [];
    const mk = (name: string) => ({
      name,
      start: async () => {},
      send: async () => {},
      stop: async () => { order.push(name); },
    });
    const gateway = new Gateway(gatewayConfig(), new InMemorySessionStore());
    gateway.registerChannel(mk('chan-a'));
    gateway.registerChannel(mk('chan-b'));
    await gateway.start();
    await gateway.stop();
    expect(order).toEqual(['chan-b', 'chan-a']);
  });

  it('getChannelStatuses: adapters without status() default to running after start', async () => {
    const gateway = new Gateway(gatewayConfig(), new InMemorySessionStore());
    gateway.registerChannel({ name: 'plain', start: async () => {}, send: async () => {}, stop: async () => {} });
    expect(gateway.getChannelStatuses()).toEqual([{ name: 'plain', state: 'dormant', detail: 'not started' }]);
    await gateway.start();
    expect(gateway.getChannelStatuses()).toEqual([{ name: 'plain', state: 'running' }]);
    await gateway.stop();
  });

  it('getChannelStatuses: adapters with status() surface their own state verbatim', async () => {
    const gateway = new Gateway(gatewayConfig(), new InMemorySessionStore());
    gateway.registerChannel({
      name: 'sick',
      start: async () => {},
      send: async () => {},
      stop: async () => {},
      status: () => ({ state: 'degraded', detail: 'poll failing (3 in a row): ECONNRESET' }),
    });
    await gateway.start();
    expect(gateway.getChannelStatuses()).toEqual([
      { name: 'sick', state: 'degraded', detail: 'poll failing (3 in a row): ECONNRESET' },
    ]);
    await gateway.stop();
  });

  it('getChannelStatuses: a throwing status() degrades that channel without breaking health', async () => {
    const gateway = new Gateway(gatewayConfig(), new InMemorySessionStore());
    gateway.registerChannel({
      name: 'bad-probe',
      start: async () => {},
      send: async () => {},
      stop: async () => {},
      status: () => { throw new Error('probe exploded'); },
    });
    await gateway.start();
    const statuses = gateway.getChannelStatuses();
    expect(statuses[0]?.state).toBe('degraded');
    expect(statuses[0]?.detail).toContain('probe exploded');
    await gateway.stop();
  });

  it('partial channel failure degrades: failed adapter is stopped and dropped, others proceed', async () => {
    const stopCalls: string[] = [];
    const gateway = new Gateway(gatewayConfig(), new InMemorySessionStore());
    gateway.registerChannel({
      name: 'chan-bad',
      start: async () => { throw new Error('boom'); },
      send: async () => {},
      stop: async () => { stopCalls.push('chan-bad'); },
    });
    gateway.registerChannel({
      name: 'chan-good',
      start: async () => {},
      send: async () => {},
      stop: async () => { stopCalls.push('chan-good'); },
    });
    await gateway.start();
    expect(stopCalls).toEqual(['chan-bad']); // failed one got best-effort stop
    await gateway.stop();
    expect(stopCalls).toEqual(['chan-bad', 'chan-good']);
  });

  it('all channels failing aborts startup with AggregateError (real reasons attached)', async () => {
    const gateway = new Gateway(gatewayConfig(), new InMemorySessionStore());
    gateway.registerChannel({ name: 'a', start: async () => { throw new Error('ea'); }, send: async () => {}, stop: async () => {} });
    gateway.registerChannel({ name: 'b', start: async () => { throw new Error('eb'); }, send: async () => {}, stop: async () => {} });
    const err = await gateway.start().then(() => null, (e: unknown) => e as AggregateError);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).message).toContain('a (ea)');
    expect((err as AggregateError).message).toContain('b (eb)');
    expect((err as AggregateError).errors).toHaveLength(2);
    await gateway.stop();
  });

  it('a failed built-in http channel is fatal even when others start', async () => {
    const gateway = new Gateway(gatewayConfig(), new InMemorySessionStore());
    const goodStopped: string[] = [];
    gateway.registerChannel({ name: 'http', start: async () => { throw new Error('EADDRINUSE'); }, send: async () => {}, stop: async () => {} });
    gateway.registerChannel({ name: 'chan-good', start: async () => {}, send: async () => {}, stop: async () => { goodStopped.push('x'); } });
    const err = await gateway.start().then(() => null, (e: unknown) => e as AggregateError);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).message).toContain('EADDRINUSE');
    expect(goodStopped).toEqual(['x']); // fatal path stops what did start
    await gateway.stop();
  });

  it('buffers inbound messages during startup and replays them after ready', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const gateway = new Gateway(gatewayConfig(), new InMemorySessionStore());
      const inbound: ChannelMessage = {
        id: 'om-early',
        channel: 'chan-a',
        senderId: 'ou_1',
        content: 'sent while starting',
        conversationId: 'oc_1',
        timestamp: 1,
      };
      gateway.registerChannel({
        name: 'chan-a',
        // 通道先于 gateway readiness 收到消息（真实场景：后启动通道仍在握手）
        start: async (handler) => { await handler(inbound); },
        send: async () => {},
        stop: async () => {},
      });
      await gateway.start();
      // 缓冲已回放（不再排队）；消息到达全链（本用例无真实模型 →
      // 回放在业务段失败并被逐条记录，这正是“已回放”的直接证据）
      expect((gateway as unknown as { pendingInbound: ChannelMessage[] }).pendingInbound).toHaveLength(0);
      expect(
        error.mock.calls.some((c) => String(c[0]).includes('Queued inbound message') && String(c[0]).includes('failed after startup')),
      ).toBe(true);
      await gateway.stop();
    } finally {
      error.mockRestore();
    }
  });
});
