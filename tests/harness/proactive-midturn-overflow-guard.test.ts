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

describe('overflow 收敛循环（Q1 纯机械，2026-11-08）', () => {
  it('同 turn 连续溢出两次 → 零 summarizeFn（纯机械性质钉死）', async () => {
    const store = new InMemoryTransformStore();
    const events: ContextCompactEvent[] = [];
    const summarize = vi.fn(async () => 'SUMMARY-MARK-OVF');
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      historyAging: { enabled: true },
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
      tokenBudget: 6000,
      contextWindow: 32000,
      summarize,
      emit: (e) => events.push(e),
    });
    expect(summarize, 'overflow 纯机械：收敛循环零 LLM（Q1）').toHaveBeenCalledTimes(0);

    // 第二轮：同 turn（append-only 追加 10 个大工具结果）再溢出 → 依然零 LLM
    const grown = [...messages];
    for (let i = 100; i < 110; i++) grown.push(toolResult(i, 3000));
    await engine.assemble({
      sessionId: 's-ovf-limit',
      messages: grown,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 6000,
      contextWindow: 32000,
      summarize,
      emit: (e) => events.push(e),
    });
    expect(summarize, '连续溢出依然零 LLM（旧每 turn 名额已随 LLM 路径拆除）').toHaveBeenCalledTimes(0);
    // 防错断言：返回视图含老化指针（真收敛证据）——第 0 轮 overflow aging 豁免 turn 首/
    // freezeBatch 后把大 tool result 降为指针；未溢出或收敛失败都会与断言矛盾
    const sent = await engine.assemble({
      sessionId: 's-ovf-limit',
      messages: grown,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 6000,
      contextWindow: 32000,
      summarize,
      emit: (e) => events.push(e),
    });
    const sentText = JSON.stringify(sent.messages);
    expect(sentText, '发送视图应含 aging 指针（overflow 第 0 轮收敛证据）').toContain('aged tool result · pointer');
    expect(
      events.some((e) => e.type === 'context.compact.error'),
      '第 0 轮收敛成功不得有 error',
    ).toBe(false);
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

  it('T5 L3 终局必须可见：连 5 档都装不下 → context_overflow_unrecoverable，不得伪装缓存重建', async () => {
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
    // L3 天然场景（丢弃次序原则）：user 文本自身远超预算（不可再生、永不账本化）——
    // 工具执行全部账本化后仍装不下 → 换 session/model（Q3「连 5 都超」的真实语义）
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) messages.push(userMsg(`u-${i} ` + 'U'.repeat(500)));
    for (let i = 20; i < 24; i++) messages.push(toolResult(i, 3000));

    // 第一轮：aging+砍档都救不了 → L3
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
      (e) =>
        e.type === 'context.compact.error' &&
        String(e.error).includes('context_overflow_unrecoverable'),
    );
    expect(errors.length, 'L3 必须 fail-loud（换 session/model 语义）').toBe(1);
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
      historyAging: { enabled: true },
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

// ── 红线 1/6：收敛档位逐级 + 成功即停 + 有限步终止 ─────────────────────────
describe('收敛阶梯红线（arch/overflow-redesign.md §3）', () => {
  function fatUser(n: number, chars: number): Message[] {
    // 工具执行段=可账本化对象（user 消息永不账本化——最不可再生，丢弃次序原则）
    return Array.from({ length: n }, (_, i) => ({
      role: 'tool' as Message['role'],
      content: '',
      toolResults: [{ toolCallId: `f${i}`, name: 'r', result: 'y'.repeat(chars) }],
      timestamp: Date.now() + i,
    })) as Message[];
  }

  it('红线 1：档位逐级 50→20→5、成功即停（round↔tailKeep 对应）', async () => {
    // 关 aging（第 0 轮不介入）+ 62 条 500 chars（4 chars/token）+ 预算 10000（limit≈5.5k）：
    // 50 档剩 ≈6.3k 超限 → 20 档剩 ≈2.5k 装得下 → round=2 成功即停（不进第 3 档）。
    // round↔tailKeep 对应（1↔50 / 2↔20 / 3↔5）：错位即跳档或过砍
    const engine2 = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      targetTokens: 0,
      proactiveCompactRatio: 0,
      historyAging: { enabled: false },
    });
    const result = await engine2.assemble({
      sessionId: 'ladder-r2',
      messages: fatUser(62, 500),
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 10000,
      contextWindow: 32000,
    });
    const m = /converged at round (\d) \(tailKeep=(\d+)[,)]/.exec(String(result.droppedSummary));
    expect(m, `收敛必须成功且带档位信息: ${result.droppedSummary}`).not.toBeNull();
    expect(['50', '20', '5'][Number(m![1]) - 1]).toBe(m![2]);
    expect(Number(m![1])).toBeLessThanOrEqual(3);
  });

  it('红线 1/6：三档都救不了 → L3 终局（overflowRound=3 封顶，不再有第 4 轮）', async () => {
    const events: Array<{ type: string; error?: string }> = [];
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      targetTokens: 0,
      proactiveCompactRatio: 0,
    });
    // 锚后 12 条胖工具结果：anchorFloor=12 顶住全部保底档（砍不动）→ 有限步收敛失败 → L3
    // L3 天然场景：user 文本自身远超预算（不可再生不可账本化）——砍光工具执行也装不下
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `u-${i} ` + 'U'.repeat(500), timestamp: Date.now() + i } as Message);
    }
    for (let i = 0; i < 4; i++) {
      messages.push({
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: `c${i}`, name: 'r', result: 'R'.repeat(3000) }],
        timestamp: Date.now() + i,
      } as Message);
    }
    await engine.assemble({
      sessionId: 'ladder-l3',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 200,
      contextWindow: 32000,
      emit: (e) => events.push(e),
    });
    // 有限步终止：一轮 start + 一个 error 终局（不是无限循环/不发多个 start）
    expect(events.filter((e) => e.type === 'context.compact.start')).toHaveLength(1);
    const err = events.find((e) => e.type === 'context.compact.error');
    expect(err?.error).toContain('context_overflow_unrecoverable');
  });

  it('红线 3：成对边界对齐——tool_call 在窗内/result 在 tail 窗时整对不砍（B1 孤儿 result 回归钉）', async () => {
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      historyAging: { enabled: false },
      transformStore: new InMemoryTransformStore(),
    });
    // 真触发构造（评审 M1：4 条构造 tailFloor=0 三档 no-op=空过）：n=12 > tailKeep 5，
    // tailKeep=5 档 tailFloor=7。候选窗 [0,7)：T0..T4（5 个可砍工具执行）+ A(c1)（其 result
    // T(c1) 在下标 7=tail 窗内 → 整对不砍）。双向钉：删「回退整对」→ A 被砍（孤儿 T）hasCall 挂；
    // 删「砍满」→ T0..T4 不砍 ledgerDropped 挂。
    const messages: Message[] = [{ role: 'user', content: 'go', timestamp: 1 } as Message];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'tool', content: '', toolResults: [{ toolCallId: `t${i}`, name: 'r', result: 'x'.repeat(3000) }], timestamp: 10 + i } as Message);
    }
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }], timestamp: 30 } as Message);
    messages.push({ role: 'tool', content: '', toolResults: [{ toolCallId: 'c1', name: 'read_file', result: 'x'.repeat(3000) }], timestamp: 31 } as Message);
    for (let i = 0; i < 4; i++) messages.push({ role: 'user', content: `tail${i}`, timestamp: 40 + i } as Message);
    const events: Array<{ type: string; error?: string }> = [];
    const result = await engine.assemble({
      sessionId: 's-pair',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 5000, // 收敛成功预算（200 下「tail+账本」超限=Q3 正确 L3，砍不落无法钉「砍满」）
      contextWindow: 32000,
      emit: (e) => events.push(e),
    });
    const texts = result.messages.map((m) => JSON.stringify(m));
    // LLM 形态检测（result.messages 是 LLM 消息：tool_calls/tool content，非领域 toolResults）
    const hasCall = texts.some((t) => t.includes('c1') && t.includes('tool_calls'));
    const hasResult = texts.some((t) => t.includes('"role":"tool"') && t.includes('xxx'));
    // 无条件断言（评审 M1：条件式断言=恒真空过）——孤儿 result → provider 400 永久复发
    expect(hasCall, 'A(c1) 的 call 被砍而 result 幸存（孤儿）→ provider 400').toBe(hasResult);
    expect(hasCall, 'B1 整对不砍：A(c1)+T(c1) 同进同出').toBe(true);
    // 砍满生效：T0..T4（窗内可砍）必须已账本化（砍满语义钉——删「砍满」此断言挂）
    const t0Survives = texts.some((t) => t.includes('t0') && t.includes('3000'));
    expect(t0Survives, 'T0..T4 应被账本化（候选窗内砍满）').toBe(false);
  });

  it('红线 4：账本化产物保留 user 原文幸存 + purpose 账本索引在场（丢弃次序）', async () => {
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 5,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      historyAging: { enabled: false },
      transformStore: new InMemoryTransformStore(),
    });
    // 中段：tool 成对执行、user 交错——tool 账本化、user 原位幸存
    const messages: Message[] = [{ role: 'user', content: 'HEAD', timestamp: 1 }];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `t${i}`, name: 'read_file', arguments: { purpose: `read file ${i}` } }], timestamp: 2 + i * 2 } as Message);
      messages.push({ role: 'tool', content: '', toolResults: [{ toolCallId: `t${i}`, name: 'read_file', result: 'z'.repeat(2000) }], timestamp: 3 + i * 2 } as Message);
      messages.push({ role: 'user', content: `mid-user-${i}`, timestamp: 4 + i * 2 });
    }
    const result = await engine.assemble({
      sessionId: 's-order',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 200,
      contextWindow: 32000,
    });
    const viewText = result.messages.map((m) => JSON.stringify(m)).join('\n');
    // 丢弃次序：user 原文（最不可再生）幸存
    for (let i = 0; i < 8; i++) {
      expect(viewText, `mid-user-${i} 被账本化吞掉（user 原文不可再生，必须幸存）`).toContain(`mid-user-${i}`);
    }
    // 执行记录 → purpose 账本索引在场
    expect(viewText, '被砍工具执行必须留 name+purpose 账本').toContain('read_file');
    expect(viewText, 'purpose 索引必须可追溯').toContain('read file');
  });

  it('红线 7：overflow 收敛事件 start↔终态严格配对（R9-3）', async () => {
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 5,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      historyAging: { enabled: false },
      transformStore: new InMemoryTransformStore(),
    });
    const messages: Message[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push({ role: 'tool', content: '', toolResults: [{ toolCallId: `q${i}`, name: 'r', result: 'y'.repeat(500) }], timestamp: i } as Message);
    }
    const events: Array<{ type: string; cancelled?: boolean; error?: string }> = [];
    await engine.assemble({
      sessionId: 's-pair-events',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 200,
      contextWindow: 32000,
      emit: (e) => events.push(e),
    });
    const starts = events.filter((e) => e.type === 'context.compact.start');
    const terminals = events.filter(
      (e) => e.type === 'context.compact.end' || e.type === 'context.compact.error',
    );
    expect(starts.length).toBeGreaterThan(0);
    expect(terminals.length, '每个 start 必须有配对终态（end 或 error），否则 store compact.active 悬挂').toBe(starts.length);
  });

});
