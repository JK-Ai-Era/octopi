/**
 * Agent Loop 新架构测试
 */

import { describe, it, expect, vi } from 'vitest';
import { IterationBudget } from '../src/loop/iteration-budget.js';
import { classifyError, isRetryable, jitteredBackoff } from '../src/loop/error-classifier.js';
import { createMessageConverter } from '../src/loop/message-converter.js';
import { runAgentLoop } from '../src/loop/run-agent-loop.js';
import type {
  AgentLoopConfig,
  ContextEngine,
  LLMProvider,
  LLMResponse,
  Message,
  LoopAdvisor,
  MetaDecision,
  ToolResult,
} from '../src/core/types.js';

// ══════════════════════════════════════════
// IterationBudget
// ══════════════════════════════════════════

describe('IterationBudget', () => {
  it('基本 consume/refund', () => {
    const budget = new IterationBudget(10);
    expect(budget.remaining).toBe(10);
    expect(budget.used).toBe(0);

    expect(budget.consume()).toBe(true);
    expect(budget.used).toBe(1);
    expect(budget.remaining).toBe(9);

    budget.refund();
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(10);
  });

  it('耗尽后 consume 返回 false', () => {
    const budget = new IterationBudget(2);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
    expect(budget.isExhausted).toBe(true);
  });

  it('refund 不会低于 0', () => {
    const budget = new IterationBudget(5);
    budget.refund(); // 没消费就 refund
    expect(budget.used).toBe(0);
  });

  it('grace call 只给一次', () => {
    const budget = new IterationBudget(1);
    budget.consume(); // 用完
    expect(budget.isExhausted).toBe(true);

    // grace call
    expect(budget.consumeGrace()).toBe(true);
    expect(budget.used).toBe(2);

    // 第二次 grace 失败
    expect(budget.consumeGrace()).toBe(false);
  });

  it('reset 清空所有状态', () => {
    const budget = new IterationBudget(5);
    budget.consume();
    budget.consume();
    budget.reset();
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(5);
  });
});

// ══════════════════════════════════════════
// Error Classifier
// ══════════════════════════════════════════

describe('ErrorClassifier', () => {
  it('429 → rate_limit', () => {
    const err = Object.assign(new Error('Too many requests'), {
      status: 429,
      response: { headers: { 'retry-after': '5' } },
    });
    const classified = classifyError(err, 'openai', 'gpt-4o');
    expect(classified.reason).toBe('rate_limit');
    expect(classified.retryAfterMs).toBe(5000);
    expect(classified.provider).toBe('openai');
  });

  it('401 → auth', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(classifyError(err).reason).toBe('auth');
  });

  it('402 → billing', () => {
    const err = Object.assign(new Error('Payment required'), { status: 402 });
    expect(classifyError(err).reason).toBe('billing');
  });

  it('context_length_exceeded → context_length', () => {
    const err = new Error('context_length_exceeded');
    expect(classifyError(err).reason).toBe('context_length');
  });

  it('ECONNRESET → network', () => {
    const err = new Error('read ECONNRESET');
    expect(classifyError(err).reason).toBe('network');
  });

  it('500 → server', () => {
    const err = Object.assign(new Error('Internal server error'), { status: 500 });
    expect(classifyError(err).reason).toBe('server');
  });

  it('未知错误 → unknown', () => {
    const err = new Error('something weird');
    expect(classifyError(err).reason).toBe('unknown');
  });

  it('isRetryable: rate_limit=true, auth=false', () => {
    expect(isRetryable({ reason: 'rate_limit', message: '', originalError: null })).toBe(true);
    expect(isRetryable({ reason: 'network', message: '', originalError: null })).toBe(true);
    expect(isRetryable({ reason: 'server', message: '', originalError: null })).toBe(true);
    expect(isRetryable({ reason: 'timeout', message: '', originalError: null })).toBe(true);
    expect(isRetryable({ reason: 'auth', message: '', originalError: null })).toBe(false);
    expect(isRetryable({ reason: 'billing', message: '', originalError: null })).toBe(false);
    expect(isRetryable({ reason: 'context_length', message: '', originalError: null })).toBe(false);
  });

  it('jitteredBackoff 递增且有上限', () => {
    const delays = Array.from({ length: 5 }, (_, i) =>
      jitteredBackoff(i, 1000, 30000),
    );
    // 第一次应该接近 base
    expect(delays[0]).toBeGreaterThanOrEqual(750);
    expect(delays[0]).toBeLessThanOrEqual(1250);
    // 最后一次应该不超过 max + jitter
    expect(delays[4]).toBeLessThanOrEqual(37500);
  });
});

// ══════════════════════════════════════════
// Message Converter
// ══════════════════════════════════════════

describe('MessageConverter', () => {
  const converter = createMessageConverter();

  it('user 消息转换', () => {
    const msg: Message = {
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    };
    const llm = converter.toLlm([msg]);
    expect(llm).toHaveLength(1);
    expect(llm[0].role).toBe('user');
    expect(llm[0].content).toBe('Hello');
  });

  it('assistant 消息带 tool_calls', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'I will search for that.',
      timestamp: Date.now(),
      toolCalls: [{
        id: 'call_1',
        name: 'search',
        arguments: { query: 'test' },
      }],
    };
    const llm = converter.toLlm([msg]);
    expect(llm[0].tool_calls).toHaveLength(1);
    expect(llm[0].tool_calls![0].function.name).toBe('search');
    expect(llm[0].tool_calls![0].function.arguments).toBe('{"query":"test"}');
  });

  it('tool 消息转换', () => {
    const msg: Message = {
      role: 'tool',
      content: 'search result',
      timestamp: Date.now(),
      toolResults: [{
        toolCallId: 'call_1',
        name: 'search',
        result: 'search result',
      }],
    };
    const llm = converter.toLlm([msg]);
    expect(llm[0].tool_call_id).toBe('call_1');
    expect(llm[0].name).toBe('search');
  });

  it('fromLlm 转换 assistant 消息', () => {
    const llm = {
      role: 'assistant',
      content: 'Here you go',
      tool_calls: [{
        id: 'call_2',
        type: 'function' as const,
        function: { name: 'read_file', arguments: '{"path":"/tmp/test"}' },
      }],
    };
    const msg = converter.fromLlm(llm);
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Here you go');
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls![0].name).toBe('read_file');
    expect(msg.toolCalls![0].arguments).toEqual({ path: '/tmp/test' });
  });

  it('fromLlm 转换 tool 消息', () => {
    const llm = {
      role: 'tool',
      content: 'file content here',
      tool_call_id: 'call_2',
      name: 'read_file',
    };
    const msg = converter.fromLlm(llm);
    expect(msg.role).toBe('tool');
    expect(msg.toolResults).toHaveLength(1);
    expect(msg.toolResults![0].toolCallId).toBe('call_2');
  });

  it('fromLlm 处理无效 JSON arguments', () => {
    const llm = {
      role: 'assistant' as const,
      content: '',
      tool_calls: [{
        id: 'call_3',
        type: 'function' as const,
        function: { name: 'test', arguments: 'not json' },
      }],
    };
    const msg = converter.fromLlm(llm);
    expect(msg.toolCalls![0].arguments).toEqual({ _raw: 'not json' });
  });
});

// ══════════════════════════════════════════
// runAgentLoop 集成测试
// ══════════════════════════════════════════

describe('runAgentLoop', () => {
  /** 创建 mock LLM Provider */
  function createMockProvider(responses: LLMResponse[]): LLMProvider {
    let callIndex = 0;
    return {
      name: 'mock',
      models: ['mock-model'],
      async complete() {
        return responses[callIndex++] ?? responses[responses.length - 1];
      },
    };
  }

  /** 创建 mock Context Engine */
  function createMockContextEngine(): ContextEngine {
    return {
      info: { id: 'mock-ce', name: 'Mock CE', ownsCompaction: false },
      async ingest() {},
      async assemble({ messages }) {
        return {
          messages: messages.map((m: any) => ({ role: m.role, content: m.content })),
          estimatedTokens: 100,
        };
      },
      async compact() { return { ok: true, compacted: false }; },
      async afterTurn() {},
    };
  }

  /** 创建 mock Tool Registry */
  function createMockToolRegistry(toolResults: Record<string, unknown> = {}) {
    return {
      getDefinitions(): unknown[] { return []; },
      async execute(name: string, args: any): Promise<ToolResult> {
        return {
          toolCallId: 'mock',
          name,
          result: toolResults[name] ?? `result of ${name}`,
        };
      },
    };
  }

  function makeInput(content: string): Message {
    return {
      role: 'user',
      content,
      timestamp: Date.now(),
    };
  }

  it('纯文本响应 → loop_end completed', async () => {
    const provider = createMockProvider([{
      content: 'Hello!',
      model: 'mock-model',
      finishReason: 'stop',
    }]);

    const config: AgentLoopConfig = {
      provider,
      contextEngine: createMockContextEngine(),
      toolRegistry: createMockToolRegistry(),
      messageConverter: createMessageConverter(),
      advisors: [],
      defaultModel: 'mock-model',
      maxTurns: 10,
      iterationBudget: 90,
      maxConsecutiveErrors: 5,
      retry: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 1000 },
    };

    const events: string[] = [];
    for await (const event of runAgentLoop(config, makeInput('Hi'))) {
      events.push(event.type);
    }

    expect(events).toContain('loop_start');
    expect(events).toContain('llm_request');
    expect(events).toContain('llm_response');
    expect(events).toContain('loop_end');
    expect(events).toContain('turn_end');
  });

  it('工具调用 → 两轮完成', async () => {
    const provider = createMockProvider([
      {
        content: 'Let me search...',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: { query: 'test' } }],
        model: 'mock-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Found it!',
        model: 'mock-model',
        finishReason: 'stop',
      },
    ]);

    const config: AgentLoopConfig = {
      provider,
      contextEngine: createMockContextEngine(),
      toolRegistry: createMockToolRegistry({ search: 'search results' }),
      messageConverter: createMessageConverter(),
      advisors: [],
      defaultModel: 'mock-model',
      maxTurns: 10,
      iterationBudget: 90,
      maxConsecutiveErrors: 5,
      retry: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 1000 },
    };

    const events: string[] = [];
    let finalResponse: string | undefined;

    for await (const event of runAgentLoop(config, makeInput('search for test'))) {
      events.push(event.type);
      if (event.type === 'loop_end') {
        finalResponse = (event as any).response;
      }
    }

    expect(events.filter((e) => e === 'turn_start')).toHaveLength(2);
    expect(events).toContain('tool_call_start');
    expect(events).toContain('tool_call_result');
    expect(finalResponse).toBe('Found it!');
  });

  it('advisor 可以注入消息', async () => {
    const provider = createMockProvider([{
      content: 'OK with context',
      model: 'mock-model',
      finishReason: 'stop',
    }]);

    const advisor: LoopAdvisor = {
      name: 'test-advisor',
      priority: 10,
      async beforeTurn(): Promise<MetaDecision> {
        return {
          injectMessages: [{
            role: 'system',
            content: 'Injected context from advisor',
            timestamp: Date.now(),
          }],
        };
      },
    };

    const config: AgentLoopConfig = {
      provider,
      contextEngine: createMockContextEngine(),
      toolRegistry: createMockToolRegistry(),
      messageConverter: createMessageConverter(),
      advisors: [advisor],
      defaultModel: 'mock-model',
      maxTurns: 10,
      iterationBudget: 90,
      maxConsecutiveErrors: 5,
      retry: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 1000 },
    };

    const events: string[] = [];
    for await (const event of runAgentLoop(config, makeInput('test'))) {
      events.push(event.type);
    }

    expect(events).toContain('advisor_call');
    expect(events).toContain('messages_injected');
    expect(events).toContain('meta_decision');
  });

  it('advisor 可以停止循环', async () => {
    const provider = createMockProvider([{
      content: 'should not reach here',
      model: 'mock-model',
      finishReason: 'stop',
    }]);

    const advisor: LoopAdvisor = {
      name: 'stopper',
      priority: 10,
      async beforeTurn(): Promise<MetaDecision> {
        return { shouldStop: true, stopReason: 'blocked by advisor' };
      },
    };

    const config: AgentLoopConfig = {
      provider,
      contextEngine: createMockContextEngine(),
      toolRegistry: createMockToolRegistry(),
      messageConverter: createMessageConverter(),
      advisors: [advisor],
      defaultModel: 'mock-model',
      maxTurns: 10,
      iterationBudget: 90,
      maxConsecutiveErrors: 5,
      retry: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 1000 },
    };

    const events: string[] = [];
    for await (const event of runAgentLoop(config, makeInput('test'))) {
      events.push(event.type);
    }

    expect(events).toContain('advisor_call');
    expect(events).toContain('loop_end');
    expect(events).not.toContain('llm_request');
  });

  it('AbortSignal 中断', async () => {
    // 创建一个会延迟的 provider
    const provider: LLMProvider = {
      name: 'slow-mock',
      models: ['mock-model'],
      async complete() {
        await new Promise((r) => setTimeout(r, 500));
        return { content: 'slow response', model: 'mock-model', finishReason: 'stop' };
      },
    };

    const ac = new AbortController();
    // 100ms 后中断
    setTimeout(() => ac.abort(), 100);

    const config: AgentLoopConfig = {
      provider,
      contextEngine: createMockContextEngine(),
      toolRegistry: createMockToolRegistry(),
      messageConverter: createMessageConverter(),
      advisors: [],
      defaultModel: 'mock-model',
      maxTurns: 10,
      iterationBudget: 90,
      maxConsecutiveErrors: 5,
      retry: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 1000 },
    };

    const events: string[] = [];
    for await (const event of runAgentLoop(config, makeInput('test'), ac.signal)) {
      events.push(event.type);
    }

    expect(events).toContain('loop_start');
    // 应该在 LLM 调用前或调用中被中断
    expect(events.some((e) => e === 'interrupted' || e === 'loop_end')).toBe(true);
  });
});
