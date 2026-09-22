/**
 * 宪法 I1 — Run 物理：RunScope 隔离
 *
 * 行为：
 * 1. withRunScope 并发 generator 身份不串
 * 2. 同 Agent 双 Session 交错 handle：落盘历史不交叉
 * 3. Runner 把 run context / runScope 传入 Agent.run
 */

import { describe, it, expect } from 'vitest';
import { withRunScope, getRunScope } from '../../src/harness/run-scope.js';
import { SessionAwareRunner } from '../../src/harness/runner.js';
import type { Agent } from '../../src/harness/agent/index.js';
import type { Message } from '../../src/core/types.js';
import { InMemorySessionStore } from '../../src/integration/storage/memory.js';
import type { SessionData } from '../../src/harness/session-types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

describe('RunScope ALS', () => {
  it('并发 generator 各自读到自己的 sessionId', async () => {
    const seen: Record<string, string[]> = { sA: [], sB: [] };

    async function* worker(sid: string, delayMs: number) {
      for (let i = 0; i < 3; i++) {
        await sleep(delayMs);
        const scope = getRunScope();
        seen[sid]!.push(scope?.sessionId ?? 'none');
        yield { sid, i };
      }
    }

    const a = withRunScope({ sessionId: 'sA', agentId: 'a1' }, worker('sA', 5));
    const b = withRunScope({ sessionId: 'sB', agentId: 'a1' }, worker('sB', 3));

    await Promise.all([
      (async () => {
        for await (const _ of a) void _;
      })(),
      (async () => {
        for await (const _ of b) void _;
      })(),
    ]);

    expect(seen.sA).toEqual(['sA', 'sA', 'sA']);
    expect(seen.sB).toEqual(['sB', 'sB', 'sB']);
  });
});

describe('SessionAwareRunner concurrent sessions (I1)', () => {
  it('同 Agent 双 Session 并行 handle，历史与 runScope 不串味', async () => {
    const seenScopes: Array<{ sessionId?: string; messagesAtStart: number; userContents: string[] }> = [];
    const runContexts: Array<{ sessionId?: string; sharedWithAgent: boolean }> = [];

    const agentContext = { systemPrompt: 'agent-template', messages: [] as Message[], tools: [] as unknown[] };

    const agent = {
      context: agentContext,
      contextSessionId: 'default',
      tools: [] as unknown[],
      model: { name: 'mock', defaultModel: 'm' },
      config: {},
      harness: {},
      setSystemPrompt: () => {},
      setContextSessionId: (sid: string) => {
        agent.contextSessionId = sid;
      },
      setSessionCompactState: () => {},
      getSessionCompactState: () => undefined,
      setOnAfterTurn: () => {},
      notifyAfterTurn: async () => {},
      run: async function* (
        _signal?: AbortSignal,
        _h?: unknown,
        opts?: {
          context?: { messages: Message[]; systemPrompt: string };
          runScope?: { sessionId: string; agentId: string; systemPrompt?: string };
        },
      ) {
        const ctx = opts?.context;
        const scope = opts?.runScope;
        expect(ctx).toBeDefined();
        expect(scope).toBeDefined();
        runContexts.push({
          sessionId: scope!.sessionId,
          sharedWithAgent: ctx === (agent as { context: unknown }).context,
        });
        const users = (ctx?.messages ?? []).filter((m) => m.role === 'user').map((m) => String(m.content));
        seenScopes.push({
          sessionId: scope!.sessionId,
          messagesAtStart: ctx?.messages.length ?? -1,
          userContents: users,
        });

        // 模拟 LLM 延迟：制造交错窗口
        await sleep(scope!.sessionId === 'sA' ? 30 : 5);
        const reply = `reply-for-${scope!.sessionId}`;
        ctx!.messages.push({
          role: 'assistant',
          content: reply,
          timestamp: Date.now(),
        });
        yield { type: 'turn_end', timestamp: Date.now(), usage: undefined } as never;
        yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
      },
    };

    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent as unknown as Agent, {} as never, store);

    await store.save('sA', emptySession('sA'));
    await store.save('sB', emptySession('sB'));

    const collect = async (sessionId: string, content: string) => {
      for await (const _ of runner.handle(
        sessionId,
        { role: 'user', content, timestamp: Date.now() },
        { systemPrompt: '', agentId: 'a1', sessionId },
      )) {
        void _;
      }
    };

    await Promise.all([collect('sA', 'hello-A'), collect('sB', 'hello-B')]);

    const sessA = await store.load('sA');
    const sessB = await store.load('sB');
    expect(sessA).toBeTruthy();
    expect(sessB).toBeTruthy();

    const contentsA = (sessA!.messages ?? []).map((m) => String(m.content));
    const contentsB = (sessB!.messages ?? []).map((m) => String(m.content));

    expect(contentsA).toContain('hello-A');
    expect(contentsA).toContain('reply-for-sA');
    expect(contentsA).not.toContain('hello-B');
    expect(contentsA).not.toContain('reply-for-sB');

    expect(contentsB).toContain('hello-B');
    expect(contentsB).toContain('reply-for-sB');
    expect(contentsB).not.toContain('hello-A');
    expect(contentsB).not.toContain('reply-for-sA');

    // Run 不得共享 Agent 单例 context
    for (const rc of runContexts) {
      expect(rc.sharedWithAgent).toBe(false);
    }

    // 每次 run 的 user 内容只含本 session
    for (const s of seenScopes) {
      if (s.sessionId === 'sA') {
        expect(s.userContents.every((c) => c.includes('A') && !c.includes('B'))).toBe(true);
      }
      if (s.sessionId === 'sB') {
        expect(s.userContents.every((c) => c.includes('B') && !c.includes('A'))).toBe(true);
      }
    }

    // 共享 agent.context.messages 不应被 Runner 写成某一会话历史
    const agentMsgs = (agent.context.messages ?? []).map((m) => String(m?.content ?? ''));
    expect(agentMsgs).not.toContain('hello-A');
    expect(agentMsgs).not.toContain('hello-B');
  });
});
