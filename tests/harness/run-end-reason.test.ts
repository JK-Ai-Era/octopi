/**
 * run 收尾原因口径回归锁
 *
 * 事故（2026-10-27）：LLM 调用彻底失败时，Loop 只设 `agent_end.reason='error'`、
 * 不设 `stopReason`，于是 `observerEndReason = stopReason ?? (hasTurnEnd ? 'completed' : ...)`
 * 把一次 52 分钟的失败 run 记成 `reason=completed`——run.timing / Observer / 指标全部失真，
 * 事故在监控里隐身。本测试锁住「错误必须记成 error」。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
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

/**
 * 按给定终态产出事件的 agent
 *
 * @param reason - agent_end 的 reason
 * @param withTurnEnd - 是否先产出 turn_end（模拟「重试轮已闭标」的真实形态）
 */
function scriptedAgent(reason: 'completed' | 'error' | 'aborted', withTurnEnd: boolean): Agent {
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
      opts?.context?.messages.push({ role: 'assistant', content: 'partial', timestamp: Date.now() });
      if (withTurnEnd) {
        yield {
          type: 'turn_end',
          timestamp: Date.now(),
          hasToolCalls: false,
          phase: 'final',
          error: true,
          usage: undefined,
        } as never;
      }
      yield { type: 'agent_end', reason, timestamp: Date.now(), error: new Error('upstream timeout') } as never;
    },
  } as unknown as Agent;
}

interface RunEndRow {
  type: string;
  data?: { stage?: string; reason?: string; loopEnd?: string };
}

describe('run 收尾原因', () => {
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function runOnce(reason: 'completed' | 'error' | 'aborted', withTurnEnd: boolean): Promise<RunEndRow[]> {
    home = await mkdtemp(join(tmpdir(), 'octopi-run-end-reason-'));
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));
    const captured: RunEndRow[] = [];
    const runner = new SessionAwareRunner(
      scriptedAgent(reason, withTurnEnd),
      {} as never,
      store,
      {
        eventSink: (event: RunEndRow) => captured.push(event),
      } as never,
    );

    for await (const _ev of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() } as Message,
      { agentId: 'a1' } as never,
    )) {
      // drain
    }
    return captured.filter((e) => e.type === 'run.timing' && e.data?.stage === 'run_end');
  }

  it('agent_end.reason=error 且已闭标时，run_end 记 error（不再冒充 completed）', async () => {
    const rows = await runOnce('error', true);
    expect(rows).toHaveLength(1);
    expect(rows[0].data?.reason).toBe('error');
    expect(rows[0].data?.loopEnd).toBe('error');
  });

  it('agent_end.reason=error 且未闭标时，run_end 仍记 error', async () => {
    const rows = await runOnce('error', false);
    expect(rows[0].data?.reason).toBe('error');
  });

  it('model_retry 桥接为 engine.model_retry 且字段完整（否则前端收不到重试）', async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-model-retry-bridge-'));
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));

    // 直接按 harness 事件形状产出（runner 消费的正是 runAgentWithReliability 的输出流）
    const agent = {
      ...(scriptedAgent('completed', true) as unknown as Record<string, unknown>),
      context: { systemPrompt: '', messages: [] as Message[], tools: [] },
      run: async function* () {
        yield {
          type: 'model_retry',
          timestamp: Date.now(),
          data: {
            attempt: 2,
            maxAttempts: 3,
            reason: 'timeout',
            delayMs: 3000,
            error: 'upstream silence',
          },
        } as never;
        yield {
          type: 'turn_end',
          timestamp: Date.now(),
          hasToolCalls: false,
          phase: 'final',
          usage: undefined,
        } as never;
        yield { type: 'agent_end', reason: 'completed', timestamp: Date.now() } as never;
      },
    } as unknown as Agent;

    const captured: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const runner = new SessionAwareRunner(agent, {} as never, store, {
      events: { emit: () => {} },
      eventSink: (e: { type: string; data?: Record<string, unknown> }) => captured.push(e),
    } as never);

    for await (const _ev of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() } as Message,
      { agentId: 'a1' } as never,
    )) {
      // drain
    }

    const bridged = captured.find((e) => e.type === 'engine.model_retry');
    expect(bridged).toBeDefined();
    expect(bridged?.data).toMatchObject({
      attempt: 2,
      maxAttempts: 3,
      reason: 'timeout',
      delayMs: 3000,
      error: 'upstream silence',
    });
    // 重试不是终态：不得把 stopReason 改成 error
    const end = captured.find(
      (e) => e.type === 'run.timing' && (e.data as { stage?: string } | undefined)?.stage === 'run_end',
    );
    expect((end?.data as { reason?: string } | undefined)?.reason).toBe('completed');
  });

  it('正常完成仍记 completed（不得把成功误判为失败）', async () => {
    const rows = await runOnce('completed', true);
    expect(rows[0].data?.reason).toBe('completed');
  });
});
