/**
 * ModelInfo 完整测试
 *
 * 覆盖：配置校验、Provider 行为、maxOutputTokens 生效、Engine fallback。
 */

import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '../src/integration/providers/openai.js';
import { AnthropicProvider } from '../src/integration/providers/anthropic.js';
import { loadConfig } from '../src/config.js';
import { Agent } from '../src/loop/agent.js';
import type { ModelProvider, LLMResponse } from '../src/core/interfaces/model-provider.js';
import type { RegisteredTool } from '../src/core/types.js';
import { DefaultEventBus } from '../src/core/primitives/event-bus.js';
import { DefaultSecurityGuard } from '../src/harness/security/default-security-guard.js';
import { IterationBudget } from '../src/harness/budget/budget.js';
import { DefaultContextEngine } from '../src/harness/context/default-context-engine.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Config Validation Tests ──

describe('Config Validation', () => {
  const tmpDir = join(tmpdir(), 'octopi-modelinfo-test-' + Date.now());

  function writeConfig(obj: unknown): string {
    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, 'octopi.json');
    writeFileSync(path, JSON.stringify(obj));
    return path;
  }

  const sampleModels = {
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test',
        api: 'openai-completions',
        models: [
          { id: 'gpt-5.5', name: 'gpt-5.5', contextWindow: 256000, maxTokens: 32768 },
          { id: 'gpt-5-mini', name: 'gpt-5-mini', contextWindow: 128000, maxTokens: 16384 },
        ],
      },
    },
  };

  it('valid config with ModelInfo passes', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: 'openai/gpt-5.5' }],
      models: sampleModels,
    });
    expect(() => loadConfig(path)).not.toThrow();
  });

  it('rejects negative contextWindow', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: 'openai/m' }],
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'test',
            api: 'openai-completions',
            models: [{ id: 'm', contextWindow: -100 }],
          },
        },
      },
    });
    expect(() => loadConfig(path)).toThrow();
  });

  it('rejects zero maxOutputTokens', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: 'openai/m' }],
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'test',
            api: 'openai-completions',
            models: [{ id: 'm', maxTokens: 0 }],
          },
        },
      },
    });
    expect(() => loadConfig(path)).toThrow('maxTokens');
  });

  it('rejects maxTokens > contextWindow (warning, not error)', () => {
    // 新 schema 不再校验 maxTokens > contextWindow，此场景现在是合法配置
    const path = writeConfig({
      agents: [{ id: 'a', model: 'openai/m' }],
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'test',
            api: 'openai-completions',
            models: [{ id: 'm', contextWindow: 1000, maxTokens: 2000 }],
          },
        },
      },
    });
    expect(() => loadConfig(path)).not.toThrow();
  });

  it('rejects model without id', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: 'openai/m' }],
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'test',
            api: 'openai-completions',
            models: [{ contextWindow: 1000 }],
          },
        },
      },
    });
    expect(() => loadConfig(path)).toThrow();
  });

  it('rejects invalid provider api type', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: 'bad/m' }],
      models: {
        providers: {
          bad: {
            baseUrl: 'https://api.example.com',
            apiKey: 'test',
            api: 'ollama' as any,
            models: [{ id: 'm' }],
          },
        },
      },
    });
    expect(() => loadConfig(path)).toThrow();
  });
});

// ── Provider maxOutputTokens Tests ──

describe('Provider maxOutputTokens enforcement', () => {
  it('OpenAI caps request.maxTokens by maxOutputTokens', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: [{ name: 'gpt-5-mini', contextWindow: 128000, maxOutputTokens: 16384 }],
    });

    // Intercept fetch to capture the request body
    let capturedBody: Record<string, unknown> = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'gpt-5-mini',
      }),
    } as any);

    try {
      await provider.chat({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gpt-5-mini',
        maxTokens: 50000, // exceeds 16384
      });

      capturedBody = (globalThis.fetch as any).mock.calls[0][1]?.body;
      if (typeof capturedBody === 'string') capturedBody = JSON.parse(capturedBody);

      // Should be capped to 16384
      expect(capturedBody.max_tokens).toBe(16384);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('OpenAI passes through maxTokens when under cap', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      models: [{ name: 'gpt-5-mini', contextWindow: 128000, maxOutputTokens: 16384 }],
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'gpt-5-mini',
      }),
    } as any);

    try {
      await provider.chat({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gpt-5-mini',
        maxTokens: 8000,
      });

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1]?.body);
      expect(body.max_tokens).toBe(8000);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Anthropic uses maxOutputTokens as default when request.maxTokens absent', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      models: [{ name: 'claude-sonnet-4-6', contextWindow: 200000, maxOutputTokens: 8192 }],
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-sonnet-4-6',
      }),
    } as any);

    try {
      await provider.chat({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'claude-sonnet-4-6',
      });

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1]?.body);
      // Should use maxOutputTokens (8192) instead of hardcoded 4096
      expect(body.max_tokens).toBe(8192);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Anthropic caps request.maxTokens by maxOutputTokens', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      models: [{ name: 'claude-sonnet-4-6', contextWindow: 200000, maxOutputTokens: 8192 }],
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-sonnet-4-6',
      }),
    } as any);

    try {
      await provider.chat({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'claude-sonnet-4-6',
        maxTokens: 20000,
      });

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1]?.body);
      expect(body.max_tokens).toBe(8192); // capped
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ── Agent model provider Tests ──

describe('Agent model provider', () => {
  function createMockProvider(defaultModel?: string): ModelProvider {
    return {
      name: 'mock',
      defaultModel,
      chat: vi.fn().mockResolvedValue({
        content: 'Hello', model: defaultModel ?? 'mock', finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      } as LLMResponse),
      stream: async function* () {
        yield { type: 'content' as const, content: 'Hello' };
        yield { type: 'done' as const, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: vi.fn().mockReturnValue({ name: defaultModel ?? 'mock', contextWindow: 128000 }),
    };
  }

  it('Agent stores the model provider directly', () => {
    const provider = createMockProvider('default-model');
    const agent = new Agent({ model: provider, systemPrompt: 'test' });

    expect(agent.model).toBe(provider);
    expect(agent.model.name).toBe('mock');
    expect(agent.model.defaultModel).toBe('default-model');
  });

  it('Agent model can be changed via setModel', () => {
    const provider1 = createMockProvider('model-1');
    const provider2 = createMockProvider('model-2');
    const agent = new Agent({ model: provider1, systemPrompt: 'test' });

    expect(agent.model.defaultModel).toBe('model-1');
    agent.setModel(provider2);
    expect(agent.model.defaultModel).toBe('model-2');
  });

  it('getModelInfo is accessible through agent.model', () => {
    const provider = createMockProvider('test-model');
    const agent = new Agent({ model: provider, systemPrompt: 'test' });

    const info = agent.model.getModelInfo('test-model');
    expect(info).toBeDefined();
    expect(provider.getModelInfo).toHaveBeenCalledWith('test-model');
  });
});
