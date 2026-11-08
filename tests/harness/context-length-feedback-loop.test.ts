/**
 * F 类反馈环的**链路级**红线（评审 M3/M4/M6）
 *
 * 状态级单测（context-length-feedback.test.ts）证明「写入/优先/快照换值」，
 * 但不证明链路成立。本文件用 runAgentWithReliability 真跑：
 *
 * - M6：长度类 400 真的触发重发（而不是一次就 abort）
 * - M3：attempt 按错误原因独立计数（timeout×2 不消耗 context_length 的额度）
 * - M4：ErrorStrategy 的 abort 指引能到达可见的 agent_end 错误文本
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '@octopi-agent/engine/harness/run/agent/agent.js';
import { runAgentWithReliability } from '@octopi-agent/engine/harness/run/reliability/run-agent.js';
import type { ReliabilityHarness } from '@octopi-agent/engine/harness/run/reliability/run-agent.js';
import type { HarnessLoopEvent } from '@octopi-agent/engine/harness/run/reliability/harness-events.js';
import type {
  ModelProvider,
  LLMResponse,
  LLMStreamChunk,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type { ClassifiedError, ErrorStrategy } from '@octopi-agent/core/interfaces/error-strategy.js';

/** 带 status 的 provider 错误 */
function providerError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

type Step = { error: Error } | { content: string };

/**
 * 按「provider 调用次数」驱动的确定性 provider。
 *
 * 不假设一轮 LLM 调用是 1 次还是 2 次（stream + chat fallback），只按总调用
 * 次数推进——测试断言与实现细节解耦（这是 M6 第一版踩的坑）。
 */
function countingProvider(behavior: (callIndex: number) => Step): {
  provider: ModelProvider;
  callCount: () => number;
} {
  let calls = 0;
  const take = (): Step => behavior(calls++);
  const provider = {
    name: 'testprov',
    defaultModel: 'testmodel',
    getModelInfo: () => null,
    getModelInfos: () => [],
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async chat(): Promise<LLMResponse> {
      const step = take();
      if ('error' in step) throw step.error;
      return { content: step.content, model: 'testmodel', finishReason: 'stop' } as LLMResponse;
    },
    async *stream(): AsyncGenerator<LLMStreamChunk> {
      const step = take();
      if ('error' in step) throw step.error;
      if (step.content) yield { type: 'content', content: step.content };
      yield { type: 'done', usage: undefined, finishReason: 'stop' };
    },
  } as unknown as ModelProvider;
  return { provider, callCount: () => calls };
}

function baseHarness(extra: Partial<ReliabilityHarness> = {}): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
    },
    ...extra,
  } as ReliabilityHarness;
}

/** ErrorStrategy 只关心 onModelError 时，其余方法给不可达默认（接口要求全实现） */
function makeStrategy(overrides: Partial<ErrorStrategy>): ErrorStrategy {
  return {
    onModelError: () => ({ action: 'abort' }),
    onToolError: () => ({ action: 'abort' }),
    onContextOverflow: () => ({ action: 'abort' }),
    onSecurityViolation: () => ({ action: 'abort' }),
    ...overrides,
  } as ErrorStrategy;
}

async function runToEnd(
  provider: ModelProvider,
  harness: ReliabilityHarness,
): Promise<HarnessLoopEvent[]> {
  const agent = new Agent({ model: provider });
  const events: HarnessLoopEvent[] = [];
  for await (const e of runAgentWithReliability(agent.context, { model: agent.model }, harness)) {
    events.push(e);
  }
  return events;
}

describe('M6：长度类 400 真的触发重发', () => {
  it('400 → 重发 → 成功（不是一次就 abort）', async () => {
    const { provider, callCount } = countingProvider((i) =>
      i < 2
        ? { error: providerError(400, 'prompt is too long: 250000 tokens > 200000 maximum') }
        : { content: 'recovered' },
    );
    const events = await runToEnd(provider, baseHarness());

    // 至少 3 次 provider 调用：失败轮（≥1 次）+ 重试轮成功（≥1 次）
    expect(callCount()).toBeGreaterThanOrEqual(3);
    const end = events.find((e) => e.type === 'agent_end');
    expect(end && 'reason' in end ? end.reason : undefined).toBe('completed');
    // 重试对用户可见（不静默）
    const retry = events.find((e) => e.type === 'model_retry');
    expect(retry).toBeDefined();
    expect(retry && 'data' in retry ? (retry.data as { reason: string }).reason : '').toBe(
      'context_length',
    );
  });
});

describe('M3：attempt 按错误原因独立计数', () => {
  it('server×N 之后 context_length 仍从 attempt=0 起算（额度不被前序错误吃掉）', async () => {
    const seen: Array<{ reason: string; attempt: number }> = [];
    const strategy = makeStrategy({
      onModelError(error: ClassifiedError, attempt: number) {
        seen.push({ reason: error.reason, attempt });
        // 长度类错误第二轮收口，避免无限重试把测试挂死
        if (error.reason === 'context_length' && attempt >= 1) {
          return { action: 'abort', reason: 'test-stop' };
        }
        return { action: 'retry', delayMs: 0 };
      },
    });
    // 前 4 次 provider 调用 = 两轮 server 错误（一轮 = stream + chat fallback 两次调用）
    const { provider } = countingProvider((i) => {
      if (i < 4) return { error: providerError(503, 'server error') };
      return {
        error: providerError(
          400,
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
        ),
      };
    });

    await runToEnd(provider, baseHarness({ errorStrategy: strategy }));

    // 前置 server 错误至少出现过 2 次
    expect(seen.filter((s) => s.reason === 'server').length).toBeGreaterThanOrEqual(2);
    // 关键：长度类错误拿到的 attempt 是 0，不是被前序错误顶到 2
    const ctxAttempts = seen.filter((s) => s.reason === 'context_length').map((s) => s.attempt);
    expect(ctxAttempts.length).toBeGreaterThan(0);
    expect(ctxAttempts[0]).toBe(0);
  });
});

describe('M4：abort 指引可到达可见错误文本', () => {
  it('strategy 的 reason 出现在 agent_end.error.message（不只存在于单测）', async () => {
    const strategy = makeStrategy({
      onModelError() {
        return { action: 'abort', reason: 'NEED_NEW_SESSION: switch to a larger window model' };
      },
    });
    const { provider } = countingProvider(() => ({
      error: providerError(400, 'prompt is too long: 250000 tokens > 200000 maximum'),
    }));

    const events = await runToEnd(provider, baseHarness({ errorStrategy: strategy }));
    const end = events.find((e) => e.type === 'agent_end') as
      | (HarnessLoopEvent & { error?: unknown })
      | undefined;

    expect(end).toBeDefined();
    const err = end?.error;
    expect(err instanceof Error ? err.message : String(err)).toContain('NEED_NEW_SESSION');
    // 原始 provider 文本保留（不静默替换）
    expect(err instanceof Error ? err.message : String(err)).toContain('prompt is too long');
  });
});
