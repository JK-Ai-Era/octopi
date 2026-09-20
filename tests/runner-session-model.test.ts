/**
 * Runner：session.metadata.model 进入 resolve；消息级覆盖优先
 */

import { describe, it, expect } from 'vitest';
import { SessionAwareRunner } from '../src/harness/runner.js';
import type { Agent } from '../src/harness/agent/index.js';
import type { ResolvedModel } from '../src/harness/model/types.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';
import { InMemorySessionStore } from '../src/integration/storage/memory.js';
import type { SessionData } from '../src/harness/session-types.js';

function makeProvider(name: string, model: string, contextWindow?: number): ModelProvider {
  return {
    name,
    defaultModel: model,
    models: [model],
    getModelInfo: (m: string) =>
      m === model && contextWindow != null ? { name: m, contextWindow } : null,
    getModelInfos: () =>
      contextWindow != null ? [{ name: model, contextWindow }] : [],
    isAvailable: async () => true,
    chat: async () => ({ content: 'ok', model, finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const, content: 'ok', finishReason: 'stop' as const };
    },
  };
}

function makeAgentStub(provider: ModelProvider) {
  const calls: Array<{
    model?: string;
    resolved?: ResolvedModel;
    runScopeSessionId?: string;
    contextMessages?: number;
  }> = [];
  const agent = {
    context: { systemPrompt: 'sys', messages: [], tools: [] },
    contextSessionId: 'default',
    model: provider,
    config: { model: provider },
    tools: [] as unknown[],
    setSystemPrompt: () => {},
    setContextSessionId: () => {},
    setSessionCompactState: () => {},
    getSessionCompactState: () => undefined,
    setOnAfterTurn: () => {},
    notifyAfterTurn: async () => {},
    harness: {},
    run: async function* (
      _s?: AbortSignal,
      _h?: unknown,
      opts?: {
        resolvedModel?: ResolvedModel;
        context?: { systemPrompt: string; messages: unknown[] };
        runScope?: { sessionId: string; agentId: string };
      },
    ) {
      calls.push({
        model: opts?.resolvedModel?.modelName,
        resolved: opts?.resolvedModel,
        runScopeSessionId: opts?.runScope?.sessionId,
        contextMessages: Array.isArray(opts?.context?.messages) ? opts.context.messages.length : -1,
      });
      yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
    },
  };
  return { agent: agent as unknown as Agent, calls: calls as Array<{ model?: string; resolved?: ResolvedModel; runScopeSessionId?: string; contextMessages?: number }> };
}

describe('SessionAwareRunner model resolve order', () => {
  it('session.metadata.model 优先进入 resolver（无消息级覆盖时）', async () => {
    const defaultProvider = makeProvider('openai', 'gpt-5-mini', 128000);
    const ollamaProvider = makeProvider('ollama', 'qwen3.5:2b');
    const { agent, calls } = makeAgentStub(defaultProvider);

    const store = new InMemorySessionStore();
    const session: SessionData = {
      id: 's1',
      agentId: 'a1',
      meta: {
        id: 's1', agentId: 'a1', channelId: 'web', peerId: 'ui',
        status: 'idle', createdAt: Date.now(), sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(), updatedAt: Date.now(),
      },
      messages: [],
      turns: [],
      metadata: { model: { provider: 'ollama', model: 'qwen3.5:2b' } },
    };
    await store.save('a1', 's1', session);

    const seenRefs: Array<string | undefined> = [];
    const runner = new SessionAwareRunner(agent, {} as never, store);
    runner.setModelResolver(({ modelRef }) => {
      seenRefs.push(modelRef);
      if (!modelRef) {
        return {
          ref: 'openai/gpt-5-mini',
          providerName: 'openai',
          modelName: 'gpt-5-mini',
          provider: defaultProvider,
          contextWindow: 128000,
          source: 'config',
          known: true,
          isOverride: false,
        };
      }
      return {
        ref: 'ollama/qwen3.5:2b',
        providerName: 'ollama',
        modelName: 'qwen3.5:2b',
        provider: ollamaProvider,
        // 未知窗口
        contextWindow: undefined,
        source: 'unknown',
        known: false,
        isOverride: true,
      };
    });

    for await (const _ of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: 'sys', agentId: 'a1', sessionId: 's1' },
      undefined,
    )) {
      // drain
    }

    expect(seenRefs[0]).toBe('ollama/qwen3.5:2b');
    expect(calls[0]?.resolved?.modelName).toBe('qwen3.5:2b');
    expect(calls[0]?.resolved?.contextWindow).toBeUndefined();
  });

  it('消息级 RunConfig.model 优先于 session.metadata.model', async () => {
    const defaultProvider = makeProvider('openai', 'gpt-5-mini', 128000);
    const { agent, calls } = makeAgentStub(defaultProvider);
    const store = new InMemorySessionStore();
    await store.save('a1', 's2', {
      id: 's2',
      agentId: 'a1',
      meta: {
        id: 's2', agentId: 'a1', channelId: 'web', peerId: 'ui',
        status: 'idle', createdAt: Date.now(), sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(), updatedAt: Date.now(),
      },
      messages: [],
      turns: [],
      metadata: { model: 'ollama/qwen3.5:2b' },
    });

    const seenRefs: Array<string | undefined> = [];
    const runner = new SessionAwareRunner(agent, {} as never, store);
    runner.setModelResolver(({ modelRef }) => {
      seenRefs.push(modelRef);
      return {
        ref: modelRef ?? 'openai/gpt-5-mini',
        providerName: 'openai',
        modelName: modelRef ?? 'gpt-5-mini',
        provider: defaultProvider,
        contextWindow: 128000,
        source: 'config',
        known: true,
        isOverride: Boolean(modelRef),
      };
    });

    for await (const _ of runner.handle(
      's2',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: 'sys', agentId: 'a1', sessionId: 's2', model: 'openai/gpt-5.5' },
      undefined,
    )) {
      // drain
    }

    expect(seenRefs[0]).toBe('openai/gpt-5.5');
    expect(calls[0]?.resolved?.modelName).toBe('openai/gpt-5.5');
  });
});
