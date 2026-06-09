/**
 * AgentEngine 高级功能测试
 *
 * 补充 core-engine.test.ts 未覆盖的场景：
 * - 流式 tool call 多工具并行
 * - 错误分类和重试策略
 * - Context pipeline 集成
 * - 系统提示词传递
 * - Token 估算器
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AgentEngine,
  DefaultEventBus,
  DefaultSecurityGuard,
  IterationBudget,
  AgentEvents,
} from '../src/core/index.js';
import type {
  AgentEngineDeps,
  RunConfig,
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ToolExecutor,
  ContextPipeline,
  PipelineInput,
  PipelineOutput,
  ErrorStrategy,
  RegisteredTool,
  Message,
} from '../src/core/index.js';
import { estimateTokens, estimateTextTokens } from '../src/core/token-estimator.js';

// ── Mock 工厂 ──

function createMockModelProvider(response?: Partial<LLMResponse>): ModelProvider {
  const defaultResponse: LLMResponse = {
    content: 'Hello!',
    model: 'mock-model',
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ ...defaultResponse, ...response }),
    stream: async function* () {
      const resp = { ...defaultResponse, ...response };
      yield { type: 'content', content: resp.content };
      if (resp.toolCalls) {
        for (const tc of resp.toolCalls) {
          yield { type: 'tool_call', toolCall: { id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments) } };
        }
      }
      yield { type: 'done', usage: resp.usage };
    },
    isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
  };
}

function createMockContextPipeline(): ContextPipeline {
  return {
    process: vi.fn().mockImplementation(async (messages: Message[], input: PipelineInput): Promise<PipelineOutput> => ({
      messages: [
        { role: 'system', content: input.systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
      estimatedTokens: 100,
      systemPrompt: input.systemPrompt,
    })),
  };
}

function createTestDeps(overrides?: Partial<AgentEngineDeps>): AgentEngineDeps {
  const events = new DefaultEventBus();
  return {
    model: createMockModelProvider(),
    tools: new Map(),
    executor: { execute: vi.fn().mockResolvedValue('result') },
    context: createMockContextPipeline(),
    events,
    security: new DefaultSecurityGuard(events),
    budget: new IterationBudget(events),
    errorStrategy: {
      onModelError: vi.fn().mockReturnValue({ action: 'abort', reason: 'test' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    },
    ...overrides,
  };
}

function createTestMessage(content: string): Message {
  return { role: 'user', content, timestamp: Date.now() };
}

// ── 测试 ──

describe('流式 tool call 多工具并行', () => {
  it('应该正确处理多个并行 tool call', async () => {
    const executor = { execute: vi.fn().mockResolvedValue('result') };

    // Mock stream: 第一次返回两个 tool call，第二次返回纯文本
    let callCount = 0;
    const model: ModelProvider = {
      name: 'mock',
      chat: vi.fn(),
      stream: async function* () {
        callCount++;
        if (callCount === 1) {
          // 两个并行 tool call，使用不同 index
          yield { type: 'tool_call', toolCall: { id: 'call_1', name: 'tool_a', arguments: '{"x":1}', index: 0 } };
          yield { type: 'tool_call', toolCall: { id: 'call_2', name: 'tool_b', arguments: '{"y":2}', index: 1 } };
          yield { type: 'done', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
        } else {
          yield { type: 'content', content: 'Both tools executed!' };
          yield { type: 'done', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
        }
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    };

    const deps = createTestDeps({ model, executor });
    const engine = new AgentEngine(deps);
    const events: any[] = [];

    for await (const event of engine.run([createTestMessage('run both tools')], { systemPrompt: 'test' })) {
      events.push(event);
    }

    // executor 应该被调用两次（两个工具）
    expect(executor.execute).toHaveBeenCalledTimes(2);

    // 应该有两个 tool.exec.start 和 tool.exec.end
    const toolStarts = events.filter(e => e.type === 'tool.exec.start');
    const toolEnds = events.filter(e => e.type === 'tool.exec.end');
    expect(toolStarts.length).toBe(2);
    expect(toolEnds.length).toBe(2);
  });

  it('应该正确合并流式 tool call 参数片段', async () => {
    const executor = { execute: vi.fn().mockResolvedValue('ok') };

    // Mock stream: 一个完整的 tool call
    const model: ModelProvider = {
      name: 'mock',
      chat: vi.fn(),
      stream: async function* () {
        yield { type: 'tool_call', toolCall: { id: 'c1', name: 'my_tool', arguments: '{"query":"hello"}', index: 0 } };
        yield { type: 'done', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    };

    const deps = createTestDeps({ model, executor });
    const engine = new AgentEngine(deps);
    const events: any[] = [];

    for await (const event of engine.run([createTestMessage('test')], { systemPrompt: 'test' })) {
      events.push(event);
    }

    // executor 应该被调用
    expect(executor.execute).toHaveBeenCalled();
    // 应该有工具执行事件
    expect(events.some(e => e.type === 'tool.exec.start')).toBe(true);
  });
});

describe('错误分类和重试', () => {
  it('应该根据 HTTP 状态码分类错误', async () => {
    const events = new DefaultEventBus();
    const errorStrategy: ErrorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort', reason: 'test' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    };

    // 模拟 429 错误
    const model: ModelProvider = {
      name: 'mock',
      chat: vi.fn().mockRejectedValue(Object.assign(new Error('Rate limited'), { status: 429 })),
      stream: (async function* () {
        throw Object.assign(new Error('Rate limited'), { status: 429 });
      })() as any,
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    };

    const deps = createTestDeps({ model, errorStrategy, events });
    const engine = new AgentEngine(deps);
    const errors: any[] = [];
    events.on('model.call.error', (e) => errors.push(e));

    for await (const _ of engine.run([createTestMessage('test')], { systemPrompt: 'test' })) {}

    // 应该触发 onModelError，且 reason 为 rate_limit
    expect(errorStrategy.onModelError).toHaveBeenCalled();
    const classified = (errorStrategy.onModelError as any).mock.calls[0][0];
    expect(classified.reason).toBe('rate_limit');
  });

  it('应该在重试后成功', async () => {
    let callCount = 0;
    const model: ModelProvider = {
      name: 'mock',
      chat: vi.fn(),
      stream: async function* () {
        callCount++;
        if (callCount === 1) {
          throw Object.assign(new Error('Timeout'), { status: 408 });
        }
        yield { type: 'content', content: 'Recovered!' };
        yield { type: 'done', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    };

    const errorStrategy: ErrorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'retry', delayMs: 10 }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    };

    const deps = createTestDeps({ model, errorStrategy });
    const engine = new AgentEngine(deps);
    const events: any[] = [];

    for await (const event of engine.run([createTestMessage('test')], { systemPrompt: 'test' })) {
      events.push(event);
    }

    // 应该有 retry 事件
    expect(events.some(e => e.type === 'retry')).toBe(true);
    // 应该最终成功
    expect(events.some(e => e.type === 'turn.end')).toBe(true);
  });
});

describe('Context pipeline 集成', () => {
  it('应该将 systemPrompt 传递给 pipeline', async () => {
    const pipelineProcess = vi.fn().mockImplementation(async (messages: Message[], input: PipelineInput): Promise<PipelineOutput> => ({
      messages: [{ role: 'system', content: input.systemPrompt }, ...messages.map(m => ({ role: m.role, content: m.content }))],
      estimatedTokens: 100,
      systemPrompt: input.systemPrompt,
    }));

    const deps = createTestDeps({
      context: { process: pipelineProcess },
    });
    const engine = new AgentEngine(deps);

    for await (const _ of engine.run([createTestMessage('test')], { systemPrompt: 'You are a helpful assistant' })) {}

    // pipeline 应该被调用
    expect(pipelineProcess).toHaveBeenCalled();
    // systemPrompt 应该被传递
    const callArgs = (pipelineProcess as any).mock.calls[0];
    expect(callArgs[1].systemPrompt).toBe('You are a helpful assistant');
  });

  it('应该优先使用 RunConfig.systemPrompt，回退到 deps.systemPrompt', async () => {
    const pipelineProcess = vi.fn().mockImplementation(async (messages: Message[], input: PipelineInput): Promise<PipelineOutput> => ({
      messages: [{ role: 'system', content: input.systemPrompt }],
      estimatedTokens: 50,
      systemPrompt: input.systemPrompt,
    }));

    const deps = createTestDeps({
      context: { process: pipelineProcess },
      systemPrompt: 'From deps',
    });
    const engine = new AgentEngine(deps);

    // RunConfig 有 systemPrompt，应该优先使用
    for await (const _ of engine.run([createTestMessage('test')], { systemPrompt: 'From RunConfig' })) {}

    const callArgs = (pipelineProcess as any).mock.calls[0];
    expect(callArgs[1].systemPrompt).toBe('From RunConfig');
  });

  it('应该在 RunConfig 无 systemPrompt 时使用 deps.systemPrompt', async () => {
    const pipelineProcess = vi.fn().mockImplementation(async (messages: Message[], input: PipelineInput): Promise<PipelineOutput> => ({
      messages: [{ role: 'system', content: input.systemPrompt }],
      estimatedTokens: 50,
      systemPrompt: input.systemPrompt,
    }));

    const deps = createTestDeps({
      context: { process: pipelineProcess },
      systemPrompt: 'From deps',
    });
    const engine = new AgentEngine(deps);

    // RunConfig.systemPrompt 为空，应该回退到 deps
    for await (const _ of engine.run([createTestMessage('test')], { systemPrompt: '' })) {}

    const callArgs = (pipelineProcess as any).mock.calls[0];
    expect(callArgs[1].systemPrompt).toBe('From deps');
  });
});

describe('Token 估算器', () => {
  it('应该正确估算中文文本', () => {
    const tokens = estimateTextTokens('你好世界');
    // 中文 4 字，约 6 tokens
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it('应该正确估算英文文本', () => {
    const tokens = estimateTextTokens('Hello world, this is a test');
    // 英文约 28 字符 / 4 = 7 tokens
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(15);
  });

  it('应该正确估算混合文本', () => {
    const tokens = estimateTextTokens('Hello 你好 world 世界');
    expect(tokens).toBeGreaterThan(0);
  });

  it('应该处理空字符串', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  it('应该正确估算消息列表', () => {
    const messages = [
      { content: 'Hello world' },
      { content: '你好世界' },
      { content: null },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('应该处理超长文本采样', () => {
    const longText = 'a'.repeat(10000);
    const tokens = estimateTextTokens(longText);
    // 超长文本应该被采样处理
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('context_length 错误自动截断', () => {
  it('应该在 context_length 错误时截断消息历史并重试', async () => {
    let callCount = 0;
    const model: ModelProvider = {
      name: 'mock',
      chat: vi.fn(),
      stream: async function* () {
        callCount++;
        if (callCount === 1) {
          // 第一次：context_length 错误
          throw Object.assign(new Error('context_length_exceeded'), { status: 400 });
        }
        // 截断后重试成功
        yield { type: 'content', content: 'Recovered after truncation!' };
        yield { type: 'done', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    };

    const errorStrategy: ErrorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort', reason: 'context length' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    };

    const deps = createTestDeps({ model, errorStrategy });
    const engine = new AgentEngine(deps);
    const events: any[] = [];

    // 传入较多消息，确保截断有意义
    const messages: Message[] = [
      createTestMessage('msg1'),
      { role: 'assistant', content: 'reply1', timestamp: Date.now() },
      createTestMessage('msg2'),
      { role: 'assistant', content: 'reply2', timestamp: Date.now() },
      createTestMessage('msg3'),
      { role: 'assistant', content: 'reply3', timestamp: Date.now() },
      createTestMessage('msg4'),
      { role: 'assistant', content: 'reply4', timestamp: Date.now() },
      createTestMessage('msg5'),
      { role: 'assistant', content: 'reply5', timestamp: Date.now() },
      createTestMessage('current question'),
    ];

    for await (const event of engine.run(messages, { systemPrompt: 'test' })) {
      events.push(event);
    }

    // 应该有 context.truncated 事件
    expect(events.some(e => e.type === 'context.truncated')).toBe(true);
    // 应该最终成功（turn.end）
    expect(events.some(e => e.type === 'turn.end')).toBe(true);
    // 模型应该被调用两次（第一次失败，截断后重试成功）
    expect(callCount).toBe(2);
  });

  it('不应该重复截断上下文', async () => {
    let callCount = 0;
    const model: ModelProvider = {
      name: 'mock',
      chat: vi.fn(),
      stream: async function* () {
        callCount++;
        // 每次都返回 context_length 错误
        throw Object.assign(new Error('context_length_exceeded'), { status: 400 });
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    };

    const errorStrategy: ErrorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort', reason: 'context length' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    };

    const deps = createTestDeps({ model, errorStrategy });
    const engine = new AgentEngine(deps);
    const events: any[] = [];

    const messages: Message[] = [
      createTestMessage('msg1'),
      { role: 'assistant', content: 'reply1', timestamp: Date.now() },
      createTestMessage('msg2'),
      { role: 'assistant', content: 'reply2', timestamp: Date.now() },
      createTestMessage('msg3'),
      { role: 'assistant', content: 'reply3', timestamp: Date.now() },
      createTestMessage('msg4'),
      { role: 'assistant', content: 'reply4', timestamp: Date.now() },
      createTestMessage('msg5'),
      { role: 'assistant', content: 'reply5', timestamp: Date.now() },
      createTestMessage('current'),
    ];

    for await (const event of engine.run(messages, { systemPrompt: 'test' })) {
      events.push(event);
    }

    // 只应该截断一次
    const truncations = events.filter(e => e.type === 'context.truncated');
    expect(truncations.length).toBe(1);
    // 第二次应该走正常 error 路径
    expect(errorStrategy.onModelError).toHaveBeenCalled();
  });
});

describe('引擎异常退出事件', () => {
  it('应该在预算耗尽时 yield budget.exceeded 事件', async () => {
    const events = new DefaultEventBus();
    const budget = new IterationBudget(events, { maxIterations: 2 });

    // Mock: 总是返回 tool call，消耗迭代
    let callCount = 0;
    const model: ModelProvider = {
      name: 'mock',
      chat: vi.fn(),
      stream: async function* () {
        callCount++;
        yield { type: 'tool_call', toolCall: { id: `call_${callCount}`, name: 'test_tool', arguments: '{}', index: 0 } };
        yield { type: 'done', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    };

    const tools = new Map<string, RegisteredTool>();
    tools.set('test_tool', {
      definition: { name: 'test_tool', description: 'test', parameters: {} },
      handler: vi.fn().mockResolvedValue('ok'),
    });

    const deps = createTestDeps({ model, tools, budget, events });
    const engine = new AgentEngine(deps);
    const collected: any[] = [];

    for await (const event of engine.run([createTestMessage('test')], { systemPrompt: 'test' })) {
      collected.push(event);
    }

    // 应该有 budget.exceeded 事件
    expect(collected.some(e => e.type === 'budget.exceeded')).toBe(true);
    // 不应该有 turn.end
    expect(collected.some(e => e.type === 'turn.end')).toBe(false);
  });
});
