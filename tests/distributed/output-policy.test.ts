import { describe, expect, it, vi } from 'vitest';
import { handleIntercept, handleReplaceContext, handleInjectContext, handleNotify, InjectionQueue } from '../../src/harness/distributed-agents/distributed/output-policy.js';
import type { InterceptOutput, ContextOutput, NotifyOutput, AgentContext } from '../../src/harness/distributed-agents/distributed/types.js';

function createMockContext(): AgentContext {
  return {
    messages: [
      { role: 'user', content: 'original', timestamp: 1000 },
      { role: 'assistant', content: 'response', timestamp: 2000 },
    ],
    runConfig: { systemPrompt: 'test', agentId: 'agent-1', sessionId: 'session-1' },
    events: { emit: vi.fn(), on: vi.fn(), onAll: vi.fn() } as any,
  };
}

describe('handleIntercept', () => {
  it('allow: returns proceed true', () => {
    const output: InterceptOutput = { kind: 'intercept', decision: 'allow', reason: 'ok', confidence: 0.9 };
    const result = handleIntercept(output, createMockContext());
    expect(result.proceed).toBe(true);
    expect(result.result).toBeUndefined();
  });

  it('degrade: returns proceed false with alternative', () => {
    const output: InterceptOutput = {
      kind: 'intercept', decision: 'degrade', reason: 'high risk', confidence: 0.8,
      alternative: { command: 'safe-cmd', notice: 'using safe alternative' },
    };
    const result = handleIntercept(output, createMockContext());
    expect(result.proceed).toBe(false);
    expect(result.result).toMatchObject({ degraded: true });
  });

  it('block: returns proceed false with reason', () => {
    const output: InterceptOutput = { kind: 'intercept', decision: 'block', reason: 'blocked', confidence: 1.0 };
    const result = handleIntercept(output, createMockContext());
    expect(result.proceed).toBe(false);
    expect(result.result).toMatchObject({ blocked: true, reason: 'blocked' });
  });
});

describe('handleReplaceContext', () => {
  it('replaces messages in context', () => {
    const ctx = createMockContext();
    const output: ContextOutput = {
      kind: 'context',
      messages: [{ role: 'system', content: 'compressed summary' }],
      compressed: true,
    };
    handleReplaceContext(output, ctx);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toBe('compressed summary');
    expect(ctx.messages[0].metadata).toMatchObject({ compressed: true });
  });
});

describe('handleInjectContext', () => {
  it('appends system messages to context', () => {
    const ctx = createMockContext();
    const originalLen = ctx.messages.length;
    const output: ContextOutput = {
      kind: 'context',
      messages: [{ role: 'system', content: 'injected info' }],
    };
    handleInjectContext(output, ctx);
    expect(ctx.messages).toHaveLength(originalLen + 1);
    expect(ctx.messages.at(-1)!.content).toBe('injected info');
    expect(ctx.messages.at(-1)!.metadata).toMatchObject({ source: 'distributed_agent' });
  });
});

describe('handleNotify', () => {
  it('emits event on EventBus', () => {
    const ctx = createMockContext();
    const output: NotifyOutput = { kind: 'notify', content: 'test notification', level: 'warning' };
    handleNotify(output, ctx);
    expect(ctx.events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'distributed_agent.notify',
        data: { content: 'test notification', level: 'warning' },
      }),
    );
  });
});

describe('InjectionQueue', () => {
  it('enqueue and pendingCount', () => {
    const queue = new InjectionQueue();
    expect(queue.pendingCount).toBe(0);
    queue.enqueue({ agentId: 'a1', output: { kind: 'context', messages: [] }, mode: 'inject_context' });
    expect(queue.pendingCount).toBe(1);
  });

  it('applyPending processes entries and clears queue', () => {
    const queue = new InjectionQueue();
    const messages: any[] = [{ role: 'user', content: 'original' }];
    queue.enqueue({ agentId: 'a1', output: { kind: 'context', messages: [{ role: 'system', content: 'injected' }] }, mode: 'inject_context' });
    queue.applyPending(messages);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('injected');
    expect(queue.pendingCount).toBe(0);
  });

  it('replace_context clears existing messages', () => {
    const queue = new InjectionQueue();
    const messages: any[] = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old response' }];
    queue.enqueue({ agentId: 'a1', output: { kind: 'context', messages: [{ role: 'system', content: 'new compressed' }], compressed: true }, mode: 'replace_context' });
    queue.applyPending(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('new compressed');
  });

  it('replace_context has higher priority than inject_context', () => {
    const queue = new InjectionQueue();
    const messages: any[] = [];
    // enqueue in reverse priority order
    queue.enqueue({ agentId: 'a2', output: { kind: 'context', messages: [{ role: 'system', content: 'injected' }] }, mode: 'inject_context' });
    queue.enqueue({ agentId: 'a1', output: { kind: 'context', messages: [{ role: 'system', content: 'replaced' }], compressed: true }, mode: 'replace_context' });
    queue.applyPending(messages);
    // replace_context runs first (clears), then inject_context appends
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('replaced');
    expect(messages[1].content).toBe('injected');
  });

  it('clear empties queue', () => {
    const queue = new InjectionQueue();
    queue.enqueue({ agentId: 'a1', output: { kind: 'context', messages: [] }, mode: 'inject_context' });
    queue.clear();
    expect(queue.pendingCount).toBe(0);
  });
});
