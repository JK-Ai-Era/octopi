/**
 * 精确复现用户 bug：工具执行后模型返回空内容
 *
 * 用户场景：
 * 1. 第一轮正常完成
 * 2. 第二轮：模型返回 tool_calls（无文本）→ 工具执行 → 模型返回空内容
 * 3. CLI 显示 "Empty response from model"
 *
 * 测试目标：验证引擎在模型返回空内容时的行为
 */

import { describe, it, expect } from 'vitest';
import { AgentEngine } from '../src/core/engine.js';
import type { RunConfig } from '../src/core/engine.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../src/core/interfaces/model-provider.js';
import type { AgentEvent } from '../src/core/event-bus.js';
import type { Message, RegisteredTool } from '../src/core/types.js';
import { DefaultEventBus } from '../src/core/event-bus.js';
import { DefaultSecurityGuard } from '../src/core/security-guard.js';
import { IterationBudget } from '../src/core/budget.js';
import { DefaultContextEngine } from '../src/harness/context/default-context-engine.js';

/**
 * 创建顺序 Provider。
 *
 * 注意：引擎在 stream 返回空内容且无 tool_calls 时会 fallback 到 chat()，
 * 因此 chat() 返回最近一次 stream 的响应（不额外推进计数器）。
 */
function createSequentialProvider(responses: LLMResponse[]): ModelProvider {
  let callIndex = 0;
  let lastStreamResponse: LLMResponse | null = null;
  return {
    name: 'test', models: ['test'], defaultModel: 'test',
    getModelInfo: () => null, getModelInfos: () => [],
    async chat(_request: LLMRequest): Promise<LLMResponse> {
      // stream fallback 到 chat 时，返回最近一次 stream 的响应
      if (lastStreamResponse) return lastStreamResponse;
      return responses[Math.min(callIndex++, responses.length - 1)];
    },
    async *stream(_request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
      const r = responses[Math.min(callIndex++, responses.length - 1)];
      lastStreamResponse = r;
      if (r.toolCalls?.length) {
        for (let i = 0; i < r.toolCalls.length; i++) {
          yield { type: 'tool_call', toolCall: { id: r.toolCalls[i].id, name: r.toolCalls[i].name, arguments: JSON.stringify(r.toolCalls[i].arguments), index: i } };
        }
      }
      if (r.content) yield { type: 'content', content: r.content };
      yield { type: 'done', usage: r.usage };
    },
    async isAvailable() { return true; },
  };
}

const errorStrategy = {
  onModelError: () => ({ action: 'abort' as const, reason: 'test' }),
  onToolError: () => ({ action: 'skip' as const, reason: 'test' }),
  onContextOverflow: () => ({ action: 'compact' as const }),
  onSecurityViolation: () => ({ action: 'block' as const, reason: 'test' }),
};

const shellTool: RegisteredTool = {
  definition: { name: 'shell', description: 'Run command', parameters: { command: { type: 'string', description: 'cmd', required: true } } },
  handler: async (args) => `output of: ${args.command}`,
};

const mockExecutor = {
  async execute(call: any, _ctx: any) {
    const handler = shellTool.handler;
    return handler(call.arguments);
  },
};

async function collectEvents(engine: AgentEngine, messages: Message[], config: RunConfig): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of engine.run(messages, config)) events.push(e);
  return events;
}

describe('Engine: empty response after tool execution', () => {
  it('should yield turn.end with empty content when model returns empty after tools', async () => {
    const provider = createSequentialProvider([
      // 模型返回 tool_call（无文本）
      { content: '', toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'ls' } }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 }, model: 'test', finishReason: 'tool_calls' },
      // 工具执行后，模型返回空内容（stream 空 + fallback chat 空 → 触发空响应重试 → 但 maxAttempts=0 所以不重试）
      { content: '', toolCalls: undefined, usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200 }, model: 'test', finishReason: 'stop' },
    ]);

    const tools = new Map<string, RegisteredTool>();
    tools.set('shell', shellTool);
    const bus = new DefaultEventBus();
    const engine = new AgentEngine({
      model: provider, tools, executor: mockExecutor, contextEngine: new DefaultContextEngine(),
      events: bus, security: new DefaultSecurityGuard(), budget: new IterationBudget(bus), errorStrategy,
    });

    const events = await collectEvents(engine, [{ role: 'user', content: 'test', timestamp: Date.now() }], { agentId: 't', sessionId: 's', model: 'test', systemPrompt: 'sys' });

    const types = events.map(e => e.type);

    // 工具应该被执行
    expect(types).toContain('tool.exec.start');
    expect(types).toContain('tool.exec.end');

    // 应该有 turn.end（即使内容为空）
    expect(types).toContain('turn.end');

    const turnEnd = events.find(e => e.type === 'turn.end');
    expect(turnEnd?.data?.content).toBe('');

    // 不应该有 engine.error
    expect(types).not.toContain('engine.error');
  });

  it('should retry when model returns empty content (no tool_calls)', async () => {
    const provider = createSequentialProvider([
      // 第一次：空内容，无 tool_calls（stream 空 → fallback chat 也返回空）
      { content: '', toolCalls: undefined, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 }, model: 'test', finishReason: 'stop' },
      // 重试后：正常回复
      { content: 'Here is the summary.', toolCalls: undefined, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 }, model: 'test', finishReason: 'stop' },
    ]);

    const bus = new DefaultEventBus();
    const engine = new AgentEngine({
      model: provider, tools: new Map(), executor: mockExecutor, contextEngine: new DefaultContextEngine(),
      events: bus, security: new DefaultSecurityGuard(), budget: new IterationBudget(bus), errorStrategy,
      emptyResponseRetry: { maxAttempts: 2 },
    });

    const events = await collectEvents(engine, [{ role: 'user', content: 'test', timestamp: Date.now() }], { agentId: 't', sessionId: 's', model: 'test', systemPrompt: 'sys' });

    const types = events.map(e => e.type);

    // 应该触发空响应重试
    expect(types).toContain('empty_response_retry');

    // 最终应该有正常回复
    expect(types).toContain('turn.end');
    const turnEnd = events.find(e => e.type === 'turn.end');
    expect(turnEnd?.data?.content).toBe('Here is the summary.');
  });

  it('should stop retrying after maxAttempts for empty response', async () => {
    const provider = createSequentialProvider([
      // 三次空内容（stream + fallback chat 共享同一个响应，所以 3 个响应对象足够）
      { content: '', toolCalls: undefined, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 }, model: 'test', finishReason: 'stop' },
      { content: '', toolCalls: undefined, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 }, model: 'test', finishReason: 'stop' },
      { content: '', toolCalls: undefined, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 }, model: 'test', finishReason: 'stop' },
    ]);

    const bus = new DefaultEventBus();
    const engine = new AgentEngine({
      model: provider, tools: new Map(), executor: mockExecutor, contextEngine: new DefaultContextEngine(),
      events: bus, security: new DefaultSecurityGuard(), budget: new IterationBudget(bus), errorStrategy,
      emptyResponseRetry: { maxAttempts: 2 },
    });

    const events = await collectEvents(engine, [{ role: 'user', content: 'test', timestamp: Date.now() }], { agentId: 't', sessionId: 's', model: 'test', systemPrompt: 'sys' });

    const retryEvents = events.filter(e => e.type === 'empty_response_retry');

    // 最多重试 2 次
    expect(retryEvents.length).toBeLessThanOrEqual(2);

    // 最终仍然有 turn.end（即使内容为空）
    const types = events.map(e => e.type);
    expect(types).toContain('turn.end');
  });

  it('should retry empty response after tool calls', async () => {
    const provider = createSequentialProvider([
      // 模型返回 tool_call
      { content: '', toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'ls' } }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 }, model: 'test', finishReason: 'tool_calls' },
      // 工具执行后模型返回空内容（stream 空 → fallback chat 返回同一空响应）
      { content: '', toolCalls: undefined, usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200 }, model: 'test', finishReason: 'stop' },
      // 重试后正常回复
      { content: 'Analysis complete.', toolCalls: undefined, usage: { promptTokens: 200, completionTokens: 10, totalTokens: 210 }, model: 'test', finishReason: 'stop' },
    ]);

    const tools = new Map<string, RegisteredTool>();
    tools.set('shell', shellTool);
    const bus = new DefaultEventBus();
    const engine = new AgentEngine({
      model: provider, tools, executor: mockExecutor, contextEngine: new DefaultContextEngine(),
      events: bus, security: new DefaultSecurityGuard(), budget: new IterationBudget(bus), errorStrategy,
      emptyResponseRetry: { maxAttempts: 2 },
    });

    const events = await collectEvents(engine, [{ role: 'user', content: 'test', timestamp: Date.now() }], { agentId: 't', sessionId: 's', model: 'test', systemPrompt: 'sys' });

    const types = events.map(e => e.type);

    // 工具应该被执行
    expect(types).toContain('tool.exec.end');

    // 应该触发空响应重试
    expect(types).toContain('empty_response_retry');

    // 最终应该有正常回复
    expect(types).toContain('turn.end');
    const turnEnd = events.find(e => e.type === 'turn.end');
    expect(turnEnd?.data?.content).toBe('Analysis complete.');
  });

  it('should correctly pass tool results to second model call', async () => {
    // 这个测试验证：工具结果是否正确传递给第二次模型调用
    const capturedRequests: LLMRequest[] = [];
    let streamCallCount = 0;

    const provider: ModelProvider = {
      name: 'test', models: ['test'], defaultModel: 'test',
      getModelInfo: () => null, getModelInfos: () => [],
      async chat(request: LLMRequest): Promise<LLMResponse> {
        capturedRequests.push(request);
        return { content: 'done', usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 }, model: 'test', finishReason: 'stop' };
      },
      async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
        capturedRequests.push(request);
        streamCallCount++;
        if (streamCallCount === 1) {
          // 第一次调用：返回 tool_call
          yield { type: 'tool_call', toolCall: { id: 'c1', name: 'shell', arguments: '{"command":"ls"}', index: 0 } };
        } else {
          // 第二次调用：返回文本
          yield { type: 'content', content: 'done' };
        }
        yield { type: 'done', usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } };
      },
      async isAvailable() { return true; },
    };

    const tools = new Map<string, RegisteredTool>();
    tools.set('shell', shellTool);
    const bus = new DefaultEventBus();
    const engine = new AgentEngine({
      model: provider, tools, executor: mockExecutor, contextEngine: new DefaultContextEngine(),
      events: bus, security: new DefaultSecurityGuard(), budget: new IterationBudget(bus), errorStrategy,
    });

    await collectEvents(engine, [{ role: 'user', content: 'test', timestamp: Date.now() }], { agentId: 't', sessionId: 's', model: 'test', systemPrompt: 'sys' });

    // 应该有 2 次模型调用
    expect(capturedRequests.length).toBe(2);

    // 第二次调用的消息应该包含 tool result
    const secondCallMessages = capturedRequests[1].messages;
    const toolMessages = secondCallMessages.filter(m => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);

    // 工具结果应该有 tool_call_id
    const toolMsg = toolMessages[0];
    expect(toolMsg.tool_call_id).toBe('c1');

    // 第二次调用的消息应该包含 assistant 消息（带 tool_calls）
    const assistantWithTools = secondCallMessages.filter(m => m.role === 'assistant' && m.tool_calls?.length);
    expect(assistantWithTools.length).toBeGreaterThan(0);
  });
});

describe('Engine: tool-only steer (model keeps calling tools without responding)', () => {
  it('should inject steer after consecutive tool-only iterations', async () => {
    const provider = createSequentialProvider([
      // 3 轮纯 tool_calls
      { content: '', toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'ls' } }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 }, model: 'test', finishReason: 'tool_calls' },
      { content: '', toolCalls: [{ id: 'c2', name: 'shell', arguments: { command: 'pwd' } }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 }, model: 'test', finishReason: 'tool_calls' },
      { content: '', toolCalls: [{ id: 'c3', name: 'shell', arguments: { command: 'whoami' } }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 }, model: 'test', finishReason: 'tool_calls' },
      // steer 后模型终于回复文本
      { content: 'Here is my analysis.', toolCalls: undefined, usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 }, model: 'test', finishReason: 'stop' },
    ]);

    const tools = new Map<string, RegisteredTool>();
    tools.set('shell', shellTool);
    const bus = new DefaultEventBus();
    const engine = new AgentEngine({
      model: provider, tools, executor: mockExecutor, contextEngine: new DefaultContextEngine(),
      events: bus, security: new DefaultSecurityGuard(), budget: new IterationBudget(bus), errorStrategy,
      toolOnlyRetry: { threshold: 3 },
    });

    const events = await collectEvents(engine, [{ role: 'user', content: 'test', timestamp: Date.now() }], { agentId: 't', sessionId: 's', model: 'test', systemPrompt: 'sys' });

    const types = events.map(e => e.type);

    // 应该触发 tool_only_steer
    expect(types).toContain('tool_only_steer');

    // 应该有 3 次工具执行
    const toolStarts = events.filter(e => e.type === 'tool.exec.start');
    expect(toolStarts.length).toBe(3);

    // 最终应该有正常文本回复
    expect(types).toContain('turn.end');
    const turnEnd = events.find(e => e.type === 'turn.end');
    expect(turnEnd?.data?.content).toBe('Here is my analysis.');
  });

  it('should not inject steer if model responds before threshold', async () => {
    const provider = createSequentialProvider([
      // 2 轮 tool_calls（低于默认阈值 3）
      { content: '', toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'ls' } }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 }, model: 'test', finishReason: 'tool_calls' },
      { content: '', toolCalls: [{ id: 'c2', name: 'shell', arguments: { command: 'pwd' } }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 }, model: 'test', finishReason: 'tool_calls' },
      // 第 3 轮模型主动回复
      { content: 'Done.', toolCalls: undefined, usage: { promptTokens: 200, completionTokens: 5, totalTokens: 205 }, model: 'test', finishReason: 'stop' },
    ]);

    const tools = new Map<string, RegisteredTool>();
    tools.set('shell', shellTool);
    const bus = new DefaultEventBus();
    const engine = new AgentEngine({
      model: provider, tools, executor: mockExecutor, contextEngine: new DefaultContextEngine(),
      events: bus, security: new DefaultSecurityGuard(), budget: new IterationBudget(bus), errorStrategy,
    });

    const events = await collectEvents(engine, [{ role: 'user', content: 'test', timestamp: Date.now() }], { agentId: 't', sessionId: 's', model: 'test', systemPrompt: 'sys' });

    const types = events.map(e => e.type);

    // 不应该触发 tool_only_steer（模型在阈值前主动回复）
    expect(types).not.toContain('tool_only_steer');

    // 最终应该有正常文本回复
    expect(types).toContain('turn.end');
    const turnEnd = events.find(e => e.type === 'turn.end');
    expect(turnEnd?.data?.content).toBe('Done.');
  });
});
