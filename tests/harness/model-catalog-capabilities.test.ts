/**
 * models.providers[].models[].{reasoning,input} 能力投影 — config → ModelInfo → 目录条目
 *
 * 防回归背景：两键自声明以来仅被 WebUI 表单透传（防保存丢数据），
 * 服务端目录从不下发（类型在说谎）；v0.98.12 起经 ModelInfo 投影到
 * ModelCatalogEntry / ModelCatalogItem。
 */
import { describe, it, expect } from 'vitest';
import { resolveCatalogEntry } from '@octopi-agent/engine/harness/run/model/resolver.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';

function fakeProvider(info: {
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image' | 'audio' | 'video'>;
}): ModelProvider {
  return {
    name: 'p',
    defaultModel: 'm',
    getModelInfo: (modelName: string) => (modelName === 'm' ? { name: 'm', ...info } : null),
    getModelInfos: () => [{ name: 'm', ...info }],
    isAvailable: async () => true,
    chat: async () => {
      throw new Error('not used in this test');
    },
    stream: async function* () {
      throw new Error('not used in this test');
    },
  };
}

describe('model capability projection (reasoning/input)', () => {
  it('projects declared capabilities into catalog entries', () => {
    const e = resolveCatalogEntry({
      providerName: 'p',
      modelName: 'm',
      providers: new Map([
        ['p', fakeProvider({ contextWindow: 128000, reasoning: true, input: ['text', 'image'] })],
      ]),
    });
    expect(e.reasoning).toBe(true);
    expect(e.input).toEqual(['text', 'image']);
    expect(e.contextWindow).toBe(128000);
    expect(e.known).toBe(true);
  });

  it('undeclared capabilities are not guessed (undefined, not false)', () => {
    const e = resolveCatalogEntry({
      providerName: 'p',
      modelName: 'm',
      providers: new Map([['p', fakeProvider({ contextWindow: 64000 })]]),
    });
    expect(e.reasoning).toBeUndefined();
    expect(e.input).toBeUndefined();
  });

  it('capabilities survive even when contextWindow is unknown', () => {
    const e = resolveCatalogEntry({
      providerName: 'p',
      modelName: 'm',
      providers: new Map([['p', fakeProvider({ reasoning: false, input: ['text'] })]]),
    });
    expect(e.known).toBe(false);
    expect(e.reasoning).toBe(false);
    expect(e.input).toEqual(['text']);
  });
});
