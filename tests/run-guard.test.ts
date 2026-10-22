/**
 * DefaultRunGuard 测试
 */

import { describe, it, expect, vi } from 'vitest';
import { makeTokenUsage } from '@octopi-agent/core/types/turn.js';
import { DefaultRunGuard, createRunGuard } from '@octopi-agent/engine/harness/run/run-guard/default-run-guard.js';
import type { CheckpointContext, CheckpointMetrics } from '@octopi-agent/core/interfaces/run-guard.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';

// ── 工具函数 ──

function createMetrics(overrides?: Partial<CheckpointMetrics>): CheckpointMetrics {
  return {
    consecutiveErrors: 0,
    consecutiveSameTool: 0,
    tokenGrowthRate: 0,
    toolFailureRate: 0,
    uniqueToolsUsed: 3,
    hasProgress: true,
    ...overrides,
  };
}

function createContext(overrides?: Partial<CheckpointContext>): CheckpointContext {
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    iteration: 15,
    totalToolCalls: 10,
    nominalTotalTokens: 5000,
    elapsedMs: 30000,
    recentSummaries: [
      { role: 'assistant', contentPreview: 'Read file config.ts', toolCalls: ['file_read'], tokenDelta: 200, timestamp: Date.now() },
      { role: 'assistant', contentPreview: 'Analyzed structure', toolCalls: ['shell'], tokenDelta: 300, timestamp: Date.now() },
    ],
    metrics: createMetrics(),
    ...overrides,
  };
}

// ── 测试 ──

describe('DefaultRunGuard', () => {
  describe('硬上限检查', () => {
    it('默认不启用 Guard hardLimit（资源归 Budget）', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({ iteration: 5000, elapsedMs: 99_000_000 });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
    });

    it('应该在迭代数达到硬上限时停止', async () => {
      const runGuard = new DefaultRunGuard({ hardLimit: 100 });
      const ctx = createContext({ iteration: 100 });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('stop');
      expect(verdict.reason).toContain('硬上限');
      expect(verdict.userMessage).toBeDefined();
    });

    it('应该在时间达到上限时停止', async () => {
      const runGuard = new DefaultRunGuard({ hardWallClockMs: 60000 });
      const ctx = createContext({ elapsedMs: 60000 });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('stop');
      expect(verdict.reason).toContain('时间上限');
    });
  });

  describe('Layer 1: 规则检测', () => {
    it('应该检测无进展重复调用（同名 + 同参 + 同结果，高严重度）', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ consecutiveSameTool: 5, consecutiveIdenticalCalls: 5 }),
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.reason).toContain('连续 5 次');
      expect(verdict.recoveryActions).toBeDefined();
      expect(verdict.recoveryActions![0].type).toBe('inject_hint');
    });

    it('仅同名不同参不得判为循环（回归：编码 turn 连续调用 shell/file_edit）', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ consecutiveSameTool: 12, consecutiveIdenticalCalls: 1 }),
      });

      const verdict = await runGuard.checkpoint(ctx);

      // 连续 12 次同名工具但参数各异 = 正常推进，不得进入 recover/stop
      expect(verdict.action).toBe('continue');
    });

    it('应该检测同一错误反复重试（真 error loop）', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ consecutiveErrors: 3, consecutiveIdenticalFailures: 3 }),
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.reason).toContain('同一错误');
    });

    it('连续失败但错误各不相同（红-改-绿调试）不得判为 error loop', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ consecutiveErrors: 3, consecutiveIdenticalFailures: 1, hasProgress: true }),
      });

      const verdict = await runGuard.checkpoint(ctx);

      // 跑测试 A 红 → 修 → 跑测试 B 红 → 修：三次失败但每次错误不同，属正常调试
      expect(verdict.action).toBe('continue');
      expect(verdict.reason ?? '').not.toContain('error_loop');
    });

    it('连续 5 次不同错误仍不得判为 error loop（普通调试上限）', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ consecutiveErrors: 5, consecutiveIdenticalFailures: 1, hasProgress: true }),
      });

      expect((await runGuard.checkpoint(ctx)).action).toBe('continue');
    });

    it('兜底：连续 8 次不同错误（工具整体不可用）仍要拦', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ consecutiveErrors: 8, consecutiveIdenticalFailures: 1 }),
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.failureKind).toBe('blowup');
      expect(verdict.reason).toContain('连续 8 次工具调用失败');
    });

    it('同错误字段缺失时只走兜底，不退回「连续失败即循环」', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ consecutiveErrors: 3 }),
      });

      expect((await runGuard.checkpoint(ctx)).action).toBe('continue');
    });

    it('应该检测工具失败率高且无进展（真 thrash）', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ toolFailureRate: 0.6, toolCallsInWindow: 10, hasProgress: false }),
        recentSummaries: [
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
        ],
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.reason).toContain('失败率');
    });

    it('高失败率但有进展（TDD：测试红 / 编辑成功交替）不得判为 thrash', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ toolFailureRate: 0.6, toolCallsInWindow: 10, hasProgress: true }),
        recentSummaries: [
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
        ],
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
      expect(verdict.reason ?? '').not.toContain('失败率');
    });

    it('窗口样本过小（2 次全失败 = 100%）不得判为 thrash', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ toolFailureRate: 1, toolCallsInWindow: 2, hasProgress: false }),
        recentSummaries: [
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
        ],
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
    });

    it('样本量字段缺失时不得退回旧判据（宁可漏报不误杀）', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ toolFailureRate: 0.9, hasProgress: false }),
        recentSummaries: [
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
        ],
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
    });

    it('应该检测 token 暴涨', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ tokenGrowthRate: 0.6 }),
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.reason).toContain('Token');
      expect(verdict.recoveryActions).toBeDefined();
      expect(verdict.recoveryActions![0].type).toBe('truncate_context');
    });

    it('正常运行时应该返回 continue', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext();

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
      expect(verdict.reason).toContain('正常');
    });
  });

  describe('Layer 2: LLM 审查', () => {
    it('应该在规则层正常时调用 LLM 审查', async () => {
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockResolvedValue({ content: 'OK', model: 'mock', usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }) }),
        stream: async function* () { yield { type: 'done' }; },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    getModelInfos: () => [],
      };

      const runGuard = new DefaultRunGuard(
        { enableLLMReview: true, llmReviewInterval: 1 },
        mockModel,
      );
      const ctx = createContext();

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
      expect(mockModel.chat).toHaveBeenCalled();
    });

    it('LLM 返回 STOP 时应该停止', async () => {
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockResolvedValue({ content: 'STOP: Agent is stuck in a loop', model: 'mock', usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }) }),
        stream: async function* () { yield { type: 'done' }; },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    getModelInfos: () => [],
      };

      const runGuard = new DefaultRunGuard(
        { enableLLMReview: true, llmReviewInterval: 1 },
        mockModel,
      );
      const ctx = createContext();

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('stop');
      expect(verdict.userMessage).toContain('stuck');
    });

    it('LLM 返回 CONCERN 时应该恢复', async () => {
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockResolvedValue({ content: 'CONCERN: Agent seems to be repeating', model: 'mock', usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }) }),
        stream: async function* () { yield { type: 'done' }; },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    getModelInfos: () => [],
      };

      const runGuard = new DefaultRunGuard(
        { enableLLMReview: true, llmReviewInterval: 1 },
        mockModel,
      );
      const ctx = createContext();

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.recoveryActions).toBeDefined();
    });

    it('LLM 调用失败时应该不影响主循环', async () => {
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockRejectedValue(new Error('API error')),
        stream: async function* () { yield { type: 'done' }; },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    getModelInfos: () => [],
      };

      const runGuard = new DefaultRunGuard(
        { enableLLMReview: true, llmReviewInterval: 1 },
        mockModel,
      );
      const ctx = createContext();

      const verdict = await runGuard.checkpoint(ctx);

      // 应该返回 continue（规则层正常，LLM 失败被忽略）
      expect(verdict.action).toBe('continue');
    });
  });

  describe('自适应间隔', () => {
    it('正常运行时应该建议放宽间隔', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({ iteration: 15 });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
      expect(verdict.nextCheckpointIn).toBeGreaterThan(15);
    });

    it('异常恢复时应该建议收紧间隔', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false, minCheckpointInterval: 5 });
      const ctx = createContext({
        iteration: 30,
        metrics: createMetrics({ consecutiveIdenticalCalls: 5 }),
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.nextCheckpointIn).toBeDefined();
      expect(verdict.nextCheckpointIn!).toBeLessThanOrEqual(30);
    });
  });

  describe('恢复升级阶梯', () => {
    it('同一 failureKind 连续 recover 3 次后应 stop', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const recoveryHistory = Array.from({ length: 3 }, (_, i) => ({
        iteration: i + 1,
        actionType: 'inject_hint' as const,
        reason: 'loop',
        failureKind: 'loop' as const,
        timestamp: Date.now(),
      }));
      const ctx = createContext({
        metrics: createMetrics({ consecutiveIdenticalCalls: 5 }),
        recoveryHistory,
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('stop');
      expect(verdict.failureKind).toBe('loop');
      expect(verdict.userMessage).toBeDefined();
    });

    it('第 3 次 recover 前建议 clear_recent_turns', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const recoveryHistory = Array.from({ length: 2 }, (_, i) => ({
        iteration: i + 1,
        actionType: 'inject_hint' as const,
        reason: 'loop',
        failureKind: 'loop' as const,
        timestamp: Date.now(),
      }));
      const ctx = createContext({
        metrics: createMetrics({ consecutiveIdenticalCalls: 5 }),
        recoveryHistory,
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.recoveryActions?.[0].type).toBe('clear_recent_turns');
    });

    it('external critical 信号触发 loop 恢复', async () => {
      const runGuard = new DefaultRunGuard({ enableLLMReview: false });
      const ctx = createContext({
        externalSignals: [
          { source: 'tool_loop', level: 'critical', detail: 'no progress x20' },
        ],
      });

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.failureKind).toBe('loop');
    });
  });

  describe('工厂函数', () => {
    it('createRunGuard 应该创建实例', () => {
      const runGuard = createRunGuard();
      expect(runGuard).toBeInstanceOf(DefaultRunGuard);
    });

    it('应该接受配置和模型', () => {
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn(),
        stream: async function* () { yield { type: 'done' }; },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    getModelInfos: () => [],
      };

      const runGuard = createRunGuard({ checkpointInterval: 10 }, mockModel);
      expect(runGuard).toBeInstanceOf(DefaultRunGuard);
    });
  });

  describe('onCheckpoint 回调', () => {
    it('应该在每次检查点调用回调', async () => {
      const callback = vi.fn();
      const runGuard = new DefaultRunGuard({
        enableLLMReview: false,
        onCheckpoint: callback,
      });
      const ctx = createContext();

      await runGuard.checkpoint(ctx);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: 'continue' }));
    });

    it('回调异常不应影响主循环', async () => {
      const callback = vi.fn().mockImplementation(() => { throw new Error('callback error'); });
      const runGuard = new DefaultRunGuard({
        enableLLMReview: false,
        onCheckpoint: callback,
      });
      const ctx = createContext();

      const verdict = await runGuard.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
    });
  });

  describe('Builder 自动接入', () => {
    it('无参 runGuard() 应该自动创建 DefaultRunGuard', async () => {
      const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockResolvedValue({ content: 'Hello!', model: 'mock', usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }) }),
        stream: async function* () {
          yield { type: 'content', content: 'Hello!' };
          yield { type: 'done', usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }) };
        },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    getModelInfos: () => [],
      };

      const { agent, harness } = await new AgentBuilder()
        .model(mockModel)
        .runGuard()
        .buildAgent();

      // harness 应该有 runGuard
      expect(harness.runGuard).toBeDefined();
    });

    it('config 形式 runGuard({}) 应该自动接入 model', async () => {
      const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockResolvedValue({ content: 'OK', model: 'mock', usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }) }),
        stream: async function* () {
          yield { type: 'content', content: 'OK' };
          yield { type: 'done', usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }) };
        },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
    getModelInfos: () => [],
      };

      const { agent, harness } = await new AgentBuilder()
        .model(mockModel)
        .runGuard({ enableLLMReview: false })
        .buildAgent();

      expect(harness.runGuard).toBeDefined();
    });
  });
});
