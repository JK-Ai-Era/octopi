/**
 * Phase D — Compact mutual exclusion + key (sessionId, agentId)
 *
 * Constitution E4 + E1:
 * 1. compactSession queues on the same session lock as handle
 * 2. compact key is per (session, agent); no borrowing
 * 3. Agent compact map isolates agents
 */

import { describe, it, expect } from 'vitest';
import { SessionAwareRunner } from '../../src/harness/runner.js';
import type { Agent } from '../../src/harness/agent/index.js';
import type { Message } from '../../src/core/types.js';
import { InMemorySessionStore } from '../../src/integration/storage/memory.js';
import type { SessionData } from '../../src/harness/session-types.js';
import { compactStateKey } from '../../src/harness/context/compact-key.js';
import {
  readSessionCompact,
  writeSessionCompact,
} from '../../src/harness/session-compact.js';
import { Agent as RealAgent } from '../../src/harness/agent/index.js';

function emptySession(id: string, agentId = 'a1'): SessionData {
  return {
    id,
    agentId,
    primaryAgentId: agentId,
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeMockAgent(opts: {
  delayMs?: number;
  compactStates?: Map<string, { summary?: string; lastProactiveMessageCount?: number }>;
}): Agent {
  const store = opts.compactStates ?? new Map();
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
    setSessionCompactState: (sessionId: string, agentId: string, state?: { summary?: string }) => {
      const key = compactStateKey(sessionId, agentId);
      if (!state) store.delete(key);
      else store.set(key, { ...state });
    },
    getSessionCompactState: (sessionId: string, agentId: string) => store.get(compactStateKey(sessionId, agentId)),
    setOnAfterTurn: () => {},
    notifyAfterTurn: async () => {},
    run: async function* (
      _signal?: AbortSignal,
      _h?: unknown,
      runOpts?: { context?: { messages: Message[] }; runScope?: { sessionId: string; agentId: string } },
    ) {
      if (opts.delayMs) await sleep(opts.delayMs);
      const ctx = runOpts?.context;
      if (ctx) {
        ctx.messages.push({ role: 'assistant', content: 'ok', timestamp: Date.now() });
      }
      yield { type: 'turn_end', timestamp: Date.now(), usage: undefined } as never;
      yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
    },
  };
  return agent as unknown as Agent;
}

describe('compactStateKey (E4)', () => {
  it('keys differ per agent on same session', () => {
    expect(compactStateKey('s1', 'a1')).not.toBe(compactStateKey('s1', 'a2'));
    expect(compactStateKey('s1', 'a1')).toBe(compactStateKey('s1', 'a1'));
  });
});

describe('session compact bucket helpers', () => {
  it('writes per-agent buckets without borrowing', () => {
    const session = emptySession('s1', 'owner');
    writeSessionCompact(session, 'owner', { summary: 'owner-sum', lastProactiveMessageCount: 3 });
    writeSessionCompact(session, 'guest', { summary: 'guest-sum', lastProactiveMessageCount: 9 });

    expect(readSessionCompact(session, 'owner')?.summary).toBe('owner-sum');
    expect(readSessionCompact(session, 'guest')?.summary).toBe('guest-sum');
    expect(session.contextCompacts?.owner?.summary).toBe('owner-sum');
    expect(session.contextCompacts?.guest?.summary).toBe('guest-sum');
  });

  it('guest does not read owner-only compact when primary is set', () => {
    const session = emptySession('s1', 'owner');
    session.contextCompacts = { owner: { summary: 'only-owner' } };
    session.primaryAgentId = 'owner';
    delete session.contextCompact;
    expect(readSessionCompact(session, 'guest')).toBeUndefined();
  });
});

describe('Agent compact map (E4)', () => {
  it('isolates compact state by (sessionId, agentId)', () => {
    const agent = new RealAgent({
      model: { name: 'mock', defaultModel: 'm' } as never,
    });
    agent.setSessionCompactState('s1', 'a1', { summary: 'A', lastProactiveMessageCount: 1 });
    agent.setSessionCompactState('s1', 'a2', { summary: 'B', lastProactiveMessageCount: 2 });
    expect(agent.getSessionCompactState('s1', 'a1')?.summary).toBe('A');
    expect(agent.getSessionCompactState('s1', 'a2')?.summary).toBe('B');
  });
});

describe('Runner.compactSession lock (D1)', () => {
  it('queues compact behind concurrent handle on same sessionId', async () => {
    const order: string[] = [];
    const agent = makeMockAgent({
      delayMs: 80,
    });
    // wrap run to record order
    const originalRun = (agent as unknown as { run: unknown }).run;
    (agent as unknown as { run: unknown }).run = async function* (
      this: unknown,
      signal?: AbortSignal,
      h?: unknown,
      opts?: { context?: { messages: Message[] }; runScope?: { sessionId: string } },
    ) {
      order.push('run:start');
       
      for await (const ev of (originalRun as any).call(this, signal, h, opts)) {
        yield ev;
      }
      order.push('run:end');
    };

    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);
    await store.save('s-lock', emptySession('s-lock', 'a1'));

    const handlePromise = (async () => {
      for await (const _ of runner.handle(
        's-lock',
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { systemPrompt: '', agentId: 'a1', sessionId: 's-lock' },
      )) {
        void _;
      }
    })();

    // small delay so handle acquires the lock first
    await sleep(10);
    const compactPromise = runner.compactSession('s-lock', 'a1', {
      compactStructural: async () => {
        order.push('compact');
        return {
          ok: true,
          compacted: true,
          reason: 'structural',
          tokensBefore: 10,
          tokensAfter: 4,
          summary: 'compacted-sum',
        };
      },
    });

    await Promise.all([handlePromise, compactPromise]);

    const runEnd = order.indexOf('run:end');
    const compactIdx = order.indexOf('compact');
    expect(runEnd).toBeGreaterThanOrEqual(0);
    expect(compactIdx).toBeGreaterThan(runEnd);

    const sess = await store.load('s-lock');
    expect(sess?.contextCompacts?.a1?.summary).toBe('compacted-sum');
  });

  it('missing session returns structured failure under lock', async () => {
    const agent = makeMockAgent({});
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);
    const result = await runner.compactSession('missing', 'a1', {
      compactStructural: async () => ({
        ok: true,
        compacted: true,
        tokensBefore: 0,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session not found');
  });
});

describe('Runner writeback compact key (D2/D4)', () => {
  it('handle writeback stores compact under this run agentId only', async () => {
    const compactStates = new Map<string, { summary?: string; lastProactiveMessageCount?: number }>();
    const agent = makeMockAgent({ compactStates });
    // seed only after handle path via mock: simulate convertToLlm writing compact
    const originalRun = (agent as unknown as { run: unknown }).run;
    (agent as unknown as { run: unknown }).run = async function* (
      this: unknown,
      signal?: AbortSignal,
      h?: unknown,
      opts?: { context?: { messages: Message[] }; runScope?: { sessionId: string; agentId: string } },
    ) {
      const sid = opts?.runScope?.sessionId ?? 's';
      const aid = opts?.runScope?.agentId ?? 'a1';
      compactStates.set(compactStateKey(sid, aid), { summary: `sum-${aid}`, lastProactiveMessageCount: 2 });
       
      for await (const ev of (originalRun as any).call(this, signal, h, opts)) {
        yield ev;
      }
    };

    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);
    await store.save('s-w', emptySession('s-w', 'a1'));

    for await (const _ of runner.handle(
      's-w',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's-w' },
    )) {
      void _;
    }

    const sess = await store.load('s-w');
    expect(sess?.contextCompacts?.a1?.summary).toBe('sum-a1');
    expect(sess?.contextCompact?.summary).toBe('sum-a1');
  });
});
