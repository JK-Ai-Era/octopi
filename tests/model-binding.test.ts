/**
 * 模型绑定 + 能力查询（contextWindow 仅认配置）
 */

import { describe, it, expect } from 'vitest';
import {
  bindModelName,
  parseModelRef,
  bindModelRef,
  lookupDeclaredContextWindow,
  lookupModelCapability,
} from '../src/harness/reliability/model-binding.js';
import type { ModelProvider, LLMRequest } from '../src/core/interfaces/model-provider.js';

function makeProvider(name: string, defaultModel: string): ModelProvider & { lastRequest?: LLMRequest } {
  const provider = {
    name,
    defaultModel,
    lastRequest: undefined as LLMRequest | undefined,
    getModelInfo: (m: string) => (m === defaultModel ? { name: m, contextWindow: 128000 } : null),
    getModelInfos: () => [{ name: defaultModel, contextWindow: 128000 }],
    isAvailable: async () => true,
    chat: async (request: LLMRequest) => {
      provider.lastRequest = request;
      return {
        content: 'ok',
        model: request.model ?? defaultModel,
        finishReason: 'stop' as const,
      };
    },
    stream: async function* (request: LLMRequest) {
      provider.lastRequest = request;
      yield { type: 'done' as const, content: 'ok', finishReason: 'stop' as const };
    },
  };
  return provider as ModelProvider & { lastRequest?: LLMRequest };
}

describe('parseModelRef', () => {
  it('解析 provider/model', () => {
    expect(parseModelRef('openai/gpt-5.5')).toEqual({ provider: 'openai', model: 'gpt-5.5' });
  });

  it('裸模型名使用 defaultProvider', () => {
    expect(parseModelRef('gpt-5.5', 'openai')).toEqual({ provider: 'openai', model: 'gpt-5.5' });
  });
});

describe('bindModelName', () => {
  it('defaultModel 变为绑定名，chat 注入 request.model', async () => {
    const base = makeProvider('openai', 'gpt-5.5');
    const bound = bindModelName(base, 'gpt-5-mini');
    expect(bound.defaultModel).toBe('gpt-5-mini');
    await bound.chat({ messages: [], tools: [] });
    expect(base.lastRequest?.model).toBe('gpt-5-mini');
  });

  it('request.model 显式指定时不覆盖', async () => {
    const base = makeProvider('openai', 'gpt-5.5');
    const bound = bindModelName(base, 'gpt-5-mini');
    await bound.chat({ messages: [], tools: [], model: 'other-model' });
    expect(base.lastRequest?.model).toBe('other-model');
  });
});

describe('bindModelRef', () => {
  it('按 provider/model 绑定', async () => {
    const openai = makeProvider('openai', 'gpt-5.5');
    const providers = new Map([['openai', openai as ModelProvider]]);
    const bound = bindModelRef('openai/gpt-5-mini', providers);
    await bound!.chat({ messages: [], tools: [] });
    expect(openai.lastRequest?.model).toBe('gpt-5-mini');
  });

  it('provider 不存在时返回 null', () => {
    expect(bindModelRef('openai/gpt-5.5', new Map())).toBeNull();
  });
});

describe('lookupModelCapability — 不猜测', () => {
  const empty = { getModelInfo: () => null } as Pick<ModelProvider, 'getModelInfo'>;

  it('无配置 → unknown', () => {
    const cap = lookupModelCapability({ provider: empty, modelName: 'qwen3.5:2b' });
    expect(cap.contextWindow).toBeUndefined();
    expect(cap.known).toBe(false);
  });

  it('explicit 配置 → known', () => {
    const cap = lookupModelCapability({
      provider: empty,
      modelName: 'qwen3.5:2b',
      explicit: { contextWindow: 8192 },
    });
    expect(cap.contextWindow).toBe(8192);
    expect(cap.known).toBe(true);
    expect(cap.source).toBe('config');
  });

  it('lookupDeclaredContextWindow 未知返回 null', () => {
    expect(lookupDeclaredContextWindow(empty, 'nope')).toBeNull();
  });
});
