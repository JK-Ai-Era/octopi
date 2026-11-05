import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import { defaultHitlCache } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { ChannelAdapter, ChannelReply } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/channel-types.js';

let root: string;
let previousHome: string | undefined;
const gateways: Gateway[] = [];
const globalEvents: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octopi-plugin-gateway-hooks-'));
  previousHome = process.env.OCTOPI_HOME;
  process.env.OCTOPI_HOME = join(root, 'home');
  globalEvents.length = 0;
  defaultHitlCache.clear();
});

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
  if (previousHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function provider(): ModelProvider {
  return {
    name: 'mock', defaultModel: 'm', models: ['m'],
    chat: async (request) => {
      const content = request.messages.at(-1)?.content;
      const text = typeof content === 'string' ? content : '';
      return { content: `reply: ${text.includes('block this') ? 'block this' : 'allow this'}`, model: 'm', finishReason: 'stop' };
    },
    stream: async function* () { yield { type: 'done' as const }; },
    isAvailable: async () => true,
    getModelInfo: () => ({ name: 'm', contextWindow: 32000 }),
    getModelInfos: () => [{ name: 'm', contextWindow: 32000 }],
  };
}

function agent(): AgentDefinition {
  return {
    id: 'tester', home: join(root, 'agent'), workspace: join(root, 'workspace'),
    persona: { name: 'Tester', description: '', systemPrompt: 'STABLE_SYSTEM' },
    model: { provider: 'mock', model: 'm' }, tools: { allow: [] },
  };
}

function plugin(source: string, hooks: string[], services?: string[], id = 'acme.lifecycle'): void {
  const dir = join(root, 'plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'octopi.plugin.json'), JSON.stringify({
    id, apiVersion: '1', version: '1.0.0', name: 'Lifecycle', entry: './index.mjs',
    engine: { octopi: '>=0.1.0' }, configSchema: { type: 'object' },
    contributes: { hooks, ...(services ? { services } : {}) },
  }));
  writeFileSync(join(dir, 'index.mjs'), source);
}

async function makeGateway(start = true, pluginIds: string[] = ['acme.lifecycle']): Promise<{ gateway: Gateway; store: InMemorySessionStore }> {
  const store = new InMemorySessionStore();
  const gateway = new Gateway({
    agents: [agent()], knowledge: { service: { manageLocal: false } },
    plugins: {
      loadPaths: [join(root, 'plugins')],
      entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
    },
  }, store);
  gateways.push(gateway);
  gateway.registerProvider(provider());
  if (start) await gateway.start();
  return { gateway, store };
}

class TestChannel implements ChannelAdapter {
  readonly name = 'test-channel';
  starts = 0;
  stops = 0;
  readonly sent: ChannelReply[] = [];
  async start(): Promise<void> { this.starts++; }
  async send(reply: ChannelReply): Promise<void> { this.sent.push(reply); }
  async stop(): Promise<void> { this.stops++; }
}

describe('Gateway P4 plugin services, messages and Sessions', () => {
  it('starts declared services before ready, observes gateway hooks, and stops in reverse order', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.registerService({ serviceId: 'one', start() { globalThis.lifecycleCalls.push('start:one'); }, stop() { globalThis.lifecycleCalls.push('stop:one'); } });
      api.registerService({ serviceId: 'two', start() { globalThis.lifecycleCalls.push('start:two'); }, stop() { globalThis.lifecycleCalls.push('stop:two'); } });
      api.on('gateway_start', () => { globalThis.lifecycleCalls.push('hook:start'); });
      api.on('gateway_stop', () => { globalThis.lifecycleCalls.push('hook:stop'); });
    } };`, ['gateway_start', 'gateway_stop'], ['one', 'two']);
    const { gateway } = await makeGateway(false);
    const channel = new TestChannel();
    gateway.registerChannel(channel);
    (globalThis as unknown as { lifecycleCalls: string[] }).lifecycleCalls = globalEvents;
    await gateway.start();
    await gateway.start();
    expect(globalEvents).toEqual(['start:one', 'start:two', 'hook:start']);
    expect(channel.starts).toBe(1);
    await gateway.stop();
    await gateway.stop();
    expect(globalEvents).toEqual(['start:one', 'start:two', 'hook:start', 'hook:stop', 'stop:two', 'stop:one']);
    expect(channel.stops).toBe(1);
  });

  it('rejects required service startup before opening a Channel and cleans up on retry', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.registerService({ serviceId: 'broken', required: true, start() { throw new Error('required unavailable'); } });
    } };`, [], ['broken']);
    const { gateway } = await makeGateway(false);
    const channel = new TestChannel();
    gateway.registerChannel(channel);
    await expect(gateway.start()).rejects.toThrow('required unavailable');
    expect(channel.starts).toBe(0);
    expect(channel.stops).toBe(0);
    await expect(gateway.start()).rejects.toThrow('required unavailable');
    expect(channel.starts).toBe(0);
    expect(gateway.getPluginManager().getDiagnostics()).toContainEqual(expect.objectContaining({ id: 'acme.lifecycle', status: 'registered' }));
  });

  it('keeps an optional failure observable with a real pluginId and opens the Host', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.registerService({ serviceId: 'optional', start() { throw new Error('optional unavailable'); } });
    } };`, [], ['optional']);
    const { gateway } = await makeGateway();
    expect(gateway.listSystemIssues('open')).toContainEqual(expect.objectContaining({
      domain: 'plugins', code: 'plugin.service.failed', refs: [expect.objectContaining({ pluginId: 'acme.lifecycle' })],
    }));
  });

  it('rejects an undeclared service before import completes', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.registerService({ serviceId: 'hidden', start() { throw new Error('must not execute'); } });
    } };`, []);
    const { gateway } = await makeGateway();
    expect(gateway.getPluginManager().getRegisteredIds()).toEqual([]);
    expect(gateway.getPluginManager().getDiagnostics()).toContainEqual(expect.objectContaining({
      id: 'acme.lifecycle', status: 'failed', reason: expect.stringContaining('not declared'),
    }));
  });

  it('observes receipt, denies outbound replies, and reports actual send success', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.on('message_received', (event) => { globalThis.lifecycleCalls.push('received:' + event.message.content); });
      api.on('message_sending', (event) => {
        globalThis.lifecycleCalls.push('sending:' + event.reply.content);
        if (event.reply.content.includes('block')) return { decision: 'deny', reason: 'test deny' };
        return { decision: 'allow' };
      });
      api.on('message_sent', (event) => { globalThis.lifecycleCalls.push('sent:' + event.success); });
    } };`, ['message_received', 'message_sending', 'message_sent']);
    const { gateway } = await makeGateway();
    (globalThis as unknown as { lifecycleCalls: string[] }).lifecycleCalls = globalEvents;
    const channel = new TestChannel();
    (gateway as unknown as { channels: Map<string, TestChannel> }).channels.set(channel.name, channel);
    await gateway.send({ id: '1', channel: channel.name, senderId: 'alice', content: 'block this', conversationId: 'blocked', timestamp: 1, metadata: { sessionId: 'blocked-session' } });
    await gateway.send({ id: '2', channel: channel.name, senderId: 'alice', content: 'allow this', conversationId: 'allowed', timestamp: 2, metadata: { sessionId: 'allowed-session' } });
    expect(channel.sent.map((reply) => reply.content)).toEqual(['reply: allow this']);
    expect(globalEvents).toEqual([
      'received:block this', 'sending:reply: block this', 'received:allow this', 'sending:reply: allow this', 'sent:true',
    ]);
  });

  it('observes a failed Channel send with success=false and the real error', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.on('message_sent', (event) => { globalThis.lifecycleCalls.push(event.success + ':' + event.error); });
    } };`, ['message_sent']);
    const { gateway } = await makeGateway();
    (globalThis as unknown as { lifecycleCalls: string[] }).lifecycleCalls = globalEvents;
    const channel = new TestChannel();
    channel.send = async () => { throw new Error('socket unavailable'); };
    (gateway as unknown as { channels: Map<string, TestChannel> }).channels.set(channel.name, channel);
    await expect(gateway.send({ id: '1', channel: channel.name, senderId: 'alice', content: 'hello', conversationId: 'failed', timestamp: 1, metadata: { sessionId: 'failed-session' } })).rejects.toThrow('socket unavailable');
    expect(globalEvents).toEqual(['false:socket unavailable']);
  });

  it('observes a Runner-created Session only after the Store contains it', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.on('session_start', (event) => { globalThis.lifecycleCalls.push(event.sessionId + ':' + event.reason); });
    } };`, ['session_start']);
    const { gateway, store } = await makeGateway();
    (globalThis as unknown as { lifecycleCalls: string[] }).lifecycleCalls = globalEvents;
    await gateway.send({ id: '1', channel: 'test', senderId: 'alice', content: 'hello', conversationId: 'new-session', timestamp: 1, metadata: { sessionId: 'tester:new-session' } });
    expect(await store.load('tester:new-session')).not.toBeNull();
    expect(globalEvents).toEqual(['tester:new-session:created']);
    await gateway.send({ id: '2', channel: 'test', senderId: 'alice', content: 'again', conversationId: 'new-session', timestamp: 2, metadata: { sessionId: 'tester:new-session' } });
    expect(globalEvents).toEqual(['tester:new-session:created']);
  });

  it('routes before_tool_call approval through the real HITL channel and honors approve_session / approve_always', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.onBeforeToolCall('vote', () => ({ decision: 'require_approval', approval: { title: 'Run echo', description: 'execute echo tool', severity: 'high', timeoutMs: 5000 } }));
    } };`, ['before_tool_call']);
    const { gateway } = await makeGateway();
    const port = gateway.getPluginManager().getHookPort();
    const event = { sessionId: 'approval-session', agentId: 'tester', runId: 'run-1', toolName: 'echo', call: { id: 'c1', name: 'echo', arguments: {} }, params: { value: 'x' } };

    const first = port.voteBeforeToolCall(event, event.params);
    await vi.waitFor(() => expect(gateway.listPendingApprovals('approval-session').filter((a) => a.status === 'pending')).toHaveLength(1));
    const card = gateway.listPendingApprovals('approval-session').find((a) => a.status === 'pending')!;
    expect(card.request).toMatchObject({ kind: 'high_risk', toolName: 'echo', arguments: { value: 'x' }, riskLevel: 'high' });
    gateway.resolvePendingApproval(card.id, { action: 'approve', scope: 'session', approver: 'owner' });
    await expect(first).resolves.toMatchObject({ decision: 'allow' });
    // approve_session is remembered by the engine cache: no second card, still allowed
    await expect(port.voteBeforeToolCall(event, event.params)).resolves.toMatchObject({ decision: 'allow' });
    expect(gateway.listPendingApprovals('approval-session').filter((a) => a.status === 'pending')).toEqual([]);

    // approve_always is remembered per agent + tool: no second card either
    const alwaysEvent = { ...event, toolName: 'reader', call: { id: 'c2', name: 'reader', arguments: {} } };
    const alwaysVote = port.voteBeforeToolCall(alwaysEvent, alwaysEvent.params);
    await vi.waitFor(() => expect(gateway.listPendingApprovals('approval-session').filter((a) => a.status === 'pending')).toHaveLength(1));
    const alwaysCard = gateway.listPendingApprovals('approval-session').find((a) => a.status === 'pending')!;
    gateway.resolvePendingApproval(alwaysCard.id, { action: 'approve', scope: 'always' });
    await expect(alwaysVote).resolves.toMatchObject({ decision: 'allow' });
    await expect(port.voteBeforeToolCall(alwaysEvent, alwaysEvent.params)).resolves.toMatchObject({ decision: 'allow' });
    expect(gateway.listPendingApprovals('approval-session').filter((a) => a.status === 'pending')).toEqual([]);
  });

  it('fails closed on approval timeout and labels the denial source as timeout', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.onBeforeToolCall('vote', () => ({ decision: 'require_approval', approval: { title: 'Run echo', description: 'execute echo tool', timeoutMs: 30 } }));
    } };`, ['before_tool_call']);
    const { gateway } = await makeGateway();
    const event = { sessionId: 'approval-timeout', agentId: 'tester', runId: 'r', toolName: 'echo', call: { id: 'c1', name: 'echo', arguments: {} }, params: {} };
    await expect(gateway.getPluginManager().getHookPort().voteBeforeToolCall(event, event.params))
      .resolves.toMatchObject({ decision: 'deny', reason: 'Host approval was not granted: timeout' });
    expect(gateway.listPendingApprovals('approval-timeout')[0]?.decisionReason).toBe('timeout');
  });

  it('distinguishes cancel and human reject from timeout in the denial source', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.onBeforeToolCall('vote', () => ({ decision: 'require_approval', approval: { title: 'Run echo', description: 'execute echo tool', timeoutMs: 5000 } }));
    } };`, ['before_tool_call']);
    const { gateway } = await makeGateway();
    const port = gateway.getPluginManager().getHookPort();
    const event = (sessionId: string) => ({ sessionId, agentId: 'tester', runId: 'r', toolName: 'echo', call: { id: 'c1', name: 'echo', arguments: {} }, params: {} });

    const cancelled = port.voteBeforeToolCall(event('approval-cancel'), {});
    await vi.waitFor(() => expect(gateway.listPendingApprovals('approval-cancel').filter((a) => a.status === 'pending')).toHaveLength(1));
    gateway.cancelPendingApprovals('approval-cancel');
    await expect(cancelled).resolves.toMatchObject({ decision: 'deny', reason: 'Host approval was not granted: cancelled' });

    const rejected = port.voteBeforeToolCall(event('approval-reject'), {});
    await vi.waitFor(() => expect(gateway.listPendingApprovals('approval-reject').filter((a) => a.status === 'pending')).toHaveLength(1));
    const card = gateway.listPendingApprovals('approval-reject').find((a) => a.status === 'pending')!;
    gateway.resolvePendingApproval(card.id, { action: 'reject', approver: 'owner' });
    await expect(rejected).resolves.toMatchObject({ decision: 'deny', reason: 'Host approval was not granted: deny' });
    expect(gateway.listPendingApprovals('approval-reject')[0]?.decisionReason).toBeUndefined();
  });

  it('keeps approval memory per plugin: one plugin\'s session grant never satisfies another', async () => {
    plugin(`export default { id: 'acme.lifecycle', register(api) {
      api.onBeforeToolCall('vote', () => ({ decision: 'require_approval', approval: { title: 'A asks', description: 'run echo', timeoutMs: 5000 } }));
    } };`, ['before_tool_call']);
    plugin(`export default { id: 'acme.other', register(api) {
      api.onBeforeToolCall('vote', () => ({ decision: 'require_approval', approval: { title: 'B asks', description: 'run echo', timeoutMs: 5000 } }));
    } };`, ['before_tool_call'], undefined, 'acme.other');
    const { gateway: iso } = await makeGateway(true, ['acme.lifecycle', 'acme.other']);
    const isoPort = iso.getPluginManager().getHookPort();
    const isoEvent = { sessionId: 'iso', agentId: 'tester', runId: 'r', toolName: 'echo', call: { id: 'c1', name: 'echo', arguments: {} }, params: {} };
    const pending = (): Array<{ id: string; request: { actionDescription: string } }> =>
      iso.listPendingApprovals('iso').filter((a) => a.status === 'pending');

    // Round 1: both plugins ask about the same tool — one card at a time.
    const first = isoPort.voteBeforeToolCall(isoEvent, isoEvent.params);
    await vi.waitFor(() => expect(pending().length).toBe(1));
    expect(pending()[0]!.request.actionDescription).toBe('A asks');
    iso.resolvePendingApproval(pending()[0]!.id, { action: 'approve', scope: 'session', approver: 'owner' });
    await vi.waitFor(() => expect(pending().length).toBe(1));
    expect(pending()[0]!.request.actionDescription).toBe('B asks');
    iso.resolvePendingApproval(pending()[0]!.id, { action: 'reject', approver: 'owner' });
    await expect(first).resolves.toMatchObject({ decision: 'deny' });

    // Round 2: A rides its own session grant (no card); B must ask again — a grant
    // recorded under one plugin's policy can never answer another plugin's question.
    const second = isoPort.voteBeforeToolCall(isoEvent, isoEvent.params);
    await vi.waitFor(() => expect(pending().length).toBe(1));
    expect(pending()[0]!.request.actionDescription).toBe('B asks');
    iso.resolvePendingApproval(pending()[0]!.id, { action: 'approve', approver: 'owner' });
    await expect(second).resolves.toMatchObject({ decision: 'allow' });
  });
});
