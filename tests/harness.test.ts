/**
 * Harness 层测试
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AgentBuilder,
  createAgent,
  loadPersona,
  composePersonas,
  DefaultContextPipeline,
  SessionAwareRunner,
} from '../src/harness/index.js';
import {
  InMemorySessionStore,
} from '../src/integration/storage/memory.js';
import {
  DefaultEventBus,
  DefaultSecurityGuard,
  IterationBudget,
} from '../src/core/index.js';
import type {
  ModelProvider,
  LLMStreamChunk,
  RegisteredTool,
} from '../src/core/index.js';

// ── Mock 工厂 ──

function createMockModelProvider(): ModelProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: 'Hello!',
      model: 'mock-model',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
    stream: async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { type: 'content', content: 'Hello!' };
      yield { type: 'done', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    },
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

// ── 测试 ──

describe('AgentBuilder', () => {
  it('应该抛出错误如果没有设置 model', async () => {
    const builder = new AgentBuilder();
    await expect(builder.buildEngine()).rejects.toThrow('ModelProvider is required');
  });

  it('应该构建 AgentEngine', async () => {
    const engine = await new AgentBuilder()
      .model(createMockModelProvider())
      .buildEngine();

    expect(engine).toBeDefined();
    expect(engine.deps).toBeDefined();
    expect(engine.deps.model.name).toBe('mock');
  });

  it('应该构建 AgentEngine + SessionAwareRunner', async () => {
    const { engine, runner } = await new AgentBuilder()
      .model(createMockModelProvider())
      .build();

    expect(engine).toBeDefined();
    expect(runner).toBeDefined();
  });

  it('应该支持注册工具', async () => {
    const tool: RegisteredTool = {
      definition: {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {},
      },
      handler: async () => 'result',
    };

    const engine = await new AgentBuilder()
      .model(createMockModelProvider())
      .tool(tool)
      .buildEngine();

    expect(engine.deps.tools.has('test_tool')).toBe(true);
  });

  it('应该支持自定义存储', async () => {
    const store = new InMemorySessionStore();
    const { runner } = await new AgentBuilder()
      .model(createMockModelProvider())
      .store(store)
      .build();

    expect(runner).toBeDefined();
  });

  it('应该支持自定义事件总线', async () => {
    const events = new DefaultEventBus();
    const handler = vi.fn();
    events.onAll(handler);

    const engine = await new AgentBuilder()
      .model(createMockModelProvider())
      .events(events)
      .buildEngine();

    // 事件总线应该是同一个实例
    expect(engine.deps.events).toBe(events);
  });
});

describe('SessionAwareRunner', () => {
  it('应该创建和管理 session', async () => {
    const store = new InMemorySessionStore();
    const engine = await new AgentBuilder()
      .model(createMockModelProvider())
      .buildEngine();

    const runner = new SessionAwareRunner(engine, store);

    const events: any[] = [];
    for await (const event of runner.handle(
      'test-session',
      { role: 'user', content: '你好', timestamp: Date.now() },
      { systemPrompt: '你是一个助手' },
    )) {
      events.push(event);
    }

    // session 应该被保存
    const session = await store.load('test-session');
    expect(session).not.toBeNull();
    expect(session!.messages.length).toBeGreaterThan(0);
  });

  it('应该支持 session 锁', async () => {
    const store = new InMemorySessionStore();
    const engine = await new AgentBuilder()
      .model(createMockModelProvider())
      .buildEngine();

    const runner = new SessionAwareRunner(engine, store);

    // 第一次调用
    const events1: any[] = [];
    for await (const event of runner.handle(
      'lock-test',
      { role: 'user', content: '消息1', timestamp: Date.now() },
      { systemPrompt: 'test' },
    )) {
      events1.push(event);
    }

    // 第二次调用应该能获取锁
    const events2: any[] = [];
    for await (const event of runner.handle(
      'lock-test',
      { role: 'user', content: '消息2', timestamp: Date.now() },
      { systemPrompt: 'test' },
    )) {
      events2.push(event);
    }

    const session = await store.load('lock-test');
    expect(session!.messages.length).toBeGreaterThan(0);
  });
});

describe('createAgent', () => {
  it('应该快速创建 agent', async () => {
    const { engine, runner } = await createAgent({
      model: createMockModelProvider(),
    });

    expect(engine).toBeDefined();
    expect(runner).toBeDefined();
  });
});

describe('DefaultContextPipeline', () => {
  it('应该组装上下文', async () => {
    const pipeline = new DefaultContextPipeline();
    const messages = [
      { role: 'user' as const, content: '你好', timestamp: Date.now() },
    ];

    const output = await pipeline.process(messages, {
      systemPrompt: '你是一个助手',
      tools: [],
    });

    expect(output.messages.length).toBeGreaterThan(0);
    expect(output.messages[0].role).toBe('system');
    expect(output.messages[0].content).toBe('你是一个助手');
    expect(output.systemPrompt).toBe('你是一个助手');
  });

  it('应该处理工具调用消息', async () => {
    const pipeline = new DefaultContextPipeline();
    const messages = [
      { role: 'user' as const, content: '搜索', timestamp: Date.now() },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'call_1', name: 'search', arguments: { query: 'test' } }],
        timestamp: Date.now(),
      },
      {
        role: 'tool' as const,
        content: '',
        toolResults: [{ toolCallId: 'call_1', name: 'search', result: 'search result' }],
        timestamp: Date.now(),
      },
    ];

    const output = await pipeline.process(messages, {
      systemPrompt: 'test',
      tools: [],
    });

    // 应该有 system + user + assistant(with tool_calls) + tool
    expect(output.messages.length).toBe(4);
    expect(output.messages[2].role).toBe('assistant');
    expect(output.messages[2].tool_calls).toBeDefined();
    expect(output.messages[3].role).toBe('tool');
  });
});
