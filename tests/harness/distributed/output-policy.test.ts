/**
 * Tests for OutputPolicy handlers and InjectionQueue
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleIntercept,
  handleReplaceContext,
  handleInjectContext,
  handleNotify,
  InjectionQueue,
} from '../../../src/harness/distributed/output-policy.js';
import type { InterceptOutput, ContextOutput, NotifyOutput, AgentContext } from '../../../src/harness/distributed/types.js';
import type { EventBus } from '../../../src/harness/distributed/../../core/event-bus.js';

function createMockContext(): AgentContext {
  return {
    messages: [
      { role: 'user', content: 'original message', timestamp: Date.now() },
    ],
    runConfig: {
      systemPrompt: 'test',
      agentId: 'agent-1',
      sessionId: 'session-1',
    },
    events: {
      emit: vi.fn(),
      on: vi.fn(() => ({ dispose: vi.fn() })),
      onAll: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };
}

describe('handleIntercept', () => {
  it('should return proceed: true for allow', () => {
    const output: InterceptOutput = {
      kind: 'intercept',
      decision: 'allow',
      reason: 'Safe',
      confidence: 0.95,
    };

    const result = handleIntercept(output, createMockContext());
    expect(result.proceed).toBe(true);
    expect(result.result).toBeUndefined();
  });

  it('should return proceed: false with alternative for degrade', () => {
    const output: InterceptOutput = {
      kind: 'intercept',
      decision: 'degrade',
      reason: 'Unsafe pattern',
      confidence: 0.8,
      alternative: {
        command: 'curl -o /tmp/script.sh ...',
        notice: 'Download first, then review',
      },
    };

    const result = handleIntercept(output, createMockContext());
    expect(result.proceed).toBe(false);
    expect(result.result).toEqual({
      degraded: true,
      alternative: { command: 'curl -o /tmp/script.sh ...', notice: 'Download first, then review' },
      notice: 'Download first, then review',
    });
  });

  it('should return proceed: false with error for block', () => {
    const output: InterceptOutput = {
      kind: 'intercept',
      decision: 'block',
      reason: 'Critical violation',
      confidence: 0.99,
    };

    const result = handleIntercept(output, createMockContext());
    expect(result.proceed).toBe(false);
    expect(result.result).toEqual({
      blocked: true,
      reason: 'Critical violation',
    });
  });
});

describe('handleReplaceContext', () => {
  it('should replace all messages', () => {
    const output: ContextOutput = {
      kind: 'context',
      messages: [
        { role: 'system', content: 'Compressed context summary' },
      ],
      compressed: true,
    };

    const ctx = createMockContext();
    expect(ctx.messages).toHaveLength(1);

    handleReplaceContext(output, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].role).toBe('system');
    expect(ctx.messages[0].content).toBe('Compressed context summary');
    expect(ctx.messages[0].metadata?.compressed).toBe(true);
  });

  it('should handle multiple replacement messages', () => {
    const output: ContextOutput = {
      kind: 'context',
      messages: [
        { role: 'system', content: 'Context 1' },
        { role: 'user', content: 'Context 2' },
      ],
    };

    const ctx = createMockContext();
    handleReplaceContext(output, ctx);

    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].content).toBe('Context 1');
    expect(ctx.messages[1].content).toBe('Context 2');
  });

  it('should handle empty messages array', () => {
    const output: ContextOutput = {
      kind: 'context',
      messages: [],
    };

    const ctx = createMockContext();
    handleReplaceContext(output, ctx);

    expect(ctx.messages).toHaveLength(0);
  });
});

describe('handleInjectContext', () => {
  it('should append system messages', () => {
    const output: ContextOutput = {
      kind: 'context',
      messages: [
        { role: 'system', content: 'Injected knowledge' },
      ],
    };

    const ctx = createMockContext();
    const originalLength = ctx.messages.length;

    handleInjectContext(output, ctx);

    expect(ctx.messages).toHaveLength(originalLength + 1);
    expect(ctx.messages.at(-1)?.role).toBe('system');
    expect(ctx.messages.at(-1)?.content).toBe('Injected knowledge');
    expect(ctx.messages.at(-1)?.metadata?.source).toBe('distributed_agent');
  });

  it('should inject multiple messages', () => {
    const output: ContextOutput = {
      kind: 'context',
      messages: [
        { role: 'system', content: 'Info 1' },
        { role: 'system', content: 'Info 2' },
      ],
    };

    const ctx = createMockContext();
    handleInjectContext(output, ctx);

    expect(ctx.messages.at(-2)?.content).toBe('Info 1');
    expect(ctx.messages.at(-1)?.content).toBe('Info 2');
  });
});

describe('handleNotify', () => {
  it('should emit notification event', () => {
    const output: NotifyOutput = {
      kind: 'notify',
      content: 'Suspicious activity',
      level: 'warning',
    };

    const ctx = createMockContext();
    handleNotify(output, ctx);

    expect(ctx.events.emit).toHaveBeenCalledWith({
      type: 'distributed_agent.notify',
      timestamp: expect.any(Number),
      data: { content: 'Suspicious activity', level: 'warning' },
    });
  });

  it('should handle different levels', () => {
    const ctx = createMockContext();

    handleNotify({ kind: 'notify', content: 'info', level: 'info' }, ctx);
    handleNotify({ kind: 'notify', content: 'error', level: 'error' }, ctx);

    expect(ctx.events.emit).toHaveBeenCalledTimes(2);
  });
});

describe('InjectionQueue', () => {
  it('should enqueue and apply inject_context', () => {
    const queue = new InjectionQueue();
    const messages: Array<{ role: string; content: string; timestamp: number }> = [];

    queue.enqueue({
      agentId: 'agent-1',
      output: {
        kind: 'context',
        messages: [{ role: 'system', content: 'Injected' }],
      },
      mode: 'inject_context',
    });

    expect(queue.pendingCount).toBe(1);

    queue.applyPending(messages as any);

    expect(queue.pendingCount).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Injected');
  });

  it('should enqueue and apply replace_context', () => {
    const queue = new InjectionQueue();
    const messages: Array<{ role: string; content: string; timestamp: number }> = [
      { role: 'user', content: 'original', timestamp: Date.now() },
    ];

    queue.enqueue({
      agentId: 'agent-1',
      output: {
        kind: 'context',
        messages: [{ role: 'system', content: 'Replaced' }],
        compressed: true,
      },
      mode: 'replace_context',
    });

    queue.applyPending(messages as any);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Replaced');
  });

  it('should sort by priority: replace before inject', () => {
    const queue = new InjectionQueue();
    const messages: Array<{ role: string; content: string; timestamp: number }> = [];

    // Enqueue in reverse priority order
    queue.enqueue({
      agentId: 'agent-1',
      output: {
        kind: 'context',
        messages: [{ role: 'system', content: 'Injected' }],
      },
      mode: 'inject_context',
    });
    queue.enqueue({
      agentId: 'agent-2',
      output: {
        kind: 'context',
        messages: [{ role: 'system', content: 'Replaced' }],
        compressed: true,
      },
      mode: 'replace_context',
    });

    queue.applyPending(messages as any);

    // replace_context should be applied first, clearing and replacing
    // then inject_context should append
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Replaced');
    expect(messages[1].content).toBe('Injected');
  });

  it('should clear queue', () => {
    const queue = new InjectionQueue();

    queue.enqueue({
      agentId: 'agent-1',
      output: { kind: 'context', messages: [] },
      mode: 'inject_context',
    });

    expect(queue.pendingCount).toBe(1);

    queue.clear();
    expect(queue.pendingCount).toBe(0);
  });

  it('should handle empty queue', () => {
    const queue = new InjectionQueue();
    const messages: Array<unknown> = [];

    queue.applyPending(messages as any);
    expect(messages).toHaveLength(0);
  });
});
