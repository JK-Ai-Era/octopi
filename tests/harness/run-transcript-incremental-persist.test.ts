/**
 * Run 进行中转录增量落盘 — SessionAwareRunner 连线回归
 *
 * 修复「浏览器刷新后在途 turn 执行过程不可见」的 A 面：消息定形即对齐落盘
 * （turn_start 定形后首同步；loop 事件边界增量同步；ephemeral 不落历史，
 * 与收尾合并口径一致）。收尾整包 save 仍是权威写。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import type { Message } from '@octopi-agent/core/types.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';

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
    tasks: [],
  };
}

interface AgentStep {
  /** 事件前 push 进 run 视图的消息（模拟 Loop：push 先于事件 yield） */
  pushes?: Message[];
  /** push 之后 yield 的事件 */
  event?: Record<string, unknown>;
}

/**
 * Fake Agent：按脚本重放「push → 事件」时序，与 agent-loop.ts 的写史顺序一致。
 */
function scriptedAgent(steps: AgentStep[]): Agent {
  return {
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
    toolsForSession: () => [],
    setOnAfterTurn: () => {},
    notifyAfterTurn: async () => {},
    run: async function* (
      _s?: AbortSignal,
      _h?: unknown,
      opts?: { context?: { messages: Message[] } },
    ) {
      const messages = opts!.context!.messages;
      for (const step of steps) {
        for (const m of step.pushes ?? []) messages.push(m);
        if (step.event) yield step.event as never;
      }
      yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
    },
  } as unknown as Agent;
}

describe('runner 转录增量落盘（A 面）', () => {
  let home: string;
  let dir: string;

  async function setup(): Promise<{ store: JsonlSessionStore; file: string }> {
    home = await mkdtemp(join(tmpdir(), 'octopi-run-sync-'));
    dir = join(home, 'sessions');
    const store = new JsonlSessionStore({ sessionsDir: dir });
    await store.save('s1', emptySession('s1'));
    return { store, file: join(dir, 's1.jsonl') };
  }

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('turn_start 定形与 assistant 消息在 run 进行中即落盘（刷新可见）', async () => {
    const { store, file } = await setup();
    const agent = scriptedAgent([
      {
        pushes: [{ role: 'assistant', content: 'first-answer', timestamp: Date.now() }],
        event: { type: 'turn_end', timestamp: Date.now(), usage: undefined },
      },
    ]);
    const runner = new SessionAwareRunner(agent, {} as never, store);

    let mid = '';
    let iter = 0;
    for await (const ev of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's1' },
    )) {
      void ev;
      iter += 1;
      // 第一次事件边界（sync 已在迭代开头执行）→ 中途快照
      if (iter === 1) mid = readFileSync(file, 'utf-8');
    }

    // 中途磁盘已含定形后的 turn_start（含 <turn_start 信封）与 assistant 消息；
    // 反向断言防假绿：turn_end 闭标是收尾才写的——若快照里出现，说明读到的是收尾后文件
    expect(mid).toContain('<turn_start');
    expect(mid).toContain('first-answer');
    expect(mid).not.toContain('<turn_end');
  });

  it('ephemeral 消息不落历史（中途与收尾口径一致）', async () => {
    const { store, file } = await setup();
    const agent = scriptedAgent([
      {
        pushes: [
          { role: 'system', content: 'live-status', timestamp: Date.now(), ephemeral: true },
          { role: 'assistant', content: 'durable-answer', timestamp: Date.now() },
        ],
        event: { type: 'turn_end', timestamp: Date.now(), usage: undefined },
      },
    ]);
    const runner = new SessionAwareRunner(agent, {} as never, store);

    let mid = '';
    let iter = 0;
    for await (const ev of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's1' },
    )) {
      void ev;
      iter += 1;
      if (iter === 1) mid = readFileSync(file, 'utf-8');
    }

    expect(mid).not.toContain('live-status');
    expect(mid).toContain('durable-answer');
    // 反向断言防假绿：快照必须取自收尾之前
    expect(mid).not.toContain('<turn_end');

    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const loaded = await fresh.load('s1');
    expect(loaded!.messages.some((m) => m.content === 'live-status')).toBe(false);
    expect(loaded!.messages.some((m) => m.content === 'durable-answer')).toBe(true);
  });

  it('旁路整包 save 漂移后继续 sync 自愈，收尾序列完整', async () => {
    const { store, file } = await setup();
    const agent = scriptedAgent([
      {
        pushes: [{ role: 'assistant', content: 'answer-1', timestamp: Date.now() }],
        event: { type: 'turn_end', timestamp: Date.now(), usage: undefined },
      },
      {
        pushes: [{ role: 'assistant', content: 'answer-2', timestamp: Date.now() }],
        event: { type: 'turn_end', timestamp: Date.now(), usage: undefined },
      },
    ]);
    const runner = new SessionAwareRunner(agent, {} as never, store);

    let iter = 0;
    for await (const ev of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's1' },
    )) {
      void ev;
      iter += 1;
      if (iter === 1) {
        // 模拟 run 中途旁路写者持旧 messages 整包 save（title/attachments 同型）
        const stale = await store.load('s1');
        await store.save('s1', {
          ...stale!,
          messages: stale!.messages.slice(0, 1),
        });
      }
      if (iter === 2) {
        // 第二个事件边界 sync 已检测漂移并全量对齐（快照仍取自收尾之前）
        const healed = readFileSync(file, 'utf-8');
        expect(healed).toContain('answer-1');
        expect(healed).not.toContain('<turn_end');
      }
    }

    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const loaded = await fresh.load('s1');
    const texts = loaded!.messages.map((m) => String(m.content));
    expect(texts).toContain('answer-1');
    expect(texts).toContain('answer-2');
    // 收尾权威写：turn_end 闭标在盘
    expect(texts[texts.length - 1]).toContain('<turn_end');
  });
});
