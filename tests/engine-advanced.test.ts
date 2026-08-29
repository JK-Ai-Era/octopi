/**
 * Agent 高级功能测试
 *
 * 补充 core-engine.test.ts 未覆盖的场景：
 * - 流式 tool call 多工具并行
 * - 错误分类和重试策略
 * - 系统提示词传递
 * - Token 估算器
 * - 重试后恢复
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/loop/agent.js';
import { runAgentWithReliability } from '../src/harness/reliability/run-agent.js';
import type { ReliabilityHarness } from '../src/harness/reliability/run-agent.js';
import type { AgentLoopEvent } from '../src/loop/types.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../src/core/interfaces/model-provider.js';
import type { Message } from '../src/core/types.js';
import { estimateTokens, estimateTextTokens } from '../src/harness/context/core-token-estimator.js';

// ── Helper ──

function createSequentialProvider(responses: LLMResponse[]): ModelProvider {
  let callIndex = 0;
  return {
    name: 'test',
    defaultModel: 'test',
    getModelInfo: () => null,
    async chat(_request: LLMRequest): Promise<LLMResponse> {
      return responses[Math.min(callIndex++, responses.length - 1)];
    },
    async *stream(_request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
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

function createErrorProvider(error: Error, recoverWith?: LLMResponse): ModelProvider {
  let callCount = 0;
  return {
    name: 'test',
    defaultModel: 'test',
    getModelInfo: () => null,
    async chat(_request: LLMRequest): Promise<LLMResponse> {
      if (recoverWith && callCount > 0) return recoverWith;
      throw error;
    },
    async *stream(_request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
      callCount++;
      if (recoverWith && callCount > 1) {
        if (recoverWith.content) yield { type: 'content', content: recoverWith.content };
        yield { type: 'done', usage: recoverWith.usage };
        return;
      }
      throw error;
    },
    async isAvailable() { return true; },
  };
}

function createAgentTools() {
  return [
    {
      name: 'tool_a',
      description: 'Tool A',
      parameters: { type: 'object' as const, properties: { x: { type: 'number' } }, required: ['x'] },
      execute: async (_id: string, args: any) => ({
        toolCallId: 'call_1',
        name: 'tool_a',
        content: `A: ${args.x}`,
      }),
    },
    {
      name: 'tool_b',
      description: 'Tool B',
      parameters: { type: 'object' as const, properties: { y: { type: 'number' } }, required: ['y'] },
      execute: async (_id: string, args: any) => ({
        toolCallId: 'call_2',
        name: 'tool_b',
        content: `B: ${args.y}`,
      }),
    },
  ];
}

function createHarness(overrides?: Partial<import('../src/harness/reliability/run-agent.js').ReliabilityConfig>): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
      ...overrides,
    },
  };
}

async function collectEvents(agent: Agent, harness?: ReliabilityHarness): Promise<AgentLoopEvent[]> {
  const h = harness ?? createHarness();
  const events: AgentLoopEvent[] = [];
  for await (const e of runAgentWithReliability(agent.context, { model: agent.model }, h)) {
    events.push(e);
  }
  return events;
}

function createTestMessage(content: string): Message {
  return { role: 'user', content, timestamp: Date.now() };
}

// ── 测试 ──

describe('流式 tool call 多工具并行', () => {
  it('应该正确处理多个并行 tool call', async () => {
    const provider = createSequentialProvider([
      // 第一次：两个并行 tool call
      {
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'tool_a', arguments: { x: 1 } },
          { id: 'call_2', name: 'tool_b', arguments: { y: 2 } },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'test',
        finishReason: 'tool_calls',
      },
      // 第二次：正常回复
      {
        content: 'Both tools executed!',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const agent = new Agent({ model: provider, systemPrompt: 'test', tools: createAgentTools() });
    agent.context.messages = [createTestMessage('run both tools')];

    const events = await collectEvents(agent);

    // 应该有 tool 相关事件（通过 observer）
    // 在新架构中，工具事件通过 observer 回调，不在 loop 事件中
    // 但应该有 turn_end(hasToolCalls: true)
    const turnEndsWithTools = events.filter(e => e.type === 'turn_end' && (e as any).hasToolCalls);
    expect(turnEndsWithTools.length).toBeGreaterThanOrEqual(1);

    // 最终应该有正常回复
    const assistantMsgs = events.filter(e => e.type === 'assistant_message');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    expect((assistantMsgs[assistantMsgs.length - 1] as any).message.content).toBe('Both tools executed!');
  });

  it('应该正确合并流式 tool call 参数片段', async () => {
    // 流式返回：tool call 参数分多个 chunk
    let callCount = 0;
    const provider: ModelProvider = {
      name: 'test',
      defaultModel: 'test',
      getModelInfo: () => null,
      async chat(_request: LLMRequest): Promise<LLMResponse> {
        return { content: 'done', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 }, model: 'test', finishReason: 'stop' };
      },
      async *stream(_request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
        callCount++;
        if (callCount === 1) {
          // tool call 参数分片
          yield { type: 'tool_call', toolCall: { id: 'c1', name: 'tool_a', arguments: '{"x":', index: 0 } };
          yield { type: 'tool_call', toolCall: { id: 'c1', name: 'tool_a', arguments: '1}', index: 0 } };
          yield { type: 'done', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
        } else {
          yield { type: 'content', content: 'done' };
          yield { type: 'done', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
        }
      },
      async isAvailable() { return true; },
    };

    const agent = new Agent({ model: provider, systemPrompt: 'test', tools: createAgentTools() });
    agent.context.messages = [createTestMessage('test')];

    const events = await collectEvents(agent);

    // 应该有工具执行（参数被正确合并）
    const turnEndsWithTools = events.filter(e => e.type === 'turn_end' && (e as any).hasToolCalls);
    expect(turnEndsWithTools.length).toBe(1);
  });
});

describe('错误分类和重试', () => {
  it('应该在 LLM 调用失败时 yield agent_end(reason: error)', async () => {
    const provider = createErrorProvider(new Error('Rate limited'));

    const agent = new Agent({ model: provider, systemPrompt: 'test' });
    agent.context.messages = [createTestMessage('test')];

    const harness = createHarness();
    const events = await collectEvents(agent, harness);

    // 应该有 agent_end(reason: 'error')
    const agentEnd = events.find(e => e.type === 'agent_end');
    expect(agentEnd).toBeDefined();
    expect((agentEnd as any).reason).toBe('error');
  });

  it('应该在重试后成功', async () => {
    const recoverResponse: LLMResponse = {
      content: 'Recovered!',
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      model: 'test',
      finishReason: 'stop',
    };
    const provider = createErrorProvider(new Error('Timeout'), recoverResponse);

    const agent = new Agent({ model: provider, systemPrompt: 'test' });
    agent.context.messages = [createTestMessage('test')];

    // 配置 onError 返回 'retry'
    const harness: ReliabilityHarness = {
      config: {
        planningRetry: { maxAttempts: 0, steerInstruction: '' },
        emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
        noopThreshold: 3,
        loopDetection: { enabled: false },
      },
    };

    // 使用自定义 onError 实现重试
    const events: AgentLoopEvent[] = [];
    for await (const e of runAgentWithReliability(
      agent.context,
      {
        model: agent.model,
        onError: async () => 'retry',
      },
      harness,
    )) {
      events.push(e);
    }

    // 应该最终成功
    const assistantMsgs = events.filter(e => e.type === 'assistant_message');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    expect((assistantMsgs[0] as any).message.content).toBe('Recovered!');
  });
});

describe('系统提示词传递', () => {
  it('应该将 systemPrompt 传递给 Agent', async () => {
    const provider = createSequentialProvider([
      {
        content: 'Hello!',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const agent = new Agent({ model: provider, systemPrompt: 'You are a helpful assistant' });
    agent.context.messages = [createTestMessage('test')];

    const events = await collectEvents(agent);

    // 应该有正常回复
    const assistantMsgs = events.filter(e => e.type === 'assistant_message');
    expect(assistantMsgs.length).toBe(1);

    // Agent 的 context 应该包含 system prompt
    expect(agent.context.systemPrompt).toBe('You are a helpful assistant');
  });
});

describe('Token 估算器', () => {
  it('应该正确估算中文文本', () => {
    const tokens = estimateTextTokens('你好世界');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it('应该正确估算英文文本', () => {
    const tokens = estimateTextTokens('Hello world, this is a test');
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
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('引擎异常退出事件', () => {
  it('应该在中止时 yield agent_end(reason: aborted)', async () => {
    const provider = createSequentialProvider([
      {
        content: 'Thinking...',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const agent = new Agent({ model: provider, systemPrompt: 'test' });
    agent.context.messages = [createTestMessage('test')];

    const abortController = new AbortController();
    // 立即中止
    abortController.abort();

    const events: AgentLoopEvent[] = [];
    for await (const e of runAgentWithReliability(
      agent.context,
      { model: agent.model },
      createHarness(),
      abortController.signal,
    )) {
      events.push(e);
    }

    // 应该有 agent_end(reason: 'aborted')
    const agentEnd = events.find(e => e.type === 'agent_end');
    expect(agentEnd).toBeDefined();
    expect((agentEnd as any).reason).toBe('aborted');
  });
});
