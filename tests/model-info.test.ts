/**
 * ModelInfo — 仅用户配置；不自动合并 builtin
 */

import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../src/integration/providers/openai.js';
import { AnthropicProvider } from '../src/integration/providers/anthropic.js';

describe('ModelInfo — 配置驱动', () => {
  it('OpenAI：用户配置的 ModelInfo 保留', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: [
        { name: 'gpt-5.5', contextWindow: 256000, maxOutputTokens: 32768 },
        { name: 'custom', contextWindow: 50000, maxOutputTokens: 4096 },
      ],
    });
    const info55 = provider.getModelInfo('gpt-5.5');
    expect(info55?.contextWindow).toBe(256000);
    expect(provider.getModelInfo('custom')?.contextWindow).toBe(50000);
  });

  it('OpenAI：纯字符串模型 → 无 ModelInfo（未知窗口）', () => {
    const provider = new OpenAIProvider({ apiKey: 'test', models: ['gpt-4o'] });
    expect(provider.getModelInfo('gpt-4o')).toBeNull();
    expect(provider.getModelInfos()).toEqual([]);
  });

  it('OpenAI：用户 ModelInfo 部分字段不自动补 builtin', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: [{ name: 'gpt-5.5', contextWindow: 500000 }],
    });
    const info = provider.getModelInfo('gpt-5.5');
    expect(info?.contextWindow).toBe(500000);
    expect(info?.maxOutputTokens).toBeUndefined();
  });

  it('Anthropic：纯字符串 → 无 ModelInfo', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      models: ['claude-sonnet-4-6'],
    });
    expect(provider.getModelInfo('claude-sonnet-4-6')).toBeNull();
  });

  it('未知模型返回 null', () => {
    const provider = new OpenAIProvider({ apiKey: 'test', models: [] });
    expect(provider.getModelInfo('my-custom-model')).toBeNull();
  });

  it('不配置 models 时列表为空（不注入默认猜测模型）', () => {
    const provider = new OpenAIProvider({ apiKey: 'test' });
    expect(provider.models.length).toBe(0);
  });
});
