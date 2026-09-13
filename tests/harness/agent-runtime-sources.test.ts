/**
 * ScheduleSource / EscalateBridge / AgentSignalSource
 */

import { describe, it, expect } from 'vitest';
import { DefaultEventBus } from '../../src/core/index.js';
import {
  AgentRuntime,
  ScheduleSource,
  EscalateBridge,
  AgentSignalSource,
  emitEscalate,
  emitAgentSignal,
  RuntimeEvents,
} from '../../src/harness/agent-runtime/index.js';
import type { RunDispatcher, Trigger } from '../../src/harness/agent-runtime/index.js';
import type { AgentEvent } from '../../src/core/primitives/event-bus.js';

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
      data: { subsystemId: 'memory.extractor', reason: 'need main' },
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
      subsystemId: 'memory.extractor',
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
