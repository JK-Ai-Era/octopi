/**
 * 主动压缩 × 工具输出密集历史（连线回归）
 *
 * 回归背景（缺陷）：HybridCompressor 第一级「旧工具输出截断」达标即返回、不产出语义摘要，
 * 而 applyProactiveCompact 曾拿「有无 previousSummary」当再压缩判据——
 * 摘要永远为空 → 复用分支永远进不去 → 每个 turn 都重裁并发非 cached 通知（UI 刷屏），
 * 且「LLM 摘要缓解长会话失忆」的产品目标静默落空。
 *
 * 本文件走真实连线（真实 DefaultContextEngine + 真实 HybridCompressor + 工具输出密集历史），
 * 只 stub 外部 LLM（summarize）。对照组先证明「机械截断达标时压缩器直接返回、无摘要」
 * （即缺陷触发面），再证明修复后：机械截断达标也产出语义摘要，且后续 assemble 走复用分支。
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { HybridCompressor } from '@octopi-agent/engine/harness/context/hybrid-compressor.js';
import { HeuristicTokenEstimator } from '@octopi-agent/engine/harness/context/token-estimator.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

/** 一轮工具调用 + 大结果（assistant tool_call / tool result 成对） */
function toolRound(i: number, resultText: string): Message[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call-${i}`, name: 'shell', arguments: { cmd: 'noop' } }],
      timestamp: Date.now(),
    },
    {
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: `call-${i}`, name: 'shell', result: resultText }],
      timestamp: Date.now(),
    },
  ];
}

/** 工具输出密集历史：每轮 5000 字符结果（旧工具输出是 token 主体） */
function buildToolHeavyHistory(rounds: number, resultChars: number): Message[] {
  const msgs: Message[] = [userMsg('do the work')];
  for (let i = 0; i < rounds; i++) {
    msgs.push(...toolRound(i, 'r'.repeat(resultChars)));
  }
  return msgs;
}

/** 方案 E：turn 边界（新 user 刚落、尚无工具）才允许 LLM 摘要——历史末尾补一条 user */
function atTurnBoundary(msgs: Message[]): Message[] {
  return [...msgs, userMsg('next')];
}

interface CollectedEvent {
  type: string;
  cached?: boolean;
}

function nonCachedCompacts(events: CollectedEvent[]): CollectedEvent[] {
  return events.filter((e) => e.type === 'context.compact.end' && !e.cached);
}

/** LLM 视图形状校验：不拆 tool_call/tool_result 对（悬空 tool_calls / 孤儿 tool 结果会被网关 400） */
function assertToolPairsAligned(
  llm: Array<{ role?: string; tool_calls?: Array<{ id?: string }>; tool_call_id?: string }>,
): void {
  if (llm.length === 0) return;
  expect(llm[0]?.role).not.toBe('tool');
  const pending = new Set<string>();
  for (const m of llm) {
    if (m.role === 'assistant') {
      expect([...pending]).toEqual([]);
      for (const tc of m.tool_calls ?? []) {
        if (tc.id) pending.add(tc.id);
      }
    } else if (m.role === 'tool') {
      if (m.tool_call_id) {
        expect(pending.has(m.tool_call_id)).toBe(true);
        pending.delete(m.tool_call_id);
      }
    } else {
      expect([...pending]).toEqual([]);
    }
  }
  expect([...pending]).toEqual([]);
}

describe('主动压缩 × 工具输出密集历史（连线回归）', () => {
  it('对照：旧工具输出截断达标时压缩器直接返回且无摘要消息（缺陷触发面）', async () => {
    const compressor = new HybridCompressor();
    const middle = buildToolHeavyHistory(10, 5_000).slice(2, -4);
    const out = await compressor.compress({
      messages: middle,
      targetTokens: 4_200,
      tokenEstimator: new HeuristicTokenEstimator(),
    });
    // 机械截断已达标 → 一级短路：压缩发生了，但结果里没有任何摘要消息
    expect(out.result.length).toBeGreaterThan(0);
    expect(out.result.some((m) => m.metadata?.source === 'contextSummary')).toBe(false);
    // 未传 summarize 时同样不产出摘要：requireSummary 前的旧路径就是这样静默跳过摘要级
    expect(out.droppedSummary).toBe('Old tool outputs truncated');
  });

  it('机械截断达标也产出语义摘要；后续小增量走复用分支不再重裁（B + A）', async () => {
    const summarize = vi.fn(async () => '## Conversation Summary\nproactive-summary');
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
      proactiveCooldownMs: 0,
    });
    const events: CollectedEvent[] = [];
    const base = buildToolHeavyHistory(10, 5_000);
    const params = {
      sessionId: 's-th',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 20_000,
      summarize,
      emit: (e: { type: string; cached?: boolean }) => events.push({ type: e.type, cached: e.cached }),
    };

    const r1 = await engine.assemble({ ...params, messages: atTurnBoundary(base) });
    // B：机械截断达标也必须调 LLM 产出摘要（修复前：永不调用）；E：仅 turn 边界可打 LLM
    expect(summarize).toHaveBeenCalledTimes(1);
    // 摘要是语义正文，进入持久化快照
    expect(r1.compactState?.summary).toContain('proactive-summary');
    // 恰好一条非 cached 压缩事件（UI 可见的那次）
    expect(nonCachedCompacts(events)).toHaveLength(1);
    // 视图形状：head/tail 边界不得拆散 tool_call/tool_result 对
    assertToolPairsAligned(r1.messages as Array<{ role?: string; tool_calls?: Array<{ id?: string }>; tool_call_id?: string }>);

    events.length = 0;
    // A：+1 条短消息 → 复用重建：不再打 LLM、不再发非 cached 事件（修复前：每 turn 重裁+发通知）
    const r2 = await engine.assemble({ ...params, messages: [...base, userMsg('tiny follow-up')] });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(nonCachedCompacts(events)).toHaveLength(0);
    // 复用重建确实发生了（cached 事件在场），而非静默无操作
    expect(events.some((e) => e.type === 'context.compact.end' && e.cached)).toBe(true);
    expect(r2.compactState?.summary).toContain('proactive-summary');

    events.length = 0;
    // 增量攒够（≥3 条）→ 开启新一轮压缩，摘要按 previousSummary 增量合并
    const grown = atTurnBoundary([...base, userMsg('n1'), userMsg('n2'), userMsg('n3')]);
    await engine.assemble({ ...params, messages: grown });
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(nonCachedCompacts(events)).toHaveLength(1);
    const mergeInput = String(summarize.mock.calls[1]?.[0]?.[0]?.content ?? '');
    expect(mergeInput).toContain('proactive-summary');
  });

  it('摘要 LLM 失败：降级机械视图，不以占位说明冒充摘要；小增量复用、攒够重试（诚实降级）', async () => {
    const summarize = vi.fn(async () => {
      throw new Error('llm down');
    });
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
      proactiveCooldownMs: 0,
    });
    const events: CollectedEvent[] = [];
    // 纯文本历史：一级截断不适用，走摘要级 → LLM 失败 → 兜底截断（产机械占位说明）
    const base: Message[] = [];
    for (let i = 0; i < 30; i++) {
      base.push(userMsg(`content-${i} ` + 'x'.repeat(400)));
    }
    const params = {
      sessionId: 's-th-fail',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4_000,
      summarize,
      emit: (e: { type: string; cached?: boolean }) => events.push({ type: e.type, cached: e.cached }),
    };

    const r1 = await engine.assemble({ ...params, messages: atTurnBoundary(base) });
    expect(summarize).toHaveBeenCalledTimes(1);
    // 降级占位说明（[Context truncated…]）不得冒充语义摘要（修复前会被存进 previousSummary）
    expect(r1.compactState?.summary).toBeUndefined();
    expect(nonCachedCompacts(events)).toHaveLength(1);

    events.length = 0;
    // +1 条 → 复用机械重建：不打 LLM、不发非 cached 事件
    await engine.assemble({ ...params, messages: atTurnBoundary([...base, userMsg('tiny')]) });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(nonCachedCompacts(events)).toHaveLength(0);

    events.length = 0;
    // 攒够增量 → 重试 LLM 摘要（turn 边界）
    await engine.assemble({ ...params, messages: atTurnBoundary([...base, userMsg('n1'), userMsg('n2'), userMsg('n3')]) });
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(nonCachedCompacts(events)).toHaveLength(1);
  });

  it('重启恢复的压缩快照（有计数无摘要）立即停止重裁，增量攒够才补真摘要（生产状态形状）', async () => {
    const summarize = vi.fn(async () => '## Conversation Summary\nrestored-summary');
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
      proactiveCooldownMs: 0,
    });
    const events: CollectedEvent[] = [];
    const base = buildToolHeavyHistory(10, 5_000);
    const params = {
      sessionId: 's-th-restore',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 20_000,
      summarize,
      // 受损会话落盘后的真实形状：contextCompacts 只有计数、无 summary
      loadCompactState: () => ({
        lastProactiveMessageCount: base.length,
        lastProactiveTokens: 224_104,
      }),
      emit: (e: { type: string; cached?: boolean }) => events.push({ type: e.type, cached: e.cached }),
    };

    // +1 条：复用机械重建——不打 LLM、不发非 cached 事件（修复前：每 turn 重裁+发通知）
    await engine.assemble({ ...params, messages: [...base, userMsg('tiny')] });
    expect(summarize).not.toHaveBeenCalled();
    expect(nonCachedCompacts(events)).toHaveLength(0);
    expect(events.some((e) => e.type === 'context.compact.end' && e.cached)).toBe(true);

    events.length = 0;
    // 攒够增量 → 真摘要补上
    await engine.assemble({ ...params, messages: [...base, userMsg('n1'), userMsg('n2'), userMsg('n3')] });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(nonCachedCompacts(events)).toHaveLength(1);
  });

  it('summarize 返回空正文：按失败降级，不以空摘要替换中间段', async () => {
    const summarize = vi.fn(async () => '');
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
      proactiveCooldownMs: 0,
    });
    const events: CollectedEvent[] = [];
    const base: Message[] = [];
    for (let i = 0; i < 30; i++) {
      base.push(userMsg(`content-${i} ` + 'x'.repeat(400)));
    }
    const params = {
      sessionId: 's-th-empty',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4_000,
      summarize,
      emit: (e: { type: string; cached?: boolean }) => events.push({ type: e.type, cached: e.cached }),
    };

    const r1 = await engine.assemble({ ...params, messages: atTurnBoundary(base) });
    expect(summarize).toHaveBeenCalledTimes(1);
    // 空摘要不进状态（修复前：'[Conversation Summary]' 空壳会冒充语义摘要、中间段被空正文替换）
    expect(r1.compactState?.summary).toBeUndefined();
    expect(nonCachedCompacts(events)).toHaveLength(1);
  });
});
