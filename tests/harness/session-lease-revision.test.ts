/**
 * Phase G — Session Lease interface + AgentRevision field slot (E2/E7)
 */

import { describe, it, expect } from 'vitest';
import { InProcessSessionLock } from '../../src/harness/concurrency/session-lease.js';
import { SessionAwareRunner } from '../../src/harness/runner.js';
import { getRunScope } from '../../src/harness/run-scope.js';
import type { Agent } from '../../src/harness/agent/index.js';
import type { Message } from '../../src/core/types.js';
import { InMemorySessionStore } from '../../src/integration/storage/memory.js';
import type { SessionData } from '../../src/harness/session-types.js';

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

describe('InProcessSessionLock (E2)', () => {
  it('serializes acquire on same sessionId FIFO', async () => {
    const lock = new InProcessSessionLock();
    const order: string[] = [];

    const a = lock.acquire('s1').then(async (release) => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
      release();
    });
    const b = lock.acquire('s1').then(async (release) => {
      order.push('b-start');
      release();
    });

    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('allows concurrent different sessionIds', async () => {
    const lock = new InProcessSessionLock();
    expect(lock.isHeld('x')).toBe(false);
    const relA = await lock.acquire('sA');
    const relB = await lock.acquire('sB');
    expect(lock.isHeld('sA')).toBe(true);
    expect(lock.isHeld('sB')).toBe(true);
    relA();
    relB();
    expect(lock.isHeld('sA')).toBe(false);
    expect(lock.isHeld('sB')).toBe(false);
  });

  it('runner accepts injected SessionLease', async () => {
    const custom = new InProcessSessionLock();
    const agentContext = { systemPrompt: '', messages: [] as Message[], tools: [] as unknown[] };
    const agent = {
      context: agentContext,
      contextSessionId: 'default',
      tools: [],
      model: { name: 'mock', defaultModel: 'm' },
      config: {},
      harness: {},
      setSystemPrompt: () => {},
      setContextSessionId: () => {},
      setSessionCompactState: (..._a: unknown[]) => {},
      getSessionCompactState: (..._a: unknown[]) => undefined,
      setOnAfterTurn: () => {},
      notifyAfterTurn: async () => {},
      run: async function* (
        _s?: AbortSignal,
        _h?: unknown,
        opts?: { context?: { messages: Message[] }; runScope?: { agentRevision?: string } },
      ) {
        if (opts?.context) {
          opts.context.messages.push({
            role: 'assistant',
            content: 'ok',
            timestamp: Date.now(),
          });
        }
        yield { type: 'turn_end', timestamp: Date.now(), usage: undefined } as never;
        yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
      },
    } as unknown as Agent;

    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store, {
      sessionLease: custom,
    });
    await store.save('a1', 's1', emptySession('s1'));
    for await (const _ of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's1', agentRevision: 'rev-3' },
    )) {
      void _;
    }
    expect(custom.isHeld('s1')).toBe(false);
  });
});

describe('AgentRevision field slot (G2)', () => {
  it('runScope carries agentRevision from RunConfig', async () => {
    const seen: Array<string | undefined> = [];
    const agent = {
      context: { systemPrompt: '', messages: [] as Message[], tools: [] },
      contextSessionId: 'default',
      tools: [],
      model: { name: 'mock', defaultModel: 'm' },
      config: {},
      harness: {},
      setSystemPrompt: () => {},
      setContextSessionId: () => {},
      setSessionCompactState: () => {},
      getSessionCompactState: () => undefined,
      setOnAfterTurn: () => {},
      notifyAfterTurn: async () => {},
      run: async function* (
        _s?: AbortSignal,
        _h?: unknown,
        opts?: {
          context?: { messages: Message[] };
          runScope?: { sessionId: string; agentId: string; agentRevision?: string };
        },
      ) {
        seen.push(opts?.runScope?.agentRevision);
        if (opts?.context) {
          opts.context.messages.push({
            role: 'assistant',
            content: 'ok',
            timestamp: Date.now(),
          });
        }
        yield { type: 'turn_end', timestamp: Date.now(), usage: undefined } as never;
        yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
      },
    } as unknown as Agent;

    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);
    await store.save('a1', 's-rev', emptySession('s-rev'));
    for await (const _ of runner.handle(
      's-rev',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      {
        systemPrompt: '',
        agentId: 'a1',
        sessionId: 's-rev',
        agentRevision: 'template-42',
      },
    )) {
      void _;
    }
    expect(seen[0]).toBe('template-42');
    void getRunScope;
  });
});

describe('shared SessionLease + ACL on handle (review fixes)', () => {
  it('two runners sharing one lease serialize the same sessionId', async () => {
    const lease = new InProcessSessionLock();
    const order: string[] = [];

    const makeAgent = (tag: string, delay: number) =>
      ({
        context: { systemPrompt: '', messages: [] as Message[], tools: [] },
        contextSessionId: 'default',
        tools: [],
        model: { name: 'mock', defaultModel: 'm' },
        config: {},
        harness: {},
        setSystemPrompt: () => {},
        setContextSessionId: () => {},
        setSessionCompactState: (..._a: unknown[]) => {},
        getSessionCompactState: (..._a: unknown[]) => undefined,
        setOnAfterTurn: () => {},
        notifyAfterTurn: async () => {},
        run: async function* (
          _s?: AbortSignal,
          _h?: unknown,
          opts?: { context?: { messages: Message[] } },
        ) {
          order.push(`${tag}:start`);
          await new Promise((r) => setTimeout(r, delay));
          if (opts?.context) {
            opts.context.messages.push({
              role: 'assistant',
              content: tag,
              timestamp: Date.now(),
            });
          }
          order.push(`${tag}:end`);
          yield { type: 'turn_end', timestamp: Date.now(), usage: undefined } as never;
          yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
        },
      }) as unknown as Agent;

    const store = new InMemorySessionStore();
    // dual-key: two agent homes, same sessionId — shared lease still serializes if both use same lease
    const runnerA = new SessionAwareRunner(makeAgent('A', 40), {} as never, store, {
      sessionLease: lease,
    });
    const runnerB = new SessionAwareRunner(makeAgent('B', 5), {} as never, store, {
      sessionLease: lease,
    });

    await store.save('agentA', 'shared-s', emptySession('shared-s', 'agentA'));
    await store.save('agentB', 'shared-s', emptySession('shared-s', 'agentB'));

    const run = async (runner: SessionAwareRunner, agentId: string) => {
      for await (const _ of runner.handle(
        'shared-s',
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { systemPrompt: '', agentId, sessionId: 'shared-s' },
      )) {
        void _;
      }
    };

    await Promise.all([run(runnerA, 'agentA'), run(runnerB, 'agentB')]);
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('ACL-injected handle denies non-primary without participant', async () => {
    const { SessionAclService } = await import('../../src/harness/session-acl/service.js');
    const acl = new SessionAclService();
    const store = new InMemorySessionStore();
    const ran: string[] = [];
    const agent = {
      context: { systemPrompt: '', messages: [] as Message[], tools: [] },
      contextSessionId: 'default',
      tools: [],
      model: { name: 'mock', defaultModel: 'm' },
      config: {},
      harness: {},
      setSystemPrompt: () => {},
      setContextSessionId: () => {},
      setSessionCompactState: (..._a: unknown[]) => {},
      getSessionCompactState: (..._a: unknown[]) => undefined,
      setOnAfterTurn: () => {},
      notifyAfterTurn: async () => {},
      run: async function* () {
        ran.push('should-not-run');
        yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
      },
    } as unknown as Agent;

    const runner = new SessionAwareRunner(agent, {} as never, store, { sessionAcl: acl });
    // 双键：以 stranger 为存储键，但 primary 指向他人 → 无绑定应拒绝
    const s = emptySession('s-acl', 'primary-agent');
    s.primaryAgentId = 'primary-agent';
    s.agentId = 'primary-agent';
    await store.save('stranger', 's-acl', s);

    const events: Array<{ type: string; data?: { error?: string } }> = [];
    for await (const ev of runner.handle(
      's-acl',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'stranger', sessionId: 's-acl' },
    )) {
      events.push(ev as never);
    }
    expect(ran).toHaveLength(0);
    expect(events.some((e) => e.type === 'engine.error')).toBe(true);
  });

  it('handle authorizeRun clamps by agentMaxSessionRights (E6 L1)', async () => {
    const { SessionAclService } = await import('../../src/harness/session-acl/service.js');
    const acl = new SessionAclService();
    const store = new InMemorySessionStore();
    const agentMax = { writeMemory: false, readScope: 'none' as const };
    const agent = {
      context: { systemPrompt: '', messages: [] as Message[], tools: [] },
      contextSessionId: 'default',
      tools: [],
      model: { name: 'mock', defaultModel: 'm' },
      config: {},
      harness: {},
      setSystemPrompt: () => {},
      setContextSessionId: () => {},
      setSessionCompactState: (..._a: unknown[]) => {},
      getSessionCompactState: (..._a: unknown[]) => undefined,
      setOnAfterTurn: () => {},
      notifyAfterTurn: async () => {},
      run: async function* (
        _s?: AbortSignal,
        _h?: unknown,
        opts?: { context?: { messages: Message[] } },
      ) {
        if (opts?.context) {
          opts.context.messages.push({
            role: 'assistant',
            content: 'ok',
            timestamp: Date.now(),
          });
        }
        yield { type: 'turn_end', timestamp: Date.now(), usage: undefined } as never;
        yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
      },
    } as unknown as Agent;

    const runner = new SessionAwareRunner(agent, {} as never, store, {
      sessionAcl: acl,
      agentMaxSessionRights: agentMax,
    });
    const s = emptySession('s-max', 'a1');
    await store.save('a1', 's-max', s);

    for await (const _ of runner.handle(
      's-max',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's-max' },
    )) {
      void _;
    }

    const auth = acl.authorizeRun({ session: s, agentId: 'a1', agentMax });
    expect(auth.ok).toBe(true);
    expect(auth.rights?.writeMemory).toBe(false);
    expect(auth.rights?.readScope).toBe('none');
  });
});
