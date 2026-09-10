import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderPool } from '../../src/harness/concurrency/provider-pool.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk, ModelInfo } from '../../src/core/interfaces/model-provider.js';

function createProvider(name: string, opts: { failChat?: boolean; available?: boolean } = {}): ModelProvider & { setAvailable(value: boolean): void } {
  let available = opts.available ?? true;
  return {
    name,
    defaultModel: `${name}-model`,
    getModelInfo: (): ModelInfo | null => null,
    getModelInfos: (): ModelInfo[] => [],
    isAvailable: async () => available,
    chat: async (_req: LLMRequest): Promise<LLMResponse> => {
      if (!available || opts.failChat) {
        throw new Error(`${name} unavailable`);
      }
      return { content: `ok-${name}`, model: `${name}-model`, finishReason: 'stop' };
    },
    stream: async function* (_req: LLMRequest): AsyncGenerator<LLMStreamChunk> {
      if (!available || opts.failChat) {
        throw new Error(`${name} unavailable`);
      }
      yield { type: 'content', content: `ok-${name}` };
      yield { type: 'done' };
    },
    setAvailable(value: boolean) {
      available = value;
    },
  };
}

describe('ProviderPool 健康探活', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('连续失败后应触发探活并自动恢复健康状态', async () => {
    const provider = createProvider('key-1', { available: false });
    const pool = new ProviderPool(
      {
        slots: [{ provider: 'key-1' }],
        healthCheck: { intervalMs: 1_000, timeoutMs: 1_000 },
      },
      new Map([['key-1', provider]]),
    );

    for (let i = 0; i < 5; i++) {
      await pool.chat({ messages: [] }).catch(() => {});
    }

    expect(pool.getSlotMetrics()[0].healthy).toBe(false);

    provider.setAvailable(true);
    await vi.advanceTimersByTimeAsync(1_100);

    expect(pool.getSlotMetrics()[0].healthy).toBe(true);
    expect(pool.getHealthStats().lastRecoverAt).toBeGreaterThan(0);

    pool.destroy();
  });

  it('失败时也会触发一次即时探活', async () => {
    const provider = createProvider('key-1', { available: false });
    const pool = new ProviderPool(
      {
        slots: [{ provider: 'key-1' }],
        healthCheck: { intervalMs: 60_000, timeoutMs: 1_000 },
      },
      new Map([['key-1', provider]]),
    );

    for (let i = 0; i < 5; i++) {
      await pool.chat({ messages: [] }).catch(() => {});
    }
    await pool.runHealthCheck();

    expect(pool.getSlotMetrics()[0].healthy).toBe(false);

    provider.setAvailable(true);
    await pool.runHealthCheck();

    expect(pool.getSlotMetrics()[0].healthy).toBe(true);
    expect(pool.getHealthStats().lastRecoverAt).toBeGreaterThan(0);

    pool.destroy();
  });
});
