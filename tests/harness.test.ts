/**
 * Harness 层测试
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AgentBuilder,
  createAgent,
  loadPersona,
  composePersonas,
  DefaultContextEngine,
  SessionAwareRunner,
  DefaultTaskSupervisor,
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
      getModelInfo: () => null,
  };
}

// ── 测试 ──

describe('AgentBuilder', () => {
  it('应该抛出错误如果没有设置 model', async () => {
    const builder = new AgentBuilder();
    await expect(builder.buildAgent()).rejects.toThrow('ModelProvider is required');
  });

  it('应该构建 Agent', async () => {
    const { agent } = await new AgentBuilder()
      .model(createMockModelProvider())
      .buildAgent();

    expect(agent).toBeDefined();
    expect(agent.model.name).toBe('mock');
  });

  it('应该构建 Agent + SessionAwareRunner', async () => {
    const { agent, runner } = await new AgentBuilder()
      .model(createMockModelProvider())
      .build();

    expect(agent).toBeDefined();
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

    const { agent } = await new AgentBuilder()
      .model(createMockModelProvider())
      .tool(tool)
      .buildAgent();

    expect(agent.tools.some(t => t.name === 'test_tool')).toBe(true);
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

    const built = await new AgentBuilder()
      .model(createMockModelProvider())
      .events(events)
      .build();

    // 事件总线应该是同一个实例
    expect(built.events).toBe(events);
  });
});

describe('SessionAwareRunner', () => {
  it('应该创建和管理 session', async () => {
    const store = new InMemorySessionStore();
    const { agent, harness } = await new AgentBuilder()
      .model(createMockModelProvider())
      .buildAgent();

    const runner = new SessionAwareRunner(agent, harness, store);

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
    const { agent, harness } = await new AgentBuilder()
      .model(createMockModelProvider())
      .buildAgent();

    const runner = new SessionAwareRunner(agent, harness, store);

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
    const { agent, runner } = await createAgent({
      model: createMockModelProvider(),
    });

    expect(agent).toBeDefined();
    expect(runner).toBeDefined();
  });
});

describe('SessionAwareRunner — 异常退出 session 一致性', () => {
  it('引擎以 budget.exceeded 退出时，应保持 session 状态为 idle', async () => {
    const store = new InMemorySessionStore();

    // Mock: 第一次返回 tool call，之后预算耗尽
    let callCount = 0;
    const model: ModelProvider = {
      name: 'mock',
      chat: vi.fn(),
      stream: async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'content', content: 'Let me check...' };
          yield { type: 'tool_call', toolCall: { id: 'c1', name: 'test_tool', arguments: '{}', index: 0 } };
          yield { type: 'done', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
        }
        // 第二次：直接结束（模拟预算耗尽后的引擎行为）
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    };

    const testTool: RegisteredTool = {
      definition: { name: 'test_tool', description: 'test', parameters: {} },
      handler: vi.fn().mockResolvedValue('ok'),
    };

    const { agent, harness } = await new AgentBuilder()
      .model(model)
      .tools(testTool)
      .buildAgent();

    const runner = new SessionAwareRunner(agent, harness, store);
    const collected: any[] = [];

    for await (const event of runner.handle(
      'consistency-test',
      { role: 'user', content: 'test', timestamp: Date.now() },
      { systemPrompt: 'test' },
    )) {
      collected.push(event);
    }

    // session 应该被保存
    const session = await store.load('consistency-test');
    expect(session).not.toBeNull();
    // session 状态应该是 idle（不是 processing）
    expect(session!.meta.status).toBe('idle');
  });

  it('引擎以 engine.error 退出时，session 应被正确保存', async () => {
    const store = new InMemorySessionStore();

    // Mock: 直接抛出认证错误
    const model: ModelProvider = {
      name: 'mock',
      chat: vi.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 })),
      stream: async function* () {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    };

    const errorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort' as const, reason: 'auth failed' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip' as const, reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' as const }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block' as const, reason: 'test' }),
    };

    const { agent, harness } = await new AgentBuilder()
      .model(model)
      .errorStrategy(errorStrategy)
      .buildAgent();

    const runner = new SessionAwareRunner(agent, harness, store);
    const collected: any[] = [];

    for await (const event of runner.handle(
      'error-test',
      { role: 'user', content: 'test', timestamp: Date.now() },
      { systemPrompt: 'test' },
    )) {
      collected.push(event);
    }

    // session 应该被保存
    const session = await store.load('error-test');
    expect(session).not.toBeNull();
    // session 状态应该是 idle
    expect(session!.meta.status).toBe('idle');
    // 应该有 engine.error 或 agent_end 事件
    const hasError = collected.some(e => e.type === 'engine.error' || e.type === 'agent_end' || e.type === 'aborted');
    expect(hasError).toBe(true);
  });

  it('有流式内容但无 turn.end 时，应保存已输出的内容', async () => {
    const store = new InMemorySessionStore();

    // Mock: 输出部分内容后出错
    const model: ModelProvider = {
      name: 'mock',
      chat: vi.fn().mockRejectedValue(Object.assign(new Error('Connection lost'), { status: 500 })),
      stream: async function* () {
        yield { type: 'content', content: 'Partial response...' };
        throw Object.assign(new Error('Connection lost'), { status: 500 });
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    };

    const errorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort' as const, reason: 'server error' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip' as const, reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' as const }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block' as const, reason: 'test' }),
    };

    const { agent, harness } = await new AgentBuilder()
      .model(model)
      .errorStrategy(errorStrategy)
      .buildAgent();

    const runner = new SessionAwareRunner(agent, harness, store);

    for await (const _ of runner.handle(
      'partial-test',
      { role: 'user', content: 'test', timestamp: Date.now() },
      { systemPrompt: 'test' },
    )) {}

    const session = await store.load('partial-test');
    expect(session).not.toBeNull();
    // session 应该有消息
    expect(session!.messages.length).toBeGreaterThan(0);
    // session 状态应该是 idle
    expect(session!.meta.status).toBe('idle');
  });
});

describe('DefaultContextEngine', () => {
  it('应该组装上下文', async () => {
    const engine = new DefaultContextEngine();
    const messages = [
      { role: 'user' as const, content: '你好', timestamp: Date.now() },
    ];

    const output = await engine.assemble({
      sessionId: 'test',
      messages,
      systemPrompt: '你是一个助手',
      tools: [],
      tokenBudget: 100000,
    });

    expect(output.messages.length).toBeGreaterThan(0);
    expect(output.messages[0].role).toBe('system');
    expect(output.messages[0].content).toBe('你是一个助手');
    expect(output.systemPrompt).toBe('你是一个助手');
  });

  it('应该处理工具调用消息', async () => {
    const engine = new DefaultContextEngine();
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

    const output = await engine.assemble({
      sessionId: 'test',
      messages,
      systemPrompt: 'test',
      tools: [],
      tokenBudget: 100000,
    });

    // 应该有 system + user + assistant(with tool_calls) + tool
    expect(output.messages.length).toBe(4);
    expect(output.messages[2].role).toBe('assistant');
    expect(output.messages[2].tool_calls).toBeDefined();
    expect(output.messages[3].role).toBe('tool');
  });
});

describe('Config Bridge — Supervisor 解析', () => {
  it('应该从配置创建 DefaultTaskSupervisor', async () => {
    const { resolveSupervisor } = await import('../src/harness/config-bridge.js');
    const providers = new Map<string, ModelProvider>();
    providers.set('mock', createMockModelProvider());

    const supervisor = resolveSupervisor({
      enabled: true,
      checkpointInterval: 10,
      enableLLMReview: false,
    }, providers);

    expect(supervisor).toBeDefined();
    expect(supervisor).toBeInstanceOf(DefaultTaskSupervisor);
  });

  it('enabled=false 应该返回 undefined', async () => {
    const { resolveSupervisor } = await import('../src/harness/config-bridge.js');
    const providers = new Map<string, ModelProvider>();

    const supervisor = resolveSupervisor({ enabled: false }, providers);

    expect(supervisor).toBeUndefined();
  });

  it('无配置应该返回 undefined', async () => {
    const { resolveSupervisor } = await import('../src/harness/config-bridge.js');
    const providers = new Map<string, ModelProvider>();

    const supervisor = resolveSupervisor(undefined, providers);

    expect(supervisor).toBeUndefined();
  });
});
