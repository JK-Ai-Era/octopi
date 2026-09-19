/**
 * Agent.run configOverride — run 级模型覆盖不污染实例
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/harness/agent/index.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';
import type { ReliabilityHarness } from '../src/harness/reliability/run-agent.js';
import { bindModelName } from '../src/harness/reliability/model-binding.js';

function makeProvider(name: string, defaultModel: string) {
  return {
    name,
    defaultModel,
    getModelInfo: () => null,
    getModelInfos: () => [],
    isAvailable: async () => true,
    chat: async () => ({ content: '', model: defaultModel, finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const, finishReason: 'stop' as const };
    },
  } as ModelProvider;
}

describe('Agent.run configOverride', () => {
  it('override 仅作用于本次 run，实例 model 不变', async () => {
    const base = makeProvider('openai', 'gpt-5.5');
    const agent = new Agent({ model: base, systemPrompt: 'x' });

    // harness 占位：run 会立即要求 harness；这里只验证 config 快照语义
    const fakeHarness = {
      run: async function* () {
        yield { type: 'agent_end', reason: 'done', timestamp: Date.now() };
      },
    } as unknown as ReliabilityHarness;

    const override = bindModelName(base, 'gpt-5-mini');
    const gen = agent.run(undefined, fakeHarness, { model: override });
    // 消费 generator 使其启动
    for await (const _ev of gen) {
      // drain
    }

    expect(agent.model.defaultModel).toBe('gpt-5.5');
    expect(agent.config.model.defaultModel).toBe('gpt-5.5');
  });
});
