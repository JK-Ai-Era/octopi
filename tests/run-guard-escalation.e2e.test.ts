/**
 * RunGuard recover → 升级 stop 集成路径
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultRunGuard } from '../src/harness/run-guard/default-run-guard.js';
import type { CheckpointContext } from '../src/core/interfaces/run-guard.js';
import { RunMetricsCollector } from '../src/harness/reliability/run-metrics-collector.js';

function metricsStuck() {
  return {
    consecutiveErrors: 0,
    consecutiveSameTool: 6,
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

  it('LLM 审查 prompt 含 recoveryHistory', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: 'OK',
      model: 'mock',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const model = {
      name: 'mock',
      chat,
      stream: async function* () {
        yield { type: 'done' as const };
      },
      isAvailable: async () => true,
      getModelInfo: () => null,
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
