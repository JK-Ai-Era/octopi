/**
 * 模型重试策略与可见性
 *
 * 事故背景（2026-10-27）：timeout 重试 3 次 × 每次 ~600s，把一次上游抖动放大成
 * 52 分钟无反馈黑屏，且 run 收尾被记成 completed。
 *
 * 修复取向（同日修正）：病因不是「重试 3 次」，而是「单次尝试无界」+「全程零反馈」。
 * 因此重试次数保持 3，本文件改为锁定：重试必须可见、等待可中止、收尾如错误记 error。
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '@octopi-agent/engine/harness/run/agent/agent.js';
import { runAgentWithReliability } from '@octopi-agent/engine/harness/run/reliability/run-agent.js';
import type { ReliabilityHarness } from '@octopi-agent/engine/harness/run/reliability/run-agent.js';
import type { HarnessLoopEvent } from '@octopi-agent/engine/harness/run/reliability/harness-events.js';
import { MODEL_ERROR_MAX_ATTEMPTS, maxAttemptsFor } from '@octopi-agent/engine/harness/run/reliability/model-error-policy.js';
import { DefaultErrorStrategy } from '@octopi-agent/engine/harness/agent/builder.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';

function createTestMessage(content: string): Message {
  return { role: 'user', content, timestamp: Date.now() };
}

/** 总是抛同一错误的 provider，记录真实尝试次数 */
function createAlwaysFailProvider(error: Error): { provider: ModelProvider; streamAttempts: () => number } {
  let calls = 0;
  const provider: ModelProvider = {
    name: 'test',
    defaultModel: 'test',
    getModelInfo: () => null,
    getModelInfos: () => [],
    async chat(_request: LLMRequest): Promise<LLMResponse> {
      // 流失败后引擎会走一次同步兜底（另计），这里只统计流尝试次数
      throw error;
    },
    async *stream(_request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
      calls++;
      throw error;
    },
    async isAvailable() {
      return true;
    },
  };
  return { provider, streamAttempts: () => calls };
}

function baseHarness(): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
    },
  };
}

async function runToEnd(
  provider: ModelProvider,
  harness: ReliabilityHarness,
): Promise<HarnessLoopEvent[]> {
  const agent = new Agent({ model: provider, systemPrompt: 'test' });
  agent.context.messages = [createTestMessage('hi')];
  const events: HarnessLoopEvent[] = [];
  for await (const e of runAgentWithReliability(agent.context, { model: agent.model }, harness)) {
    events.push(e);
  }
  return events;
}

describe('重试上限表', () => {
  it('timeout 保留 3 次重试（自愈能力不得为压时长而削弱）', () => {
    expect(maxAttemptsFor('timeout')).toBe(3);
  });

  it('其它可重试原因保持原上限', () => {
    expect(maxAttemptsFor('rate_limit')).toBe(3);
    expect(maxAttemptsFor('network')).toBe(3);
    expect(maxAttemptsFor('server')).toBe(2);
  });

  it('不可重试原因返回 0', () => {
    expect(maxAttemptsFor('auth')).toBe(0);
    expect(maxAttemptsFor('billing')).toBe(0);
    expect(MODEL_ERROR_MAX_ATTEMPTS.timeout).toBe(3);
  });
});

describe('timeout 重试行为', () => {
  it('默认策略下 timeout 尝试 4 次（1 + 3 次重试）后终止', { timeout: 30_000 }, async () => {
    const { provider, streamAttempts } = createAlwaysFailProvider(new Error('Timeout'));
    const events = await runToEnd(provider, baseHarness());

    // 首次 + 3 次重试 = 4
    expect(streamAttempts()).toBe(4);
    // 终止事件必须是 agent_end error，而不是静默继续
    const end = events.find((e) => e.type === 'agent_end');
    expect(end).toBeDefined();
    expect((end as { reason?: string }).reason).toBe('error');
  });

  it('注入 DefaultErrorStrategy 时同样重试 3 次（生产路径）', { timeout: 30_000 }, async () => {
    const { provider, streamAttempts } = createAlwaysFailProvider(new Error('Timeout'));
    // 生产装配恒注入 DefaultErrorStrategy；此处用等价的 strategy 复现该分支
    const harness: ReliabilityHarness = {
      ...baseHarness(),
      errorStrategy: {
        onModelError: (_error, attempt) => {
          const max = maxAttemptsFor('timeout');
          return attempt < max
            ? { action: 'retry' as const, delayMs: 0 }
            : { action: 'abort' as const, reason: 'timeout' };
        },
        onToolError: () => ({ action: 'skip' as const, reason: 'x' }),
        onContextOverflow: () => ({ action: 'abort' as const }),
        onSecurityViolation: () => ({ action: 'block' as const, reason: 'x' }),
      },
    };
    await runToEnd(provider, harness);
    expect(streamAttempts()).toBe(4);
  });

  it('重试必须产生可见的 model_retry 事件', { timeout: 30_000 }, async () => {
    const { provider } = createAlwaysFailProvider(new Error('Timeout'));
    const events = await runToEnd(provider, baseHarness());

    const retries = events.filter((e) => e.type === 'model_retry') as Array<{
      type: 'model_retry';
      data: { attempt: number; maxAttempts: number; reason: string; delayMs: number; error: string };
    }>;
    expect(retries).toHaveLength(3);
    expect(retries[0].data.attempt).toBe(1);
    expect(retries[0].data.maxAttempts).toBe(3);
    // 每次重试都必须可见，不能只发第一条
    expect(retries.map((r) => r.data.attempt)).toEqual([1, 2, 3]);
    expect(retries[0].data.reason).toBe('timeout');
    expect(retries[0].data.error).toContain('Timeout');
  });

  it('重试通知必须先于退避等待送达（否则等待期仍无反馈）', async () => {
    // 失败后首次尝试即入队通知；用 status=429 制造一个可观测的退避等待
    let calls = 0;
    const provider: ModelProvider = {
      name: 'test',
      defaultModel: 'test',
      getModelInfo: () => null,
      getModelInfos: () => [],
      async chat() {
        calls++;
        const err = new Error('rate limited') as Error & { status?: number };
        err.status = 429;
        throw err;
      },
      async *stream(): AsyncGenerator<LLMStreamChunk> {
        calls++;
        const err = new Error('rate limited') as Error & { status?: number };
        err.status = 429;
        throw err;
      },
      async isAvailable() {
        return true;
      },
    } as ModelProvider;

    const agent = new Agent({ model: provider, systemPrompt: 'test' });
    agent.context.messages = [createTestMessage('hi')];

    const startedAt = Date.now();
    let retryAt = -1;
    for await (const e of runAgentWithReliability(agent.context, { model: agent.model }, baseHarness())) {
      if (e.type === 'model_retry') {
        retryAt = Date.now() - startedAt;
        break; // 只关心首条通知的到达时刻，不必等完整退避序列
      }
    }

    expect(retryAt).toBeGreaterThanOrEqual(0);
    // rate_limit 的退避是秒级；若通知被排在 sleep 之后，这里会看到 >= 1000ms
    expect(retryAt).toBeLessThan(500);
    expect(calls).toBeGreaterThan(0);
  });

  it('network 错误仍允许 3 次重试（避免把可自愈断连修坏）', { timeout: 20_000 }, async () => {
    const { provider, streamAttempts } = createAlwaysFailProvider(new Error('socket hang up'));
    await runToEnd(provider, baseHarness());
    // 首次 + 3 次重试
    expect(streamAttempts()).toBe(4);
  });

  it('重试上限表由 DefaultErrorStrategy 真实实现消费（非手抄副本）', () => {
    // 直接实例化生产类：若策略与 policy 表再次漂移，本用例会红
    const strategy = new DefaultErrorStrategy();
    const timeoutError = { reason: 'timeout' as const, message: 't', originalError: new Error('t') };
    // attempt 从 0 起：0 → retry，1 → abort（上限 1）
    expect(strategy.onModelError(timeoutError, 0).action).toBe('retry');
    expect(strategy.onModelError(timeoutError, 2).action).toBe('retry');
    expect(strategy.onModelError(timeoutError, 3).action).toBe('abort');

    const networkError = { reason: 'network' as const, message: 'n', originalError: new Error('n') };
    expect(strategy.onModelError(networkError, 2).action).toBe('retry');
    expect(strategy.onModelError(networkError, 3).action).toBe('abort');
  });
});
