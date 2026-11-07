/**
 * 压缩摘要调用的可中断 / 可观测 / 有预算（P3，2026-11-07 事故回归）。
 *
 * 事故现场：00:37 发出 2.13MB 非流式摘要请求，provider 20+ 分钟不返回；
 * 00:46 用户点 abort，但摘要调用没有 signal，abort 只到 convertToLlm 边界 →
 * 请求继续挂到进程重启。UI 全程只有「进行中」，无法区分「在跑」和「provider 挂了」。
 *
 * 红线：
 * - run 中止必须取消在飞摘要请求，且中止轮不得写转换记录（残缺产物不进历史）
 * - 单次摘要调用有独立预算；超时按失败降级并如实上报 summarize_timeout
 * - 摘要请求发出时必须上报 progress（体量 + 预算），UI 不再只能显示「进行中」
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { InMemoryTransformStore } from '@octopi-agent/engine/harness/session/transform-store.js';

function textTurns(count: number, chars: number, tag: string): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ role: 'user', content: `q ${tag}-${i} ${'q'.repeat(40)}`, timestamp: Date.now() });
    out.push({ role: 'assistant', content: `${tag}-${i} ${'a'.repeat(chars)}`, timestamp: Date.now() });
  }
  return out;
}

/** 视图超线（tokenBudget 小），必然走到摘要调用 */
function baseParams(messages: Message[], sessionId: string) {
  return {
    messages,
    sessionId,
    systemPrompt: 'sys',
    tools: [],
    tokenBudget: 20_000,
    contextWindow: 1_048_576,
  };
}

describe('P3：摘要调用可中断', () => {
  it('已中止的 signal → 完全不发起摘要，也不写记录', async () => {
    const store = new InMemoryTransformStore();
    const summarize = vi.fn(async () => '## 交接摘要\nshould-not-run');
    const engine = new DefaultContextEngine({ proactiveCooldownMs: 0, transformStore: store });
    const messages = textTurns(30, 4000, 'abort-pre');
    const controller = new AbortController();
    controller.abort();

    await engine.assemble({
      ...baseParams(messages, 's-abort-pre'),
      summarize,
      signal: controller.signal,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect((await store.load('s-abort-pre', '')).records).toEqual([]);
  });

  it('飞行中 abort → 摘要收到的 signal 被中止，且不写记录', async () => {
    const store = new InMemoryTransformStore();
    const controller = new AbortController();
    let sawSignal: AbortSignal | undefined;
    // 模拟 provider 行为：把 signal 接到在飞请求上，abort 时以错误结束
    const summarize = vi.fn(
      async (_msgs: unknown, opts?: { signal?: AbortSignal }): Promise<string> => {
        sawSignal = opts?.signal;
        return new Promise<string>((_resolve, reject) => {
          if (!opts?.signal) return; // 无 signal 会一直挂着——正是事故形态
          opts.signal.addEventListener(
            'abort',
            () => reject(new Error('Request aborted')),
            { once: true },
          );
        });
      },
    );
    const engine = new DefaultContextEngine({ proactiveCooldownMs: 0, transformStore: store });
    const messages = textTurns(30, 4000, 'abort-mid');

    const pending = engine.assemble({
      ...baseParams(messages, 's-abort-mid'),
      summarize,
      signal: controller.signal,
    });
    // 等摘要调用真正发出（否则 abort 可能早于请求，测不到「飞行中」）
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    controller.abort();
    await pending;

    expect(sawSignal?.aborted).toBe(true);
    expect((await store.load('s-abort-mid', '')).records).toEqual([]);
  });
});

describe('P3：摘要调用有独立预算', () => {
  it('预算超时 → 中止请求、降级，并如实上报 summarize_timeout', async () => {
    const store = new InMemoryTransformStore();
    const events: Array<{ type: string; error?: string; kind?: string }> = [];
    const summarize = vi.fn(
      async (_msgs: unknown, opts?: { signal?: AbortSignal }): Promise<string> =>
        new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(new Error('Request aborted')),
            { once: true },
          );
        }),
    );
    const engine = new DefaultContextEngine({
      proactiveCooldownMs: 0,
      summarizeTimeoutMs: 25,
      transformStore: store,
    });
    const messages = textTurns(30, 4000, 'timeout');

    await engine.assemble({
      ...baseParams(messages, 's-timeout'),
      summarize,
      emit: (e) => events.push(e as { type: string }),
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    const errorEvent = events.find((e) => e.type === 'context.compact.error');
    expect(errorEvent?.kind).toBe('failed');
    expect(errorEvent?.error).toContain('summarize_timeout:25ms');
    // 超时是真实失败：按 onSummarizeFail 语义降级（不静默成功）
    const { records } = await store.load('s-timeout', '');
    expect(records.length).toBeGreaterThan(0);
  }, 10_000);
});

describe('P3：摘要请求可观测', () => {
  it('请求发出时上报 progress（体量 + 预算），且体量随视图而非全量历史', async () => {
    const events: Array<{
      type: string;
      phase?: string;
      requestChars?: number;
      requestMessages?: number;
      timeoutMs?: number;
    }> = [];
    const summarize = vi.fn(async () => '## 交接摘要\nok');
    const engine = new DefaultContextEngine({
      proactiveCooldownMs: 0,
      summarizeTimeoutMs: 90_000,
    });
    const messages = textTurns(30, 4000, 'progress');

    await engine.assemble({
      ...baseParams(messages, 's-progress'),
      summarize,
      emit: (e) => events.push(e as never),
    });

    const progress = events.find((e) => e.type === 'context.compact.progress');
    expect(progress?.phase).toBe('summarize');
    expect(progress?.timeoutMs).toBe(90_000);
    expect(progress?.requestChars).toBeGreaterThan(0);
    expect(progress?.requestMessages).toBeGreaterThan(0);
    // 首次压缩无既有摘要 → 前缀就是会话内容（尚未超过原始文本太多，只做量级校验）
    const originalChars = JSON.stringify(messages).length;
    expect(progress!.requestChars!).toBeLessThan(originalChars * 2);
  });

  it('未配置时的缺省预算 = 300s（慢 provider 留余量）', async () => {
    const events: Array<{ type: string; timeoutMs?: number }> = [];
    const engine = new DefaultContextEngine({ proactiveCooldownMs: 0 });
    const messages = textTurns(30, 4000, 'default-budget');

    await engine.assemble({
      ...baseParams(messages, 's-default-budget'),
      summarize: async () => '## 交接摘要\nok',
      emit: (e) => events.push(e as never),
    });

    const progress = events.find((e) => e.type === 'context.compact.progress');
    expect(progress?.timeoutMs).toBe(300_000);
  });
});
