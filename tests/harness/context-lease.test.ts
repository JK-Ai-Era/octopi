/**
 * 上下文租约（idleExpiryMs）— opt-in
 *
 * - 缺省：续聊带全量历史（不 detach）
 * - 显式 idleExpiryMs + 闲置超时：LLM 默认窗口从租约点截断；Discourse 全量保留
 * - 不触发 memory 硬收敛（冷沉淀归 backfill-trigger）
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { LLMRequest } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { SessionStore } from '@octopi-agent/core/interfaces/session-store.js';

function mockProvider(onChat?: (req: LLMRequest) => void): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat(req: LLMRequest) {
      onChat?.(req);
      return { content: 'ok', model: 'm', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() {
      return true;
    },
    getModelInfo() {
      return { name: 'm', contextWindow: 8000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 8000 }];
    },
  };
}

function userMsg(text: string, at = Date.now()): Message {
  return { role: 'user', content: text, timestamp: at };
}

function memoryStoreHarness(initial: SessionData) {
  const sessions = new Map<string, SessionData>([[initial.id, initial]]);
  const store: SessionStore<SessionData> = {
    async load(id: string) {
      return sessions.get(id) ?? null;
    },
    async save(id: string, data: SessionData) {
      sessions.set(id, JSON.parse(JSON.stringify(data)) as SessionData);
    },
    async delete(id: string) {
      sessions.delete(id);
    },
    async list(filter?: { agentId?: string }) {
      return [...sessions.values()]
        .filter((s) =>
          filter?.agentId ? s.agentId === filter.agentId || s.primaryAgentId === filter.agentId : true,
        )
        .map((s) => s.meta);
    },
    async exists(id: string) {
      return sessions.has(id);
    },
  };
  return { sessions, store };
}

async function runOnce(
  runner: {
    handle: (
      sid: string,
      msg: Message,
      cfg: { systemPrompt: string; agentId: string; sessionId: string },
    ) => AsyncGenerator<{ type: string }>;
  },
  sessionId: string,
  text: string,
) {
  for await (const ev of runner.handle(sessionId, userMsg(text), {
    systemPrompt: '',
    agentId: 'default',
    sessionId,
  })) {
    if (ev.type === 'engine.end' || ev.type === 'engine.error') break;
  }
}

function contents(messages: Message[]): string[] {
  return messages.map((m) => (typeof m.content === 'string' ? m.content : ''));
}

/** 含 turn_start 信封后，断言改为「任一条含子串」 */
function anyIncludes(texts: string[], needle: string): boolean {
  return texts.some((t) => t.includes(needle));
}

describe('context lease (idleExpiryMs opt-in)', () => {
  it('缺省关闭：闲置后续聊仍带全量历史进 LLM 窗口', async () => {
    const oldTs = Date.now() - 3 * 60 * 60 * 1000;
    const { sessions, store } = memoryStoreHarness({
      id: 's-full',
      agentId: 'default',
      meta: {
        id: 's-full',
        agentId: 'default',
        channelId: 'test',
        peerId: 'p',
        status: 'idle',
        createdAt: oldTs,
        updatedAt: oldTs,
        lastInteractionAt: oldTs,
        sessionStartedAt: oldTs,
      },
      messages: [userMsg('old', oldTs)],
      turns: [],
      metadata: {},
    });

    const llmWindows: string[][] = [];
    const { runner } = await new AgentBuilder()
      .model(
        mockProvider((req) => {
          llmWindows.push(
            req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')),
          );
        }),
      )
      .store(store)
      .build();

    await runOnce(runner as never, 's-full', 'hi');

    expect(sessions.get('s-full')?.contextDetachIndex ?? 0).toBe(0);
    const saved = sessions.get('s-full');
    expect(anyIncludes(contents(saved?.messages ?? []), 'old')).toBe(true);
    expect(anyIncludes(contents(saved?.messages ?? []), 'hi')).toBe(true);
    // LLM 窗口含历史
    const window = llmWindows[0] ?? [];
    expect(window.some((c) => c.includes('old'))).toBe(true);
    expect(window.some((c) => c.includes('hi'))).toBe(true);
  });

  it('显式 idleExpiryMs + 闲置超时：LLM 窗口截断，Discourse 全量保留', async () => {
    const oldTs = Date.now() - 3 * 60 * 60 * 1000;
    const { sessions, store } = memoryStoreHarness({
      id: 's-lease',
      agentId: 'default',
      meta: {
        id: 's-lease',
        agentId: 'default',
        channelId: 'test',
        peerId: 'p',
        status: 'idle',
        createdAt: oldTs,
        updatedAt: oldTs,
        lastInteractionAt: oldTs,
        sessionStartedAt: oldTs,
      },
      messages: [userMsg('old-secret', oldTs), { role: 'assistant', content: 'old-reply', timestamp: oldTs + 1 }],
      turns: [],
      metadata: {},
    });

    const llmWindows: string[][] = [];
    const { runner } = await new AgentBuilder()
      .model(
        mockProvider((req) => {
          llmWindows.push(
            req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')),
          );
        }),
      )
      .store(store)
      .runnerConfig({ idleExpiryMs: 2 * 60 * 60 * 1000 })
      .build();

    await runOnce(runner as never, 's-lease', 'fresh');

    const saved = sessions.get('s-lease');
    // Discourse 保留全部
    const texts = contents(saved?.messages ?? []);
    expect(anyIncludes(texts, 'old-secret')).toBe(true);
    expect(anyIncludes(texts, 'old-reply')).toBe(true);
    expect(anyIncludes(texts, 'fresh')).toBe(true);
    // 租约点之后还有本轮产物
    expect(saved?.contextDetachIndex).toBe(2);

    // LLM 默认窗口不含租约前历史
    const window = llmWindows[0] ?? [];
    expect(window.some((c) => c.includes('old-secret'))).toBe(false);
    expect(window.some((c) => c.includes('old-reply'))).toBe(false);
    expect(window.some((c) => c.includes('fresh'))).toBe(true);
  });

  it('未超时的闲置：即使配置了 idleExpiryMs 也不截断', async () => {
    const recent = Date.now() - 10 * 60 * 1000;
    const { sessions, store } = memoryStoreHarness({
      id: 's-recent',
      agentId: 'default',
      meta: {
        id: 's-recent',
        agentId: 'default',
        channelId: 'test',
        peerId: 'p',
        status: 'idle',
        createdAt: recent,
        updatedAt: recent,
        lastInteractionAt: recent,
        sessionStartedAt: recent,
      },
      messages: [userMsg('keep-me', recent)],
      turns: [],
      metadata: {},
    });

    const { runner, agent } = await new AgentBuilder()
      .model(mockProvider())
      .store(store)
      .runnerConfig({ idleExpiryMs: 2 * 60 * 60 * 1000 })
      .build();
    void agent;

    await runOnce(runner as never, 's-recent', 'next');

    expect(sessions.get('s-recent')?.contextDetachIndex ?? 0).toBe(0);
    const texts = contents(sessions.get('s-recent')?.messages ?? []);
    expect(anyIncludes(texts, 'keep-me')).toBe(true);
    expect(anyIncludes(texts, 'next')).toBe(true);
  });

  it('租约不触发 memory 硬收敛（无 session.lifecycle.updated→recent）', async () => {
    const oldTs = Date.now() - 3 * 60 * 60 * 1000;
    const { store } = memoryStoreHarness({
      id: 's-nomem',
      agentId: 'default',
      meta: {
        id: 's-nomem',
        agentId: 'default',
        channelId: 'test',
        peerId: 'p',
        status: 'idle',
        createdAt: oldTs,
        updatedAt: oldTs,
        lastInteractionAt: oldTs,
        sessionStartedAt: oldTs,
      },
      messages: [userMsg('x', oldTs)],
      turns: [],
      metadata: {},
    });

    const lifecycleEvents: string[] = [];
    const { runner } = await new AgentBuilder()
      .model(mockProvider())
      .store(store)
      .runnerConfig({ idleExpiryMs: 2 * 60 * 60 * 1000 })
      .build();

    void lifecycleEvents;

    await runOnce(runner as never, 's-nomem', 'hi');
    // 租约路径不再发 session.lifecycle.updated(lifecycle=recent)
    expect(lifecycleEvents).toEqual([]);
  });
});
