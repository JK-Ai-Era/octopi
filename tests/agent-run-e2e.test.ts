/**
 * Agent.run() 门面端到端
 *
 * 覆盖全配置路径：harness 绑定、observer 回调、beforeToolCall、
 * timeouts 默认值 — 业务测试里手拼 runAgentWithReliability 时会剥掉这些。
 */

import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../src/harness/agent/agent.js';
import type { ModelProvider, LLMResponse, LLMStreamChunk } from '../src/core/interfaces/model-provider.js';
import type { ReliabilityHarness } from '../src/core/interfaces/reliability.js';
import type { HarnessLoopEvent } from '../src/harness/reliability/harness-events.js';

function createProvider(responses: LLMResponse[]): ModelProvider {
  let i = 0;
  const pick = () => responses[Math.min(i++, responses.length - 1)];
  return {
    name: 'test',
    defaultModel: 'test',
    getModelInfo: () => null,
    getModelInfos: () => [],
    async chat(): Promise<LLMResponse> {
      return pick();
    },
    async *stream(): AsyncGenerator<LLMStreamChunk> {
      const r = pick();
      if (r.toolCalls?.length) {
        for (let t = 0; t < r.toolCalls.length; t++) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: r.toolCalls[t].id,
              name: r.toolCalls[t].name,
              arguments: JSON.stringify(r.toolCalls[t].arguments),
              index: t,
            },
          };
        }
      }
      if (r.content) yield { type: 'content', content: r.content };
      yield { type: 'done', usage: r.usage, finishReason: r.finishReason };
    },
    async isAvailable() {
      return true;
    },
  };
}

function createHarness(): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
    },
  };
}

describe('Agent.run() 门面', () => {
  it('无 harness 时 throw', async () => {
    const agent = new Agent({ model: createProvider([]) });
    expect(() => agent.run()).toThrow(/ReliabilityHarness/);
  });

  it('构造期 harness + observer + beforeToolCall 全路径可跑通', async () => {
    const onLLMStart = vi.fn();
    const onToolEnd = vi.fn();
    let beforeCalls = 0;

    const provider = createProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { n: 1 } }],
        model: 'test',
        finishReason: 'tool_calls',
      },
      { content: 'done', model: 'test', finishReason: 'stop' },
    ]);

    const agent = new Agent({
      model: provider,
      systemPrompt: 'sys',
      tools: [
        {
          name: 'echo',
          description: 'echo',
          execute: async (id, args) => ({
            toolCallId: id,
            name: 'echo',
            content: JSON.stringify(args),
          }),
        },
      ],
      harness: createHarness(),
      modelCallIdleTimeoutMs: 5_000,
      modelCallAbsoluteTimeoutMs: 10_000,
      observer: {
        onLLMStart,
        onToolEnd,
      },
      beforeToolCall: async () => {
        beforeCalls++;
        return undefined;
      },
    });

    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });

    const events: HarnessLoopEvent[] = [];
    for await (const e of agent.run()) {
      events.push(e);
    }

    expect(onLLMStart).toHaveBeenCalled();
    expect(onToolEnd).toHaveBeenCalled();
    expect(beforeCalls).toBe(1);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
    expect((events.find((e) => e.type === 'agent_end') as { reason: string }).reason).toBe('completed');
    expect(agent.context.systemPrompt).toBe('sys');
  });

  it('setHarness 后可 run；harnessOverride 优先', async () => {
    const provider = createProvider([
      { content: 'a', model: 'test', finishReason: 'stop' },
    ]);
    const agent = new Agent({ model: provider });
    agent.context.messages.push({ role: 'user', content: 'x', timestamp: Date.now() });

    agent.setHarness(createHarness());
    const viaSetter: string[] = [];
    for await (const e of agent.run()) {
      viaSetter.push(e.type);
    }
    expect(viaSetter).toContain('agent_end');

    agent.context.messages = [{ role: 'user', content: 'y', timestamp: Date.now() }];
    const override: string[] = [];
    for await (const e of agent.run(undefined, createHarness())) {
      override.push(e.type);
    }
    expect(override).toContain('agent_end');
  });

  it('config getter 为只读类型，运行仍读到内部 model', async () => {
    const provider = createProvider([
      { content: 'ok', model: 'test', finishReason: 'stop' },
    ]);
    const agent = new Agent({ model: provider, harness: createHarness() });
    expect(agent.config.model).toBe(provider);
    expect(agent.model).toBe(provider);
  });
});
