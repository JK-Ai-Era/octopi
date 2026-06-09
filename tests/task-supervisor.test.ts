/**
 * DefaultTaskSupervisor 测试
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultTaskSupervisor, createTaskSupervisor } from '../src/harness/supervisor/task-supervisor.js';
import type { CheckpointContext, CheckpointMetrics } from '../src/core/interfaces/task-supervisor.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';

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
    totalTokens: 5000,
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

describe('DefaultTaskSupervisor', () => {
  describe('硬上限检查', () => {
    it('应该在迭代数达到硬上限时停止', async () => {
      const supervisor = new DefaultTaskSupervisor({ hardLimit: 100 });
      const ctx = createContext({ iteration: 100 });

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('stop');
      expect(verdict.reason).toContain('硬上限');
      expect(verdict.userMessage).toBeDefined();
    });

    it('应该在时间达到上限时停止', async () => {
      const supervisor = new DefaultTaskSupervisor({ hardWallClockMs: 60000 });
      const ctx = createContext({ elapsedMs: 60000 });

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('stop');
      expect(verdict.reason).toContain('时间上限');
    });
  });

  describe('Layer 1: 规则检测', () => {
    it('应该检测重复工具循环（高严重度）', async () => {
      const supervisor = new DefaultTaskSupervisor({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ consecutiveSameTool: 5 }),
      });

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.reason).toContain('连续 5 次');
      expect(verdict.recoveryActions).toBeDefined();
      expect(verdict.recoveryActions![0].type).toBe('inject_hint');
    });

    it('应该检测重复工具循环（中严重度）', async () => {
      const supervisor = new DefaultTaskSupervisor({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ consecutiveSameTool: 3 }),
      });

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.reason).toContain('连续 3 次');
    });

    it('应该检测错误循环', async () => {
      const supervisor = new DefaultTaskSupervisor({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ consecutiveErrors: 3 }),
      });

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.reason).toContain('错误');
    });

    it('应该检测工具失败率高', async () => {
      const supervisor = new DefaultTaskSupervisor({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ toolFailureRate: 0.6 }),
        recentSummaries: [
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
          { role: 'tool', contentPreview: 'error', toolErrors: ['shell'], tokenDelta: 0, timestamp: Date.now() },
        ],
      });

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.reason).toContain('失败率');
    });

    it('应该检测 token 暴涨', async () => {
      const supervisor = new DefaultTaskSupervisor({ enableLLMReview: false });
      const ctx = createContext({
        metrics: createMetrics({ tokenGrowthRate: 0.6 }),
      });

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.reason).toContain('Token');
      expect(verdict.recoveryActions).toBeDefined();
      expect(verdict.recoveryActions![0].type).toBe('truncate_context');
    });

    it('正常运行时应该返回 continue', async () => {
      const supervisor = new DefaultTaskSupervisor({ enableLLMReview: false });
      const ctx = createContext();

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
      expect(verdict.reason).toContain('正常');
    });
  });

  describe('Layer 2: LLM 审查', () => {
    it('应该在规则层正常时调用 LLM 审查', async () => {
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockResolvedValue({ content: 'OK', model: 'mock', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
        stream: async function* () { yield { type: 'done' }; },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
      };

      const supervisor = new DefaultTaskSupervisor(
        { enableLLMReview: true, llmReviewInterval: 1 },
        mockModel,
      );
      const ctx = createContext();

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
      expect(mockModel.chat).toHaveBeenCalled();
    });

    it('LLM 返回 STOP 时应该停止', async () => {
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockResolvedValue({ content: 'STOP: Agent is stuck in a loop', model: 'mock', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
        stream: async function* () { yield { type: 'done' }; },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
      };

      const supervisor = new DefaultTaskSupervisor(
        { enableLLMReview: true, llmReviewInterval: 1 },
        mockModel,
      );
      const ctx = createContext();

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('stop');
      expect(verdict.userMessage).toContain('stuck');
    });

    it('LLM 返回 CONCERN 时应该恢复', async () => {
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockResolvedValue({ content: 'CONCERN: Agent seems to be repeating', model: 'mock', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
        stream: async function* () { yield { type: 'done' }; },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
      };

      const supervisor = new DefaultTaskSupervisor(
        { enableLLMReview: true, llmReviewInterval: 1 },
        mockModel,
      );
      const ctx = createContext();

      const verdict = await supervisor.checkpoint(ctx);

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
      };

      const supervisor = new DefaultTaskSupervisor(
        { enableLLMReview: true, llmReviewInterval: 1 },
        mockModel,
      );
      const ctx = createContext();

      const verdict = await supervisor.checkpoint(ctx);

      // 应该返回 continue（规则层正常，LLM 失败被忽略）
      expect(verdict.action).toBe('continue');
    });
  });

  describe('自适应间隔', () => {
    it('正常运行时应该建议放宽间隔', async () => {
      const supervisor = new DefaultTaskSupervisor({ enableLLMReview: false });
      const ctx = createContext({ iteration: 15 });

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
      expect(verdict.nextCheckpointIn).toBeGreaterThan(15);
    });

    it('异常恢复时应该建议收紧间隔', async () => {
      const supervisor = new DefaultTaskSupervisor({ enableLLMReview: false, minCheckpointInterval: 5 });
      const ctx = createContext({
        iteration: 30,
        metrics: createMetrics({ consecutiveSameTool: 5 }),
      });

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('recover');
      expect(verdict.nextCheckpointIn).toBeDefined();
      expect(verdict.nextCheckpointIn!).toBeLessThanOrEqual(30);
    });
  });

  describe('工厂函数', () => {
    it('createTaskSupervisor 应该创建实例', () => {
      const supervisor = createTaskSupervisor();
      expect(supervisor).toBeInstanceOf(DefaultTaskSupervisor);
    });

    it('应该接受配置和模型', () => {
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn(),
        stream: async function* () { yield { type: 'done' }; },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
      };

      const supervisor = createTaskSupervisor({ checkpointInterval: 10 }, mockModel);
      expect(supervisor).toBeInstanceOf(DefaultTaskSupervisor);
    });
  });

  describe('onCheckpoint 回调', () => {
    it('应该在每次检查点调用回调', async () => {
      const callback = vi.fn();
      const supervisor = new DefaultTaskSupervisor({
        enableLLMReview: false,
        onCheckpoint: callback,
      });
      const ctx = createContext();

      await supervisor.checkpoint(ctx);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: 'continue' }));
    });

    it('回调异常不应影响主循环', async () => {
      const callback = vi.fn().mockImplementation(() => { throw new Error('callback error'); });
      const supervisor = new DefaultTaskSupervisor({
        enableLLMReview: false,
        onCheckpoint: callback,
      });
      const ctx = createContext();

      const verdict = await supervisor.checkpoint(ctx);

      expect(verdict.action).toBe('continue');
    });
  });

  describe('Builder 自动接入', () => {
    it('无参 taskSupervisor() 应该自动创建 DefaultTaskSupervisor', async () => {
      const { AgentBuilder } = await import('../src/harness/builder.js');
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockResolvedValue({ content: 'Hello!', model: 'mock', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
        stream: async function* () {
          yield { type: 'content', content: 'Hello!' };
          yield { type: 'done', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
        },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
      };

      const engine = await new AgentBuilder()
        .model(mockModel)
        .taskSupervisor()
        .buildEngine();

      // engine 应该有 taskSupervisor
      expect(engine.deps.taskSupervisor).toBeDefined();
    });

    it('config 形式 taskSupervisor({}) 应该自动接入 model', async () => {
      const { AgentBuilder } = await import('../src/harness/builder.js');
      const mockModel: ModelProvider = {
        name: 'mock',
        chat: vi.fn().mockResolvedValue({ content: 'OK', model: 'mock', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
        stream: async function* () {
          yield { type: 'content', content: 'OK' };
          yield { type: 'done', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
        },
        isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: () => null,
      };

      const engine = await new AgentBuilder()
        .model(mockModel)
        .taskSupervisor({ enableLLMReview: false })
        .buildEngine();

      expect(engine.deps.taskSupervisor).toBeDefined();
    });
  });
});
