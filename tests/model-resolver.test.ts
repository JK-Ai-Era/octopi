/**
 * harness/model — contextWindow 仅认显式配置
 */

import { describe, it, expect } from 'vitest';
import {
  resolveModel,
  resolveModelRef,
  resolveCatalogEntry,
  lookupModelCapability,
} from '../src/harness/model/index.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';

function makeProvider(
  name: string,
  models: Record<string, { contextWindow?: number; maxOutputTokens?: number }>,
): ModelProvider {
  return {
    name,
    defaultModel: Object.keys(models)[0],
    getModelInfo: (m: string) => (models[m] ? { name: m, ...models[m] } : null),
    getModelInfos: () => Object.entries(models).map(([n, v]) => ({ name: n, ...v })),
    isAvailable: async () => true,
    chat: async (r) => ({ content: '', model: r.model ?? '', finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const };
    },
  };
}

const providers = new Map<string, ModelProvider>([
  ['openai', makeProvider('openai', { 'gpt-5.5': { contextWindow: 256000 } })],
  ['ollama', makeProvider('ollama', { 'qwen3.5:2b': {} })],
]);

describe('resolveModel — contextWindow 未知则 undefined', () => {
  it('provider 配置了窗口 → known', () => {
    const r = resolveModel({
      providerName: 'openai',
      modelName: 'gpt-5.5',
      providers,
      isOverride: false,
    })!;
    expect(r.contextWindow).toBe(256000);
    expect(r.known).toBe(true);
    expect(r.source).toBe('config');
  });

  it('未配置窗口 → undefined + unknown（不猜 32k/200k）', () => {
    const r = resolveModel({
      providerName: 'ollama',
      modelName: 'qwen3.5:2b',
      providers,
      isOverride: true,
    })!;
    expect(r.contextWindow).toBeUndefined();
    expect(r.known).toBe(false);
    expect(r.source).toBe('unknown');
  });

  it('会话覆盖不继承 agent explicit 窗口', () => {
    const r = resolveModel({
      providerName: 'ollama',
      modelName: 'qwen3.5:2b',
      providers,
      explicit: { contextWindow: 1000000 },
      isOverride: true,
    })!;
    expect(r.contextWindow).toBeUndefined();
    expect(r.known).toBe(false);
  });

  it('agent 默认可用 explicit 配置窗口', () => {
    const r = resolveModel({
      providerName: 'ollama',
      modelName: 'qwen3.5:2b',
      providers,
      explicit: { contextWindow: 8192 },
      isOverride: false,
    })!;
    expect(r.contextWindow).toBe(8192);
    expect(r.known).toBe(true);
    expect(r.source).toBe('config');
  });

  it('provider 不存在返回 null', () => {
    expect(resolveModel({ providerName: 'nope', modelName: 'x', providers })).toBeNull();
  });
});

describe('catalog 未知窗口为 null', () => {
  it('未配置 → contextWindow null', () => {
    const e = resolveCatalogEntry({
      providerName: 'ollama',
      modelName: 'qwen3.5:2b',
      providers,
    });
    expect(e.contextWindow).toBeNull();
    expect(e.known).toBe(false);
    expect(e.source).toBe('unknown');
  });

  it('已配置 → 有数值', () => {
    const e = resolveCatalogEntry({
      providerName: 'openai',
      modelName: 'gpt-5.5',
      providers,
    });
    expect(e.contextWindow).toBe(256000);
    expect(e.known).toBe(true);
  });
});

describe('lookupModelCapability', () => {
  it('不使用 builtin 猜测', () => {
    const cap = lookupModelCapability({
      provider: providers.get('ollama')!,
      modelName: 'qwen3.5:2b',
    });
    expect(cap.contextWindow).toBeUndefined();
    expect(cap.known).toBe(false);
  });
});
