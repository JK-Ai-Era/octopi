/**
 * FallbackProvider 测试
 *
 * 覆盖 chat / stream 的主链路成功、失败回退、全部失败三种场景。
 */

import { describe, test, expect, vi } from 'vitest';
import { FallbackProvider } from '../src/harness/reliability/fallback-provider.js';
import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '../src/core/interfaces/model-provider.js';
import type { ModelConfig, ModelInfo } from '../src/core/types/agent-definition.js';

function makeRequest(model?: string): LLMRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    model,
  };
}

function createProvider(
  name: string,
  overrides: Partial<ModelProvider> = {},
): ModelProvider {
  return {
    name,
    defaultModel: `${name}-default`,
    chat: async (_req: LLMRequest): Promise<LLMResponse> => ({
      content: `ok:${name}`,
      model: `${name}-default`,
      finishReason: 'stop',
    }),
    stream: async function* (_req: LLMRequest): AsyncGenerator<LLMStreamChunk> {
      yield { type: 'content', content: `stream:${name}` };
      yield { type: 'done' };
    },
    isAvailable: async () => true,
    getModelInfo: (modelName: string): ModelInfo | null => ({
      name: modelName,
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
    }),
    getModelInfos: (): ModelInfo[] => [],
    ...overrides,
  } as ModelProvider;
}

describe('FallbackProvider', () => {
  test('chat 优先使用主 provider', async () => {
    const main = createProvider('main');
    const fallback = createProvider('fallback');
    const provider = new FallbackProvider(
      main,
      'main-default',
      [{ provider: 'fallback', model: 'fallback-default' } as ModelConfig],
      new Map([['fallback', fallback]]),
    );

    const res = await provider.chat(makeRequest());

    expect(res.content).toBe('ok:main');
  });

  test('chat 主 provider 失败时回退到备选 provider', async () => {
    const main = createProvider('main', {
      chat: async () => {
        throw new Error('main down');
      },
    });
    const fallback = createProvider('fallback');
    const provider = new FallbackProvider(
      main,
      'main-default',
      [{ provider: 'fallback', model: 'fallback-default' } as ModelConfig],
      new Map([['fallback', fallback]]),
    );

    const res = await provider.chat(makeRequest());

    expect(res.content).toBe('ok:fallback');
  });

  test('chat 所有 provider 均失败时抛出最后一个错误', async () => {
    const main = createProvider('main', {
      chat: async () => {
        throw new Error('main down');
      },
    });
    const fallback = createProvider('fallback', {
      chat: async () => {
        throw new Error('fallback down');
      },
    });
    const provider = new FallbackProvider(
      main,
      'main-default',
      [{ provider: 'fallback', model: 'fallback-default' } as ModelConfig],
      new Map([['fallback', fallback]]),
    );

    await expect(provider.chat(makeRequest())).rejects.toThrow('fallback down');
  });

  test('stream 优先使用主 provider', async () => {
    const main = createProvider('main');
    const fallback = createProvider('fallback');
    const provider = new FallbackProvider(
      main,
      'main-default',
      [{ provider: 'fallback', model: 'fallback-default' } as ModelConfig],
      new Map([['fallback', fallback]]),
    );

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual(
      expect.objectContaining({ type: 'content', content: 'stream:main' }),
    );
  });

  test('stream 主 provider 在首个 chunk 前失败时回退到备选 provider', async () => {
    const main = createProvider('main', {
      stream: async function* () {
        throw new Error('main stream failed');
      },
    });
    const fallback = createProvider('fallback');
    const provider = new FallbackProvider(
      main,
      'main-default',
      [{ provider: 'fallback', model: 'fallback-default' } as ModelConfig],
      new Map([['fallback', fallback]]),
    );

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual(
      expect.objectContaining({ type: 'content', content: 'stream:fallback' }),
    );
  });

  test('stream 已产出首个 chunk 后主 provider 抛错时直接向上传播', async () => {
    const main = createProvider('main', {
      stream: async function* () {
        yield { type: 'content', content: 'partial' };
        throw new Error('mid-stream failure');
      },
    });
    const fallback = createProvider('fallback');
    const provider = new FallbackProvider(
      main,
      'main-default',
      [{ provider: 'fallback', model: 'fallback-default' } as ModelConfig],
      new Map([['fallback', fallback]]),
    );

    const collected: LLMStreamChunk[] = [];
    await expect(async () => {
      for await (const chunk of provider.stream(makeRequest())) {
        collected.push(chunk);
      }
    }).rejects.toThrow('mid-stream failure');

    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(
      expect.objectContaining({ type: 'content', content: 'partial' }),
    );
  });

  test('缺少 provider 配置时跳过该 fallback 并继续链路', async () => {
    const main = createProvider('main', {
      chat: async () => {
        throw new Error('main down');
      },
    });
    const last = createProvider('last');
    const provider = new FallbackProvider(
      main,
      'main-default',
      [
        { provider: 'missing', model: 'missing-model' } as ModelConfig,
        { provider: 'last', model: 'last-model' } as ModelConfig,
      ],
      new Map([['last', last]]),
    );

    const res = await provider.chat(makeRequest());

    expect(res.content).toBe('ok:last');
  });
});
