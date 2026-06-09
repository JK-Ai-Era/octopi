/**
 * ModelInfo 完整测试
 *
 * 覆盖：配置校验、Provider 行为、maxOutputTokens 生效、Engine fallback。
 */

import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '../src/integration/providers/openai.js';
import { AnthropicProvider } from '../src/integration/providers/anthropic.js';
import { loadConfig } from '../src/config.js';
import { AgentEngine } from '../src/core/engine.js';
import type { AgentEngineDeps, RunConfig } from '../src/core/engine.js';
import type { ModelProvider, LLMResponse } from '../src/core/interfaces/model-provider.js';
import type { RegisteredTool } from '../src/core/types.js';
import { DefaultEventBus } from '../src/core/event-bus.js';
import { DefaultSecurityGuard } from '../src/core/security-guard.js';
import { IterationBudget } from '../src/core/budget.js';
import { DefaultContextPipeline } from '../src/harness/context/pipeline.js';
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

  it('valid config with ModelInfo passes', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: { provider: 'openai', model: 'gpt-5.5' } }],
      providers: [{
        type: 'openai', name: 'openai', apiKey: 'test',
        models: [
          'gpt-5.5',
          { name: 'gpt-5-mini', contextWindow: 128000, maxOutputTokens: 16384 },
        ],
      }],
    });
    expect(() => loadConfig(path)).not.toThrow();
  });

  it('rejects negative contextWindow', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: { provider: 'openai', model: 'm' } }],
      providers: [{
        type: 'openai', name: 'openai', apiKey: 'test',
        models: [{ name: 'm', contextWindow: -100 }],
      }],
    });
    expect(() => loadConfig(path)).toThrow('contextWindow must be a positive number');
  });

  it('rejects zero maxOutputTokens', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: { provider: 'openai', model: 'm' } }],
      providers: [{
        type: 'openai', name: 'openai', apiKey: 'test',
        models: [{ name: 'm', maxOutputTokens: 0 }],
      }],
    });
    expect(() => loadConfig(path)).toThrow('maxOutputTokens must be a positive number');
  });

  it('rejects maxOutputTokens > contextWindow', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: { provider: 'openai', model: 'm' } }],
      providers: [{
        type: 'openai', name: 'openai', apiKey: 'test',
        models: [{ name: 'm', contextWindow: 1000, maxOutputTokens: 2000 }],
      }],
    });
    expect(() => loadConfig(path)).toThrow('maxOutputTokens (2000) exceeds contextWindow (1000)');
  });

  it('rejects model without name', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: { provider: 'openai', model: 'm' } }],
      providers: [{
        type: 'openai', name: 'openai', apiKey: 'test',
        models: [{ contextWindow: 1000 }],
      }],
    });
    expect(() => loadConfig(path)).toThrow('model entry must have a name');
  });

  it('rejects invalid provider type', () => {
    const path = writeConfig({
      agents: [{ id: 'a', model: { provider: 'bad', model: 'm' } }],
      providers: [{ type: 'ollama' as any, name: 'bad', apiKey: 'test' }],
    });
    expect(() => loadConfig(path)).toThrow('type must be "openai" or "anthropic"');
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

// ── Engine defaultModel fallback Tests ──

describe('Engine defaultModel fallback', () => {
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

  it('uses config.model when set', async () => {
    const provider = createMockProvider('default-model');
    const deps: AgentEngineDeps = {
      model: provider,
      tools: new Map(),
      executor: { execute: vi.fn() },
      context: new DefaultContextPipeline(),
      events: new DefaultEventBus(),
      security: new DefaultSecurityGuard(new DefaultEventBus()),
      budget: new IterationBudget(new DefaultEventBus(), { maxIterations: 5 }),
      errorStrategy: {
        onModelError: () => ({ action: 'abort' as const, reason: 'test' }),
        onToolError: () => ({ action: 'skip' as const, reason: 'test' }),
        onContextOverflow: () => ({ action: 'compact' as const }),
        onSecurityViolation: () => ({ action: 'block' as const, reason: 'test' }),
      },
    };
    const engine = new AgentEngine(deps);
    const messages = [{ role: 'user' as const, content: 'hi', timestamp: Date.now() }];

    for await (const _ of engine.run(messages, { systemPrompt: 'test', model: 'custom-model' })) {
      // consume events
    }

    expect(provider.getModelInfo).toHaveBeenCalledWith('custom-model');
  });

  it('falls back to provider.defaultModel when config.model not set', async () => {
    const provider = createMockProvider('default-model');
    const deps: AgentEngineDeps = {
      model: provider,
      tools: new Map(),
      executor: { execute: vi.fn() },
      context: new DefaultContextPipeline(),
      events: new DefaultEventBus(),
      security: new DefaultSecurityGuard(new DefaultEventBus()),
      budget: new IterationBudget(new DefaultEventBus(), { maxIterations: 5 }),
      errorStrategy: {
        onModelError: () => ({ action: 'abort' as const, reason: 'test' }),
        onToolError: () => ({ action: 'skip' as const, reason: 'test' }),
        onContextOverflow: () => ({ action: 'compact' as const }),
        onSecurityViolation: () => ({ action: 'block' as const, reason: 'test' }),
      },
    };
    const engine = new AgentEngine(deps);
    const messages = [{ role: 'user' as const, content: 'hi', timestamp: Date.now() }];

    for await (const _ of engine.run(messages, { systemPrompt: 'test' })) {
      // consume events
    }

    expect(provider.getModelInfo).toHaveBeenCalledWith('default-model');
  });

  it('does not query getModelInfo when neither config.model nor defaultModel', async () => {
    const provider = createMockProvider(); // no defaultModel
    const deps: AgentEngineDeps = {
      model: provider,
      tools: new Map(),
      executor: { execute: vi.fn() },
      context: new DefaultContextPipeline(),
      events: new DefaultEventBus(),
      security: new DefaultSecurityGuard(new DefaultEventBus()),
      budget: new IterationBudget(new DefaultEventBus(), { maxIterations: 5 }),
      errorStrategy: {
        onModelError: () => ({ action: 'abort' as const, reason: 'test' }),
        onToolError: () => ({ action: 'skip' as const, reason: 'test' }),
        onContextOverflow: () => ({ action: 'compact' as const }),
        onSecurityViolation: () => ({ action: 'block' as const, reason: 'test' }),
      },
    };
    const engine = new AgentEngine(deps);
    const messages = [{ role: 'user' as const, content: 'hi', timestamp: Date.now() }];

    for await (const _ of engine.run(messages, { systemPrompt: 'test' })) {
      // consume events
    }

    // getModelInfo should NOT be called (modelName is undefined, so we skip the call)
    expect(provider.getModelInfo).not.toHaveBeenCalled();
  });
});
