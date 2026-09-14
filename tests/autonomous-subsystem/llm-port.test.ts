import { describe, it, expect, vi } from 'vitest';
import { createSubsystemLLMPort, DEP_LLM_PORT, DEP_SUBSYSTEM_PROMPT } from '../../src/harness/autonomous-subsystem/think/llm-port.js';
import { ModelResolver } from '../../src/harness/autonomous-subsystem/think/model-resolver.js';
import { SubsystemRuntime } from '../../src/harness/autonomous-subsystem/runtime.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import type { ModelProvider, LLMRequest, LLMResponse } from '../../src/core/interfaces/model-provider.js';
import type { SubsystemSpec, SubsystemLLMPort } from '../../src/harness/autonomous-subsystem/index.js';

function mockProvider(responses: Array<'ok' | 'error'> | 'ok'): ModelProvider & { chat: ReturnType<typeof vi.fn> } {
  let call = 0;
  const chat = vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
    const mode = Array.isArray(responses) ? (responses[call] ?? 'ok') : responses;
    call++;
    if (mode === 'error') {
      throw new Error('rate limit 429');
    }
    return {
      content: JSON.stringify({ modelUsed: req.model, system: req.messages[0]?.content }),
      model: req.model ?? 'x',
      finishReason: 'stop',
    };
  });
  return {
    name: 'mock',
    chat,
    stream: async function* () {},
    isAvailable: async () => true,
    getModelInfo: () => null,
    getModelInfos: () => [],
  } as never;
}

const resolver = new ModelResolver({
  levels: {
    mini: { primary: 'mock/gpt-mini', fallback: ['mock/gpt-mini-fallback'] },
    standard: { primary: 'mock/gpt-std' },
  },
  defaultProvider: 'mock',
});

describe('createSubsystemLLMPort', () => {
  it('injects cognitive prompt as system message by default', async () => {
    const provider = mockProvider('ok');
    const port = createSubsystemLLMPort({
      provider,
      modelResolver: resolver,
      modelRef: 'mini',
      cognitivePrompt: 'You are a memory extractor.',
    });

    await port.chat({ messages: [{ role: 'user', content: 'hello' }] });

    const req = provider.chat.mock.calls[0]![0] as LLMRequest;
    expect(req.model).toBe('gpt-mini');
    expect(req.messages[0]).toEqual({ role: 'system', content: 'You are a memory extractor.' });
    expect(req.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('allows overriding systemPrompt per call', async () => {
    const provider = mockProvider('ok');
    const port = createSubsystemLLMPort({
      provider,
      modelResolver: resolver,
      modelRef: 'mini',
      cognitivePrompt: 'default',
    });

    await port.chat({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'override',
    });

    const req = provider.chat.mock.calls[0]![0] as LLMRequest;
    expect(req.messages[0]?.content).toBe('override');
  });

  it('falls back to next model on rate limit', async () => {
    const provider = mockProvider(['error', 'ok']);
    const port = createSubsystemLLMPort({
      provider,
      modelResolver: resolver,
      modelRef: 'mini',
      cognitivePrompt: 'p',
    });

    const res = await port.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(res.model).toBe('gpt-mini-fallback');
  });

  it('resolves request.model override through ModelResolver (does not pin literal level name)', async () => {
    const provider = mockProvider(['error', 'ok']);
    const port = createSubsystemLLMPort({
      provider,
      modelResolver: resolver,
      modelRef: 'standard',
      cognitivePrompt: 'p',
    });

    // 调用方传级别名 mini → 应解析为 gpt-mini，失败后再 fallback
    const res = await port.chat({
      messages: [{ role: 'user', content: 'x' }],
      model: 'mini',
    });
    expect(provider.chat).toHaveBeenCalledTimes(2);
    const first = provider.chat.mock.calls[0]![0] as LLMRequest;
    const second = provider.chat.mock.calls[1]![0] as LLMRequest;
    expect(first.model).toBe('gpt-mini');
    expect(second.model).toBe('gpt-mini-fallback');
    expect(res.model).toBe('gpt-mini-fallback');
  });

  it('does not fallback on non-retryable finishReason=error', async () => {
    const chat = vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
      return {
        content: 'invalid api key',
        model: req.model ?? 'x',
        finishReason: 'error',
      };
    });
    const provider = {
      name: 'mock',
      chat,
      stream: async function* () {},
      isAvailable: async () => true,
      getModelInfo: () => null,
      getModelInfos: () => [],
    } as unknown as ModelProvider;

    const port = createSubsystemLLMPort({
      provider,
      modelResolver: resolver,
      modelRef: 'mini',
    });
    const res = await port.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(res.finishReason).toBe('error');
  });

  it('does not match overly broad error strings for fallback', async () => {
    const { shouldFallbackModel } = await import('../../src/harness/autonomous-subsystem/think/llm-port.js');
    expect(shouldFallbackModel(new Error('failed to generate certificate'))).toBe(false);
    expect(shouldFallbackModel(new Error('serverless invoke failed'))).toBe(false);
    expect(shouldFallbackModel(new Error('rate limit exceeded'))).toBe(true);
    expect(shouldFallbackModel(new Error('Request timed out'))).toBe(true);
    expect(shouldFallbackModel(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(shouldFallbackModel(new Error('ECONNRESET'))).toBe(true);
  });

  it('exposes resolved chain and default model', () => {
    const provider = mockProvider('ok');
    const port = createSubsystemLLMPort({
      provider,
      modelResolver: resolver,
      modelRef: 'mini',
    });
    expect(port.defaultModel).toBe('gpt-mini');
    expect(port.resolved.fallback[0]?.model).toBe('gpt-mini-fallback');
    expect(port.providerName).toBe('mock');
  });
});

describe('SubsystemRuntime injects llmPort and cognitive prompt', () => {
  function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
    return {
      id: 'inject-sub',
      name: 'Inject',
      description: 't',
      sense: { source: 'eventBus', filter: { events: ['t.fire'] }, isolation: 'structured' },
      think: {
        strategy: 'deterministic',
        implementation: 'code',
        systemPrompt: 'Cognitive from SUBSYSTEM.md',
        model: 'mini',
        handler: async (input, deps) => {
          (globalThis as Record<string, unknown>).__lastDeps = deps;
          return { signals: [{ action: 'no-op', reason: 'ok' }] };
        },
      },
      act: { mode: 'none' },
      signal: { severity: 'info', channel: ['event'] },
      boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
      tools: { mode: 'none' },
      session: { mode: 'ephemeral', scope: 'session' },
      ...overrides,
    };
  }

  it('code handler receives llmPort, prompt, and resolved models', async () => {
    const provider = mockProvider('ok');
    const events = new DefaultEventBus();
    const runtime = new SubsystemRuntime({
      deps: {
        model: provider,
        events,
        errorStrategy: {} as never,
        mainTools: new Map(),
        modelLevels: {
          mini: { primary: 'mock/gpt-mini', fallback: ['mock/gpt-mini-fallback'] },
        },
      },
    });

    runtime.register(makeSpec());
    await runtime.trigger('inject-sub');

    const deps = (globalThis as Record<string, unknown>).__lastDeps as Record<string, unknown>;
    expect(deps[DEP_SUBSYSTEM_PROMPT]).toBe('Cognitive from SUBSYSTEM.md');
    expect(deps['__resolved_model__']).toBe('gpt-mini');

    const port = deps[DEP_LLM_PORT] as SubsystemLLMPort;
    expect(port.cognitivePrompt).toBe('Cognitive from SUBSYSTEM.md');
    expect(port.defaultModel).toBe('gpt-mini');

    await port.chat({ messages: [{ role: 'user', content: 'from handler' }] });
    const req = provider.chat.mock.calls[0]![0] as LLMRequest;
    expect(req.messages[0]?.content).toBe('Cognitive from SUBSYSTEM.md');
    expect(req.model).toBe('gpt-mini');

    runtime.dispose();
  });

  it('injects llmPort even without runtimeInject block', async () => {
    const provider = mockProvider('ok');
    const events = new DefaultEventBus();
    const runtime = new SubsystemRuntime({
      deps: {
        model: provider,
        events,
        errorStrategy: {} as never,
        mainTools: new Map(),
      },
    });

    runtime.register(makeSpec());
    await runtime.trigger('inject-sub');
    const deps = (globalThis as Record<string, unknown>).__lastDeps as Record<string, unknown>;
    expect(deps[DEP_LLM_PORT]).toBeDefined();
    expect(deps[DEP_SUBSYSTEM_PROMPT]).toBeDefined();
    runtime.dispose();
  });
});
