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

function createSequentialProvider(responses: LLMResponse[]): ModelProvider {
  let callIndex = 0;
  return {
    name: 'test', models: ['test'], defaultModel: 'test',
    getModelInfo: () => null, getModelInfos: () => [],
    async chat(request: LLMRequest): Promise<LLMResponse> {
      return responses[Math.min(callIndex++, responses.length - 1)];
    },
    async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
      const r = responses[Math.min(callIndex++, responses.length - 1)];
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
      // 工具执行后，模型返回空内容
      { content: '', toolCalls: undefined, usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200 }, model: 'test', finishReason: 'stop' },
    ]);

    const tools = new Map<string, RegisteredTool>();
    tools.set('shell', shellTool);
    const bus = new DefaultEventBus();
    const engine = new AgentEngine({
      model: provider, tools, executor: null as any, contextEngine: new DefaultContextEngine(),
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
      model: provider, tools, executor: null as any, contextEngine: new DefaultContextEngine(),
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
