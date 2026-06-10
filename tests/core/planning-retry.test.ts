/**
 * Planning-only Retry 测试
 *
 * 测试 AgentEngine 的 planning-only 重试机制：
 * 1. 检测 planning-only 响应
 * 2. 自动重试并附加 steer 指令
 * 3. 重试次数限制
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentEngine } from '../../src/core/engine.js';
import type { AgentEngineDeps, RunConfig, EngineEvent } from '../../src/core/engine.js';
import type { ModelProvider, LLMResponse } from '../../src/core/interfaces/model-provider.js';
import type { RegisteredTool } from '../../src/core/types.js';
import { DefaultEventBus } from '../../src/core/event-bus.js';
import { DefaultSecurityGuard } from '../../src/core/security-guard.js';
import { IterationBudget } from '../../src/core/budget.js';
import { DefaultContextEngine } from '../../src/harness/context/default-context-engine.js';

// ── Helper ──

function createMockModel(responses: LLMResponse[]): ModelProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    chat: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex % responses.length];
      callIndex++;
      return response;
    }),
    stream: vi.fn().mockImplementation(async function* () {
      const response = responses[callIndex % responses.length];
      callIndex++;

      // 模拟流式响应
      if (response.content) {
        yield { type: 'content', content: response.content };
      }
      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
              index: 0,
            },
          };
        }
      }
      yield { type: 'done', usage: response.usage };
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
    getModelInfo: () => null,
  };
}

function createMockTool(name: string): RegisteredTool {
  return {
    definition: {
      name,
      description: `Mock ${name} tool`,
      parameters: {
        path: { type: 'string', description: 'Path', required: true },
      },
    },
    handler: vi.fn().mockResolvedValue({ success: true }),
  };
}

async function collectEvents(engine: AgentEngine, messages: any[], config: RunConfig): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of engine.run(messages, config)) {
    events.push(event);
  }
  return events;
}

// ── Tests ──

describe('Planning-only Retry', () => {
  it('should detect planning-only response and retry', async () => {
    // 第一次响应：planning-only
    // 第二次响应：执行工具
    const mockModel = createMockModel([
      {
        content: 'I will analyze the project structure. Let me first list the files.',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'file_list', arguments: { path: '.' } }],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'tool_calls',
      },
      {
        content: 'Here is the project structure...',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const tool = createMockTool('file_list');
    const tools = new Map([['file_list', tool]]);

    const events = new DefaultEventBus();
    const security = new DefaultSecurityGuard(events);
    const budget = new IterationBudget(events, { maxIterations: 10 });
    const errorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort', reason: 'test' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    };
    const contextEngine = new DefaultContextEngine();
    const executor = { execute: vi.fn().mockResolvedValue('result') };

    const deps: AgentEngineDeps = {
      model: mockModel,
      tools,
      executor,
      contextEngine,
      events,
      security,
      budget,
      errorStrategy,
      planningRetry: { maxAttempts: 2 },
    };

    const engine = new AgentEngine(deps);
    const messages = [{ role: 'user' as const, content: 'Analyze the project', timestamp: Date.now() }];
    const config: RunConfig = { systemPrompt: 'You are helpful.' };

    const eventsList = await collectEvents(engine, messages, config);

    // 应该有 planning_only_retry 事件
    const retryEvents = eventsList.filter(e => e.type === 'planning_only_retry');
    expect(retryEvents.length).toBe(1);
    expect(retryEvents[0].data?.attempt).toBe(1);
    expect(retryEvents[0].data?.maxAttempts).toBe(2);

    // 消息历史中应该有 steer 指令
    const steerMessage = messages.find(m =>
      m.role === 'user' && m.content?.includes('[System:')
    );
    expect(steerMessage).toBeDefined();

    // 最终应该有 turn.end 事件
    const turnEndEvents = eventsList.filter(e => e.type === 'turn.end');
    expect(turnEndEvents.length).toBe(1);
  });

  it('should not retry if max attempts reached', async () => {
    // 所有响应都是 planning-only
    const mockModel = createMockModel([
      {
        content: 'I will analyze the project. Let me check the files.',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const tool = createMockTool('file_list');
    const tools = new Map([['file_list', tool]]);

    const events = new DefaultEventBus();
    const security = new DefaultSecurityGuard(events);
    const budget = new IterationBudget(events, { maxIterations: 10 });
    const errorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort', reason: 'test' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    };
    const contextEngine = new DefaultContextEngine();
    const executor = { execute: vi.fn().mockResolvedValue('result') };

    const deps: AgentEngineDeps = {
      model: mockModel,
      tools,
      executor,
      contextEngine,
      events,
      security,
      budget,
      errorStrategy,
      planningRetry: { maxAttempts: 1 }, // 只允许重试 1 次
    };

    const engine = new AgentEngine(deps);
    const messages = [{ role: 'user' as const, content: 'Analyze the project', timestamp: Date.now() }];
    const config: RunConfig = { systemPrompt: 'You are helpful.' };

    const eventsList = await collectEvents(engine, messages, config);

    // 应该有 1 次 planning_only_retry 事件
    const retryEvents = eventsList.filter(e => e.type === 'planning_only_retry');
    expect(retryEvents.length).toBe(1);

    // 最终应该有 turn.end 事件（不再重试）
    const turnEndEvents = eventsList.filter(e => e.type === 'turn.end');
    expect(turnEndEvents.length).toBe(1);
  });

  it('should not retry if response has tool_calls', async () => {
    const mockModel = createMockModel([
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'file_list', arguments: { path: '.' } }],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'tool_calls',
      },
      {
        content: 'Here is the project structure...',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const tool = createMockTool('file_list');
    const tools = new Map([['file_list', tool]]);

    const events = new DefaultEventBus();
    const security = new DefaultSecurityGuard(events);
    const budget = new IterationBudget(events, { maxIterations: 10 });
    const errorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort', reason: 'test' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    };
    const contextEngine = new DefaultContextEngine();
    const executor = { execute: vi.fn().mockResolvedValue('result') };

    const deps: AgentEngineDeps = {
      model: mockModel,
      tools,
      executor,
      contextEngine,
      events,
      security,
      budget,
      errorStrategy,
    };

    const engine = new AgentEngine(deps);
    const messages = [{ role: 'user' as const, content: 'List files', timestamp: Date.now() }];
    const config: RunConfig = { systemPrompt: 'You are helpful.' };

    const eventsList = await collectEvents(engine, messages, config);

    // 不应该有 planning_only_retry 事件
    const retryEvents = eventsList.filter(e => e.type === 'planning_only_retry');
    expect(retryEvents.length).toBe(0);
  });

  it('should not retry if no tools available', async () => {
    const mockModel = createMockModel([
      {
        content: 'I will analyze the project. Let me check the files.',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const tools = new Map<string, RegisteredTool>(); // 没有工具

    const events = new DefaultEventBus();
    const security = new DefaultSecurityGuard(events);
    const budget = new IterationBudget(events, { maxIterations: 10 });
    const errorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort', reason: 'test' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    };
    const contextEngine = new DefaultContextEngine();
    const executor = { execute: vi.fn().mockResolvedValue('result') };

    const deps: AgentEngineDeps = {
      model: mockModel,
      tools,
      executor,
      contextEngine,
      events,
      security,
      budget,
      errorStrategy,
    };

    const engine = new AgentEngine(deps);
    const messages = [{ role: 'user' as const, content: 'Analyze the project', timestamp: Date.now() }];
    const config: RunConfig = { systemPrompt: 'You are helpful.' };

    const eventsList = await collectEvents(engine, messages, config);

    // 不应该有 planning_only_retry 事件（没有工具可用）
    const retryEvents = eventsList.filter(e => e.type === 'planning_only_retry');
    expect(retryEvents.length).toBe(0);

    // 应该直接返回 turn.end
    const turnEndEvents = eventsList.filter(e => e.type === 'turn.end');
    expect(turnEndEvents.length).toBe(1);
  });

  it('should not retry short responses', async () => {
    const mockModel = createMockModel([
      {
        content: 'OK',  // 太短，不是 planning-only
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const tool = createMockTool('file_list');
    const tools = new Map([['file_list', tool]]);

    const events = new DefaultEventBus();
    const security = new DefaultSecurityGuard(events);
    const budget = new IterationBudget(events, { maxIterations: 10 });
    const errorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort', reason: 'test' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    };
    const contextEngine = new DefaultContextEngine();
    const executor = { execute: vi.fn().mockResolvedValue('result') };

    const deps: AgentEngineDeps = {
      model: mockModel,
      tools,
      executor,
      contextEngine,
      events,
      security,
      budget,
      errorStrategy,
    };

    const engine = new AgentEngine(deps);
    const messages = [{ role: 'user' as const, content: 'Hello', timestamp: Date.now() }];
    const config: RunConfig = { systemPrompt: 'You are helpful.' };

    const eventsList = await collectEvents(engine, messages, config);

    // 不应该有 planning_only_retry 事件
    const retryEvents = eventsList.filter(e => e.type === 'planning_only_retry');
    expect(retryEvents.length).toBe(0);
  });

  it('should use custom steer instruction', async () => {
    const customSteer = 'Please execute the tools now!';
    const mockModel = createMockModel([
      {
        content: 'I will analyze the project. Let me check the files.',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'file_list', arguments: { path: '.' } }],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'tool_calls',
      },
      {
        content: 'Here are the files...',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const tool = createMockTool('file_list');
    const tools = new Map([['file_list', tool]]);

    const events = new DefaultEventBus();
    const security = new DefaultSecurityGuard(events);
    const budget = new IterationBudget(events, { maxIterations: 10 });
    const errorStrategy = {
      onModelError: vi.fn().mockReturnValue({ action: 'abort', reason: 'test' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip', reason: 'test' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'block', reason: 'test' }),
    };
    const contextEngine = new DefaultContextEngine();
    const executor = { execute: vi.fn().mockResolvedValue('result') };

    const deps: AgentEngineDeps = {
      model: mockModel,
      tools,
      executor,
      contextEngine,
      events,
      security,
      budget,
      errorStrategy,
      planningRetry: {
        maxAttempts: 2,
        steerInstruction: customSteer,
      },
    };

    const engine = new AgentEngine(deps);
    const messages = [{ role: 'user' as const, content: 'Analyze the project', timestamp: Date.now() }];
    const config: RunConfig = { systemPrompt: 'You are helpful.' };

    await collectEvents(engine, messages, config);

    // 消息历史中应该有自定义的 steer 指令
    const steerMessage = messages.find(m =>
      m.role === 'user' && m.content?.includes(customSteer)
    );
    expect(steerMessage).toBeDefined();
  });
});
