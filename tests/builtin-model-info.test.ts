/**
 * Builtin ModelInfo 表仍可查询，但 **引擎/Provider 不再自动合并** 用于 contextWindow 猜测
 */

import { describe, it, expect } from 'vitest';
import { getBuiltinModelInfo, mergeWithBuiltinInfo } from '../src/builtin-model-info.js';
import { OpenAIProvider } from '../src/integration/providers/openai.js';

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
});

describe('mergeWithBuiltinInfo（可选工具，引擎 resolve 不用）', () => {
  it('仍可手工合并', () => {
    const merged = mergeWithBuiltinInfo('gpt-4o');
    expect(merged?.contextWindow).toBe(128000);
  });
});
