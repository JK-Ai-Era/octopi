/**
 * 摘要闸门可观测性（2026-11-13）
 *
 * 事故：一次摘要被判污染 → strict 重试 → 整包 348k token 重发（+59s），
 * 但全程零事件——UI 只显示「已等待 Ns」，日志无迹可查。
 * 本测试锁定：闸门每次判定都必须 emit，且带上判定理由与命中量。
 */
import { describe, it, expect, vi } from 'vitest';
import { DefaultContextEngine } from '@octopi-agent/engine/harness';

function textTurns(n: number, chars: number, tag: string) {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `${tag}-${i}-` + 'x'.repeat(chars),
  }));
}

function baseMessages() {
  return [...textTurns(30, 4000, 'c'), ...textTurns(11, 7000, 'tail')];
}

function params(messages: unknown[], summarize: unknown, emit: (e: unknown) => void) {
  return {
    messages: messages as never,
    sessionId: 's-obs',
    systemPrompt: 'sys',
    tools: [],
    tokenBudget: 20_000,
    contextWindow: 1_048_576,
    summarize: summarize as never,
    loadCompactState: () => ({
      summary: '上一份交接书',
      lastProactiveMessageCount: messages.length - 10,
      lastProactiveCoverEnd: messages.length - 40,
    }),
    emit: emit as never,
  };
}

describe('闸门可观测：污染判定必须 emit', () => {
  it('首次被判逐字复读 → emit contamination(attempt=1, retryTriggered)', async () => {
    const messages = baseMessages();
    const events: Array<Record<string, unknown>> = [];
    // 输出 = 前缀原文复读（真实失效模式）
    const replay = messages.slice(0, 40).map((m) => String((m as { content: string }).content)).join('\n');
    const summarize = vi
      .fn()
      .mockResolvedValueOnce(replay)
      .mockResolvedValueOnce('干净正文' + '散文'.repeat(300));

    const engine = new DefaultContextEngine({
      targetTokens: 0, proactiveCompactRatio: 0.5, proactiveCooldownMs: 0,
    });
    await engine.assemble(params(messages, summarize, (e) => events.push(e as never)));

    const contamination = events.filter((e) => e.type === 'context.compact.contamination');
    // 两次判定都要上报（第一次污染 + 第二次干净）——只报失败项会丢失"重试过一次"的事实
    expect(contamination).toHaveLength(2);
    expect(contamination[0]).toMatchObject({
      verdict: 'verbatim_echo',
      attempt: 1,
      retryTriggered: true,
    });
    expect(contamination[0].echoHits as number).toBeGreaterThan(0);
    expect(contamination[0].textChars as number).toBeGreaterThan(0);
    expect(contamination[1]).toMatchObject({ verdict: 'clean', attempt: 2, retryTriggered: false });
    // 重试确实发生（这正是耗时翻倍的原因）
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it('首次即干净 → 只 emit 一条 clean 事件（不制造噪音）', async () => {
    const messages = baseMessages();
    const events: Array<Record<string, unknown>> = [];
    const summarize = vi.fn().mockResolvedValue('干净正文' + '散文'.repeat(300));
    const engine = new DefaultContextEngine({
      targetTokens: 0, proactiveCompactRatio: 0.5, proactiveCooldownMs: 0,
    });
    await engine.assemble(params(messages, summarize, (e) => events.push(e as never)));

    const contamination = events.filter((e) => e.type === 'context.compact.contamination');
    expect(contamination).toHaveLength(1);
    expect(contamination[0]).toMatchObject({ verdict: 'clean', attempt: 1, retryTriggered: false });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('progress 必须同时上报 token 口径（与会话顶栏同尺）', async () => {
    const messages = baseMessages();
    const events: Array<Record<string, unknown>> = [];
    const summarize = vi.fn().mockResolvedValue('干净正文' + '散文'.repeat(300));
    const engine = new DefaultContextEngine({
      targetTokens: 0, proactiveCompactRatio: 0.5, proactiveCooldownMs: 0,
    });
    await engine.assemble(params(messages, summarize, (e) => events.push(e as never)));

    const progress = events.find((e) => e.type === 'context.compact.progress');
    expect(progress).toBeDefined();
    expect(typeof progress!.requestTokens).toBe('number');
    expect(progress!.requestTokens as number).toBeGreaterThan(0);
    // 字符数与 token 量纲比例应在 1.5–6 之间（中文+JSON 正常密度），不是同一个数字
    const ratio = (progress!.requestChars as number) / (progress!.requestTokens as number);
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(6);
  });
});
