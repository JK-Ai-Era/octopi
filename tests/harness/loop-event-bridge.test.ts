/**
 * yield → EventBus 桥接映射测试
 *
 * 锁定 SessionAwareRunner.adaptLoopEvent 的词表与字段，
 * 防止 Loop 协议与 EventBus 广播静默漂移。
 */

import { describe, it, expect } from 'vitest';
import { adaptLoopEvent } from '../../src/harness/runner.js';
import type { HarnessLoopEvent } from '../../src/harness/reliability/harness-events.js';

const meta = { agentId: 'a1', sessionId: 's1' };
const state = { assistantContent: '', lastUserContent: 'hi user' };

function adapt(event: HarnessLoopEvent) {
  return adaptLoopEvent(event, meta, { ...state, assistantContent: 'hello' });
}

describe('adaptLoopEvent bridge map', () => {
  it('agent_start → engine.start', () => {
    const e = adapt({ type: 'agent_start', timestamp: 1 });
    expect(e?.type).toBe('engine.start');
    expect(e?.sessionId).toBe('s1');
  });

  it('agent_end(completed) → engine.end', () => {
    const e = adapt({ type: 'agent_end', reason: 'completed', timestamp: 1 });
    expect(e?.type).toBe('engine.end');
    expect(e?.data?.reason).toBe('completed');
  });

  it('agent_end(error) → engine.error', () => {
    const e = adapt({ type: 'agent_end', reason: 'error', timestamp: 1, error: new Error('boom') });
    expect(e?.type).toBe('engine.error');
    expect(e?.data?.error).toBe('boom');
  });

  it('turn_start → iteration.start', () => {
    const e = adapt({ type: 'turn_start', timestamp: 1 });
    expect(e?.type).toBe('iteration.start');
  });

  it('turn_end → turn.end（含 phase / hasToolCalls / userText）', () => {
    const e = adapt({
      type: 'turn_end',
      hasToolCalls: true,
      phase: 'pre_tools',
      timestamp: 1,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    expect(e?.type).toBe('turn.end');
    expect(e?.data).toMatchObject({
      hasToolCalls: true,
      phase: 'pre_tools',
      content: 'hello',
      userText: 'hi user',
    });
  });

  it('tool_start/end → tool.exec.start/end', () => {
    const start = adapt({
      type: 'tool_start',
      timestamp: 1,
      toolCall: { id: 't1', name: 'fs_read', arguments: { path: '/x' } },
    });
    expect(start?.type).toBe('tool.exec.start');
    expect(start?.data).toMatchObject({ toolCallId: 't1', toolName: 'fs_read' });

    const end = adapt({
      type: 'tool_end',
      timestamp: 1,
      toolCall: { id: 't1', name: 'fs_read', arguments: { path: '/x' } },
      result: { toolCallId: 't1', name: 'fs_read', content: 'ok', isError: false, durationMs: 3 },
    });
    expect(end?.type).toBe('tool.exec.end');
    expect(end?.data).toMatchObject({ toolCallId: 't1', hasError: false, durationMs: 3 });
  });

  it('assistant_message → null（只更新状态，不广播）', () => {
    const e = adapt({
      type: 'assistant_message',
      timestamp: 1,
      message: { role: 'assistant', content: 'x', timestamp: 1 },
    });
    expect(e).toBeNull();
  });

  it('llm_stream_delta → 同名事件（由 runner 决定是否 emit 到 bus）', () => {
    const e = adapt({
      type: 'llm_stream_delta',
      timestamp: 1,
      data: { delta: 'tok' },
    });
    expect(e?.type).toBe('llm_stream_delta');
    expect(e?.data?.delta).toBe('tok');
  });

  it('budget_exceeded → budget.exceeded（透传 reason/report）', () => {
    const e = adapt({
      type: 'budget_exceeded',
      timestamp: 1,
      data: { reason: 'tokens', report: { totalTokens: 100 } },
    });
    expect(e?.type).toBe('budget.exceeded');
    expect(e?.data).toMatchObject({ reason: 'tokens' });
    expect(e?.agentId).toBe('a1');
  });

  it('run_guard_stopped / recovered → run_guard.*', () => {
    const stopped = adapt({
      type: 'run_guard_stopped',
      timestamp: 1,
      data: { reason: 'loop', userMessage: 'stopped' },
    });
    expect(stopped?.type).toBe('run_guard.stopped');

    const recovered = adapt({
      type: 'run_guard_recovered',
      timestamp: 1,
      data: { reason: 'thrash', actions: ['inject_hint'] },
    });
    expect(recovered?.type).toBe('run_guard.recovered');
  });

  it('stream.fallback_* 原样透传 type', () => {
    const e = adapt({
      type: 'stream.fallback_to_sync',
      timestamp: 1,
      data: { reason: 'idle' },
    });
    expect(e?.type).toBe('stream.fallback_to_sync');
  });
});
