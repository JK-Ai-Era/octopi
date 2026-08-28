/**
 * Provider 包装工具测试
 *
 * 验证 wrapProviderWithCircuitBreaker 保证接口完整性。
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { wrapProviderWithCircuitBreaker } from '../src/harness/reliability/provider-wrapper.js';
import { CircuitBreaker } from '../src/harness/reliability/circuit-breaker.js';
import type { ModelProvider, LLMRequest, LLMResponse } from '../src/core/interfaces/model-provider.js';
import type { ModelInfo } from '../src/core/types.js';

// ── Mock Provider ──

function createMockProvider(overrides?: Partial<ModelProvider>): ModelProvider {
  return {
    name: 'mock',
    chat: async (_req: LLMRequest): Promise<LLMResponse> => ({
      content: 'hello',
      finishReason: 'stop',
    }),
    stream: async function* (_req: LLMRequest) {
      yield { delta: 'hello', done: false };
      yield { delta: '', done: true, response: { content: 'hello', finishReason: 'stop' } };
    },
    getModelInfo: (name: string): ModelInfo | null => ({
      name,
      contextWindow: 128000,
      maxOutputTokens: 4096,
    }),
    getModelInfos: (): ModelInfo[] => [],
    ...overrides,
  } as ModelProvider;
}

// ── 测试 ──

describe('wrapProviderWithCircuitBreaker', () => {
  test('保留所有原始属性', () => {
    const provider = createMockProvider();
    const cb = new CircuitBreaker();
    const wrapped = wrapProviderWithCircuitBreaker(provider, cb);

    expect(wrapped.name).toBe('mock');
    expect(typeof wrapped.getModelInfo).toBe('function');
    expect(typeof wrapped.getModelInfos).toBe('function');
    expect(wrapped.getModelInfo('test')).toEqual({
      name: 'test',
      contextWindow: 128000,
      maxOutputTokens: 4096,
    });
    expect(wrapped.getModelInfos()).toEqual([]);
  });

  test('chat 被熔断器包装', async () => {
    const provider = createMockProvider();
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    const wrapped = wrapProviderWithCircuitBreaker(provider, cb);

    // 正常调用
    const result = await wrapped.chat!({ messages: [] });
    expect(result.content).toBe('hello');
    expect(cb.snapshot().state).toBe('closed');
  });

  test('chat 连续失败触发熔断', async () => {
    let failCount = 0;
    const provider = createMockProvider({
      chat: async () => { failCount++; throw new Error('fail'); },
    });
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    const wrapped = wrapProviderWithCircuitBreaker(provider, cb);

    // 第 1 次失败
    await expect(wrapped.chat!({ messages: [] })).rejects.toThrow('fail');
    expect(cb.snapshot().state).toBe('closed');

    // 第 2 次失败 → 熔断
    await expect(wrapped.chat!({ messages: [] })).rejects.toThrow('fail');
    expect(cb.snapshot().state).toBe('open');

    // 第 3 次调用 → 直接被熔断器拒绝
    await expect(wrapped.chat!({ messages: [] })).rejects.toThrow('Circuit breaker open');
  });

  test('stream 被熔断器包装', async () => {
    const provider = createMockProvider();
    const cb = new CircuitBreaker();
    const wrapped = wrapProviderWithCircuitBreaker(provider, cb);

    const chunks: string[] = [];
    for await (const chunk of wrapped.stream!({ messages: [] })) {
      if (chunk.delta) chunks.push(chunk.delta);
    }
    expect(chunks).toEqual(['hello']);
  });

  test('接口完整性：新增属性自动转发', () => {
    // 模拟未来 ModelProvider 新增方法
    const provider = createMockProvider({
      futureMethod: () => 'future',
    } as any);
    const cb = new CircuitBreaker();
    const wrapped = wrapProviderWithCircuitBreaker(provider, cb);

    // Proxy 自动转发，不需要修改包装器
    expect((wrapped as any).futureMethod()).toBe('future');
  });
});


