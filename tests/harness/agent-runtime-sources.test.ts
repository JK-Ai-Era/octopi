/**
 * ScheduleSource / EscalateBridge / AgentSignalSource
 */

import { describe, it, expect } from 'vitest';
import { DefaultEventBus } from '@octopi-agent/core/index.js';
import {
  AgentRuntime,
  ScheduleSource,
  EscalateBridge,
  AgentSignalSource,
  emitEscalate,
  emitAgentSignal,
  RuntimeEvents,
} from '@octopi-agent/engine/harness/activation/index.js';
import type { RunDispatcher, Trigger } from '@octopi-agent/engine/harness/activation/index.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

function mockDispatcher(calls: unknown[]): RunDispatcher {
  return {
    async *execute(req) {
      calls.push(req);
      yield { type: 'engine.end', timestamp: Date.now() } as AgentEvent;
    },
  };
}

function makeRuntime(calls: unknown[]): AgentRuntime {
  const runtime = new AgentRuntime();
  runtime.registerAgent({
    agentId: 'assistant',
    dispatcher: mockDispatcher(calls),
  });
  return runtime;
}

describe('ScheduleSource', () => {
  it('interval 到点产 Trigger 且不阻塞 emit', async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime(calls);
    const source = new ScheduleSource({
      jobs: [
        {
          agentId: 'assistant',
          intervalMs: 20,
          payload: { kind: 'system_note', content: 'tick' },
        },
      ],
    });
    runtime.addSource(source);
    await runtime.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    await runtime.stop();
    expect(source.isRunning).toBe(false);
  });

  it('runOnStart 立即触发一次', async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime(calls);
    const source = new ScheduleSource({
      jobs: [
        {
          agentId: 'assistant',
          intervalMs: 60_000,
          runOnStart: true,
          payload: { kind: 'system_note', content: 'boot' },
        },
      ],
    });
    runtime.addSource(source);
    await runtime.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    await runtime.stop();
  });
});

describe('EscalateBridge', () => {
  it('subsystem.signal.escalate（SignalBus 实际类型）→ dispatch', async () => {
    const bus = new DefaultEventBus();
    const calls: unknown[] = [];
    const runtime = new AgentRuntime({ events: bus });
    runtime.registerAgent({
      agentId: 'assistant',
      dispatcher: mockDispatcher(calls),
    });
    const bridge = new EscalateBridge({ events: bus, defaultAgentId: 'assistant' });
    runtime.addSource(bridge);
    await runtime.start();

    bus.emit({
      type: 'subsystem.signal.escalate',
      timestamp: Date.now(),
      data: { subsystemId: 'test.lifecycle.subsystem', reason: 'need main' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    await runtime.stop();
  });

  it('subsystem.escalate → dispatch 对应 agent', async () => {
    const bus = new DefaultEventBus();
    const calls: Array<{ messages: Array<{ content?: string; metadata?: unknown }> }> = [];
    const runtime = new AgentRuntime({ events: bus });
    runtime.registerAgent({
      agentId: 'assistant',
      dispatcher: {
        async *execute(req) {
          calls.push(req as never);
          yield { type: 'engine.end', timestamp: Date.now() } as AgentEvent;
        },
      },
    });
    const bridge = new EscalateBridge({ events: bus, defaultAgentId: 'assistant' });
    runtime.addSource(bridge);
    await runtime.start();

    emitEscalate(bus, {
      subsystemId: 'test.lifecycle.subsystem',
      summary: 'need main agent',
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toContain('need main agent');
    await runtime.stop();
  });

  it('无 agentId 且无 default → 不触发', async () => {
    const bus = new DefaultEventBus();
    const runtime = new AgentRuntime({ events: bus });
    runtime.registerAgent({
      agentId: 'assistant',
      dispatcher: mockDispatcher([]),
    });
    const bridge = new EscalateBridge({ events: bus });
    runtime.addSource(bridge);
    await runtime.start();
    emitEscalate(bus, { subsystemId: 'x', summary: 'orphan' });
    await new Promise((r) => setTimeout(r, 15));
    // runtime 有 agent 但 trigger 未产出（no agentId）
    await runtime.stop();
  });
});

describe('AgentSignalSource', () => {
  it('emitAgentSignal 路由到 toAgentId', async () => {
    const bus = new DefaultEventBus();
    const calls: unknown[] = [];
    const runtime = new AgentRuntime({ events: bus });
    runtime.registerAgent({ agentId: 'a2', dispatcher: mockDispatcher(calls) });
    runtime.addSource(new AgentSignalSource({ events: bus }));
    await runtime.start();
    emitAgentSignal(bus, {
      fromAgentId: 'a1',
      toAgentId: 'a2',
      payload: { kind: 'system_note', content: 'done' },
      reason: 'pipeline',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    await runtime.stop();
  });

  it('toTrigger 含 parentAgentId metadata', () => {
    const src = new AgentSignalSource();
    const t: Trigger = src.toTrigger({
      fromAgentId: 'a1',
      toAgentId: 'a2',
      payload: { kind: 'system_note', content: 'x' },
    });
    expect(t.type).toBe('agent_signal');
    expect(t.agentId).toBe('a2');
    expect(t.metadata?.parentAgentId).toBe('a1');
  });
});

describe('RuntimeEvents 常量', () => {
  it('稳定事件名', () => {
    expect(RuntimeEvents.RUN_STARTED).toBe('runtime.run.started');
  });
});

// ── TRIGGER_DROPPED 不变量：trigger 未送达必有 dropped 事件（带裁剪 triggerRef） ──

describe('TRIGGER_DROPPED 不变量', () => {
  function refDrop(events: DefaultEventBus): Array<Record<string, unknown>> {
    const drops: Array<Record<string, unknown>> = [];
    events.on(RuntimeEvents.TRIGGER_DROPPED, (e) => {
      drops.push((e as { data?: Record<string, unknown> }).data ?? {});
    });
    return drops;
  }

  it('runtime_stopped：stop 后 dispatch → dropped 带 triggerRef（不含 payload 正文）', async () => {
    const events = new DefaultEventBus();
    const drops = refDrop(events);
    const runtime = new AgentRuntime({ events });
    await runtime.start();
    await runtime.stop();

    const trigger: Trigger = {
      id: 'trig-1',
      type: 'agent_signal',
      agentId: 'a',
      payload: { kind: 'system_note', content: 'should-not-leak' },
      metadata: { delegationId: 'del-x' },
    };
    await runtime.dispatch(trigger);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.reason).toBe('runtime_stopped');
    const ref = drops[0]!.triggerRef as Record<string, unknown>;
    expect(ref.id).toBe('trig-1');
    expect((ref.metadata as { delegationId?: string }).delegationId).toBe('del-x');
    // 防泄漏回归：正文不得进事件流（onAll 会转发给所有观察者）
    expect(ref.payload).toBeUndefined();
  });

  it('单目标 skipped（router 命中但目标未注册）→ dropped 事件（本轮补发的出口）', async () => {
    const events = new DefaultEventBus();
    const drops = refDrop(events);
    // router 返回恰好 1 个 target → 走单目标分支；agents 里没有 → dispatchToTarget
    // skipped → 本轮补发的 TRIGGER_DROPPED（此前静默返回）
    const runtime = new AgentRuntime({
      events,
      router: {
        async resolve() {
          return [{ agentId: 'ghost' }];
        },
      },
    });
    await runtime.start();

    const trigger: Trigger = {
      id: 'trig-2',
      type: 'agent_signal',
      agentId: 'ghost',
      payload: { kind: 'system_note', content: 'x' },
    };
    const result = await runtime.dispatch(trigger);
    expect(result.status).toBe('skipped');
    expect(drops).toHaveLength(1);
    expect((drops[0]!.triggerRef as { id?: string }).id).toBe('trig-2');
    await runtime.stop();
  });

  it('run 失败（已受理）→ RUN_FAILED 带 triggerRefs 回执关联', async () => {
    const events = new DefaultEventBus();
    const fails: Array<Record<string, unknown>> = [];
    events.on(RuntimeEvents.RUN_FAILED, (e) => {
      fails.push((e as { data?: Record<string, unknown> }).data ?? {});
    });
    const runtime = new AgentRuntime({ events });
    runtime.registerAgent({
      agentId: 'boom',
      dispatcher: {
        async *execute() {
          throw new Error('run blew up');
        },
      },
    });
    await runtime.start();

    const trigger: Trigger = {
      id: 'trig-f',
      type: 'agent_signal',
      agentId: 'boom',
      payload: { kind: 'system_note', content: 'x' },
      metadata: { delegationId: 'del-f' },
    };
    const result = await runtime.dispatch(trigger);
    expect(result.status).toBe('failed');
    expect(fails).toHaveLength(1);
    const refs = fails[0]!.triggerRefs as Array<{ id: string; metadata?: { delegationId?: string } }>;
    expect(refs[0]!.id).toBe('trig-f');
    expect(refs[0]!.metadata?.delegationId).toBe('del-f');
    await runtime.stop();
  });

  it('fan-out 全丢弃 → dropped 带 results 明细', async () => {
    const events = new DefaultEventBus();
    const drops = refDrop(events);
    const runtime = new AgentRuntime({
      events,
      router: {
        async resolve() {
          return [{ agentId: 'x' }, { agentId: 'y' }];
        },
      },
    });
    await runtime.start();

    const trigger: Trigger = {
      id: 'trig-3',
      type: 'agent_signal',
      payload: { kind: 'system_note', content: 'x' },
    };
    const result = await runtime.dispatch(trigger);
    expect(result.status).toBe('skipped');
    expect(drops).toHaveLength(1);
    expect(Array.isArray(drops[0]!.results)).toBe(true);
    await runtime.stop();
  });
});
