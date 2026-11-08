/**
 * P3 测试 — notify 通道（§7.1）与长 Run 状态提示（§7.3）
 *
 * 覆盖 `arch/delegation.md` P3：
 * - 子终态 → `emitAgentSignal` → `AgentSignalSource` → Trigger
 * - Compiler 透传 `delegationId` 到消息 metadata
 * - `<delegation_result …>` 内容渲染（统一信封，status 属性区分终态）
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
  DEFAULT_DELEGATION_OUTPUT_CHARS,
  DELEGATION_SCHEMA_VERSION,
  normalizeMaxOutputChars,
} from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
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
import type {
  DispatchDelegationInput,
} from '@octopi-agent/engine/harness/collaboration/delegation/service.js';
import {
  createDelegateDispatchTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/delegation.js';
import { DefaultAgentRegistry } from '@octopi-agent/engine/harness/collaboration/delegation/registry.js';
import { InProcessTransport } from '@octopi-agent/engine/harness/collaboration/delegation/transport.js';
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
    deliveryState: 'pending',
    schemaVersion: DELEGATION_SCHEMA_VERSION,
    ...overrides,
  };
}

// ── 渲染（§7.1） ──

describe('renderDelegationNotice', () => {
  it('renders a self-closing tag when there is no body', () => {
    const text = renderDelegationNotice(makeDelegation({ output: undefined }));
    expect(text).toMatch(/^<delegation_result /);
    expect(text).toContain('id="del-abc"');
    expect(text).toContain('status="completed"');
    expect(text).toContain('agent="worker"');
    expect(text).toContain('/>');
  });

  it('wraps output in a body when present', () => {
    const text = renderDelegationNotice(makeDelegation());
    expect(text).toContain('<output>found it</output>');
  });

  it('keeps the unified envelope and reports the raw status', () => {
    const failed = renderDelegationNotice(makeDelegation({ status: 'failed', output: undefined, error: 'boom' }));
    expect(failed).toContain('<delegation_result');
    expect(failed).toContain('status="failed"');
    expect(renderDelegationNotice(makeDelegation({ status: 'timeout', output: undefined })))
      .toContain('status="timeout"');
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

// ── 自动返回结果截断上限（B 方案，2026-11-09 拍板） ──

describe('delegation output cap（max_output_chars）', () => {
  it('缺省按 DEFAULT_DELEGATION_OUTPUT_CHARS（16k）截断自动返回 <output>', () => {
    const big = 'x'.repeat(30_000);
    const text = renderDelegationNotice(makeDelegation({ output: big }));
    const m = text.match(/<output>([\s\S]*)<\/output>/);
    expect(m).toBeTruthy();
    expect(m![1]!.length).toBe(DEFAULT_DELEGATION_OUTPUT_CHARS + 1); // +1 = '…' 截断标记
    expect(m![1]!.endsWith('…')).toBe(true);
  });

  it('maxOutputChars 按委派单生效（覆盖缺省）', () => {
    const big = 'x'.repeat(30_000);
    const text = renderDelegationNotice(makeDelegation({ output: big, maxOutputChars: 500 }));
    const m = text.match(/<output>([\s\S]*)<\/output>/);
    expect(m![1]!.length).toBe(501);
    expect(m![1]!.startsWith('x'.repeat(500))).toBe(true);
  });

  it('短输出不截断（上限只封顶不填充）', () => {
    const text = renderDelegationNotice(makeDelegation({ output: 'short', maxOutputChars: 500 }));
    expect(text).toContain('<output>short</output>');
  });

  it('默认上限钉死产品拍板 16k（B 方案，m7）', () => {
    expect(DEFAULT_DELEGATION_OUTPUT_CHARS).toBe(16_000);
  });

  it('<error> 1000 cap 回归（n4，有意保留）', () => {
    const text = renderDelegationNotice(
      makeDelegation({ output: undefined, error: 'e'.repeat(3000) }),
    );
    const m = text.match(/<error>([\s\S]*)<\/error>/);
    expect(m).toBeTruthy();
    expect(m![1]!.length).toBe(1001); // 1000 + '…' 截断标记
  });
});

describe('normalizeMaxOutputChars（写入口校验，M2）', () => {
  it('undefined 通过（未指定，渲染侧回落默认）', () => {
    expect(normalizeMaxOutputChars(undefined)).toBeUndefined();
  });

  it('正整数原样通过', () => {
    expect(normalizeMaxOutputChars(16_000)).toBe(16_000);
  });

  it('NaN/0/负数/Infinity/小数 fail loud（不静默丢结果也不静默禁用截断）', () => {
    for (const bad of [NaN, 0, -3, Infinity, 1.5]) {
      expect(() => normalizeMaxOutputChars(bad), String(bad)).toThrow(/maxOutputChars/);
    }
  });
});

describe('delegate_dispatch max_output_chars 透传与校验', () => {
  /** 捕获 dispatch 入参的假服务 */
  function fakeService(): { service: DelegateService; calls: DispatchDelegationInput[] } {
    const calls: DispatchDelegationInput[] = [];
    const service = {
      dispatch: async (input: DispatchDelegationInput) => {
        calls.push(input);
        return { delegation: makeDelegation(), resolvedAgentId: 'worker' };
      },
    } as unknown as DelegateService;
    return { service, calls };
  }

  /** 真实 service（M3 中间层：service.dispatch → store.create 链路） */
  function realService(): { store: DelegationStore; service: DelegateService } {
    const events = new DefaultEventBus();
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
      {},
    );
    return { store, service };
  }

  const ctx = { agentId: 'main', sessionId: 's1', runId: 'r1', messages: [] } as never;

  it('max_output_chars 传入 → maxOutputChars 透传到 dispatch 入参', async () => {
    const { service, calls } = fakeService();
    const tool = createDelegateDispatchTool(service);
    const res = (await tool.handler!(
      { agent: 'worker', task: 't', input: 'i', max_output_chars: 500 },
      ctx,
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(calls[0]!.maxOutputChars).toBe(500);
  });

  it('maxOutputChars 穿透 service.dispatch → store（M3 中间层）', async () => {
    const { store, service } = realService();
    const tool = createDelegateDispatchTool(service);
    const res = (await tool.handler!(
      { agent: 'worker', task: 't', input: 'i', max_output_chars: 500 },
      ctx,
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(store.list()[0]!.maxOutputChars).toBe(500);
  });

  it('非法值 fail loud（M2/m6）：NaN/0/负数/Infinity/小数 → ok:false 带错', async () => {
    const { service } = realService();
    const tool = createDelegateDispatchTool(service);
    for (const bad of [NaN, 0, -5, Infinity, 1.5]) {
      const res = (await tool.handler!(
        { agent: 'worker', task: 't', input: 'i', max_output_chars: bad },
        ctx,
      )) as { ok: boolean; error?: string };
      expect(res.ok, `max_output_chars=${String(bad)}`).toBe(false);
      expect(res.error).toContain('maxOutputChars');
    }
  });

  it('缺省 → undefined（渲染侧回落 DEFAULT_DELEGATION_OUTPUT_CHARS）', async () => {
    const { service, calls } = fakeService();
    const tool = createDelegateDispatchTool(service);
    await tool.handler!({ agent: 'worker', task: 't', input: 'i' }, ctx);
    expect(calls[0]!.maxOutputChars).toBeUndefined();
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
    expect((t.payload as { content: string }).content).toContain('<delegation_result');
    expect((t.payload as { content: string }).content).toContain('status="completed"');
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
    expect(content).toContain('<delegation_result');
    expect(content).toContain('status="failed"');
    expect(content).toContain('<error>child exploded</error>');

    await source.stop();
  });

  it('emitAgentSignal carries delegationId end to end', async () => {
    const events = new DefaultEventBus();
    const seen: Array<Record<string, unknown>> = [];
    events.on('runtime.agent_signal', (e) => {
      seen.push((e.data ?? {}) as Record<string, unknown>);
    });

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
    // notify 成功只证明已投递；surfaced 由 Runner 确认「结果已进父上下文」时置位
    expect(store.list()[0].deliveryState).toBe('delivering');
    store.markSurfaced(store.list()[0].id);
    expect(store.list()[0].deliveryState).toBe('surfaced');
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

// 微任务/事件链落定
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// ── 送达回执回滚（§7.1）：dispatch 被丢 → 送达标记回滚、提示恢复 ──

describe('送达回执回滚（runtime.trigger.dropped）', () => {
  it('真实 notify 时序下 dispatch 无目标被丢 → notified 最终 false、提示兜底', async () => {
    const events = new DefaultEventBus();
    const { AgentRuntime } = await import(
      '@octopi-agent/engine/harness/activation/runtime.js'
    );
    // events 必须共享：dropped 事件经 runtime 的 events 进总线，wiring 订阅才收得到
    const runtime = new AgentRuntime({ events });
    runtime.addSource(new AgentSignalSource({ events }));
    await runtime.start();
    // 正向对照用：记录被丢 trigger 的 delegationId
    const droppedIds: string[] = [];
    events.on('runtime.trigger.dropped', (e) => {
      const ref = (e as { data?: { triggerRef?: { metadata?: { delegationId?: string } } } })
        .data?.triggerRef;
      if (ref?.metadata?.delegationId) droppedIds.push(ref.metadata.delegationId);
    });

    const boss = fakeAgent('boss', { callable: true, canDelegate: true, maxDepth: 2 });
    // worker 进委派 registry（过 resolveTarget），但不注册 activation runtime：
    // notify 的 signal dispatch 找不到目标 → no_agent 丢弃
    const worker = fakeAgent('worker', { callable: true, canDelegate: false });
    const wiring = wireDelegation([boss, worker] as never, { events })!;
    expect(wiring.notifyWired).toBe(true);

    // 全真时序：建单 → 子跑失败 → notify（先乐观置位再投递）→ signal →
    // dispatch → boss 未注册进 activation runtime → no_agent 丢弃 → 回滚。
    // 禁止手工预置送达标记——那会掩盖「dropped 先于置位到达」的真实竞态
    //（P0 回归：旧实现下本用例 notified 会停在 true）
    const { delegation } = await wiring.service.dispatch({
      parent: { agentId: 'boss', sessionId: 's-parent', runId: 'r-1' },
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });
    await vi.waitFor(() =>
      expect(['completed', 'failed']).toContain(
        wiring.delegationStore.get(delegation.id)?.status,
      ),
    );
    await vi.waitFor(() =>
      expect(wiring.delegationStore.get(delegation.id)?.deliveryState).toBe('pending'),
    );
    expect(wiring.service.renderStatusHint('s-parent')).not.toBe('');
    // 正向对照：dropped 确实带着本单的 delegationId 发生过（否则「从未投递」
    // 也会让 notified=false 成立，掩盖掉回滚本身失效的回归）
    expect(droppedIds).toContain(delegation.id);
    await runtime.stop();
  });

  it('fan-out 部分丢弃不回滚（有目标已受理即视为部分送达）', async () => {
    const events = new DefaultEventBus();
    const boss = fakeAgent('boss', { callable: true, canDelegate: true, maxDepth: 2 });
    const wiring = wireDelegation([boss] as never, { events })!;
    const d = wiring.delegationStore.create({
      parent: { agentId: 'boss', sessionId: 's-parent', runId: 'r-1' },
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });
    wiring.delegationStore.update(d.id, { status: 'completed', output: 'ok' });
    wiring.delegationStore.markSurfaced(d.id);

    events.emit({
      type: 'runtime.trigger.dropped',
      timestamp: Date.now(),
      data: {
        reason: 'fanout_partial_failure',
        triggerRef: { id: 't-fan', metadata: { delegationId: d.id } },
        results: [{ agentId: 'x', status: 'ran' }],
      },
    } as never);
    await settle();
    // 部分目标已 run（消息已进其上下文）→ 保持已送达
    expect(wiring.delegationStore.get(d.id)?.deliveryState).toBe('surfaced');
  });

  it('dispose 后送达回执订阅释放，dropped 不再回滚', async () => {
    const events = new DefaultEventBus();
    const boss = fakeAgent('boss', { callable: true, canDelegate: true, maxDepth: 2 });
    const wiring = wireDelegation([boss] as never, { events })!;
    const d = wiring.delegationStore.create({
      parent: { agentId: 'boss', sessionId: 's-parent', runId: 'r-1' },
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });
    wiring.delegationStore.update(d.id, { status: 'completed', output: 'ok' });
    wiring.delegationStore.markSurfaced(d.id);

    wiring.dispose();
    events.emit({
      type: 'runtime.trigger.dropped',
      timestamp: Date.now(),
      data: {
        reason: 'no_agent',
        triggerRef: { id: 't-x', metadata: { delegationId: d.id } },
      },
    } as never);
    await settle();
    expect(wiring.delegationStore.get(d.id)?.deliveryState).toBe('surfaced');
  });

  it('无关 dropped 不回滚：无 delegationId、不同单、未置位的单', async () => {
    const events = new DefaultEventBus();
    const boss = fakeAgent('boss', { callable: true, canDelegate: true, maxDepth: 2 });
    const wiring = wireDelegation([boss] as never, { events })!;
    const mk = () => {
      const d = wiring.delegationStore.create({
        parent: { agentId: 'boss', sessionId: 's-parent', runId: 'r-1' },
        target: { agentId: 'worker' },
        task: 't',
        input: 'i',
      });
      wiring.delegationStore.update(d.id, { status: 'completed', output: 'ok' });
      return d;
    };
    const drop = (data: Record<string, unknown>) =>
      events.emit({
        type: 'runtime.trigger.dropped',
        timestamp: Date.now(),
        data,
      });

    const d1 = mk();
    wiring.delegationStore.markSurfaced(d1.id);
    // 无 delegationId → 忽略；不同 delegationId → 不得误伤 d1
    drop({ triggerRef: { id: 't1', metadata: {} } });
    drop({ triggerRef: { id: 't2', metadata: { delegationId: 'del-other' } } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(wiring.delegationStore.get(d1.id)?.deliveryState).toBe('surfaced');

    // 未置位的单：dropped 不得无中生有（仍 false，不抛）
    const d2 = mk();
    drop({ triggerRef: { id: 't3', metadata: { delegationId: d2.id } } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(wiring.delegationStore.get(d2.id)?.deliveryState).toBe('pending');
  });
});

// ── wireDelegation ──

function fakeAgent(agentId: string, delegation?: { callable: boolean; canDelegate: boolean; maxDepth?: number }) {
  const self = {
    agentId,
    agent: {
      contextSessionId: 'default',
    },
    runner: {
      setSteeringProvider(fn: unknown) {
        self.steering = fn;
      },
      setDelegationDeliveryAck(fn: unknown) {
        self.deliveryAck = fn;
      },
    },
    store: {},
    traits: [] as string[],
    delegation,
    registered: [] as string[],
    registerTools(tools: Array<{ definition: { name: string } }>) {
      for (const t of tools) self.registered.push(t.definition.name);
    },
    steering: undefined as unknown,
    deliveryAck: undefined as unknown,
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

  it('keeps the hint until the result lands in the parent context', async () => {
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

    // notify 投递成功仍保留提示（surfaced 由「结果进父上下文」的 ack 确认），
    // ack 后提示消音，不再重复已送达的工作
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
    expect(store.list()[0].deliveryState).toBe('delivering');
    expect(service.renderStatusHint('s-1')).toContain('<delegation_status>');
    store.markSurfaced(store.list()[0].id);
    expect(service.renderStatusHint('s-1')).toBe('');
    expect(store.list()[0].deliveryState).toBe('surfaced');
  });
});
