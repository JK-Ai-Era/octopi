/**
 * run 子进程委派 notify 桥（跨进程唤醒链，2026-11-12 断链修复）：
 *
 * 断链根因：run-serve-child 不构造 AgentRuntime/TriggerSource（无 dispatch 消费方），
 * 委派终态 notify 只发本进程 bus → 无人编译进父 session 队列 → 父会话永不被唤醒
 * （poll/hint fallback 只在父会话下一次 turn 才出现，实际等于永不出）。
 *
 * 修复语义：子进程挂 AgentSignalSource，Trigger 出口 → notify('redispatch') →
 * gateway 既有 case → runtime.dispatch → 父 session 队列（自动唤醒）。
 *
 * 本文件守两段：① 桥接收（notifier 投递 → source → 转发回调拿到完整 Trigger）；
 * ② gateway redispatch 侧 dispatch 语义。
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import { AgentSignalSource } from '@octopi-agent/engine/harness/activation/sources/agent-signal.js';
import { createDelegationNotifier } from '@octopi-agent/engine/harness/collaboration/delegation/notifier.js';
import type { Delegation } from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
import type { Trigger } from '@octopi-agent/engine/harness/activation/types.js';

function makeDelegation(): Delegation {
  return {
    id: 'del-test-1',
    status: 'completed',
    task: 'do something',
    maxOutputChars: 1000,
    output: 'result body',
    parent: {
      runId: 'run-parent-1',
      agentId: 'assistant',
      sessionId: 'sess-parent-1',
    },
    target: { agentId: 'default' },
    resolvedAgentId: 'default',
    childRunId: 'run-child-1',
  } as unknown as Delegation;
}

describe('run 子进程委派 notify 桥', () => {
  it('notifier 投递 → AgentSignalSource → 转发回调收到完整 Trigger（含 delegationId）', async () => {
    const bus = new DefaultEventBus();
    const forwarded: Trigger[] = [];
    const bridge = new AgentSignalSource({ events: bus });
    await bridge.start((trigger) => forwarded.push(trigger));

    // notifyPush on 的形态：notifier 有接收端，投递不抛
    const notify = createDelegationNotifier({ events: bus });
    expect(() => notify(makeDelegation())).not.toThrow();

    expect(forwarded).toHaveLength(1);
    const t = forwarded[0]!;
    // redispatch 信封所需字段齐全：目标父会话 + system_note 载荷
    expect(t.agentId).toBe('assistant');
    expect(t.sessionId).toBe('sess-parent-1');
    expect(t.metadata?.delegationId).toBe('del-test-1');
    expect(t.payload.kind).toBe('system_note');
    expect(String(t.payload.content)).toContain('<delegation_result');
    expect(String(t.payload.content)).toContain('result body');

    await bridge.stop();
  });

  it('桥未挂（无接收端）时 notifier 投递 fail-loud——不误标已送达', () => {
    const bus = new DefaultEventBus();
    const notify = createDelegationNotifier({ events: bus });
    expect(() => notify(makeDelegation())).toThrow(/no AgentSignalSource receiver/);
  });

  it('桥 stop 后不再转发（receiver 计数回收）', async () => {
    const bus = new DefaultEventBus();
    const forwarded: Trigger[] = [];
    const bridge = new AgentSignalSource({ events: bus });
    await bridge.start((t) => forwarded.push(t));
    await bridge.stop();

    const notify = createDelegationNotifier({ events: bus });
    expect(() => notify(makeDelegation())).toThrow(/no AgentSignalSource receiver/);
    expect(forwarded).toHaveLength(0);
  });
});

describe('gateway redispatch 侧（既有 case 语义守卫）', () => {
  it('handleRunHostNotify(redispatch) → runtime.dispatch(trigger)', async () => {
    const { Gateway } = await import('@octopi-agent/gateway/gateway/gateway.js');
    const { InMemorySessionStore } = await import('@octopi-agent/engine/integration/storage/memory.js');
    const gateway = new Gateway(
      {
        agents: [
          {
            id: 'assistant',
            home: '',
            workspace: '',
            persona: { name: 'a', description: '', systemPrompt: 'x' },
            tools: { allow: ['*'] },
            model: { provider: 'openai', model: 'gpt-5-mini' },
          },
        ],
        knowledge: { service: { manageLocal: false } },
      },
      new InMemorySessionStore(),
    );

    const dispatched: Trigger[] = [];
    (
      gateway as unknown as {
        runtime: { dispatch: (t: Trigger) => Promise<unknown>; stop: () => Promise<void> };
      }
    ).runtime.dispatch = vi.fn(async (t: Trigger) => {
      dispatched.push(t);
      return undefined;
    });

    const trigger: Trigger = {
      id: 'trg-1',
      type: 'agent_signal',
      agentId: 'assistant',
      sessionId: 'sess-parent-1',
      payload: { kind: 'system_note', content: '<delegation_result id="del-x"/>' },
      metadata: { reason: 'delegation_completed', delegationId: 'del-x' },
    };
    await (
      gateway as unknown as {
        handleRunHostNotify: (n: unknown, id: string) => Promise<void>;
      }
    ).handleRunHostNotify({ type: 'redispatch', trigger }, 'run-0');

    expect(dispatched).toEqual([trigger]);
    await gateway.stop();
  });
});
