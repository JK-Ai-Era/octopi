/**
 * RunGuard recover → 升级 stop 集成路径
 */

import { describe, it, expect, vi } from 'vitest';
import { makeTokenUsage } from '@octopi-agent/core/types/turn.js';
import { DefaultRunGuard } from '@octopi-agent/engine/harness/run/run-guard/default-run-guard.js';
import type { CheckpointContext } from '@octopi-agent/core/interfaces/run-guard.js';
import { RunMetricsCollector } from '@octopi-agent/engine/harness/run/reliability/run-metrics-collector.js';

function metricsStuck() {
  return {
    consecutiveErrors: 0,
    consecutiveSameTool: 6,
    consecutiveIdenticalCalls: 6,
    tokenGrowthRate: 0,
    toolFailureRate: 0.2,
    uniqueToolsUsed: 1,
    hasProgress: false,
    noopStreak: 0,
  };
}

function ctxWithHistory(
  collector: RunMetricsCollector,
  history: CheckpointContext['recoveryHistory'],
): CheckpointContext {
  const base = collector.buildContext({});
  return { ...base, metrics: { ...base.metrics, ...metricsStuck() }, recoveryHistory: history };
}

describe('Guard recover → escalate stop（e2e 式）', () => {
  it('连续 3 次 loop recover 后 stop，且 userMessage 可读', async () => {
    const guard = new DefaultRunGuard({ enableLLMReview: false, checkpointInterval: 5 });
    const collector = new RunMetricsCollector();
    const history: NonNullable<CheckpointContext['recoveryHistory']> = [];

    // recover ×3（写入 recoveryHistory）
    for (let i = 0; i < 3; i++) {
      const v = await guard.checkpoint(ctxWithHistory(collector, history));
      expect(v.action).toBe('recover');
      expect(v.failureKind).toBe('loop');
      const actions =
        v.recoveryActions && v.recoveryActions.length > 0
          ? v.recoveryActions
          : [{ type: 'inject_hint' as const, hint: v.reason }];
      for (const a of actions) {
        history.push({
          iteration: i + 1,
          actionType: a.type,
          reason: v.reason,
          failureKind: v.failureKind,
          timestamp: Date.now(),
        });
      }
    }

    // 第 4 次仍 loop → stop（同一 failureKind 连续 3 次 recover 后升级）
    const stop = await guard.checkpoint(ctxWithHistory(collector, history));
    expect(stop.action).toBe('stop');
    expect(stop.failureKind).toBe('loop');
    expect(stop.userMessage).toBeTruthy();
  });

  it('小样本失败率高但有进展：不得判 thrash（旧判据会 recover）', async () => {
    // 真实调试节奏：连续跑两个测试都红，然后一次编辑成功。
    // 窗口只有 3 条记录 → 失败率 67%，但模型确实在推进。
    // 旧判据（只看 toolFailureRate > 0.5）会判 thrash → recover，
    // 同 kind 连续 3 次时还会 clear_recent_turns，抹掉刚做完的进度。
    const guard = new DefaultRunGuard({ enableLLMReview: false, checkpointInterval: 5 });
    const collector = new RunMetricsCollector();
    for (let i = 0; i < 3; i++) {
      collector.recordTurn({
        role: 'assistant',
        contentPreview: '',
        tokenDelta: 0,
        timestamp: Date.now(),
      });
    }
    collector.recordToolResult('shell', false, false, {
      args: { command: 'npx vitest run test-a' },
      result: { exitCode: 1 },
    });
    collector.recordToolResult('shell', false, false, {
      args: { command: 'npx vitest run test-b' },
      result: { exitCode: 1 },
    });
    collector.recordToolResult('file_edit', true, false, {
      args: { path: 'a.ts' },
      result: { ok: true },
    });

    const ctx = collector.buildContext({});
    // 前提：失败率确实过半，样本确实很小，且确实有进展
    expect(ctx.metrics.toolFailureRate).toBeGreaterThan(0.5);
    expect(ctx.metrics.toolCallsInWindow).toBe(3);
    expect(ctx.metrics.hasProgress).toBe(true);

    const verdict = await guard.checkpoint(ctx);
    expect(verdict.action).toBe('continue');
  });

  it('collector 必须填充 toolCallsInWindow（否则失败率判据静默失效）', () => {
    const collector = new RunMetricsCollector();
    collector.recordToolResult('shell', true, false, { args: { command: 'a' }, result: { ok: true } });
    collector.recordToolResult('shell', false, false, { args: { command: 'b' }, result: { exitCode: 1 } });
    const ctx = collector.buildContext({});
    expect(ctx.metrics.toolCallsInWindow).toBe(2);
  });

  it('LLM 审查 prompt 含 recoveryHistory', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: 'OK',
      model: 'mock',
      usage: makeTokenUsage({ promptTokens: 1, completionTokens: 1 }),
    });
    const model = {
      name: 'mock',
      chat,
      stream: async function* () {
        yield { type: 'done' as const };
      },
      isAvailable: async () => true,
      getModelInfo: () => null,
    getModelInfos: () => [],
    };
    const guard = new DefaultRunGuard(
      { enableLLMReview: true, llmReviewInterval: 1 },
      model,
    );
    const collector = new RunMetricsCollector();
    const ctx = collector.buildContext({});
    ctx.recoveryHistory = [
      {
        iteration: 10,
        actionType: 'inject_hint',
        reason: 'loop hint',
        failureKind: 'loop',
        timestamp: Date.now(),
      },
    ];

    await guard.checkpoint(ctx);

    expect(chat).toHaveBeenCalled();
    const prompt = (chat.mock.calls[0][0] as { messages: Array<{ content: string }> })
      .messages[0].content;
    expect(prompt).toContain('最近恢复尝试');
    expect(prompt).toContain('loop hint');
  });
});
