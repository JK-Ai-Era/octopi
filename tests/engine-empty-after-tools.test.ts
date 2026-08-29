/**
 * 精确复现用户 bug：工具执行后模型返回空内容
 *
 * 用户场景：
 * 1. 第一轮正常完成
 * 2. 第二轮：模型返回 tool_calls（无文本）→ 工具执行 → 模型返回空内容
 * 3. CLI 显示 "Empty response from model"
 *
 * 测试目标：验证 runAgentWithReliability 在模型返回空内容时的行为
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/loop/agent.js';
import { runAgentWithReliability } from '../src/harness/reliability/run-agent.js';
import type { ReliabilityHarness } from '../src/harness/reliability/run-agent.js';
import type { AgentLoopEvent } from '../src/loop/types.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../src/core/interfaces/model-provider.js';
import type { Message, RegisteredTool } from '../src/core/types.js';

/**
 * 创建顺序 Provider。
 *
 * 注意：agentLoop 在 stream 返回空内容且无 tool_calls 时会 fallback 到 chat()，
 * 因此 chat() 返回最近一次 stream 的响应（不额外推进计数器）。
 */
function createSequentialProvider(responses: LLMResponse[]): ModelProvider {
  let callIndex = 0;
  let lastStreamResponse: LLMResponse | null = null;
  return {
    name: 'test', defaultModel: 'test',
    getModelInfo: () => null,
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

const shellTool: RegisteredTool = {
  definition: { name: 'shell', description: 'Run command', parameters: { command: { type: 'string', description: 'cmd', required: true } } },
  handler: async (args) => `output of: ${args.command}`,
};

function createAgentTools(): import('../src/loop/types.js').AgentTool[] {
  return [{
    name: 'shell',
    description: 'Run command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'cmd' } },
      required: ['command'],
    },
    execute: async (_toolCallId: string, args: unknown) => ({
      toolCallId: 'c1',
      name: 'shell',
      content: `output of: ${(args as any).command}`,
    }),
  }];
}

function createHarness(config?: Partial<import('../src/harness/reliability/run-agent.js').ReliabilityConfig>): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 2, steerInstruction: 'Please respond.' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
      ...config,
    },
  };
}

async function collectEvents(agent: Agent, harness: ReliabilityHarness): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const e of runAgentWithReliability(agent.context, { model: agent.model }, harness)) {
    events.push(e);
  }
  return events;
}

describe('Engine: empty response after tool execution', () => {
  it('should yield turn_end when model returns empty after tools', async () => {
    const provider = createSequentialProvider([
      // 模型返回 tool_call（无文本）
      { content: '', toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'ls' } }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 }, model: 'test', finishReason: 'tool_calls' },
      // 工具执行后，模型返回空内容
      { content: '', toolCalls: undefined, usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200 }, model: 'test', finishReason: 'stop' },
    ]);

    const agent = new Agent({ model: provider, systemPrompt: 'sys', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'test', timestamp: Date.now() }];

    // 使用 maxAttempts=0 禁用空响应重试，验证原始行为
    const harness = createHarness({ emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' } });
    const events = await collectEvents(agent, harness);

    const types = events.map(e => e.type);

    // 应该有 turn_end（即使内容为空）
    expect(types).toContain('turn_end');

    // turn_end 应该标记有工具调用
    const turnEnd = events.find(e => e.type === 'turn_end');
    expect((turnEnd as any).hasToolCalls).toBe(true);

    // 应该有 assistant_message
    const assistantMsg = events.find(e => e.type === 'assistant_message');
    expect(assistantMsg).toBeDefined();
  });

  it('should retry when model returns empty content (no tool_calls)', async () => {
    const provider = createSequentialProvider([
      // 第一次：空内容
      { content: '', toolCalls: undefined, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 }, model: 'test', finishReason: 'stop' },
      // 重试后：正常回复
      { content: 'Here is the summary.', toolCalls: undefined, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 }, model: 'test', finishReason: 'stop' },
    ]);

    const agent = new Agent({ model: provider, systemPrompt: 'sys' });
    agent.context.messages = [{ role: 'user', content: 'test', timestamp: Date.now() }];

    const harness = createHarness();
    const events = await collectEvents(agent, harness);

    // 最终应该有正常回复（assistant_message 事件）
    const assistantMsgs = events.filter(e => e.type === 'assistant_message');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    // 最后一条 assistant_message 应该包含重试后的回复
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    expect((lastAssistant as any).message.content).toBe('Here is the summary.');
  });

  it('should stop retrying after maxAttempts for empty response', async () => {
    const provider = createSequentialProvider([
      // 三次空内容
      { content: '', toolCalls: undefined, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 }, model: 'test', finishReason: 'stop' },
      { content: '', toolCalls: undefined, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 }, model: 'test', finishReason: 'stop' },
      { content: '', toolCalls: undefined, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 }, model: 'test', finishReason: 'stop' },
    ]);

    const agent = new Agent({ model: provider, systemPrompt: 'sys' });
    agent.context.messages = [{ role: 'user', content: 'test', timestamp: Date.now() }];

    const harness = createHarness();
    const events = await collectEvents(agent, harness);

    // 最终仍然有 turn_end
    const types = events.map(e => e.type);
    expect(types).toContain('turn_end');
  });

  it('should retry empty response after tool calls', async () => {
    const provider = createSequentialProvider([
      // 模型返回 tool_call
      { content: '', toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'ls' } }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 }, model: 'test', finishReason: 'tool_calls' },
      // 工具执行后模型返回空内容
      { content: '', toolCalls: undefined, usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200 }, model: 'test', finishReason: 'stop' },
      // 重试后正常回复
      { content: 'Analysis complete.', toolCalls: undefined, usage: { promptTokens: 200, completionTokens: 10, totalTokens: 210 }, model: 'test', finishReason: 'stop' },
    ]);

    const agent = new Agent({ model: provider, systemPrompt: 'sys', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'test', timestamp: Date.now() }];

    const harness = createHarness();
    const events = await collectEvents(agent, harness);

    const types = events.map(e => e.type);

    // 应该有 turn_end 且标记有工具调用
    const turnEnds = events.filter(e => e.type === 'turn_end');
    expect(turnEnds.some(e => (e as any).hasToolCalls)).toBe(true);

    // 最终应该有正常回复
    const assistantMsgs = events.filter(e => e.type === 'assistant_message');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    expect((lastAssistant as any).message.content).toBe('Analysis complete.');
  });

  it('should correctly pass tool results to second model call', async () => {
    // 这个测试验证：工具结果是否正确传递给第二次模型调用
    const capturedRequests: LLMRequest[] = [];
    let streamCallCount = 0;

    const provider: ModelProvider = {
      name: 'test', defaultModel: 'test',
      getModelInfo: () => null,
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

    const agent = new Agent({ model: provider, systemPrompt: 'sys', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'test', timestamp: Date.now() }];

    const harness = createHarness();
    await collectEvents(agent, harness);

    // 应该有 2 次模型调用
    expect(capturedRequests.length).toBe(2);

    // 第二次调用的消息应该包含 tool result
    const secondCallMessages = capturedRequests[1].messages;
    const toolMessages = secondCallMessages.filter((m: any) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);

    // 第二次调用的消息应该包含 assistant 消息（带 toolCalls）
    const assistantWithTools = secondCallMessages.filter((m: any) => m.role === 'assistant' && (m.toolCalls?.length || m.tool_calls?.length));
    expect(assistantWithTools.length).toBeGreaterThan(0);
  });
});
