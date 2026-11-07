/**
 * 方案 E 修订 + overflow 止血（2026-11-07）回归红线：
 *
 * 1. turn 内 proactive 可触发（旧版 isMidTurn 禁令让目标线在 agent 长 turn 全程失效）
 * 2. turn 内活跃窗口保护：压缩选段不触及最近 midTurnProtectLastN 条（进行中工作记录）
 * 3. overflow 每 turn 至多发起一次 LLM 摘要（连环 200k→200k 削尖事故回归）
 * 4. overflow 无记录轮不发假「compacted」（auto 短路 = 什么都没变 → cached 0/0）
 *
 * 构造纪律：工具活动用真实 assistant(toolCalls)→tool(result) 对——alignViewSplit 的
 * tail 起点不得落在 tool result 上（会顺对下滑）；孤立 tool 消息会让 middle 塌空、
 * 记录转由 overflow 路径产出，测的就不是 proactive 了。
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { InMemoryTransformStore } from '@octopi-agent/engine/harness/session/transform-store.js';
import { resolveRun } from '@octopi-agent/engine/harness/context/transform/anchors.js';
import type { ContextCompactEvent } from '@octopi-agent/engine/harness/context/types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: text, timestamp: Date.now() };
}

/** 一轮工具调用 + 结果（assistant toolCalls / tool result 成对） */
function toolRound(i: number, resultChars: number): Message[] {
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
      toolResults: [{ toolCallId: `call-${i}`, name: 'shell', result: 'r'.repeat(resultChars) }],
      timestamp: Date.now(),
    },
  ];
}

/** 溢出形态用的孤立工具结果（overflow 走 selector，不受 tail 对齐影响） */
function toolResult(i: number, chars: number): Message {
  return {
    role: 'tool',
    content: '',
    toolResults: [{ toolCallId: `call_${i}`, name: 'read_file', result: 'R'.repeat(chars) }],
    timestamp: Date.now(),
  };
}

/** turn 内形态：user 起头 + 全程工具对（isMidTurn = true） */
function midTurnHistory(rounds: number, resultChars: number): Message[] {
  const out: Message[] = [userMsg('GO ' + 'h'.repeat(200))];
  for (let i = 0; i < rounds; i++) out.push(...toolRound(i, resultChars));
  return out;
}

describe('方案 E 修订：turn 内 proactive 可触发', () => {
  it('工具链进行中（isMidTurn）超线 → 仍发起 LLM 摘要', async () => {
    const store = new InMemoryTransformStore();
    const summarize = vi.fn(async () => 'SUMMARY-MARK-MIDTURN');
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 2,
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    // 50 轮工具对 ≈ 4.5k tokens：超触发线（≈2.9k）但未到硬溢出（≈5.8k）——
    // 命中 proactive 而非 overflow
    const messages = midTurnHistory(50, 300);

    await engine.assemble({
      sessionId: 's-midturn',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 6000,
      contextWindow: 1_048_576,
      summarize,
    });

    // 旧版（isMidTurn 禁令）此处 summarize 从未被调用
    expect(summarize, 'turn 内也必须能按目标线发起摘要').toHaveBeenCalledTimes(1);
  });

  it('turn 内活跃窗口保护：压缩选段不触及最近 50 条', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 2,
      midTurnProtectLastN: 50,
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    const messages = midTurnHistory(50, 300); // 101 条

    await engine.assemble({
      sessionId: 's-tail-guard',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 6000,
      contextWindow: 1_048_576,
      summarize: async () => 'SUMMARY-MARK',
    });

    const ledger = await store.load('s-tail-guard', '');
    const summary = ledger.records.find((r) => r.type === 'summary');
    expect(summary, '应产出 summary 记录').toBeDefined();
    // 记录覆盖区间上界必须早于「最近 50 条」的起点（进行中工作记录不进选段）
    const guardStart = messages.length - 50;
    for (const run of summary!.covers) {
      const span = resolveRun(messages, run);
      if (!span) continue;
      expect(span[1], `覆盖上界 ${span[1]} 不得进入活跃窗口（起点 ${guardStart}）`).toBeLessThan(
        guardStart,
      );
    }
  });

  it('turn 边界（末条真实 user 之后无工具活动）维持 protectLastN 窗口', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 2,
      midTurnProtectLastN: 50,
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    // turn 边界形态：历史工具对之后是「新 user + 纯文本回复」——末条真实 user 之后
    // 无工具活动（isMidTurn = false），活跃窗口守卫不生效
    const messages = midTurnHistory(50, 300);
    messages.push(userMsg('follow-up question'), assistantText('final answer ' + 'a'.repeat(200)));

    await engine.assemble({
      sessionId: 's-boundary',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 6000,
      contextWindow: 1_048_576,
      summarize: async () => 'SUMMARY-MARK',
    });

    const ledger = await store.load('s-boundary', '');
    const summary = ledger.records.find((r) => r.type === 'summary');
    expect(summary).toBeDefined();
    // 覆盖应深入到距尾部 5 条以内（只保 protectLastN=2 对齐滑动 1 条），
    // 而不是被 50 条活跃窗口挡住
    const spans = summary!.covers
      .map((run) => resolveRun(messages, run))
      .filter((s): s is [number, number] => s !== null);
    const maxEnd = Math.max(...spans.map((s) => s[1]));
    expect(maxEnd, 'turn 边界应只保护 protectLastN 条').toBeGreaterThanOrEqual(
      messages.length - 5,
    );
  });
});

describe('overflow 止血：每 turn 限 1 次 LLM 摘要', () => {
  it('同 turn 连续溢出两次 → summarize 只发起一次', async () => {
    const store = new InMemoryTransformStore();
    const summarize = vi.fn(async () => 'SUMMARY-MARK-OVF');
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });

    // 第一轮：溢出（小预算 + 大工具结果 + 尾部 user 收口开 turn 边界）；
    // 构造纪律：工具链结尾的历史被 selector 整体保留（无溢出可压），需尾部 user 开边界
    const messages = [userMsg('go')];
    for (let i = 0; i < 8; i++) messages.push(toolResult(i, 3000));
    messages.push(userMsg('wrap up'));
    await engine.assemble({
      sessionId: 's-ovf-limit',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 3000,
      contextWindow: 32000,
      summarize,
    });
    expect(summarize).toHaveBeenCalledTimes(1);

    // 第二轮：同 turn（append-only 追加 10 个大工具结果，末条真实 user 不变 → turn key 不变）
    // 再溢出 → 不得再打 LLM，走机械
    const grown = [...messages];
    for (let i = 100; i < 110; i++) grown.push(toolResult(i, 3000));
    await engine.assemble({
      sessionId: 's-ovf-limit',
      messages: grown,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 3000,
      contextWindow: 32000,
      summarize,
    });
    expect(summarize, '同 turn 第二次溢出走机械，不得再发起 LLM 摘要').toHaveBeenCalledTimes(1);
    // 防错断言：第二轮确实走了 overflow 机械路径（degrade 记录）——
    // 否则「1 次」可能是因为根本没溢出（测了个寂寞）
    const ledger = await store.load('s-ovf-limit', '');
    expect(
      ledger.records.some((r) => r.type === 'degrade'),
      '第二轮应有机械 degrade 记录（证明真溢出且被限次拦下）',
    ).toBe(true);
  });
});

describe('评审修复回归（del-ec61eb65）', () => {
  it('T2 锚点硬保护：当前 turn 的 user 指令永不进压缩选段', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 2,
      midTurnProtectLastN: 50,
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    // 5 条填充 + user 锚（index 5，不在 head 内）+ 97 轮工具对 = 200 条
    const messages: Message[] = [];
    for (let i = 0; i < 5; i++) messages.push(assistantText(`filler-${i}`));
    messages.push(userMsg('CONSTRAINT: only read, never write'));
    for (let i = 0; i < 97; i++) messages.push(...toolRound(i, 300));
    expect(messages.length).toBe(200);

    await engine.assemble({
      sessionId: 's-anchor',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 6000,
      contextWindow: 1_048_576,
      summarize: async () => 'SUMMARY-MARK',
    });

    const ledger = await store.load('s-anchor', '');
    const summary = ledger.records.find((r) => r.type === 'summary');
    expect(summary, '应产出 summary 记录').toBeDefined();
    for (const run of summary!.covers) {
      const span = resolveRun(messages, run);
      if (!span) continue;
      expect(span[0], '覆盖区间不得包含锚点 index 5').not.toBe(5);
      expect(span[1], '覆盖区间不得包含锚点 index 5').not.toBe(5);
      expect(span[0] <= 5 && 5 <= span[1], '锚点不得落在覆盖区间内').toBe(false);
    }
  });

  it('limit 语义（状态级）：fresh 成功烧名额，失败不烧（M5）', async () => {
    const store = new InMemoryTransformStore();
    // fresh 成功 → 名额=turn key
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    const messages = [userMsg('go')];
    for (let i = 0; i < 8; i++) messages.push(toolResult(i, 3000));
    messages.push(userMsg('wrap up'));
    await engine.assemble({
      sessionId: 's-quota-ok',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 3000,
      contextWindow: 32000,
      summarize: async () => 'SUMMARY-MARK',
    });
    const st = (engine as unknown as {
      states: Map<string, { overflowLlmTurnIndex?: number }>;
    }).states;
    expect(st.get('s-quota-ok')?.overflowLlmTurnIndex, 'fresh 成功必须烧名额').toBe(9);

    // 失败（summarize 抛错）→ 名额不烧（冷却后可重试——M5）
    const engine2 = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    await engine2.assemble({
      sessionId: 's-quota-fail',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 3000,
      contextWindow: 32000,
      summarize: async () => {
        throw new Error('provider exploded');
      },
    });
    const st2 = (engine2 as unknown as {
      states: Map<string, { overflowLlmTurnIndex?: number }>;
    }).states;
    expect(st2.get('s-quota-fail')?.overflowLlmTurnIndex, '失败不得烧名额').toBeUndefined();
  });

  it('T5 cannot_help 必须可见：无记录且仍超预算 → error 终态，不得伪装缓存重建', async () => {
    const store = new InMemoryTransformStore();
    const events: ContextCompactEvent[] = [];
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      proactiveCooldownMs: 60_000,
      transformStore: store,
    });
    const messages = [userMsg('go')];
    messages.push(toolResult(0, 3000));
    messages.push(toolResult(1, 3000));
    messages.push(userMsg('tail'));

    // 第一轮：摘要失败 → 降级账本（≈500tok）> 预算 200 → 视图仍超
    await engine.assemble({
      sessionId: 's-cannot-help',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 200,
      contextWindow: 32000,
      summarize: async () => {
        throw new Error('provider exploded');
      },
      emit: (e) => events.push(e),
    });
    // 第二轮：冷却中（LLM 被拦）+ 小溢出段（≤ floorKeep → ledgerTruncate 原样）
    // → 无记录且仍超预算 → 必须 fail-loud
    events.length = 0;
    await engine.assemble({
      sessionId: 's-cannot-help',
      messages: [...messages, toolResult(9, 50)],
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 200,
      contextWindow: 32000,
      summarize: async () => 'SUMMARY-MARK',
      emit: (e) => events.push(e),
    });

    const errors = events.filter(
      (e) => e.type === 'context.compact.error' && String(e.error).includes('cannot_help'),
    );
    expect(errors.length, '压缩救不了必须 fail-loud').toBe(1);
    const cachedEnds = events.filter(
      (e) => e.type === 'context.compact.end' && e.cached === true,
    );
    expect(cachedEnds, 'cannot_help 不得伪装成良性缓存重建').toEqual([]);
  });

  it('T1 接线：resolveContextEngine 的 midTurnProtectLastN 真正生效', async () => {
    const { resolveContextEngine } = await import(
      '@octopi-agent/engine/harness/agent/wire-agent-builder.js'
    );
    const engine = resolveContextEngine(
      { midTurnProtectLastN: 7 },
      undefined,
    ) as unknown as { config: { midTurnProtectLastN?: number } };
    expect(engine.config.midTurnProtectLastN, '配置必须穿过 wire 层生效').toBe(7);
  });
});

describe('overflow 止血：无记录轮不发假 compacted', () => {
  it('auto 短路（什么都没变）→ end 事件 cached:true + 0/0 + 零记录', async () => {
    const store = new InMemoryTransformStore();
    const events: ContextCompactEvent[] = [];
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    // 小溢出：溢出段体量 ≤ overflow 目标预算 → mode auto 短路原样返回
    const messages = [userMsg('go ' + 'g'.repeat(200))];
    messages.push(toolResult(0, 400));
    messages.push(toolResult(1, 400));
    messages.push(userMsg('tail ' + 't'.repeat(200)));

    await engine.assemble({
      sessionId: 's-ovf-noop',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 500,
      contextWindow: 32000,
      summarize: async () => 'SUMMARY-MARK',
      emit: (e) => events.push(e),
    });

    const ledger = await store.load('s-ovf-noop', '');
    // 核心不变量：无替换 = 无记录，且任何终态都不得伪装成可见的「compacted」
    // （空转可走 cached 同形或不发 end——具体分支是实现细节，不钉死）
    expect(ledger.records, '空转轮应零记录').toEqual([]);
    const ends = events.filter((e) => e.type === 'context.compact.end');
    for (const end of ends) {
      expect(end.cached, '空转轮不得发可见 compacted 通知').toBe(true);
    }
    const visibleEnds = ends.filter((e) => e.cached !== true);
    expect(visibleEnds, '1ms 假 compacted 回归').toEqual([]);
  });
});
