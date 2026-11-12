/**
 * Runner 观测专属事件出口（跨进程 Observer 桥）：
 * - 专属事件（emitObserved 且不进 execute 流 yield）→ observedEventSink
 * - loop adapted 事件（已 yield 进 execute 流）→ 不进 sink（防跨进程重复过线）
 */

import { describe, it, expect } from 'vitest';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';

function makeProvider(): ModelProvider {
  return {
    name: 'openai',
    defaultModel: 'gpt-5-mini',
    getModelInfo: () => null,
    getModelInfos: () => [],
    isAvailable: async () => true,
    chat: async () => ({ content: 'ok', model: 'gpt-5-mini', finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const, content: 'ok', finishReason: 'stop' as const };
    },
  };
}

function makeAgentStub(provider: ModelProvider) {
  return {
    context: { systemPrompt: 'sys', messages: [], tools: [] },
    contextSessionId: 'default',
    model: provider,
    config: { model: provider },
    tools: [] as unknown[],
    setSystemPrompt: () => {},
    setContextSessionId: () => {},
    setSessionCompactState: () => {},
    getSessionCompactState: () => undefined,
    toolsForSession: () => [],
    setOnAfterStep: () => {},
    notifyAfterStep: async () => {},
    harness: {},
    run: async function* () {
      // loop 事件（经 adaptLoopEvent → adapted → yield + emitObserved(streamed)）
      yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
    },
  } as unknown as Agent;
}

async function makeSession(store: InMemorySessionStore, id: string): Promise<void> {
  const session: SessionData = {
    id,
    agentId: 'a1',
    meta: {
      id,
      agentId: 'a1',
      channelId: 'web',
      peerId: 'ui',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    steps: [],
    metadata: {},
  };
  await store.save(id, session);
}

describe('Runner observedEventSink 分流', () => {
  it('streamed 事件（execute 流 yield 的）不进 sink；专属事件进 sink', async () => {
    const store = new InMemorySessionStore();
    await makeSession(store, 's1');
    const runner = new SessionAwareRunner(makeAgentStub(makeProvider()), {} as never, store);

    const sinkEvents: AgentEvent[] = [];
    runner.setObservedEventSink((e) => sinkEvents.push(e));

    const streamed: AgentEvent[] = [];
    for await (const ev of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: 'sys', agentId: 'a1', sessionId: 's1' },
      undefined,
    )) {
      streamed.push(ev);
    }

    // 流里至少有终态事件
    expect(streamed.length).toBeGreaterThan(0);
    // 分流不交集：sink 里不得出现任何 execute 流事件（同对象）
    for (const ev of streamed) {
      expect(sinkEvents).not.toContain(ev);
    }
    // 且流事件未以任何形式进 sink（同 timestamp+type 的重复也不允许）
    const streamedKeys = new Set(streamed.map((e) => `${e.type}:${e.timestamp}`));
    for (const ev of sinkEvents) {
      expect(streamedKeys.has(`${ev.type}:${ev.timestamp}`)).toBe(false);
    }
  });

  it('专属事件（recordAdmissionRefusal）进 sink 且不进 execute 流', async () => {
    const store = new InMemorySessionStore();
    await makeSession(store, 's2');
    const runner = new SessionAwareRunner(makeAgentStub(makeProvider()), {} as never, store);

    const sinkEvents: AgentEvent[] = [];
    runner.setObservedEventSink((e) => sinkEvents.push(e));

    runner.recordAdmissionRefusal('ops.policy.degraded', { reason: 'test' }, {
      agentId: 'a1',
      sessionId: 's2',
    });

    expect(sinkEvents).toHaveLength(1);
    expect(sinkEvents[0]!.type).toBe('ops.policy.degraded');
    expect(sinkEvents[0]!.sessionId).toBe('s2');

    // 专属事件不进 execute 流（handle 拉流为空或不含该事件）
    const streamed: AgentEvent[] = [];
    for await (const ev of runner.handle(
      's2',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: 'sys', agentId: 'a1', sessionId: 's2' },
      undefined,
    )) {
      streamed.push(ev);
    }
    expect(streamed.some((e) => e.type === 'ops.policy.degraded')).toBe(false);
  });

  it('未注入 sink 不影响 run（fail-open）', async () => {
    const store = new InMemorySessionStore();
    await makeSession(store, 's3');
    const runner = new SessionAwareRunner(makeAgentStub(makeProvider()), {} as never, store);

    const streamed: AgentEvent[] = [];
    for await (const ev of runner.handle(
      's3',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: 'sys', agentId: 'a1', sessionId: 's3' },
      undefined,
    )) {
      streamed.push(ev);
    }
    expect(streamed.length).toBeGreaterThan(0);
    // 抛错的 sink 也不得中断 run
    runner.setObservedEventSink(() => {
      throw new Error('sink boom');
    });
    await expect(
      (async () => {
        for await (const _ of runner.handle(
          's3',
          { role: 'user', content: 'again', timestamp: Date.now() },
          { systemPrompt: 'sys', agentId: 'a1', sessionId: 's3' },
          undefined,
        )) {
          // drain
        }
      })(),
    ).resolves.toBeUndefined();
  });
});
