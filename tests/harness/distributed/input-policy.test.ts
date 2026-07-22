/**
 * Tests for InputPolicy and buildAgentInput
 */

import { describe, it, expect } from 'vitest';
import { buildTaskSummary, buildAgentInput } from '../../../src/harness/distributed/input-policy.js';
import type { InputPolicy, ContextField } from '../../../src/harness/distributed/input-policy.js';
import type { AgentContext } from '../../../src/harness/distributed/types.js';
import type { EventBus } from '../../../src/harness/distributed/../../core/event-bus.js';

function createMockEvents(): EventBus {
  return {
    emit: () => {},
    on: () => ({ dispose: () => {} }),
    onAll: () => ({ dispose: () => {} }),
  };
}

function createMockContext(): AgentContext {
  return {
    messages: [
      { role: 'user', content: 'Hello', timestamp: Date.now() },
      {
        role: 'assistant',
        content: 'I will help',
        timestamp: Date.now(),
        toolCalls: [{ id: 'tc1', name: 'shell', arguments: { command: 'ls' } }],
      },
      { role: 'user', content: 'Thanks', timestamp: Date.now() },
    ],
    runConfig: {
      systemPrompt: 'You are helpful',
      agentId: 'agent-1',
      sessionId: 'session-1',
      cwd: '/home/user',
    },
    pendingToolCall: { name: 'read', arguments: { path: '/tmp/test.txt' } },
    events: createMockEvents(),
  };
}

describe('buildTaskSummary', () => {
  it('should build a task summary from context', () => {
    const ctx = createMockContext();
    const summary = buildTaskSummary(ctx);

    expect(summary.agentId).toBe('agent-1');
    expect(summary.sessionId).toBe('session-1');
    expect(summary.recentTools).toEqual(['shell']);
    expect(summary.phase).toBe('user_request'); // last message is user
    expect(summary.pendingAction).toBe('read');
  });

  it('should detect agent_working phase', () => {
    const ctx = createMockContext();
    ctx.messages.push({ role: 'assistant', content: 'Working...', timestamp: Date.now() });

    const summary = buildTaskSummary(ctx);
    expect(summary.phase).toBe('agent_working');
  });

  it('should handle empty messages', () => {
    const ctx = createMockContext();
    ctx.messages = [];

    const summary = buildTaskSummary(ctx);
    expect(summary.recentTools).toEqual([]);
    expect(summary.phase).toBe('agent_working'); // no messages, at(-1) is undefined, falls to else
  });

  it('should collect tools from multiple assistant messages', () => {
    const ctx = createMockContext();
    ctx.messages = [
      {
        role: 'assistant',
        content: 'a',
        timestamp: Date.now(),
        toolCalls: [{ id: '1', name: 'shell', arguments: {} }],
      },
      {
        role: 'assistant',
        content: 'b',
        timestamp: Date.now(),
        toolCalls: [{ id: '2', name: 'read', arguments: {} }],
      },
    ];

    const summary = buildTaskSummary(ctx);
    expect(summary.recentTools).toEqual(['shell', 'read']);
  });
});

describe('buildAgentInput', () => {
  it('should build input with visible fields only', () => {
    const policy: InputPolicy = {
      visible: ['task_summary', 'pending_tool_call'],
      snapshot: 'full',
    };

    const ctx = createMockContext();
    const input = buildAgentInput(policy, ctx);

    expect(input.taskSummary).toBeDefined();
    expect(input.pendingToolCall).toBeDefined();
    expect(input.workingDirectory).toBeUndefined();
    expect(input.tokenCount).toBeUndefined();
  });

  it('should include working_directory when visible', () => {
    const policy: InputPolicy = {
      visible: ['working_directory'],
      snapshot: 'full',
    };

    const ctx = createMockContext();
    const input = buildAgentInput(policy, ctx);

    expect(input.workingDirectory).toBe('/home/user');
  });

  it('should include session_metadata when visible', () => {
    const policy: InputPolicy = {
      visible: ['session_metadata'],
      snapshot: 'full',
    };

    const ctx = createMockContext();
    const input = buildAgentInput(policy, ctx);

    expect(input.sessionMetadata).toBeDefined();
    expect(input.sessionMetadata?.agentId).toBe('agent-1');
    expect(input.sessionMetadata?.turnCount).toBe(1); // one assistant message
  });

  it('should include token_count when visible and provided', () => {
    const policy: InputPolicy = {
      visible: ['token_count'],
      snapshot: 'full',
    };

    const ctx = createMockContext();
    const input = buildAgentInput(policy, ctx, {
      tokenCount: { used: 5000, limit: 100000 },
    });

    expect(input.tokenCount).toEqual({ used: 5000, limit: 100000 });
  });

  it('should include conversation_history in full snapshot', () => {
    const policy: InputPolicy = {
      visible: ['conversation_history'],
      snapshot: 'full',
    };

    const ctx = createMockContext();
    const input = buildAgentInput(policy, ctx);

    expect(input.conversationHistory).toHaveLength(3);
  });

  it('should trim conversation_history in summary snapshot', () => {
    const policy: InputPolicy = {
      visible: ['conversation_history'],
      snapshot: 'summary',
    };

    const ctx = createMockContext();
    // Add many messages
    for (let i = 0; i < 30; i++) {
      ctx.messages.push({ role: 'user', content: `msg ${i}`, timestamp: Date.now() });
    }

    const input = buildAgentInput(policy, ctx);

    expect(input.conversationHistory).toHaveLength(20); // summary takes last 20
  });

  it('should include tool_calls when visible', () => {
    const policy: InputPolicy = {
      visible: ['tool_calls'],
      snapshot: 'full',
    };

    const ctx = createMockContext();
    const recentToolCalls = [
      { name: 'shell', arguments: { command: 'ls' }, result: 'file1\nfile2' },
    ];

    const input = buildAgentInput(policy, ctx, { recentToolCalls });

    expect(input.recentToolCalls).toHaveLength(1);
    expect(input.recentToolCalls?.[0].name).toBe('shell');
  });

  it('should trim tool_calls in summary snapshot', () => {
    const policy: InputPolicy = {
      visible: ['tool_calls'],
      snapshot: 'summary',
    };

    const ctx = createMockContext();
    const recentToolCalls = Array.from({ length: 10 }, (_, i) => ({
      name: `tool-${i}`,
      arguments: {},
    }));

    const input = buildAgentInput(policy, ctx, { recentToolCalls });

    expect(input.recentToolCalls).toHaveLength(5); // summary takes last 5
  });

  it('should build a security guard input (structured)', () => {
    const policy: InputPolicy = {
      visible: ['task_summary', 'pending_tool_call', 'working_directory'],
      snapshot: 'structured',
    };

    const ctx = createMockContext();
    const input = buildAgentInput(policy, ctx);

    expect(input.taskSummary).toBeDefined();
    expect(input.pendingToolCall).toBeDefined();
    expect(input.workingDirectory).toBe('/home/user');
    expect(input.conversationHistory).toBeUndefined();
    expect(input.tokenCount).toBeUndefined();
  });

  it('should build a context compressor input (full)', () => {
    const policy: InputPolicy = {
      visible: ['conversation_history', 'token_count'],
      snapshot: 'full',
    };

    const ctx = createMockContext();
    const input = buildAgentInput(policy, ctx, {
      tokenCount: { used: 80000, limit: 100000 },
    });

    expect(input.conversationHistory).toHaveLength(3);
    expect(input.tokenCount?.used).toBe(80000);
    expect(input.taskSummary).toBeUndefined();
  });

  it('should handle empty visible array', () => {
    const policy: InputPolicy = {
      visible: [],
      snapshot: 'full',
    };

    const ctx = createMockContext();
    const input = buildAgentInput(policy, ctx);

    expect(input.taskSummary).toBeUndefined();
    expect(input.pendingToolCall).toBeUndefined();
    expect(input.workingDirectory).toBeUndefined();
  });

  it('should skip pending_tool_call when not present in context', () => {
    const policy: InputPolicy = {
      visible: ['pending_tool_call'],
      snapshot: 'full',
    };

    const ctx = createMockContext();
    ctx.pendingToolCall = undefined;

    const input = buildAgentInput(policy, ctx);

    expect(input.pendingToolCall).toBeUndefined();
  });
});
