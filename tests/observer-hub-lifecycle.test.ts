/**
 * ObserverHub 跨进程镜像面生命周期（评审 MAJ-1 / MIN-1 回归锚）：
 * - run.scope.ready 按事件自带 runId 补建记录——同 session 第二轮 run 不得误挂
 *   第一轮旧记录（latestRun 兜底陷阱）
 * - run.scope.messages 消费进 record.messages（entry/final）
 * - engine.end 清 active 归属（跨进程无 recordRunEnd）
 */

import { describe, it, expect } from 'vitest';
import { ObserverHub } from '@octopi-agent/engine/harness/observability/observer/hub.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

function readyEvent(runId: string, ts = Date.now()): AgentEvent {
  return {
    type: 'run.scope.ready',
    timestamp: ts,
    agentId: 'assistant',
    sessionId: 's-multi',
    data: {
      sessionId: 's-multi',
      agentId: 'assistant',
      runId,
      scope: {
        sessionId: 's-multi',
        agentId: 'assistant',
        runId,
        capturedAt: ts,
        toolRuntime: { cwd: '/tmp/ws' },
      },
      messages: { count: 1, byRole: { user: 1 }, byKind: { user_speech: 1 }, systemPromptCount: 0, contextSummaryCount: 0, hiddenFromChatCount: 0, chars: 10, agentIds: ['assistant'] },
    },
  } as unknown as AgentEvent;
}

function timelineEvent(runId: string, ts: number): AgentEvent {
  return {
    type: 'tool.exec.start',
    timestamp: ts,
    agentId: 'assistant',
    sessionId: 's-multi',
    data: { runId, toolCallId: `call-${runId}-${ts}`, toolName: 'shell', phase: 'start' },
  } as unknown as AgentEvent;
}

function endEvent(runId: string, ts: number): AgentEvent {
  return {
    type: 'engine.end',
    timestamp: ts,
    agentId: 'assistant',
    sessionId: 's-multi',
    data: { runId, reason: 'done' },
  } as unknown as AgentEvent;
}

describe('ObserverHub 跨进程生命周期', () => {
  it('同 session 两轮 run：第二轮事件挂第二轮记录（MAJ-1 回归锚）', () => {
    const hub = new ObserverHub({ level: 'full' });

    // 第一轮
    hub.ingestEvent(readyEvent('run-a', 1000));
    hub.ingestEvent(timelineEvent('run-a', 1100));
    hub.ingestEvent(endEvent('run-a', 1200));

    // 第二轮（latestRun 兜底此刻返回 run-a 旧记录——归属必须按 runId 补建）
    hub.ingestEvent(readyEvent('run-b', 2000));
    hub.ingestEvent(timelineEvent('run-b', 2100));

    const b = hub.getRunById('run-b');
    expect(b).not.toBeNull();
    // run-b 的 timeline 事件必须在 run-b 记录上（不在 run-a）
    expect(b!.timeline?.some((e) => e.toolCallId === 'call-run-b-2100')).toBe(true);

    const a = hub.getRunById('run-a');
    expect(a).not.toBeNull();
    expect(a!.timeline?.some((e) => e.toolCallId === 'call-run-a-1100')).toBe(true);
    expect(a!.timeline?.some((e) => e.toolCallId === 'call-run-b-2100')).toBe(false);

    // Run 页签读口（latestRun）= 最新一轮
    const latest = hub.getRunObservatory('s-multi');
    expect(latest?.runId).toBe('run-b');
  });

  it('run.scope.ready 幂等：同一 runId 重复 ready 不重建/不重复', () => {
    const hub = new ObserverHub({ level: 'full' });
    hub.ingestEvent(readyEvent('run-x', 1000));
    hub.ingestEvent(timelineEvent('run-x', 1500));
    hub.ingestEvent(readyEvent('run-x', 1600)); // 重复（乱序补发）

    const x = hub.getRunById('run-x');
    expect(x).not.toBeNull();
    // 重复 ready 不清空已有 timeline
    expect(x!.timeline?.some((e) => e.toolCallId === 'call-run-x-1500')).toBe(true);
  });

  it('run.scope.messages 消费进 record.messages（entry/final）', () => {
    const hub = new ObserverHub({ level: 'full' });
    hub.ingestEvent(readyEvent('run-m', 1000));
    hub.ingestEvent({
      type: 'run.scope.messages',
      timestamp: 1100,
      agentId: 'assistant',
      sessionId: 's-multi',
      data: {
        sessionId: 's-multi',
        agentId: 'assistant',
        runId: 'run-m',
        phase: 'entry',
        messages: { count: 3, byRole: { user: 2, assistant: 1 }, byKind: { user_speech: 2 }, systemPromptCount: 0, contextSummaryCount: 0, hiddenFromChatCount: 0, chars: 42, agentIds: ['assistant'] },
      },
    } as unknown as AgentEvent);
    hub.ingestEvent({
      type: 'run.scope.messages',
      timestamp: 1900,
      agentId: 'assistant',
      sessionId: 's-multi',
      data: {
        sessionId: 's-multi',
        agentId: 'assistant',
        runId: 'run-m',
        phase: 'final',
        messages: { count: 7, byRole: { user: 2, assistant: 2, tool: 3 }, byKind: { user_speech: 2 }, systemPromptCount: 0, contextSummaryCount: 0, hiddenFromChatCount: 0, chars: 99, agentIds: ['assistant'] },
      },
    } as unknown as AgentEvent);

    const msgs = hub.getRunMessages('s-multi', { runId: 'run-m' });
    expect(msgs).not.toBeNull();
    const entry = hub.getRunMessages('s-multi', { runId: 'run-m', phase: 'entry' });
    const final = hub.getRunMessages('s-multi', { runId: 'run-m', phase: 'final' });
    expect(entry?.summary?.chars).toBe(42);
    expect(final?.summary?.chars).toBe(99);
  });

  it('engine.end 清 active 归属：end 后新事件不挂旧 active', () => {
    const hub = new ObserverHub({ level: 'full' });
    hub.ingestEvent(readyEvent('run-e', 1000));
    hub.ingestEvent(endEvent('run-e', 1200));

    // end 后无 ready 的 stray 事件：latestRun 兜底挂 run-e（可接受），但 active 已清——
    // 下一轮 ready 必须建新记录（同 MAJ-1 判据，此处断言 active 清除后补建仍工作）
    hub.ingestEvent(readyEvent('run-f', 2000));
    expect(hub.getRunById('run-f')).not.toBeNull();
  });
});
