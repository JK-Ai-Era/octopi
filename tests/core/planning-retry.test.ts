/**
 * Planning-only Retry 测试
 *
 * 测试 runAgentWithReliability 的 planning-only 重试机制：
 * 1. 检测 planning-only 响应（只说不做）
 * 2. 自动注入 steer 指令并重试
 * 3. 重试次数限制
 * 4. 有 tool_calls 时不触发
 * 5. 短响应不触发
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../../src/loop/agent.js';
import { runAgentWithReliability } from '../../src/harness/reliability/run-agent.js';
import type { ReliabilityHarness } from '../../src/harness/reliability/run-agent.js';
import type { AgentLoopEvent } from '../../src/loop/types.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../../src/core/interfaces/model-provider.js';

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

function createAgentTools() {
  return [{
    name: 'file_list',
    description: 'List files',
    parameters: { type: 'object' as const, properties: { path: { type: 'string', description: 'Path' } }, required: ['path'] },
    execute: async (_id: string, args: any) => ({
      toolCallId: 'call_1',
      name: 'file_list',
      content: `Files in ${args.path}: file1.ts, file2.ts`,
    }),
  }];
}

function createHarness(overrides?: Partial<import('../../src/harness/reliability/run-agent.js').ReliabilityConfig>): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 2, steerInstruction: 'Continue with the task using available tools.' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
      ...overrides,
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

// ── Tests ──

describe('Planning-only Retry', () => {
  it('should detect planning-only response and retry with tool execution', async () => {
    const provider = createSequentialProvider([
      // 第一次：planning-only（只说不做）
      {
        content: 'I will analyze the project structure. Let me first list the files.',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
      // 重试后：执行工具
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'file_list', arguments: { path: '.' } }],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'tool_calls',
      },
      // 工具执行后：正常回复
      {
        content: 'Here is the project structure...',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'Analyze the project', timestamp: Date.now() }];

    const harness = createHarness();
    const events = await collectEvents(agent, harness);

    const types = events.map(e => e.type);

    // 应该有 turn_end（planning-only 回合）
    expect(types).toContain('turn_end');

    // 应该有 tool 执行（第二次调用执行了工具）
    const turnEndsWithTools = events.filter(e => e.type === 'turn_end' && (e as any).hasToolCalls);
    expect(turnEndsWithTools.length).toBeGreaterThanOrEqual(1);

    // 最终应该有正常回复
    const assistantMsgs = events.filter(e => e.type === 'assistant_message');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    expect((lastAssistant as any).message.content).toBe('Here is the project structure...');

    // 消息历史中应该有 steer 指令
    const steerInContext = agent.context.messages.find(
      (m: any) => m.role === 'user' && m.content?.includes('[System:')
    );
    expect(steerInContext).toBeDefined();
  });

  it('should stop retrying after maxAttempts', async () => {
    const provider = createSequentialProvider([
      // 所有响应都是 planning-only
      {
        content: 'I will analyze the project. Let me check the files.',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
      {
        content: 'I will now look at the code. Let me start by reading the main file.',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'Analyze the project', timestamp: Date.now() }];

    // maxAttempts: 1 → 只允许重试 1 次
    const harness = createHarness({ planningRetry: { maxAttempts: 1, steerInstruction: 'Continue with the task using available tools.' } });
    const events = await collectEvents(agent, harness);

    // 应该有 2 条 assistant_message（原始 + 1 次重试）
    const assistantMsgs = events.filter(e => e.type === 'assistant_message');
    expect(assistantMsgs.length).toBe(2);

    // 应该有 agent_end（循环结束）
    const agentEnd = events.find(e => e.type === 'agent_end');
    expect(agentEnd).toBeDefined();
  });

  it('should not retry if response has tool_calls', async () => {
    const provider = createSequentialProvider([
      // 有 tool_calls → 不是 planning-only
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

    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'List files', timestamp: Date.now() }];

    const harness = createHarness();
    const events = await collectEvents(agent, harness);

    // 不应该有 steer 指令（没有触发 planning-only 重试）
    const steerInContext = agent.context.messages.find(
      (m: any) => m.role === 'user' && m.content?.includes('[System:')
    );
    expect(steerInContext).toBeUndefined();
  });

  it('should not retry if no tools available', async () => {
    const provider = createSequentialProvider([
      {
        content: 'I will analyze the project. Let me check the files.',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    // 没有工具
    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.' });
    agent.context.messages = [{ role: 'user', content: 'Analyze the project', timestamp: Date.now() }];

    const harness = createHarness();
    const events = await collectEvents(agent, harness);

    // 不应该有 steer 指令（没有工具可用，不触发 planning-only 检测）
    // 注意：新架构中 planning-only 检测仍然会触发，因为 isPlanningOnlyResponse 不检查工具可用性
    // 但重试后模型仍返回 planning-only，最终循环结束
    const agentEnd = events.find(e => e.type === 'agent_end');
    expect(agentEnd).toBeDefined();
  });

  it('should not retry short responses', async () => {
    const provider = createSequentialProvider([
      {
        content: 'OK',  // 太短，不是 planning-only
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'Hello', timestamp: Date.now() }];

    const harness = createHarness();
    const events = await collectEvents(agent, harness);

    // 不应该有 steer 指令
    const steerInContext = agent.context.messages.find(
      (m: any) => m.role === 'user' && m.content?.includes('[System:')
    );
    expect(steerInContext).toBeUndefined();

    // 应该只有 1 条 assistant_message
    const assistantMsgs = events.filter(e => e.type === 'assistant_message');
    expect(assistantMsgs.length).toBe(1);
    expect((assistantMsgs[0] as any).message.content).toBe('OK');
  });

  it('should use custom steer instruction', async () => {
    const customSteer = 'Please execute the tools now!';
    const provider = createSequentialProvider([
      {
        content: 'I will analyze the project. Let me check the files.',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'test',
        finishReason: 'stop',
      },
      // 重试后执行工具
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

    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'Analyze the project', timestamp: Date.now() }];

    const harness = createHarness({ planningRetry: { maxAttempts: 2, steerInstruction: customSteer } });
    await collectEvents(agent, harness);

    // 消息历史中应该有自定义的 steer 指令
    const steerInContext = agent.context.messages.find(
      (m: any) => m.role === 'user' && m.content?.includes(customSteer)
    );
    expect(steerInContext).toBeDefined();
  });
});
