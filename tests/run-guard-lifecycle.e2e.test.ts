/**
 * Guard 升级阶梯 — 走 runAgentWithReliability 全链路
 */

import { describe, it, expect } from 'vitest';
import { DefaultRunGuard } from '../src/harness/run-guard/default-run-guard.js';
import { runAgentWithReliability } from '../src/harness/reliability/run-agent.js';
import { IterationBudget } from '../src/harness/budget/budget.js';
import { DefaultEventBus } from '../src/core/primitives/event-bus.js';
import { Agent } from '../src/harness/agent/agent.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';
import type { ReliabilityHarness } from '../src/core/interfaces/reliability.js';

function failingToolModel(tokens = 50): ModelProvider {
  let n = 0;
  return {
    name: 'mock',
    chat: async () => ({
      content: '',
      model: 'mock',
      toolCalls: [{ id: `c${++n}`, name: 'fail_tool', arguments: {} }],
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: tokens },
    }),
    stream: async function* () {
      n++;
      yield {
        type: 'tool_call',
        toolCall: { id: `c${n}`, name: 'fail_tool', arguments: '{}', index: 0 },
      };
      yield {
        type: 'done',
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: tokens },
      };
    },
    isAvailable: async () => true,
    getModelInfo: () => null,
  };
}

describe('runAgentWithReliability + Guard 升级（真 e2e）', () => {
  it('连续失败工具触发 recover，最终 run_guard_stopped', async () => {
    const model = failingToolModel(40);
    const tools = [
      {
        name: 'fail_tool',
        description: 'always fails',
        parameters: { type: 'object' as const, properties: {} },
        execute: async (id: string) => ({
          toolCallId: id,
          name: 'fail_tool',
          content: 'err',
          isError: true,
        }),
      },
    ];
    const agent = new Agent({ model, systemPrompt: 't', tools });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });

    // 每 3 轮检查点；无 LLM 审查；soft 拉高以免干扰
    const guard = new DefaultRunGuard({
      enableLLMReview: false,
      checkpointInterval: 3,
      minCheckpointInterval: 3,
    });
    const budget = new IterationBudget(new DefaultEventBus(), {
      maxTokens: 1_000_000,
      softTokens: 1_000_000,
    });
    const harness: ReliabilityHarness = {
      config: { checkpointInterval: 3 },
      runGuard: guard,
      budget,
      sessionId: 'e2e',
      agentId: 'e2e',
    };

    const events: string[] = [];
    for await (const e of runAgentWithReliability(agent.context, { model }, harness)) {
      events.push(e.type);
      if (events.length > 80) break;
    }

    expect(events).toContain('run_guard_recovered');
    expect(events).toContain('run_guard_stopped');
    // stopped 应在 recovered 之后
    expect(events.indexOf('run_guard_stopped')).toBeGreaterThan(
      events.indexOf('run_guard_recovered'),
    );
  });
});
