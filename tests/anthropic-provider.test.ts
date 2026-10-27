import { describe, test, expect } from 'vitest';
import { AnthropicProvider } from '@octopi-agent/engine/integration/providers/anthropic.js';
import { OpenAIProvider } from '@octopi-agent/engine/integration/providers/openai.js';

describe('AnthropicProvider', () => {
  test('基本属性', () => {
    const provider = new AnthropicProvider({
      name: 'anthropic',
      apiKey: 'test-key',
      models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
    });
    expect(provider.name).toBe('anthropic');
    expect(provider.models).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5']);
  });

  test('默认模型列表', () => {
    const p = new AnthropicProvider({ apiKey: 'key' });
    expect(p.name).toBe('anthropic');
    // 不配置 models 时不注入默认猜测列表
    expect(p.models).toEqual([]);
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

  test('toolResults 错误时设置 is_error 且 content 携带错误文案', () => {
    const p = new AnthropicProvider({ apiKey: 'key' });
    const converted = p['toAnthropicMessage']({
      role: 'tool',
      toolResults: [
        { toolCallId: 'c1', name: 'shell', result: null, error: 'command not found' },
        { toolCallId: 'c2', name: 'shell', result: 'ok' },
        // 空串 error 仍视为失败，与 Loop / ContextEngine 契约一致
        { toolCallId: 'c3', name: 'shell', result: null, error: '' },
      ],
    }) as { role: string; content: Array<Record<string, unknown>> };

    expect(converted.role).toBe('user');
    expect(converted.content).toHaveLength(3);
    expect(converted.content[0].type).toBe('tool_result');
    expect(converted.content[0].is_error).toBe(true);
    expect(String(converted.content[0].content)).toContain('command not found');
    expect(converted.content[1].is_error).toBe(false);
    expect(converted.content[1].content).toBe('ok');
    expect(converted.content[2].is_error).toBe(true);
    expect(String(converted.content[2].content)).toContain('error');
  });

  test('并行工具调用的多条 tool 消息聚合为单条 user 消息', () => {
    const p = new AnthropicProvider({ apiKey: 'key' });
    const body = p['toAnthropicRequest']({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'run two tools' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'file_read', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolResults: [{ toolCallId: 'c1', name: 'shell', result: 'r1' }] },
        { role: 'tool', toolResults: [{ toolCallId: 'c2', name: 'file_read', result: 'r2' }] },
      ],
    }) as { messages: Array<{ role: string; content: unknown }> };

    // user → assistant(tool_use ×2) → user(tool_result ×2)：连续 tool 消息不得拆成多条 user
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2].role).toBe('user');
    const blocks = body.messages[2].content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2']);
  });

  test('非 tool 的相邻 user 消息不被合并', () => {
    const p = new AnthropicProvider({ apiKey: 'key' });
    const body = p['toAnthropicRequest']({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
    }) as { messages: Array<{ role: string; content: unknown }> };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe('first');
    expect(body.messages[1].content).toBe('second');
  });

  test('模型级 temperature 在请求未指定时生效，请求级优先', () => {
    const p = new AnthropicProvider({
      apiKey: 'key',
      models: [{ name: 'kimi-k3.1-pro', temperature: 1 }],
    });
    const messages = [{ role: 'user' as const, content: 'hi' }];

    const fallback = p['toAnthropicRequest']({ model: 'kimi-k3.1-pro', messages }) as { temperature?: number };
    expect(fallback.temperature).toBe(1);

    const explicit = p['toAnthropicRequest']({ model: 'kimi-k3.1-pro', messages, temperature: 0 }) as { temperature?: number };
    expect(explicit.temperature).toBe(0);
  });

  test('未配置 temperature 时不发送该参数', () => {
    const p = new AnthropicProvider({ apiKey: 'key', models: ['claude-sonnet-4-6'] });
    const body = p['toAnthropicRequest']({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    }) as Record<string, unknown>;

    expect('temperature' in body).toBe(false);
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
