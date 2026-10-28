/**
 * 中断续跑的 turn 信封收尾（2026-10-28 事故回归）
 *
 * 事故链：run 中断（冻结/被杀）时 turnSeq 计数器只随收尾 save 落盘而丢失 →
 * 续跑复用已闭 turn 的 id → ensurePreviousTurnClosed 为上一个未闭信封补写闭标 →
 * 收尾 appendTurnEnd 撞全局 write-once 守卫 throw → loop 已 completed 的 run 被
 * 升级成 error（会话被中止），且抛错发生在 save 之前导致下一次续跑继续复用 id。
 *
 * 不变式：
 * - turnSeq 分配即持久化（store 支持 updateMetadata 时），崩溃续跑不复用 turn id
 * - 闭标幂等收养按信封区间判形：同 id 的历史闭标不算「本信封已闭」，收尾不 throw
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import {
  formatTurnContextXml,
  formatTurnEndContent,
  formatTurnStartContent,
  isTurnEndContent,
  isTurnStartContent,
  parseTurnIdFromContent,
} from '@octopi-agent/engine/harness/context/turn-envelope.js';

function makeProvider(): ModelProvider {
  const model = 'm1';
  return {
    name: 'p1',
    defaultModel: model,
    models: [model],
    getModelInfo: () => ({ name: model, contextWindow: 100000 }),
    getModelInfos: () => [{ name: model, contextWindow: 100000 }],
    isAvailable: async () => true,
    chat: async () => ({ content: 'ok', model, finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const, content: 'ok', finishReason: 'stop' as const };
    },
  };
}

function makeAgent(provider: ModelProvider, onRun?: () => Promise<void>): Agent {
  return {
    context: { systemPrompt: 'sys', messages: [], tools: [] },
    contextSessionId: 'default',
    model: provider,
    config: { model: provider },
    tools: [],
    setSystemPrompt: () => {},
    setContextSessionId: () => {},
    setSessionCompactState: () => {},
    getSessionCompactState: () => undefined,
    toolsForSession: () => [],
    setOnAfterTurn: () => {},
    notifyAfterTurn: async () => {},
    harness: {},
    run: async function* () {
      if (onRun) await onRun();
      yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
    },
  } as unknown as Agent;
}

function turnStart(turnId: string, userText: string): Message {
  return {
    role: 'user',
    content: formatTurnStartContent({
      turnId,
      at: '2026-10-29T00:00:00.000Z',
      turnContextXml: formatTurnContextXml({ turnId, slotsXml: '' }),
      userText,
    }),
    timestamp: Date.now(),
    metadata: { turnId },
  };
}

/** 崩溃现场：上一 turn 的 turn_start 已定形、无 turn_end（run 未收尾即中断） */
function crashStateSession(id: string, metadata: SessionData['metadata']): SessionData {
  return {
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
    messages: [turnStart('t1', '第一轮（中断未收尾）')],
    turns: [],
    metadata,
  };
}

function countMarks(messages: readonly Message[], kind: 'start' | 'end'): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of messages) {
    const hit = kind === 'start' ? isTurnStartContent(m.content) : isTurnEndContent(m.content);
    if (!hit) continue;
    const id = parseTurnIdFromContent(m.content) ?? '?';
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

function makeRunner(
  store: InMemorySessionStore,
  provider: ModelProvider,
  onRun?: () => Promise<void>,
): SessionAwareRunner {
  const runner = new SessionAwareRunner(makeAgent(provider, onRun), {} as never, store);
  runner.setModelResolver(() => ({
    ref: 'p1/m1',
    providerName: 'p1',
    modelName: 'm1',
    provider,
    contextWindow: 100000,
    source: 'config' as const,
    known: true,
    isOverride: false,
  }));
  return runner;
}

async function runTurn(runner: SessionAwareRunner, sessionId: string): Promise<void> {
  for await (const _ of runner.handle(
    sessionId,
    { role: 'user', content: '继续', timestamp: Date.now() },
    { systemPrompt: 'sys', agentId: 'a1', sessionId },
    undefined,
  )) {
    // drain
  }
}

describe('中断续跑的 turn 信封收尾', () => {
  it('崩溃后续跑分配新 turn id，闭标各归其位（计数器分配即持久化）', async () => {
    const provider = makeProvider();
    const store = new InMemorySessionStore();
    // 修复后形态的崩溃现场：run 已把 turnSeq=1 持久化，但 turn 未闭
    await store.save('s1', crashStateSession('s1', { turnSeq: 1 }));
    // run 收尾 save 之前观察 store：锁「分配即持久化」而非收尾兜底（评审 M4）
    let seqBeforeRunEnd: unknown;
    const runner = makeRunner(store, provider, async () => {
      seqBeforeRunEnd = (await store.load('s1'))?.metadata.turnSeq;
    });

    await runTurn(runner, 's1');

    // 分配时刻（收尾 save 之前）计数器已落盘为 2
    expect(seqBeforeRunEnd).toBe(2);
    const session = await store.load('s1');
    const starts = countMarks(session!.messages, 'start');
    const ends = countMarks(session!.messages, 'end');
    // 续跑不复用 t1：分配 t2 并把计数器推进到 2
    expect(starts.get('t1')).toBe(1);
    expect(starts.get('t2')).toBe(1);
    expect(session!.metadata.turnSeq).toBe(2);
    // 修复器补闭 t1、收尾闭 t2：每个信封恰好一枚闭标
    expect(ends.get('t1')).toBe(1);
    expect(ends.get('t2')).toBe(1);
  });

  it('旧数据 id 复用（计数器丢失）时收尾幂等收养，不把 run 升级成 error', async () => {
    const provider = makeProvider();
    const store = new InMemorySessionStore();
    // 修复前遗留现场：turnSeq 丢失（续跑无可避免复用 t1），上一信封已被修复器补闭
    const session = crashStateSession('s2', {});
    session.messages.push({
      role: 'user',
      content: formatTurnEndContent('t1'),
      timestamp: Date.now(),
      metadata: { source: 'turnEnd', turnId: 't1' },
    });
    await store.save('s2', session);
    const runner = makeRunner(store, provider);

    // 事故行为：收尾 appendTurnEnd 撞已有闭标直接 throw，run 报 error（会话被中止）
    await expect(runTurn(runner, 's2')).resolves.toBeUndefined();

    const loaded = await store.load('s2');
    const starts = countMarks(loaded!.messages, 'start');
    const ends = countMarks(loaded!.messages, 'end');
    // 旧数据下 id 复用仍在（计数器无从恢复），但每个 turn_start 信封各有自己的闭标
    expect(starts.get('t1')).toBe(2);
    expect(ends.get('t1')).toBe(starts.get('t1'));
  });

  it('闭标幂等收养：同信封重复收尾只留一枚，历史闭标不挡新信封', async () => {
    const provider = makeProvider();
    const store = new InMemorySessionStore();
    const runner = makeRunner(store, provider);
    const appendTurnEnd = (
      runner as unknown as { appendTurnEnd(messages: Message[], turnId: string): void }
    ).appendTurnEnd.bind(runner);

    // 同信封二次收尾（曾经 throw turn_end already exists）：只留一枚闭标、不抛
    const once: Message[] = [turnStart('t1', 'x')];
    expect(() => {
      appendTurnEnd(once, 't1');
      appendTurnEnd(once, 't1');
    }).not.toThrow();
    expect(countMarks(once, 'end').get('t1')).toBe(1);

    // 同 id 的历史闭标属于上一个信封：新信封仍要补自己的闭标
    const reused: Message[] = [
      turnStart('t1', '旧信封'),
      {
        role: 'user',
        content: formatTurnEndContent('t1'),
        timestamp: Date.now(),
        metadata: { source: 'turnEnd', turnId: 't1' },
      },
      turnStart('t1', '新信封（旧数据 id 复用）'),
    ];
    appendTurnEnd(reused, 't1');
    expect(countMarks(reused, 'end').get('t1')).toBe(2);
  });
});
