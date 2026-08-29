import { describe, expect, it } from 'vitest';
import { buildTaskSummary, buildAgentInput } from '../../src/harness/distributed-agents/distributed/input-policy.js';
import type { AgentContext } from '../../src/harness/distributed-agents/distributed/types.js';
import type { InputPolicy } from '../../src/harness/distributed-agents/distributed/input-policy.js';

function createMockAgentContext(): AgentContext {
  return {
    messages: [
      { role: 'user', content: 'help me', timestamp: Date.now() },
      { role: 'assistant', content: 'sure', timestamp: Date.now(), toolCalls: [{ name: 'shell', arguments: { command: 'ls' }, id: 'tc1' }] },
      { role: 'tool', content: 'file1.txt', timestamp: Date.now(), toolCallId: 'tc1' },
    ],
    runConfig: {
      systemPrompt: 'test',
      agentId: 'agent-1',
      sessionId: 'session-1',
      cwd: '/tmp',
    },
    pendingToolCall: { name: 'shell', arguments: { command: 'rm -rf /tmp/old' } },
    events: { emit: () => {}, on: () => ({ dispose: () => {} }), onAll: () => ({ dispose: () => {} }) } as any,
  };
}

describe('buildTaskSummary', () => {
  it('extracts recent tools from messages', () => {
    const ctx = createMockAgentContext();
    const summary = buildTaskSummary(ctx);
    expect(summary.recentTools).toContain('shell');
    expect(summary.agentId).toBe('agent-1');
    expect(summary.sessionId).toBe('session-1');
  });

  it('detects user_request phase', () => {
    const ctx = createMockAgentContext();
    ctx.messages.push({ role: 'user', content: 'next', timestamp: Date.now() });
    const summary = buildTaskSummary(ctx);
    expect(summary.phase).toBe('user_request');
  });

  it('detects agent_working phase', () => {
    const ctx = createMockAgentContext();
    // last message is tool result, not user
    const summary = buildTaskSummary(ctx);
    expect(summary.phase).toBe('agent_working');
  });

  it('includes pendingAction when available', () => {
    const ctx = createMockAgentContext();
    const summary = buildTaskSummary(ctx);
    expect(summary.pendingAction).toBe('shell');
  });
});

describe('buildAgentInput', () => {
  it('respects InputPolicy.visible fields', () => {
    const policy: InputPolicy = {
      visible: ['task_summary', 'working_directory'],
      snapshot: 'full',
    };
    const ctx = createMockAgentContext();
    const input = buildAgentInput(policy, ctx);
    expect(input.taskSummary).toBeDefined();
    expect(input.workingDirectory).toBe('/tmp');
    expect(input.pendingToolCall).toBeUndefined();
    expect(input.conversationHistory).toBeUndefined();
  });

  it('includes pending_tool_call when visible', () => {
    const policy: InputPolicy = {
      visible: ['pending_tool_call'],
      snapshot: 'structured',
    };
    const ctx = createMockAgentContext();
    const input = buildAgentInput(policy, ctx);
    expect(input.pendingToolCall).toEqual({ name: 'shell', arguments: { command: 'rm -rf /tmp/old' } });
  });

  it('includes conversation_history when visible', () => {
    const policy: InputPolicy = {
      visible: ['conversation_history'],
      snapshot: 'full',
    };
    const ctx = createMockAgentContext();
    const input = buildAgentInput(policy, ctx);
    expect(input.conversationHistory).toHaveLength(3);
  });

  it('summary snapshot limits conversation_history', () => {
    const policy: InputPolicy = {
      visible: ['conversation_history'],
      snapshot: 'summary',
    };
    const ctx = createMockAgentContext();
    // Add many messages
    for (let i = 0; i < 30; i++) {
      ctx.messages.push({ role: 'user', content: `msg ${i}`, timestamp: Date.now() });
    }
    const input = buildAgentInput(policy, ctx);
    // summary mode takes last 20
    expect(input.conversationHistory!.length).toBeLessThanOrEqual(20);
  });

  it('session_metadata includes turn count', () => {
    const policy: InputPolicy = {
      visible: ['session_metadata'],
      snapshot: 'structured',
    };
    const ctx = createMockAgentContext();
    const input = buildAgentInput(policy, ctx);
    expect(input.sessionMetadata?.agentId).toBe('agent-1');
    expect(input.sessionMetadata?.turnCount).toBe(1); // 1 assistant message
  });

  it('returns empty object when no fields visible', () => {
    const policy: InputPolicy = { visible: [], snapshot: 'full' };
    const ctx = createMockAgentContext();
    const input = buildAgentInput(policy, ctx);
    expect(Object.keys(input)).toHaveLength(0);
  });
});
