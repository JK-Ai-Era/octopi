/**
 * 引擎主动停止：判据正确性 + 可见性
 *
 * 三个不变式：
 * 1. 「连续同名工具」不是循环判据——编码 turn 会连续调用 shell/file_edit，
 *    参数各异即正常推进；只有「名 + 参数 + 结果」全同才是无进展。
 * 2. 引擎有权终止 turn，就必须留下用户可见原因（runStopped 消息 + metadata）。
 * 3. run 收口必须留 [timing] stage=run_end 痕迹（原因可事后定位）。
 */

import { describe, it, expect } from 'vitest';
import { makeTokenUsage } from '@octopi-agent/core/types/turn.js';
import { DefaultRunGuard } from '@octopi-agent/engine/harness/run/run-guard/default-run-guard.js';
import { RunMetricsCollector } from '@octopi-agent/engine/harness/run/reliability/run-metrics-collector.js';
import { adaptLoopEvent } from '@octopi-agent/engine/harness/run/runner.js';
import { Agent } from '@octopi-agent/engine/harness/run/agent/agent.js';
import { runAgentWithReliability } from '@octopi-agent/engine/harness/run/reliability/run-agent.js';
import type { ReliabilityHarness } from '@octopi-agent/engine/harness/run/reliability/run-agent.js';
import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '@octopi-agent/core/interfaces/model-provider.js';
import { ConversationAdapter } from '@octopi-agent/gateway/web/conversation/adapter.js';
import { isEngineCarrierSource } from '@octopi-agent/engine/harness/context/layer-types.js';
import type { AgentTool } from '@octopi-agent/core/loop/types.js';
import type { MessageRecord } from '@octopi-agent/gateway/web/sdk/client.js';
import type { SystemConversationItem } from '@octopi-agent/gateway/web/conversation/types.js';

function buildHistoryItemsFixture(messages: MessageRecord[]) {
  return ConversationAdapter.buildHistoryItems(messages, 's1');
}

function createSequentialProvider(responses: LLMResponse[]): ModelProvider {
  let callIndex = 0;
  return {
    name: 'test',
    defaultModel: 'test',
    getModelInfo: () => null,
    async chat(): Promise<LLMResponse> {
      return responses[Math.min(callIndex++, responses.length - 1)];
    },
    async *stream(_request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
      const r = responses[Math.min(callIndex++, responses.length - 1)];
      if (r.toolCalls?.length) {
        for (let i = 0; i < r.toolCalls.length; i++) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: r.toolCalls[i].id,
              name: r.toolCalls[i].name,
              arguments: JSON.stringify(r.toolCalls[i].arguments),
              index: i,
            },
          };
        }
      }
      if (r.content) yield { type: 'content', content: r.content };
      yield { type: 'done', usage: r.usage };
    },
    async isAvailable() {
      return true;
    },
    getModelInfos: () => [],
  };
}

function createHarness(
  overrides?: Partial<
    import('@octopi-agent/engine/harness/run/reliability/run-agent.js').ReliabilityConfig
  >,
): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
      ...overrides,
    },
  };
}

const meta = { agentId: 'a1', sessionId: 's1' };

function newState() {
  return { assistantContent: '', lastUserContent: 'hi' } as {
    assistantContent: string;
    lastUserContent?: string;
    stopReason?: string;
    stopMessage?: string;
    stopDetail?: string;
    loopEndReason?: string;
  };
}

describe('① 循环判据：同名 ≠ 循环', () => {
  it('连续 10 次 shell 但参数各异 → consecutiveIdenticalCalls 保持 1', () => {
    const c = new RunMetricsCollector();
    for (let i = 0; i < 10; i++) {
      c.recordToolResult('shell', true, false, {
        args: { command: `npm run typecheck -- --batch=${i}` },
        result: `batch ${i} ok`,
      });
    }
    const ctx = c.buildContext({});
    expect(ctx.metrics.consecutiveSameTool).toBe(10);
    expect(ctx.metrics.consecutiveIdenticalCalls).toBe(1);
  });

  it('同名 + 同参 + 同结果 → 累加', () => {
    const c = new RunMetricsCollector();
    for (let i = 0; i < 6; i++) {
      c.recordToolResult('file_read', true, false, {
        args: { path: '/x/a.ts' },
        result: 'same bytes',
      });
    }
    expect(c.buildContext({}).metrics.consecutiveIdenticalCalls).toBe(6);
  });

  it('同参但结果不同 → 视为有进展', () => {
    const c = new RunMetricsCollector();
    for (let i = 0; i < 6; i++) {
      c.recordToolResult('shell', true, false, {
        args: { command: 'tail log' },
        result: `line ${i}`,
      });
    }
    expect(c.buildContext({}).metrics.consecutiveIdenticalCalls).toBe(1);
  });

  it('RunGuard：连续 12 次同名（参数不同）不得 recover/stop', async () => {
    const c = new RunMetricsCollector();
    for (let i = 0; i < 12; i++) {
      c.recordToolResult('shell', true, false, {
        args: { command: `step-${i}` },
        result: `out-${i}`,
      });
    }
    const guard = new DefaultRunGuard({ enableLLMReview: false });
    const verdict = await guard.checkpoint(c.buildContext({}));
    expect(verdict.action).toBe('continue');
  });

  it('RunGuard：完全相同调用 5 次 → recover（loop）', async () => {
    const c = new RunMetricsCollector();
    for (let i = 0; i < 5; i++) {
      c.recordToolResult('file_read', true, false, {
        args: { path: '/x/a.ts' },
        result: 'same',
      });
    }
    const guard = new DefaultRunGuard({ enableLLMReview: false });
    const verdict = await guard.checkpoint(c.buildContext({}));
    expect(verdict.action).toBe('recover');
    expect(verdict.failureKind).toBe('loop');
  });

  it('loopDetection 关闭时指标仍喂给 RunGuard（集成：走 runAgentWithReliability）', async () => {
    const provider = createSequentialProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'file_read', arguments: { path: '/a.ts' } }],
        usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }),
        model: 'test',
        finishReason: 'tool_calls',
      },
      {
        content: 'done',
        usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }),
        model: 'test',
        finishReason: 'stop',
      },
    ]);

    const tools: AgentTool[] = [
      {
        name: 'file_read',
        description: 'Read a file',
        parameters: {
          type: 'object' as const,
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        execute: async (id: string, args: unknown) => ({
          toolCallId: id,
          name: 'file_read',
          content: `constant body of ${(args as { path: string }).path}`,
        }),
      },
    ];

    const agent = new Agent({ model: provider, systemPrompt: 'x', tools });
    agent.context.messages = [{ role: 'user', content: 'go', timestamp: Date.now() }];

    let guardMetrics: Record<string, number> | undefined;
    let guardTotalToolCalls: number | undefined;
    const harness: ReliabilityHarness = {
      ...createHarness({ loopDetection: { enabled: false }, checkpointInterval: 1 }),
      runGuard: {
        checkpoint: async (ctx: { metrics: Record<string, number>; totalToolCalls: number }) => {
          guardMetrics = ctx.metrics;
          guardTotalToolCalls = ctx.totalToolCalls;
          return { action: 'continue' as const };
        },
      },
    } as unknown as ReliabilityHarness;

    for await (const _event of runAgentWithReliability(agent.context, { model: agent.model }, harness)) {
      void _event;
    }

    // loopDetection 关闭时指标仍必须落到 Guard（否则判据永远为 0，静默失效）
    expect(guardMetrics).toBeDefined();
    expect(guardTotalToolCalls).toBeGreaterThanOrEqual(1);
    expect(guardMetrics?.consecutiveIdenticalCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('② 停止必须可见：桥接捕获原因', () => {
  it('run_guard_stopped → stopReason/stopMessage/stopDetail 全部捕获', () => {
    const state = newState();
    adaptLoopEvent(
      {
        type: 'run_guard_stopped',
        timestamp: 1,
        data: { reason: '连续 5 次相同调用', userMessage: '监督器已停止本轮' },
      },
      meta,
      state,
    );
    expect(state.stopReason).toBe('behavior_stopped');
    expect(state.stopMessage).toBe('监督器已停止本轮');
    expect(state.stopDetail).toBe('连续 5 次相同调用');
  });

  it('budget.exceeded → policy_stopped + 用户消息', () => {
    const state = newState();
    adaptLoopEvent(
      {
        type: 'budget.exceeded',
        timestamp: 1,
        metric: 'policy',
        unit: 'wall_clock_ms',
        userMessage: '预算策略接近上限，已停止',
      },
      meta,
      state,
    );
    expect(state.stopReason).toBe('policy_stopped');
    expect(state.stopMessage).toBe('预算策略接近上限，已停止');
    expect(state.stopDetail).toBe('policy/wall_clock_ms');
  });

  it('security_blocked → security_stopped 且带兜底文案', () => {
    const state = newState();
    adaptLoopEvent(
      { type: 'security_blocked', timestamp: 1, data: { reason: 'blocked' } },
      meta,
      state,
    );
    expect(state.stopReason).toBe('security_stopped');
    expect(state.stopMessage).toBeTruthy();
  });

  it('userMessage 缺失时仍保留 stopReason（不得丢失可见性）', () => {
    const state = newState();
    adaptLoopEvent(
      { type: 'run_guard_stopped', timestamp: 1, data: { reason: 'loop' } },
      meta,
      state,
    );
    expect(state.stopReason).toBe('behavior_stopped');
    expect(state.stopDetail).toBe('loop');
  });

  it('budget_exceeded（旧形状）→ policy_stopped + 可读原因', () => {
    const state = newState();
    adaptLoopEvent(
      { type: 'budget_exceeded', timestamp: 1, data: { reason: 'iteration' } },
      meta,
      state,
    );
    expect(state.stopReason).toBe('policy_stopped');
    expect(state.stopDetail).toBe('iteration');
    expect(state.stopMessage).toContain('迭代次数');
  });

  it('只记录真实终止：agent_end.reason 决定是否「提前停止」', () => {
    const stopped = newState();
    adaptLoopEvent({ type: 'agent_end', reason: 'should_stop', timestamp: 2 }, meta, stopped);
    expect(stopped.loopEndReason).toBe('should_stop');

    // 单次安全拦截后 run 继续跑完 → completed，不得当成停止
    const blockedThenDone = newState();
    adaptLoopEvent(
      { type: 'security_blocked', timestamp: 1, data: { reason: 'blocked' } },
      meta,
      blockedThenDone,
    );
    adaptLoopEvent({ type: 'agent_end', reason: 'completed', timestamp: 2 }, meta, blockedThenDone);
    expect(blockedThenDone.loopEndReason).toBe('completed');
    expect(blockedThenDone.loopEndReason).not.toBe('should_stop');
  });
});

describe('② 停止消息在聊天回放可见', () => {
  it('runStopped 渲染为 warning 系统条，不冒充用户气泡', () => {
    const items = buildHistoryItemsFixture([
      {
        role: 'user',
        content: '引擎监督器判定停止（连续 5 次相同调用）：任务已停止',
        timestamp: 1,
        metadata: { source: 'runStopped', turnId: 't2', stopReason: 'behavior_stopped' },
      },
    ]);
    expect(items).toHaveLength(1);
    const item = items[0] as SystemConversationItem;
    expect(item.role).toBe('system');
    expect(item.kind).toBe('warning');
    expect(item.message).toContain('判定停止');
  });

  it('turnEnd 仍隐藏（引擎载体不进回放）', () => {
    const items = buildHistoryItemsFixture([
      { role: 'user', content: '<turn_end id="t2"/>', timestamp: 1, metadata: { source: 'turnEnd' } },
    ]);
    expect(items).toHaveLength(0);
  });

  it('runStopped 是引擎载体：不得被当成真实用户发言', () => {
    // isMidTurn / grounding / aging 都以此判定 turn 边界；
    // 若 runStopped 被当作真实用户，停止后会凭空开一个新 turn。
    expect(isEngineCarrierSource('runStopped')).toBe(true);
    expect(isEngineCarrierSource('turnEnd')).toBe(true);
    expect(isEngineCarrierSource('user')).toBe(false);
  });
});
