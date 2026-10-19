/**
 * F1-B3：工作目标与窗口解耦——compact 兜底线挂 targetTokens（缺省 20 万 × 1.5）
 *
 * 红线（arch/long-session-latency.md §5 B3）：
 * - 触发线挂工作目标而非窗口（旧挂法 1M×0.6 ≈ 57 万 = 永不触发）
 * - 尺子量**老化视图**（实际请求）：raw 估算会把 B2 稳态误判超线 → 每 turn LLM 摘要 = 双机制打架
 * - ⚠️ 兜底线必须 > B2 老化稳态，单测锁死
 * - targetTokens=0 退回旧窗口比例模式；proactiveCompactRatio=0 禁新 LLM（不丢粘滞视图）
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type { Message } from '@octopi-agent/core/types.js';

let seq = 0;

/** 一个「user → assistant(tool_calls) → tool(results)」轮次 */
function toolTurn(resultCount: number, resultChars: number): Message[] {
  seq += 1;
  const calls = Array.from({ length: resultCount }, (_, j) => ({
    id: `call-${seq}-${j}`,
    name: 'file_read',
    arguments: { path: `src/f${seq}-${j}.ts` },
  }));
  const results = calls.map((tc, j) => ({
    toolCallId: tc.id,
    name: tc.name,
    result: `file body ${seq}-${j} ${'x'.repeat(resultChars)}`,
  }));
  return [
    { role: 'user', content: `question ${seq}`, timestamp: 1 } as Message,
    { role: 'assistant', content: '', toolCalls: calls, timestamp: 2 } as unknown as Message,
    { role: 'tool', content: '', toolResults: results, timestamp: 3 } as unknown as Message,
  ];
}

function mockSummarize() {
  return vi.fn(async () => '## Conversation Summary\nproactive-hit');
}

describe('proactive compact at working target (F1-B3)', () => {
  it('should NOT compact a B2 steady-state history (fallback line > steady state, no double-mechanism)', async () => {
    // 150 跨轮 × 5000 字符 ≈ 375k token raw（远超 30 万兜底线）——
    // 但老化后 ≈ 100 指针 + 50 原文 ≈ 145k token < 30 万兜底线（B2 稳态）。
    // 尺子若量 raw（旧行为）summarize 必被触发 = 双机制打架。
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({ proactiveCooldownMs: 0 });
    const messages = Array.from({ length: 151 }, () => toolTurn(1, 5000)).flat();

    const result = await engine.assemble({
      sessionId: 's-steady',
      messages,
      systemPrompt: 'sys',
      tools: [],
      contextWindow: 1_048_576,
      tokenBudget: 1_048_576,
      summarize,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.summary).toBeUndefined();
    // 数值锁：稳态视图在兜底线（20 万 × 1.5 = 30 万）之下，且确实不小（非空跑）
    expect(result.estimatedTokens).toBeLessThan(300_000);
    expect(result.estimatedTokens).toBeGreaterThan(50_000);
  });

  it('should compact over the fallback line even with a 1M window (decoupled from the window)', async () => {
    // 当前 run 80 × 8000 字符（当前 run 永不老化）体量巨大。
    // 方案 E：turn 内禁 LLM 摘要——超线走机械分级，不得打 summarize。
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({ proactiveCooldownMs: 0 });
    const messages = [
      ...Array.from({ length: 30 }, () => toolTurn(1, 200)).flat(),
      ...toolTurn(80, 8000),
    ];

    const result = await engine.assemble({
      sessionId: 's-over',
      messages,
      systemPrompt: 'sys',
      tools: [],
      contextWindow: 1_048_576,
      tokenBudget: 1_048_576,
      summarize,
    });

    // turn 内（工具活动中）不得 LLM 摘要
    expect(summarize).not.toHaveBeenCalled();
    // 但仍应通过机械分级把视图压下来（或至少不爆窗口）
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeLessThan(1_048_576);
  });

  it('should respect targetTokens and compactFallbackRatio knobs', async () => {
    const history = [
      ...Array.from({ length: 40 }, () => toolTurn(1, 2000)).flat(),
      { role: 'user', content: 'next', timestamp: 1 } as Message,
    ];
    // 40 × 2000 字符 = 80k chars ≈ 40k token（跨轮 39 条 < rawWindow 40：不触发老化，量的是原文）

    const strict = mockSummarize();
    await new DefaultContextEngine({ proactiveCooldownMs: 0, targetTokens: 10_000 }).assemble({
      sessionId: 's-knob-strict',
      messages: history,
      systemPrompt: 'sys',
      tools: [],
      summarize: strict,
    });
    expect(strict).toHaveBeenCalled(); // 兜底线 1.5 万 < 稳态 → 触发

    const lax = mockSummarize();
    await new DefaultContextEngine({ proactiveCooldownMs: 0, targetTokens: 200_000 }).assemble({
      sessionId: 's-knob-lax',
      messages: history,
      systemPrompt: 'sys',
      tools: [],
      summarize: lax,
    });
    expect(lax).not.toHaveBeenCalled(); // 兜底线 30 万 > 稳态 → 不触发

    const relaxed = mockSummarize();
    await new DefaultContextEngine({
      proactiveCooldownMs: 0,
      targetTokens: 10_000,
      compactFallbackRatio: 20,
    }).assemble({
      sessionId: 's-knob-ratio',
      messages: history,
      systemPrompt: 'sys',
      tools: [],
      summarize: relaxed,
    });
    expect(relaxed).not.toHaveBeenCalled(); // 兜底线 1 万 × 20 = 20 万 > 稳态 → 不触发
  });

  it('should fall back to the legacy window-ratio trigger when targetTokens=0', async () => {
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
    });
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: 'user' as const,
      content: `content-${i} ${'x'.repeat(400)}`,
      timestamp: i,
    })) as Message[];

    await engine.assemble({
      sessionId: 's-legacy',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    expect(summarize).toHaveBeenCalled();
  });

  it('should keep proactiveCompactRatio=0 as the master kill switch in target mode', async () => {
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({ proactiveCompactRatio: 0, proactiveCooldownMs: 0 });
    // 同 test 2 的超线历史；ratio=0 即使 target 模式也不得触发
    const messages = [
      ...Array.from({ length: 30 }, () => toolTurn(1, 200)).flat(),
      ...toolTurn(80, 8000),
    ];

    await engine.assemble({
      sessionId: 's-kill',
      messages,
      systemPrompt: 'sys',
      tools: [],
      contextWindow: 1_048_576,
      tokenBudget: 1_048_576,
      summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
  });

  it('should keep gated proactive summaries alive for small windows (line clamps to the window ratio line)', async () => {
    // 小窗口（此处 tokenBudget 4000）：兜底线若只挂目标线（30 万），有门槛/冷却的 proactive
    // 会被挤成死代码、由无门槛的溢出路径每 turn 压缩（评审 H1）——min 钳制保住温和路径。
    const summarize = mockSummarize();
    const events: Array<{ type: string; reason?: string }> = [];
    const engine = new DefaultContextEngine({ proactiveCooldownMs: 0, protectFirstN: 2, protectLastN: 4 });
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: 'user' as const,
      content: `content-${i} ${'x'.repeat(400)}`,
      timestamp: i,
    })) as Message[];

    await engine.assemble({
      sessionId: 's-smallwin',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
      emit: (e) => events.push(e as { type: string; reason?: string }),
    });

    expect(summarize).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'context.compact.start' && e.reason === 'proactive')).toBe(true);
  });

  it('should keep the legacy unknown-window skip when targetTokens=0', async () => {
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({ proactiveCompactRatio: 0.5, targetTokens: 0 });
    const messages = Array.from({ length: 40 }, () => toolTurn(1, 2000)).flat();

    await engine.assemble({ sessionId: 's-unk-legacy', messages, systemPrompt: 'sys', tools: [], summarize });
    expect(summarize).not.toHaveBeenCalled(); // 旧行为：窗口未知 → 完全跳过 proactive
  });

  it('should not re-compact without material growth since the last compaction (occasional fallback)', async () => {
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({ proactiveCooldownMs: 0, targetTokens: 10_000 });
    const base = [
      ...Array.from({ length: 40 }, () => toolTurn(1, 2000)).flat(),
      { role: 'user', content: 'next', timestamp: 1 } as Message,
    ];

    await engine.assemble({ sessionId: 's-h2', messages: base, systemPrompt: 'sys', tools: [], summarize });
    expect(summarize).toHaveBeenCalledTimes(1);

    // 消息增量过门槛（5 条）但 token 增长不足 25% 阈值 → 走缓存重建，不得再打 LLM
    // （否则持续超线会话每攒 5 条就全量重压——「偶发兜底」变「周期压缩」，评审 H2）
    const grown: Message[] = [
      ...base,
      ...Array.from({ length: 5 }, (_, i) => ({ role: 'user' as const, content: `tiny-${i}`, timestamp: i })),
    ];
    await engine.assemble({ sessionId: 's-h2', messages: grown, systemPrompt: 'sys', tools: [], summarize });
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
