/**
 * 校准样本新鲜配对红线（arch/context-size-accounting.md §10.14）
 *
 * 事故（2026-11-06，session default-web-1793699728105）：step_end 缺 usage
 * （失败/重试/中止步）时 runner 把 lastUsage（上一步实测）传给 notifyAfterStep，
 * ContextSizeLedger 收到「陈旧实测 × 当步估算」错配样本（实测 raw=0.088/11.014
 * 双向垃圾样本），ratio 在 clamp 两端震荡、决策读数虚高 3 倍 → 假 85% 压力停跑。
 * 本测试锁住「notifyAfterStep 只传本步新鲜 usage；缺 usage 传 undefined」。
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
import { makeTokenUsage, type TokenUsage } from '@octopi-agent/core/types/step.js';

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
    steps: [],
    metadata: {},
    tasks: [],
  };
}

/**
 * 按给定 usage 序列产出 step_end 的 agent（undefined = 该步缺 usage，如失败/重试/中止步）
 *
 * @param usages - 每个 step_end 携带的 usage 序列
 * @param captured - notifyAfterStep 收到的 usage（含 undefined）按调用序记录
 */
function scriptedAgent(usages: Array<TokenUsage | undefined>, captured: Array<TokenUsage | undefined>): Agent {
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
    setOnAfterStep: () => {},
    notifyAfterStep: async (usage?: TokenUsage) => {
      captured.push(usage);
    },
    run: async function* (
      _s?: AbortSignal,
      _h?: unknown,
      opts?: { context?: { messages: Message[] } },
    ) {
      opts?.context?.messages.push({ role: 'assistant', content: 'partial', timestamp: Date.now() });
      for (const usage of usages) {
        yield {
          type: 'step_end',
          timestamp: Date.now(),
          hasToolCalls: false,
          phase: 'final',
          // 真实形状：缺 usage 的 step_end 是失败/重试步，error 为 true（StepEndEvent 契约）
          error: usage === undefined,
          usage,
        } as never;
      }
      yield { type: 'agent_end', reason: 'completed', timestamp: Date.now() } as never;
    },
  } as unknown as Agent;
}

describe('afterStep usage 新鲜配对（§10.14 红线）', () => {
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  /**
   * 跑一轮并返回 notifyAfterStep 捕获的 usage 序列
   *
   * @param usages - 每个 step_end 携带的 usage 序列
   */
  async function runOnce(usages: Array<TokenUsage | undefined>): Promise<Array<TokenUsage | undefined>> {
    home = await mkdtemp(join(tmpdir(), 'octopi-afterstep-pairing-'));
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));
    const captured: Array<TokenUsage | undefined> = [];
    const runner = new SessionAwareRunner(
      scriptedAgent(usages, captured),
      {} as never,
      store,
      { eventSink: () => {} } as never,
    );
    for await (const _ev of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() } as Message,
      { agentId: 'a1' } as never,
    )) {
      // drain
    }
    return captured;
  }

  it('缺 usage 的 step 不得携带上一步实测（lastUsage 不得漏入校准喂样）', async () => {
    const freshA = makeTokenUsage({ promptTokens: 100, completionTokens: 1 });
    const freshB = makeTokenUsage({ promptTokens: 200, completionTokens: 1 });
    const captured = await runOnce([freshA, undefined, freshB]);
    expect(captured).toHaveLength(3);
    expect(captured[0]).toBe(freshA); // 首步新鲜 usage 原样传递（同一性，防错传别步用量）
    expect(captured[1]).toBeUndefined(); // 核心断言：缺 usage 步不得携带 freshA
    expect(captured[2]).toBe(freshB); // 后续新鲜 usage 同一性
  });

  it('首个 step 就缺 usage 时传 undefined（不得凭空产出样本）', async () => {
    const captured = await runOnce([undefined, undefined]);
    expect(captured).toEqual([undefined, undefined]);
  });
});
