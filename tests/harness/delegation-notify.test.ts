/**
 * P3 测试 — notify 通道（§7.1）与长 Run 状态提示（§7.3）
 *
 * 覆盖 `arch/delegation.md` P3：
 * - 子终态 → `emitAgentSignal` → `AgentSignalSource` → Trigger
 * - Compiler 透传 `delegationId` 到消息 metadata
 * - `<delegation_completed …/>` 内容渲染
 * - `wireDelegation`：工具只挂给 canDelegate 的 agent + 状态提示接线
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { Trigger } from '@octopi-agent/engine/harness/activation/types.js';
import {
  AgentSignalSource,
  emitAgentSignal,
  hasAgentSignalReceiver,
} from '@octopi-agent/engine/harness/activation/sources/agent-signal.js';
import { compileMessages } from '@octopi-agent/engine/harness/activation/compiler.js';
import type { Delegation } from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
import {
  createDelegationNotifier,
  renderDelegationNotice,
  delegationReason,
} from '@octopi-agent/engine/harness/collaboration/delegation/notifier.js';
import {
  DelegationStore,
} from '@octopi-agent/engine/harness/collaboration/delegation/store.js';
import {
  DelegateService,
} from '@octopi-agent/engine/harness/collaboration/delegation/service.js';
import { DefaultAgentRegistry } from '@octopi-agent/engine/harness/collaboration/delegation/registry.js';
import { InProcessTransport } from '@octopi-agent/engine/harness/collaboration/delegation/transport.js';
import {
  DELEGATION_SCHEMA_VERSION,
} from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
import {
  wireDelegation,
  createDelegationRuntime,
} from '@octopi-agent/engine/harness/collaboration/delegation/wiring.js';

function makeDelegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    id: 'del-abc',
    parent: { agentId: 'main', sessionId: 's-parent', runId: 'r-1' },
    target: { agentId: 'worker' },
    resolvedAgentId: 'worker',
    task: 'research X',
    input: 'raw',
    context: 'clean',
    status: 'completed',
    output: 'found it',
    depth: 1,
    createdAt: Date.now(),
    cancelable: true,
    cascade: false,
    notified: false,
    schemaVersion: DELEGATION_SCHEMA_VERSION,
    ...overrides,
  };
}

// ── 渲染（§7.1） ──

describe('renderDelegationNotice', () => {
  it('renders a self-closing tag when there is no body', () => {
    const text = renderDelegationNotice(makeDelegation({ output: undefined }));
    expect(text).toMatch(/^<delegation_completed /);
    expect(text).toContain('id="del-abc"');
    expect(text).toContain('status="completed"');
    expect(text).toContain('agent="worker"');
    expect(text).toContain('/>');
  });

  it('wraps output in a body when present', () => {
    const text = renderDelegationNotice(makeDelegation());
    expect(text).toContain('<output>found it</output>');
  });

  it('switches to delegation_failed for non-completed statuses', () => {
    expect(renderDelegationNotice(makeDelegation({ status: 'failed', output: undefined, error: 'boom' })))
      .toContain('<delegation_failed');
    expect(renderDelegationNotice(makeDelegation({ status: 'timeout', output: undefined })))
      .toContain('<delegation_failed');
  });

  it('escapes markup in untrusted child output', () => {
    const text = renderDelegationNotice(
      makeDelegation({ output: '</output><injected>x</injected>' }),
    );
    expect(text).not.toContain('<injected>');
    expect(text).toContain('&lt;injected&gt;');
  });

  it('derives the notify reason from status', () => {
    expect(delegationReason(makeDelegation({ status: 'completed' }))).toBe('delegation_completed');
    expect(delegationReason(makeDelegation({ status: 'failed', output: undefined }))).toBe('delegation_failed');
  });
});

// ── notify 通道（§7.1） ──

describe('delegation notify channel', () => {
  it('emits an agent_signal that AgentSignalSource turns into a trigger', async () => {
    const events = new DefaultEventBus();
    const source = new AgentSignalSource({ events });
    const triggers: Trigger[] = [];
    await source.start((t) => triggers.push(t));

    const notifier = createDelegationNotifier({ events });
    notifier(makeDelegation());

    await vi.waitFor(() => expect(triggers.length).toBe(1));
    const t = triggers[0];
    expect(t.type).toBe('agent_signal');
    expect(t.agentId).toBe('main');
    expect(t.sessionId).toBe('s-parent');
    expect(t.payload.kind).toBe('system_note');
    expect((t.payload as { content: string }).content).toContain('<delegation_completed');
    expect(t.metadata?.delegationId).toBe('del-abc');
    expect(t.metadata?.parentAgentId).toBe('worker');

    await source.stop();
  });

  it('Compiler carries delegationId into message metadata', async () => {
    const events = new DefaultEventBus();
    const source = new AgentSignalSource({ events });
    const triggers: Trigger[] = [];
    await source.start((t) => triggers.push(t));

    createDelegationNotifier({ events })(makeDelegation());
    await vi.waitFor(() => expect(triggers.length).toBe(1));

    const [message] = compileMessages(triggers);
    expect(message.metadata).toMatchObject({
      delegationId: 'del-abc',
      source: 'runtime',
      triggerType: 'agent_signal',
      parentAgentId: 'worker',
    });
    // 不伪装真人（arch/agent-runtime.md Compiler 规则）
    expect(message.role).toBe('user');

    await source.stop();
  });

  it('a failed delegation reports the error body', async () => {
    const events = new DefaultEventBus();
    const source = new AgentSignalSource({ events });
    const triggers: Trigger[] = [];
    await source.start((t) => triggers.push(t));

    createDelegationNotifier({ events })(
      makeDelegation({ status: 'failed', output: undefined, error: 'child exploded' }),
    );
    await vi.waitFor(() => expect(triggers.length).toBe(1));

    const content = (triggers[0].payload as { content: string }).content;
    expect(content).toContain('<delegation_failed');
    expect(content).toContain('<error>child exploded</error>');

    await source.stop();
  });

  it('emitAgentSignal carries delegationId end to end', async () => {
    const events = new DefaultEventBus();
    const seen: Array<Record<string, unknown>> = [];
    events.on('runtime.agent_signal', (e) => seen.push((e.data ?? {}) as Record<string, unknown>));

    emitAgentSignal(events, {
      fromAgentId: 'child',
      toAgentId: 'main',
      sessionId: 's',
      payload: { kind: 'system_note', content: 'hi' },
      reason: 'delegation_completed',
      delegationId: 'del-xyz',
    });

    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0].delegationId).toBe('del-xyz');
  });
});

// ── DelegateService notify 触发 ──

describe('DelegateService notify', () => {
  it('fires the notifier exactly once per terminal delegation', async () => {
    const events = new DefaultEventBus();
    // 投递器要求总线上有接收端（AgentSignalSource）；挂上后走真实投递路径
    const source = new AgentSignalSource({ events });
    await source.start(() => {});
    const notifier = createDelegationNotifier({ events });
    const spy = vi.fn((d: Delegation) => notifier(d));

    const registry = new DefaultAgentRegistry();
    registry.register({
      id: 'worker',
      name: 'worker',
      traits: [],
      status: 'idle',
      delegation: { callable: true, canDelegate: false, maxDepth: 1 },
    });
    const store = new DelegationStore(events);
    const service = new DelegateService(
      store,
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        output: 'ok',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      { notifier: spy },
    );

    await service.dispatch({
      parent: { agentId: 'main', sessionId: 's', runId: 'r' },
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(store.list()[0].notified).toBe(true);
    await source.stop();
  });

  it('a notifier without a receiver refuses to claim delivery', () => {
    const events = new DefaultEventBus();
    // 总线上没有 AgentSignalSource：投递必须失败，否则会被误标已送达（断链根因）
    const notifier = createDelegationNotifier({ events });
    expect(() => notifier(makeDelegation())).toThrow(/no AgentSignalSource receiver/);
  });
});

// ── hasAgentSignalReceiver 引用计数配平 ──

describe('hasAgentSignalReceiver 引用计数配平', () => {
  it('未 start / 二次 stop 不得误删兄弟 source 的接收端登记', async () => {
    const events = new DefaultEventBus();
    const a = new AgentSignalSource({ events });
    await a.start(() => {});

    const neverStarted = new AgentSignalSource({ events });
    await neverStarted.stop();
    expect(hasAgentSignalReceiver(events)).toBe(true);

    await a.stop();
    await a.stop();
    expect(hasAgentSignalReceiver(events)).toBe(false);

    // 重新挂载仍可恢复（stop → start 计数配平）
    const b = new AgentSignalSource({ events });
    await b.start(() => {});
    expect(hasAgentSignalReceiver(events)).toBe(true);
    await b.stop();
    expect(hasAgentSignalReceiver(events)).toBe(false);
  });
});

// ── wireDelegation ──

function fakeAgent(agentId: string, delegation?: { callable: boolean; canDelegate: boolean; maxDepth?: number }) {
  const self = {
    agentId,
    agent: {
      contextSessionId: 'default',
      setSteeringMessages(fn: unknown) {
        self.steering = fn;
      },
    },
    runner: {},
    store: {},
    traits: [] as string[],
    delegation,
    registered: [] as string[],
    registerTools(tools: Array<{ definition: { name: string } }>) {
      for (const t of tools) self.registered.push(t.definition.name);
    },
    steering: undefined as unknown,
  };
  return self;
}

describe('wireDelegation', () => {
  it('returns undefined when no agent can delegate', () => {
    const plain = fakeAgent('plain', { callable: true, canDelegate: false });
    const result = wireDelegation([plain] as never, {});
    expect(result).toBeUndefined();
    expect(plain.registered).toEqual([]);
  });

  it('registers the four delegate tools only on delegating agents', () => {
    const boss = fakeAgent('boss', { callable: true, canDelegate: true, maxDepth: 2 });
    const worker = fakeAgent('worker', { callable: true, canDelegate: false, maxDepth: 1 });

    const wiring = wireDelegation([boss, worker] as never, {});

    expect(wiring?.notifyWired).toBe(false);
    expect(boss.registered.sort()).toEqual(
      ['delegate_cancel', 'delegate_dispatch', 'delegate_get', 'delegate_list'],
    );
    expect(worker.registered).toEqual([]);
  });

  it('wires notify only when a shared bus is supplied', () => {
    const mk = (events?: DefaultEventBus) => {
      const boss = fakeAgent('boss', { callable: true, canDelegate: true, maxDepth: 2 });
      return wireDelegation([boss] as never, events ? { events } : {});
    };

    expect(mk(undefined)?.notifyWired).toBe(false);
    expect(mk(new DefaultEventBus())?.notifyWired).toBe(true);
  });

  it('does not install the notifier when notifyPush is false (poll + hint fallback)', () => {
    const boss = fakeAgent('boss', { callable: true, canDelegate: true, maxDepth: 2 });
    const wiring = wireDelegation([boss] as never, {
      events: new DefaultEventBus(),
      notifyPush: false,
    });
    expect(wiring?.notifyWired).toBe(false);
  });

  it('attaches a delegation_status steering hook to delegating agents (§7.3)', () => {
    const boss = fakeAgent('boss', { callable: true, canDelegate: true, maxDepth: 2 });
    wireDelegation([boss] as never, {});
    expect(typeof boss.steering).toBe('function');
  });

  it('leaves non-delegating agents without a steering hook', () => {
    const worker = fakeAgent('worker', { callable: true, canDelegate: false });
    wireDelegation([worker] as never, {});
    expect(worker.steering).toBeUndefined();
  });

  it('supports incremental attach (Gateway lazy-build pattern)', () => {
    const runtime = createDelegationRuntime({ events: new DefaultEventBus() });
    expect(runtime.notifyWired).toBe(true);
    expect(runtime.attached).toEqual([]);

    const boss = fakeAgent('boss', { callable: true, canDelegate: true, maxDepth: 2 });
    runtime.attach(boss as never);
    expect(runtime.attached).toEqual(['boss']);
    expect(boss.registered.sort()).toEqual(
      ['delegate_cancel', 'delegate_dispatch', 'delegate_get', 'delegate_list'],
    );

    // 幂等：重复 attach 不重复挂工具
    runtime.attach(boss as never);
    expect(boss.registered).toHaveLength(4);

    // 后续 worker 仍可被委派（走惰性 resolve）
    const worker = fakeAgent('worker', { callable: true, canDelegate: false });
    runtime.attach(worker as never);
    expect(worker.registered).toEqual([]);
    expect(runtime.registry.get('worker')?.delegation?.callable).toBe(true);
    expect(runtime.registry.get('worker')?.delegation?.canDelegate).toBe(false);
  });
});

// ── 状态提示渲染（§7.3） ──

describe('delegation_status hint', () => {
  it('shows in-flight delegations and clears once all are surfaced', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register({
      id: 'worker',
      name: 'worker',
      traits: [],
      status: 'idle',
      delegation: { callable: true, canDelegate: false, maxDepth: 1 },
    });
    const store = new DelegationStore();
    // 永不落地的 transport：保持 running，验证提示里能看到在途委派
    const service = new DelegateService(
      store,
      registry,
      new InProcessTransport(() => new Promise(() => { /* never settles */ })),
      {},
    );

    expect(service.renderStatusHint('s-1')).toBe('');

    await service.dispatch({
      parent: { agentId: 'main', sessionId: 's-1', runId: 'r' },
      target: { agentId: 'worker' },
      task: 'a',
      input: 'i',
    });
    await service.dispatch({
      parent: { agentId: 'main', sessionId: 's-1', runId: 'r' },
      target: { agentId: 'worker' },
      task: 'b',
      input: 'i',
    });

    const hint = service.renderStatusHint('s-1');
    expect(hint).toContain('<delegation_status>');
    expect(hint).toContain('2 running');
    // 不串 session
    expect(service.renderStatusHint('s-other')).toBe('');
  });

  it('does not repeat work already delivered through the notify channel', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register({
      id: 'worker',
      name: 'worker',
      traits: [],
      status: 'idle',
      delegation: { callable: true, canDelegate: false, maxDepth: 1 },
    });
    const store = new DelegationStore();
    const delivered = vi.fn();
    const service = new DelegateService(
      store,
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        output: 'ok',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      { notifier: delivered },
    );

    await service.dispatch({
      parent: { agentId: 'main', sessionId: 's-1', runId: 'r' },
      target: { agentId: 'worker' },
      task: 'a',
      input: 'i',
    });

    // 终态 + notify 投递成功后，提示不再重复（notify 通道已送达）
    await vi.waitFor(() => expect(service.renderStatusHint('s-1')).toBe(''));
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(store.list()[0].notified).toBe(true);
  });
});
