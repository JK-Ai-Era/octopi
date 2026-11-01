/**
 * Builtin ModelInfo 表仍可查询，但 **引擎/Provider 不再自动合并** 用于 contextWindow 猜测
 */

import { describe, it, expect } from 'vitest';
import { getBuiltinModelInfo, mergeWithBuiltinInfo } from '@octopi-agent/engine/builtin-model-info.js';
import { createProviderFromConfig } from '@octopi-agent/engine/config.js';
import { OpenAIProvider } from '@octopi-agent/engine/integration/providers/openai.js';
import { resolveCatalogEntry } from '@octopi-agent/engine/harness/run/model/resolver.js';

describe('Builtin ModelInfo（仅数据表）', () => {
  it('returns info for known models', () => {
    const info = getBuiltinModelInfo('gpt-5.5');
    expect(info).not.toBeNull();
    expect(info!.contextWindow).toBe(256000);
  });

  it('strips ollama tag: qwen3.5:2b → qwen3.5', () => {
    const info = getBuiltinModelInfo('qwen3.5:2b');
    expect(info?.contextWindow).toBe(32768);
  });
});

describe('Provider 不自动合并 builtin contextWindow', () => {
  it('string-only models 无 ModelInfo（未知窗口）', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: ['gpt-4o'],
    });
    expect(provider.getModelInfo('gpt-4o')).toBeNull();
    expect(provider.getModelInfos()).toEqual([]);
  });

  it('用户显式配置的 ModelInfo 保留', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: [{ name: 'custom', contextWindow: 50000, maxOutputTokens: 4096 }],
    });
    const info = provider.getModelInfo('custom');
    expect(info?.contextWindow).toBe(50000);
  });

  it('能力声明（reasoning/input）随 ModelInfo 保留，不依赖窗口（v0.98.12 P0 回归锁）', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: [
        { name: 'with-window', contextWindow: 50000, reasoning: true, input: ['text', 'image'] },
        { name: 'only-capabilities', reasoning: true, input: ['text'] },
      ],
    });
    expect(provider.getModelInfo('with-window')).toMatchObject({
      contextWindow: 50000,
      reasoning: true,
      input: ['text', 'image'],
    });
    // 只有能力声明（无窗口）也要进 ModelInfo map
    expect(provider.getModelInfo('only-capabilities')).toMatchObject({
      reasoning: true,
      input: ['text'],
    });
  });

  it('未声明的能力不猜测（undefined，不回落 false/["text"]）', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: [{ name: 'custom', contextWindow: 50000 }],
    });
    expect(provider.getModelInfo('custom')?.reasoning).toBeUndefined();
    expect(provider.getModelInfo('custom')?.input).toBeUndefined();
  });
});

describe('mergeWithBuiltinInfo（可选工具，引擎 resolve 不用）', () => {
  it('仍可手工合并', () => {
    const merged = mergeWithBuiltinInfo('gpt-4o');
    expect(merged?.contextWindow).toBe(128000);
  });
});

describe('createProviderFromConfig → resolveCatalogEntry 端到端', () => {
  it('config 声明的 reasoning/input 到达目录条目', async () => {
    const provider = await createProviderFromConfig('p', {
      baseUrl: 'http://127.0.0.1:1',
      apiKey: '',
      api: 'openai-completions',
      models: [{ id: 'm', reasoning: true, input: ['text', 'video'] }],
    } as never);
    const entry = resolveCatalogEntry({
      providerName: 'p',
      modelName: 'm',
      providers: new Map([['p', provider]]),
    });
    expect(entry.reasoning).toBe(true);
    expect(entry.input).toEqual(['text', 'video']);
  });
});
