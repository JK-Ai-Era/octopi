import { describe, test, expect } from 'vitest';
import { AnthropicProvider } from '../src/integration/providers/anthropic.js';
import { OpenAIProvider } from '../src/integration/providers/openai.js';

describe('AnthropicProvider', () => {
  test('基本属性', () => {
    const provider = new AnthropicProvider({
      name: 'anthropic',
      apiKey: 'test-key',
      models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'],
    });
    expect(provider.name).toBe('anthropic');
    expect(provider.models).toEqual(['claude-sonnet-4-20250514', 'claude-haiku-4-20250414']);
  });

  test('默认模型列表', () => {
    const p = new AnthropicProvider({ apiKey: 'key' });
    expect(p.name).toBe('anthropic');
    expect(p.models.length).toBeGreaterThan(0);
    expect(p.models).toContain('claude-sonnet-4-20250514');
  });

  test('isAvailable 不可达时返回 false', async () => {
    const p = new AnthropicProvider({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:1',
    });
    const result = await p.isAvailable();
    expect(result).toBe(false);
  });

  test('自定义 baseUrl 去除末尾 /', () => {
    const p = new AnthropicProvider({
      apiKey: 'key',
      baseUrl: 'https://custom-proxy.example.com/',
    });
    expect(p['baseUrl']).toBe('https://custom-proxy.example.com');
  });

  test('自定义 version', () => {
    const p = new AnthropicProvider({
      apiKey: 'key',
      version: '2024-01-01',
    });
    expect(p['version']).toBe('2024-01-01');
  });
});

describe('Provider 协议差异对比', () => {
  test('OpenAI 和 Anthropic 的 provider name 不同', () => {
    const openai = new OpenAIProvider({ apiKey: 'key', models: ['gpt-4o'] });
    const anthropic = new AnthropicProvider({ apiKey: 'key', models: ['claude-sonnet-4-20250514'] });

    expect(openai.name).toBe('openai');
    expect(anthropic.name).toBe('anthropic');
  });

  test('两个 provider 都支持 chat 和 isAvailable', () => {
    const openai = new OpenAIProvider({ apiKey: 'key', models: ['gpt-4o'] });
    const anthropic = new AnthropicProvider({ apiKey: 'key', models: ['claude-sonnet-4-20250514'] });

    expect(typeof openai.chat).toBe('function');
    expect(typeof anthropic.chat).toBe('function');
    expect(typeof openai.isAvailable).toBe('function');
    expect(typeof anthropic.isAvailable).toBe('function');
  });

  test('两个 provider 都支持流式输出', () => {
    const openai = new OpenAIProvider({ apiKey: 'key', models: ['gpt-4o'] });
    const anthropic = new AnthropicProvider({ apiKey: 'key', models: ['claude-sonnet-4-20250514'] });

    expect(typeof openai.stream).toBe('function');
    expect(typeof anthropic.stream).toBe('function');
  });
});
