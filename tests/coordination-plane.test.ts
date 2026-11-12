/**
 * 跨进程协调面（2026-11-12 委派唤醒链案例，arch/service-topology-p2.md §2.1）：
 *
 * A. 插话语义：dispatcher.inbox 接收（continued）→ 不开新 Run；未接收（dispatched）
 *    → 照常开新 Run；offer 通道失败 fail-open 到 dispatched（不吞消息）。
 * B. 唤醒/重试：唤醒类 trigger 被 lease_held 直拒 → 延迟重投（at-least-once）；
 *    human 消息不重投；attempts 耗尽落 TRIGGER_DROPPED。
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import { AgentRuntime } from '@octopi-agent/engine/harness/activation/runtime.js';
import type { Trigger, RunRequest } from '@octopi-agent/engine/harness/activation/types.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

function signalTrigger(id: string): Trigger {
  return {
    id,
    type: 'agent_signal',
    agentId: 'a1',
    sessionId: 's1',
    payload: { kind: 'system_note', content: '<delegation_result id="d1"/>' },
    metadata: { reason: 'delegation_completed', delegationId: 'd1' },
  };
}

function humanTrigger(id: string): Trigger {
  return {
    id,
    type: 'message',
    agentId: 'a1',
    sessionId: 's1',
    payload: { kind: 'user_message', content: 'hi' },
  };
}

describe('A. 插话语义（inbox offer 分支）', () => {
  it('inbox 返回 continued → 不开新 Run，dispatch 结果为 accepted', async () => {
    const runtime = new AgentRuntime({ events: new DefaultEventBus() });
    const executed: RunRequest[] = [];
    const admitted: string[] = [];
    runtime.registerAgent({
      agentId: 'a1',
      dispatcher: {
        execute: async function* (req: RunRequest) {
          executed.push(req);
          yield { type: 'run.completed', sessionId: req.sessionId } as unknown as AgentEvent;
        },
        inbox: {
          offer: async (signal) => {
            signal.onAdmitted?.('continued');
            admitted.push(signal.entryId ?? '');
            return 'continued' as const;
          },
        },
      },
      resolveSession: (t) => t.sessionId ?? 'a1:main',
    });
    await runtime.start();

    const result = await runtime.dispatch(signalTrigger('t1'));
    expect(result).toMatchObject({ status: 'accepted', delivery: 'continued' });
    expect(executed).toHaveLength(0); // 插话 = 不开新 Run
    expect(admitted).toEqual(['d1']);
    await runtime.stop();
  });

  it('inbox 返回 dispatched → 照常开新 Run', async () => {
    const runtime = new AgentRuntime({ events: new DefaultEventBus() });
    const executed: RunRequest[] = [];
    runtime.registerAgent({
      agentId: 'a1',
      dispatcher: {
        execute: async function* (req: RunRequest) {
          executed.push(req);
          yield { type: 'run.completed', sessionId: req.sessionId } as unknown as AgentEvent;
        },
        inbox: { offer: async () => 'dispatched' as const },
      },
      resolveSession: (t) => t.sessionId ?? 'a1:main',
    });
    await runtime.start();

    const result = await runtime.dispatch(signalTrigger('t2'));
    expect(result.status).toBe('ran');
    expect(executed).toHaveLength(1);
    await runtime.stop();
  });

  it('offer 通道抛错 fail-open 到 dispatched（不吞消息）', async () => {
    const runtime = new AgentRuntime({ events: new DefaultEventBus() });
    const executed: RunRequest[] = [];
    runtime.registerAgent({
      agentId: 'a1',
      dispatcher: {
        execute: async function* (req: RunRequest) {
          executed.push(req);
          yield { type: 'run.completed', sessionId: req.sessionId } as unknown as AgentEvent;
        },
        inbox: {
          offer: async () => {
            throw new Error('inboxOffer channel down');
          },
        },
      },
      resolveSession: (t) => t.sessionId ?? 'a1:main',
    });
    await runtime.start();

    const result = await runtime.dispatch(signalTrigger('t3'));
    expect(result.status).toBe('ran'); // fail-open → 新 Run 送达
    expect(executed).toHaveLength(1);
    await runtime.stop();
  });
});

describe('B. 唤醒/重试（lease_held 延迟重投）', () => {
  it('唤醒类 trigger 被 lease_held 直拒 → 延迟重投直到成功', async () => {
    vi.useFakeTimers();
    try {
      const runtime = new AgentRuntime({
        events: new DefaultEventBus(),
        wakeupRetry: { maxAttempts: 3, delayMs: 1000 },
      });
      let calls = 0;
      runtime.registerAgent({
        agentId: 'a1',
        dispatcher: {
          execute: async function* (req: RunRequest) {
            calls += 1;
            if (calls === 1) throw new Error('supervise: lease_held — session "s1" run lease held');
            yield { type: 'run.completed', sessionId: req.sessionId } as unknown as AgentEvent;
          },
        },
        resolveSession: (t) => t.sessionId ?? 'a1:main',
      });
      await runtime.start();

      const first = await runtime.dispatch(signalTrigger('t4'));
      expect(first.status).toBe('failed');
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(1100); // 重投窗口
      expect(calls).toBe(2); // 重投已发生
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('human 消息被拒不重投（拒必须回到用户可见面）', async () => {
    vi.useFakeTimers();
    try {
      const runtime = new AgentRuntime({
        events: new DefaultEventBus(),
        wakeupRetry: { maxAttempts: 3, delayMs: 1000 },
      });
      let calls = 0;
      runtime.registerAgent({
        agentId: 'a1',
        dispatcher: {
          execute: async function* () {
            calls += 1;
            throw new Error('supervise: lease_held — session "s1" run lease held');
          },
        },
        resolveSession: (t) => t.sessionId ?? 'a1:main',
      });
      await runtime.start();

      const first = await runtime.dispatch(humanTrigger('t5'));
      expect(first.status).toBe('failed');
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(1); // 无重投
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('attempts 耗尽 → TRIGGER_DROPPED 落账，不再无限重投', async () => {
    vi.useFakeTimers();
    const events = new DefaultEventBus();
    const dropped: unknown[] = [];
    events.on('runtime.trigger.dropped', (e: unknown) => { dropped.push(e); });
    try {
      const runtime = new AgentRuntime({
        events,
        wakeupRetry: { maxAttempts: 2, delayMs: 500 },
      });
      let calls = 0;
      runtime.registerAgent({
        agentId: 'a1',
        dispatcher: {
          execute: async function* () {
            calls += 1;
            throw new Error('supervise: lease_held — held');
          },
        },
        resolveSession: (t) => t.sessionId ?? 'a1:main',
      });
      await runtime.start();

      await runtime.dispatch(signalTrigger('t6'));
      await vi.advanceTimersByTimeAsync(2000);
      // 1 次原始 + 2 次重投后放弃
      expect(calls).toBe(3);
      expect(dropped.length).toBeGreaterThan(0);
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
