/**
 * Phase C — Session 一等数据形态（模型 2 最小集）
 *
 * 行为：
 * 1. create / Runner createSession 写入 primaryAgentId
 * 2. 历史 session 缺省 primary 时回填为 agentId（单 agent 兼容）
 * 3. assistant 消息写回带 agentId 归因（来自本 Run）
 * 4. JsonlSessionStore 持久化 primaryAgentId
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAwareRunner } from '../../src/harness/runner.js';
import type { Agent } from '../../src/harness/agent/index.js';
import type { Message } from '../../src/core/types.js';
import { InMemorySessionStore } from '../../src/integration/storage/memory.js';
import { JsonlSessionStore } from '../../src/integration/storage/jsonl.js';
import { writeSessionCompact } from '../../src/harness/session-compact.js';
import type { SessionData } from '../../src/harness/session-types.js';

function emptySession(id: string, agentId = 'a1'): SessionData {
  return {
    id,
    agentId,
    meta: {
      id,
      agentId,
      channelId: 'web',
      peerId: 'ui',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    turns: [],
    metadata: {},
  };
}

function makeMockAgent(replyContent: string): Agent {
  const agentContext = { systemPrompt: '', messages: [] as Message[], tools: [] as unknown[] };
  const agent = {
    context: agentContext,
    contextSessionId: 'default',
    tools: [] as unknown[],
    model: { name: 'mock', defaultModel: 'm' },
    config: {},
    harness: {},
    setSystemPrompt: () => {},
    setContextSessionId: (sid: string) => {
      (agent as { contextSessionId: string }).contextSessionId = sid;
    },
    setSessionCompactState: () => {},
    getSessionCompactState: () => undefined,
    setOnAfterTurn: () => {},
    notifyAfterTurn: async () => {},
    run: async function* (
      _signal?: AbortSignal,
      _h?: unknown,
      runOpts?: {
        context?: { messages: Message[] };
        runScope?: { sessionId: string; agentId: string };
      },
    ) {
      const ctx = runOpts?.context;
      if (ctx) {
        ctx.messages.push({
          role: 'assistant',
          content: replyContent,
          timestamp: Date.now(),
        });
      }
      yield { type: 'turn_end', timestamp: Date.now(), usage: undefined, hasToolCalls: false } as never;
      yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
    },
  };
  return agent as unknown as Agent;
}

describe('Phase C SessionData.primaryAgentId', () => {
  it('Runner 新建 session 时 primaryAgentId = 创建 agentId', async () => {
    const agent = makeMockAgent('hello');
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);

    for await (const _ of runner.handle(
      's-new',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's-new' },
    )) {
      void _;
    }

    const sess = await store.load('a1', 's-new');
    expect(sess).toBeTruthy();
    expect(sess!.primaryAgentId).toBe('a1');
    expect(sess!.agentId).toBe('a1');
  });

  it('历史 session 缺省 primary 时 Runner 回填 agentId（单 agent 兼容）', async () => {
    const agent = makeMockAgent('hello');
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);

    const legacy = emptySession('s-legacy', 'a1');
    // 故意不设 primaryAgentId
    delete (legacy as { primaryAgentId?: string }).primaryAgentId;
    await store.save('a1', 's-legacy', legacy);

    for await (const _ of runner.handle(
      's-legacy',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's-legacy' },
    )) {
      void _;
    }

    const sess = await store.load('a1', 's-legacy');
    expect(sess!.primaryAgentId).toBe('a1');
  });

  it('assistant 消息写回带 agentId 归因', async () => {
    const agent = makeMockAgent('reply-from-a1');
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);

    await store.save('a1', 's-attr', emptySession('s-attr', 'a1'));

    for await (const _ of runner.handle(
      's-attr',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's-attr' },
    )) {
      void _;
    }

    const sess = await store.load('a1', 's-attr');
    expect(sess).toBeTruthy();
    const assistant = (sess!.messages ?? []).filter((m) => m.role === 'assistant');
    expect(assistant.length).toBeGreaterThan(0);
    for (const m of assistant) {
      expect(m.agentId).toBe('a1');
    }
    const user = (sess!.messages ?? []).find((m) => m.role === 'user');
    expect(user?.agentId).toBeUndefined();

    const turnOut = sess!.turns?.[0]?.output;
    if (turnOut && turnOut.role === 'assistant') {
      expect(turnOut.agentId).toBe('a1');
    }
  });

  it('InMemory save/load 往返保留 primaryAgentId', async () => {
    const store = new InMemorySessionStore();
    const data = emptySession('s1', 'a1');
    data.primaryAgentId = 'a1';
    await store.save('a1', 's1', data);
    const loaded = await store.load('a1', 's1');
    expect(loaded?.primaryAgentId).toBe('a1');
  });

  it('JsonlSessionStore 持久化 primaryAgentId', async () => {
    const home = mkdtempSync(join(tmpdir(), 'octopi-c-jsonl-'));
    const store = new JsonlSessionStore((agentId) => join(home, agentId));

    const data = emptySession('s-json', 'a1');
    data.primaryAgentId = 'a1';
    data.messages = [
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { role: 'assistant', content: 'yo', timestamp: Date.now(), agentId: 'a1' },
    ];
    await store.save('a1', 's-json', data);

    const loaded = await store.load('a1', 's-json');
    expect(loaded).toBeTruthy();
    expect(loaded!.primaryAgentId).toBe('a1');
    const assistant = loaded!.messages.find((m) => m.role === 'assistant');
    expect(assistant?.agentId).toBe('a1');
  });

  it('Jsonl 持久化 preferred / participants / contextCompacts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'octopi-c-jsonl-m2-'));
    const store = new JsonlSessionStore((agentId) => join(home, agentId));

    const data = emptySession('s-m2', 'a1');
    data.primaryAgentId = 'a1';
    data.preferredAgentId = 'spec';
    data.participants = [
      {
        sessionId: 's-m2',
        agentId: 'spec',
        roleId: 'specialist',
        grantSeq: 1,
        grantedAt: Date.now(),
      },
    ];
    data.contextCompacts = { a1: { summary: 'sum-a1', lastProactiveMessageCount: 2 } };
    data.contextCompact = { summary: 'sum-a1', lastProactiveMessageCount: 2 };
    data.switchAudit = [
      {
        at: Date.now(),
        mode: 'preferred',
        toAgentId: 'spec',
        actorId: 'host-1',
        actorType: 'host',
        intent: 'switch_preferred',
      },
    ];
    await store.save('a1', 's-m2', data);

    const loaded = await store.load('a1', 's-m2');
    expect(loaded?.preferredAgentId).toBe('spec');
    expect(loaded?.participants?.[0]?.roleId).toBe('specialist');
    expect(loaded?.contextCompacts?.a1?.summary).toBe('sum-a1');
    expect(loaded?.switchAudit?.[0]?.mode).toBe('preferred');
  });

  it('Jsonl 历史 state 缺 primary 时 load 回填双键 agentId', async () => {
    const home = mkdtempSync(join(tmpdir(), 'octopi-c-jsonl-legacy2-'));
    const store = new JsonlSessionStore((agentId) => join(home, agentId));

    const data = emptySession('s-old', 'a1');
    await store.save('a1', 's-old', data);

    // 手写去掉 primaryAgentId 的旧 state
    const { writeFileSync, readFileSync } = await import('node:fs');
    const statePath = join(home, 'a1', 'sessions', 's-old.state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    delete state.primaryAgentId;
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const loaded = await store.load('a1', 's-old');
    expect(loaded?.primaryAgentId).toBe('a1');
  });

  it('session compact helper clears primary view and buckets (E4)', () => {
    const s = emptySession('s-clr', 'a1');
    s.contextCompacts = { a1: { summary: 'x' }, guest: { summary: 'y' } };
    s.contextCompact = { summary: 'x' };
    writeSessionCompact(s, 'a1', undefined);
    writeSessionCompact(s, 'guest', undefined);
    expect(s.contextCompacts).toBeUndefined();
    expect(s.contextCompact).toBeUndefined();
  });
});
