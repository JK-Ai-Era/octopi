/**
 * Builtin ModelInfo + getModelInfos 测试
 */

import { describe, it, expect } from 'vitest';
import { getBuiltinModelInfo, mergeWithBuiltinInfo } from '../src/builtin-model-info.js';
import { OpenAIProvider } from '../src/integration/providers/openai.js';
import { AnthropicProvider } from '../src/integration/providers/anthropic.js';

describe('Builtin ModelInfo', () => {
  it('returns info for known models', () => {
    const info = getBuiltinModelInfo('gpt-5.5');
    expect(info).not.toBeNull();
    expect(info!.contextWindow).toBe(256000);
    expect(info!.maxOutputTokens).toBe(32768);
  });

  it('returns null for unknown models', () => {
    expect(getBuiltinModelInfo('my-custom-model')).toBeNull();
  });

  it('covers major providers', () => {
    expect(getBuiltinModelInfo('claude-sonnet-4-6')).not.toBeNull();
    expect(getBuiltinModelInfo('gemini-2.5-pro')).not.toBeNull();
    expect(getBuiltinModelInfo('deepseek-chat')).not.toBeNull();
  });
});

describe('mergeWithBuiltinInfo', () => {
  it('returns builtin when no user config', () => {
    const merged = mergeWithBuiltinInfo('gpt-5.5');
    expect(merged).not.toBeNull();
    expect(merged!.contextWindow).toBe(256000);
  });

  it('user config overrides builtin', () => {
    const merged = mergeWithBuiltinInfo('gpt-5.5', {
      name: 'gpt-5.5',
      contextWindow: 500000, // user override
    });
    expect(merged!.contextWindow).toBe(500000); // user wins
    expect(merged!.maxOutputTokens).toBe(32768); // builtin fills in
  });

  it('returns null for unknown model with no user config', () => {
    expect(mergeWithBuiltinInfo('unknown-model')).toBeNull();
  });

  it('returns user config when model not in builtin', () => {
    const merged = mergeWithBuiltinInfo('custom', {
      name: 'custom',
      contextWindow: 10000,
    });
    expect(merged!.contextWindow).toBe(10000);
  });
});

describe('Provider getModelInfos', () => {
  it('OpenAI: returns all configured ModelInfo', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: [
        'gpt-5.5',
        { name: 'custom', contextWindow: 50000, maxOutputTokens: 4096 },
      ],
    });

    const infos = provider.getModelInfos();
    expect(infos.length).toBe(2);

    // gpt-5.5 gets builtin info
    const gpt5 = infos.find(i => i.name === 'gpt-5.5');
    expect(gpt5).toBeDefined();
    expect(gpt5!.contextWindow).toBe(256000);

    // custom gets user info
    const custom = infos.find(i => i.name === 'custom');
    expect(custom).toBeDefined();
    expect(custom!.contextWindow).toBe(50000);
  });

  it('Anthropic: string models get builtin info', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      models: ['claude-sonnet-4-6'],
    });

    const infos = provider.getModelInfos();
    expect(infos.length).toBe(1);
    expect(infos[0].contextWindow).toBe(200000);
    expect(infos[0].maxOutputTokens).toBe(16000);
  });

  it('OpenAI: string-only models still get builtin info via getModelInfo', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: ['gpt-4o'],
    });

    const info = provider.getModelInfo('gpt-4o');
    expect(info).not.toBeNull();
    expect(info!.contextWindow).toBe(128000);
  });

  it('empty models list returns empty array', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: [],
    });

    expect(provider.getModelInfos()).toEqual([]);
  });
});
