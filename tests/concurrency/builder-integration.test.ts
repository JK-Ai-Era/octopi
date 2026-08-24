import { describe, it, expect } from 'vitest';
import { AgentBuilder } from '../../src/harness/builder.js';
import type { ModelProvider, LLMRequest, LLMResponse, ModelInfo } from '../../src/core/interfaces/model-provider.js';

function createMockProvider(name: string, defaultModel = 'mock-model'): ModelProvider {
  return {
    name,
    defaultModel,
    getModelInfo: (_model: string): ModelInfo | null => null,
    chat: async () => ({ content: `from ${name}`, model: defaultModel, finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'content' as const, content: `stream from ${name}` };
      yield { type: 'done' as const };
    },
  };
}

describe('Builder ProviderPool integration', () => {
  it('should build agent with single provider (no pool)', async () => {
    const provider = createMockProvider('single');
    const builder = new AgentBuilder()
      .model(provider)
      .systemPrompt('test');

    const { agent } = await builder.build();
    expect(agent.model.name).toBe('single');
  });

  it('should build agent with ProviderPool when concurrency configured', async () => {
    const p1 = createMockProvider('key-1');
    const p2 = createMockProvider('key-2');

    const builder = new AgentBuilder()
      .model(p1)
      .provider('key-1', p1)
      .provider('key-2', p2)
      .systemPrompt('test')
      .concurrency({
        providerPool: {
          slots: [
            { provider: 'key-1', weight: 2 },
            { provider: 'key-2', weight: 1 },
          ],
          routing: { strategy: 'round-robin' },
        },
      });

    const { agent } = await builder.build();

    // model 应该是 ProviderPool
    expect(agent.model.name).toBe('provider-pool');
    expect((agent.model as any).getSlotMetrics).toBeDefined();
    expect((agent.model as any).getSlotMetrics()).toHaveLength(2);
  });

  it('should use single provider when concurrency not configured', async () => {
    const p1 = createMockProvider('key-1');
    const p2 = createMockProvider('key-2');

    const builder = new AgentBuilder()
      .model(p1)
      .provider('key-1', p1)
      .provider('key-2', p2)
      .systemPrompt('test');

    const { agent } = await builder.build();

    // 没配 concurrency → 用原始 provider
    expect(agent.model.name).toBe('key-1');
  });

  it('should support providers() bulk registration', async () => {
    const p1 = createMockProvider('key-1');
    const p2 = createMockProvider('key-2');

    const providerMap = new Map<string, ModelProvider>();
    providerMap.set('key-1', p1);
    providerMap.set('key-2', p2);

    const builder = new AgentBuilder()
      .model(p1)
      .providers(providerMap)
      .systemPrompt('test')
      .concurrency({
        providerPool: {
          slots: [{ provider: 'key-1' }, { provider: 'key-2' }],
        },
      });

    const { agent } = await builder.build();
    expect(agent.model.name).toBe('provider-pool');
  });

  it('should pass global rateLimit config to ProviderPool', async () => {
    const p1 = createMockProvider('key-1');

    const builder = new AgentBuilder()
      .model(p1)
      .provider('key-1', p1)
      .systemPrompt('test')
      .concurrency({
        providerPool: {
          slots: [{ provider: 'key-1' }],
          rateLimit: { requestsPerMinute: 120, burstCapacity: 10 },
        },
      });

    const { agent } = await builder.build();
    const pool = agent.model as any;
    const metrics = pool.getSlotMetrics();
    expect(metrics[0].rateLimiter.availableTokens).toBe(10); // burstCapacity
  });
});
