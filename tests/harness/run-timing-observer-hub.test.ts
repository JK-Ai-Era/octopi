/**
 * run.timing → ObserverHub 端到端（F3-d P0/P1 回归锁）
 *
 * 曾经的缺陷：
 * P0——run.timing 事件缺 sessionId，被 hub.ingestEvent 入口直接丢弃（wait/build 生产恒空）；
 * P1——run_start/context_ready 发射早于 recordRunStart，首轮丢失、次轮起污染上一轮 run。
 * 直注 hub 的单点测试绕开了真实链路，挡不住这两个缺陷——本测试走 SessionAwareRunner.handle() 全链路。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import { ObserverHub } from '@octopi-agent/engine/harness/observability/observer/hub.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import type { Message } from '@octopi-agent/core/types.js';
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

/** 单 turn 脚本 agent（run.timing 发射在 handle() 内，与 agent 内部无关） */
function scriptedAgent(): Agent {
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
      opts?.context?.messages.push({ role: 'assistant', content: 'ans', timestamp: Date.now() });
      yield { type: 'turn_end', timestamp: Date.now(), hasToolCalls: false, phase: 'final', usage: undefined } as never;
      yield { type: 'agent_end', reason: 'completed', timestamp: Date.now() } as never;
    },
  } as unknown as Agent;
}

describe('run.timing → ObserverHub 全链路', () => {
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('三段 run.timing 进 hub timeline 且归属本 run；第二轮不污染上一轮', async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-run-timing-'));
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));
    const hub = new ObserverHub({ level: 'full' });
    const runner = new SessionAwareRunner(scriptedAgent(), {} as never, store);
    runner.setObserverHub(hub);

    const drive = async () => {
      for await (const _ev of runner.handle(
        's1',
        { role: 'user', content: 'hi', timestamp: Date.now() } as Message,
        { agentId: 'a1' } as never,
      )) {
        // drain
      }
    };

    await drive();
    const obs1 = hub.getRunObservatory('s1');
    const stages1 = (obs1?.timeline ?? [])
      .filter((t) => t.type === 'run.timing')
      .map((t) => t.timing?.stage);
    // P0：缺 sessionId 时这里会是 []（hub 入口丢弃）
    expect(stages1).toEqual(['run_start', 'context_ready', 'run_end']);
    const runStartRow = obs1?.timeline?.find(
      (t) => t.type === 'run.timing' && t.timing?.stage === 'run_start',
    );
    expect(typeof runStartRow?.timing?.waitMs).toBe('number');
    const contextRow = obs1?.timeline?.find(
      (t) => t.type === 'run.timing' && t.timing?.stage === 'context_ready',
    );
    expect(typeof contextRow?.timing?.buildMs).toBe('number');
    // security 通道无污染（run.timing 不属于 SECURITY_EVENT_TYPES）
    expect(obs1?.securityEvents ?? []).toHaveLength(0);

    // 第二轮：P1 跨 run 污染锁——上一轮 timeline 的 run.timing 数量恒为 3
    await drive();
    const obs2 = hub.getRunObservatory('s1');
    expect(obs2?.runId).not.toBe(obs1?.runId);
    const stages2 = (obs2?.timeline ?? [])
      .filter((t) => t.type === 'run.timing')
      .map((t) => t.timing?.stage);
    expect(stages2).toEqual(['run_start', 'context_ready', 'run_end']);

    const obs1After = hub.getRunById(obs1!.runId);
    expect(
      (obs1After?.timeline ?? []).filter((t) => t.type === 'run.timing'),
    ).toHaveLength(3);
  });
});
