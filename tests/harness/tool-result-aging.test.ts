/**
 * F1-B2：历史工具结果批量冻结老化（视图级、零 LLM、write-once）
 *
 * 红线（arch/long-session-latency.md §5 B2 + arch/b0-cache-stable-context.md §4）：
 * - 当前 run 永不老化；近 rawWindow 条跨轮原文
 * - 批量冻结：老化边界只成批推进（禁渐进老化——每轮改写 recency 边界=烧前缀缓存）
 * - write-once：指针恒同字节、已降级条目永不回原文（含裁剪视图，评审 F1 回归）
 * - user / assistant 正文永不降级；tool_call/result 配对不拆
 * - error 结果永不降级（错误可追溯性优先）；不膨胀：指针不比原文短就不降级
 */

import { describe, it, expect } from 'vitest';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import {
  agedToolResultPointer,
  computeToolResultAgingPlan,
  resolveToolResultAgingOptions,
  type ToolResultAgingOptions,
} from '@octopi-agent/engine/harness/context/tool-result-aging.js';
import type { Message } from '@octopi-agent/core/types.js';

const OPTS = (over?: Partial<ToolResultAgingOptions>): ToolResultAgingOptions => ({
  enabled: true,
  rawWindow: 40,
  freezeBatch: 20,
  maxPointerChars: 400,
  ...over,
});

let seq = 0;

interface FixtureToolResult {
  toolCallId: string;
  name: string;
  result?: string;
  error?: string;
}

/**
 * 一个「user → assistant(tool_calls) → tool(results)」轮次。
 * 缺省结果正文 ~830 字符（> 400 指针目标，可被降级）。
 */
function toolTurn(
  resultCount: number,
  opts?: { errorAt?: number; resultChars?: number },
): Message[] {
  seq += 1;
  const calls = Array.from({ length: resultCount }, (_, j) => ({
    id: `call-${seq}-${j}`,
    name: 'file_read',
    arguments: { path: `src/f${seq}-${j}.ts`, purpose: 'read fixture' },
  }));
  const results: FixtureToolResult[] = calls.map((tc, j) => ({
    toolCallId: tc.id,
    name: tc.name,
    ...(opts?.errorAt === j
      ? { error: `ENOENT: no such file src/f${seq}-${j}.ts (verbatim error text)` }
      : { result: `file body ${seq}-${j} ${'x'.repeat(opts?.resultChars ?? 800)}` }),
  }));
  return [
    { role: 'user', content: `question ${seq}`, timestamp: 1 } as Message,
    { role: 'assistant', content: '', toolCalls: calls, timestamp: 2 } as unknown as Message,
    { role: 'tool', content: '', toolResults: results, timestamp: 3 } as unknown as Message,
  ];
}

/** 所有工具结果 id（按时间序） */
function allResultIds(messages: Message[]): string[] {
  return messages.flatMap((m) => (m.toolResults ?? []).map((tr: { toolCallId: string }) => tr.toolCallId));
}

/** 引擎载体插槽（user 角色、机器来源）——不是用户发言 */
function carrierSlot(): Message {
  return {
    role: 'user',
    content: '<runtime_snapshot>machine slot</runtime_snapshot>',
    metadata: { source: 'runtimeSnapshot' },
    timestamp: 4,
  } as Message;
}

describe('tool-result-aging plan', () => {
  it('should age beyond rawWindow in freezeBatch steps and keep the tail raw', () => {
    const messages = Array.from({ length: 7 }, () => toolTurn(2)).flat();
    // 6 个历史轮 × 2 条 = 12 跨轮工具结果；第 7 轮是当前 run
    const plan = computeToolResultAgingPlan(messages, OPTS({ rawWindow: 4, freezeBatch: 2 }));
    const ids = allResultIds(messages);
    const crossIds = ids.slice(0, 12);
    const aged = crossIds.filter((id) => plan.agedIds.has(id));
    expect(aged).toHaveLength(8); // 12 - 4 窗 = 8 候选，2 整批
    expect(crossIds.filter((id) => !plan.agedIds.has(id))).toEqual(crossIds.slice(8)); // 近 4 条原文
    // 当前 run 永不老化
    expect(ids.slice(12).every((id) => !plan.agedIds.has(id))).toBe(true);
  });

  it('should leave batch slack raw (candidates not a batch multiple)', () => {
    const messages = Array.from({ length: 3 }, () => toolTurn(1)).flat();
    // 2 跨轮结果，rawWindow=0 → 2 候选，freezeBatch=3 → 整批 0 条降级
    const plan = computeToolResultAgingPlan(messages, OPTS({ rawWindow: 0, freezeBatch: 3 }));
    expect(plan.agedIds.size).toBe(0);
  });

  it('should never age the current run even beyond rawWindow', () => {
    const messages = [...toolTurn(2), ...toolTurn(2), ...toolTurn(10)];
    const plan = computeToolResultAgingPlan(messages, OPTS({ rawWindow: 0, freezeBatch: 1 }));
    const ids = allResultIds(messages);
    expect(ids.slice(4)).toHaveLength(10);
    expect(ids.slice(4).every((id) => !plan.agedIds.has(id))).toBe(true);
    expect(plan.agedIds.size).toBe(4); // 前两轮 4 条全降级
  });

  it('should freeze the boundary between batches (new current-run results change nothing)', () => {
    const opts = OPTS({ rawWindow: 2, freezeBatch: 2 });
    const t1 = toolTurn(2);
    const t2 = toolTurn(2);
    const t3 = toolTurn(2);
    const base = [...t1, ...t2, ...t3];
    const before = computeToolResultAgingPlan(base, opts);
    expect(before.agedIds.size).toBe(2); // 4 跨轮 - 2 窗 = 2 候选 → 整批 2

    // 当前 run 追加 1 条结果（不落新 user）：跨轮集合不变 → 老化集合逐字节稳定
    const extra = toolTurn(1);
    const after = computeToolResultAgingPlan([...base, ...extra.slice(1)], opts);
    expect(after.agedIds.size).toBe(before.agedIds.size);
    for (const id of before.agedIds) expect(after.agedIds.has(id)).toBe(true);
  });

  it('should advance the boundary by whole batches when a new turn lands', () => {
    const opts = OPTS({ rawWindow: 1, freezeBatch: 2 });
    const threeTurns = Array.from({ length: 3 }, () => toolTurn(2)).flat();
    const p3 = computeToolResultAgingPlan(threeTurns, opts);
    // 4 跨轮 - 1 窗 = 3 候选 → 整批 2
    expect(p3.agedIds.size).toBe(2);

    const fourTurns = [...threeTurns, ...toolTurn(2)];
    const p4 = computeToolResultAgingPlan(fourTurns, opts);
    // 6 跨轮 - 1 窗 = 5 候选 → 整批 4：一次 +2（成批），不是 +1 渐进
    expect(p4.agedIds.size).toBe(4);
  });

  it('should not treat engine carrier slots as user turns', () => {
    const messages = [...toolTurn(1), carrierSlot()];
    // 插槽是最后一条 user 角色消息：若误当用户发言，唯一结果会被降级
    const plan = computeToolResultAgingPlan(messages, OPTS({ rawWindow: 0, freezeBatch: 1 }));
    expect(plan.agedIds.size).toBe(0);
  });

  it('should keep small bodies raw (no pointer bloat)', () => {
    const messages = [...toolTurn(1, { resultChars: 5 }), ...toolTurn(1, { resultChars: 5 })];
    const plan = computeToolResultAgingPlan(messages, OPTS({ rawWindow: 0, freezeBatch: 1 }));
    // 正文（~30 字符）远小于指针：降级是纯损失 → 不降级
    expect(plan.agedIds.size).toBe(0);
  });

  it('should never degrade error results even past the freeze line', () => {
    const messages = [...toolTurn(1, { errorAt: 0 }), ...toolTurn(2, { resultChars: 2000 })];
    // maxPointerChars=20 使 error 正文（~70）也过预筛——只有 error 红线在拦
    const plan = computeToolResultAgingPlan(
      messages,
      OPTS({ rawWindow: 0, freezeBatch: 1, maxPointerChars: 20 }),
    );
    expect(plan.agedIds.size).toBe(0);
  });

  it('should only degrade when the pointer is strictly smaller than the body', () => {
    // 不膨胀守卫：maxPointerChars=200 时指针（骨架+截断轮廓）比 ~250 字符正文更长 → 不降级
    const opts = OPTS({ rawWindow: 0, freezeBatch: 1, maxPointerChars: 200 });
    const hugeArgs = { blob: 'a'.repeat(600) };
    const body = 'x'.repeat(248);
    const tr: FixtureToolResult = { toolCallId: 'c-big', name: 'file_read', result: body };
    const pointer = agedToolResultPointer(tr, hugeArgs, opts);
    expect(pointer.length).toBeGreaterThan(250); // 指针比原文长（285 > 250）
    // 计划层同样拒绝（构造同形消息）
    const messages = [
      { role: 'user', content: 'q', timestamp: 1 } as Message,
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c-big', name: 'file_read', arguments: hugeArgs }],
        timestamp: 2,
      } as unknown as Message,
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'c-big', name: 'file_read', result: body }],
        timestamp: 3,
      } as unknown as Message,
      ...toolTurn(1),
    ];
    const plan = computeToolResultAgingPlan(messages, opts);
    expect(plan.agedIds.has('c-big')).toBe(false);
  });

  it('should produce write-once pointers: same bytes for the same input, even distinct objects', () => {
    const opts = OPTS();
    const mk = (): FixtureToolResult => ({ toolCallId: 'c', name: 'file_read', result: 'x'.repeat(800) });
    const p1 = agedToolResultPointer(mk(), { path: 'src/a.ts' }, opts);
    const p2 = agedToolResultPointer(mk(), { path: 'src/a.ts' }, opts);
    const p3 = agedToolResultPointer(mk(), { path: 'src/a.ts' }, opts);
    expect(p2).toBe(p1); // 不同对象、同输入 → 恒同字节（纯函数定形）
    expect(p3).toBe(p1);
    // 结构：工具名 + 参数要点 + 结果轮廓 + re-run 提示
    expect(p1).toContain('tool: file_read');
    expect(p1).toContain('src/a.ts');
    expect(p1).toContain('result: ');
    expect(p1).toContain('re-run this tool call');
  });

  it('should scale the pointer with maxPointerChars (the knob is real)', () => {
    const tr: FixtureToolResult = { toolCallId: 'c', name: 'file_read', result: 'x'.repeat(2000) };
    const small = agedToolResultPointer(tr, { path: 'a' }, OPTS({ maxPointerChars: 150 }));
    const large = agedToolResultPointer(tr, { path: 'a' }, OPTS({ maxPointerChars: 800 }));
    expect(small.length).toBeLessThan(large.length);
    expect(small.length).toBeLessThan(260);
    expect(large.length).toBeLessThan(700);
  });

  it('should keep error text verbatim in the defensive pointer branch', () => {
    const tool = toolTurn(1, { errorAt: 0 })[2] as unknown as { toolResults: FixtureToolResult[] };
    const pointer = agedToolResultPointer(tool.toolResults[0], { path: 'src/b.ts' }, OPTS());
    // 计划永不选中 error；此分支仅防御性保真——错误文案原样
    expect(pointer).toContain('error: ');
    expect(pointer).toContain('ENOENT: no such file');
  });

  it('should disable aging entirely when enabled=false', () => {
    const messages = Array.from({ length: 3 }, () => toolTurn(1)).flat();
    const plan = computeToolResultAgingPlan(messages, OPTS({ enabled: false, rawWindow: 0, freezeBatch: 1 }));
    expect(plan.agedIds.size).toBe(0);
    expect(resolveToolResultAgingOptions({ enabled: false }).enabled).toBe(false);
    expect(resolveToolResultAgingOptions({}).rawWindow).toBe(40);
    expect(resolveToolResultAgingOptions({ freezeBatch: 0 }).freezeBatch).toBe(20); // 0 = 非法步长回落缺省
  });
});

describe('DefaultContextEngine — aged LLM view', () => {
  it('should serve pointers for aged results and raw for the tail, pairing intact', async () => {
    const engine = new DefaultContextEngine({
      historyAging: { rawWindow: 2, freezeBatch: 2 },
    });
    const messages = Array.from({ length: 4 }, () => toolTurn(2)).flat();
    const expectedUserTexts = messages.filter((m) => m.role === 'user').map((m) => m.content);
    const result = await engine.assemble({ sessionId: 's-aging', messages, systemPrompt: 'sys', tools: [] });

    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(8); // tool_call/result 配对不拆
    const aged = toolMsgs.filter((m) => String(m.content).includes('[aged tool result'));
    const raw = toolMsgs.filter((m) => !String(m.content).includes('[aged tool result'));
    // 6 跨轮 - 2 窗 = 4 候选 → 整批 4 降级；近 2 条 + 当前 run 2 条原文
    expect(aged).toHaveLength(4);
    expect(raw).toHaveLength(4);

    // 配对：assistant tool_calls 与 tool 结果同 id 共存
    const callIds = result.messages.flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.id));
    const resultIds = toolMsgs.map((m) => m.tool_call_id);
    expect([...callIds].sort()).toEqual([...resultIds].sort());

    // 红线：user 正文逐字节保真
    const userTexts = result.messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(userTexts).toEqual(expect.arrayContaining(expectedUserTexts));
  });

  it('should keep aged entries aged even when the assembly view is trimmed (write-once, F1 regression)', async () => {
    const engine = new DefaultContextEngine({
      protectFirstN: 3,
      protectLastN: 3,
      historyAging: { rawWindow: 1, freezeBatch: 2 },
    });
    const t0 = toolTurn(2); // A1,A2
    const t1 = toolTurn(2); // B1,B2
    const t2 = toolTurn(2); // C1,C2
    const t3 = toolTurn(2); // D1,D2（当前 run）
    const full = [...t0, ...t1, ...t2, ...t3];
    await engine.compactStructural({
      sessionId: 's-trim',
      messages: full,
      summarize: async () => 'SUMMARY MARKER',
    });

    // 结构视图 = head(3: q0/asst0/tool0) + summary + tail(3: q3/asst3/tool3)——B/C 段被裁掉。
    // 完整历史口径：跨轮 6 条（A/B/C），rawWindow=1 → 5 候选 → 整批 4：A1,A2,B1,B2 降级。
    // 若按裁剪视图重算边界（旧缺陷），视图内 crossTurn 仅 A1,A2、covered=0 → 全部回原文。
    const result = await engine.assemble({ sessionId: 's-trim', messages: full, systemPrompt: 'sys', tools: [] });
    const toolTexts = result.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    const aged = toolTexts.filter((t) => t.includes('[aged tool result'));
    const raw = toolTexts.filter((t) => !t.includes('[aged tool result'));
    expect(aged).toHaveLength(2); // A1/A2 过冻结线 → 指针（B/C 不在视图）
    expect(raw).toHaveLength(2); // D1/D2 当前 run → 原文
    expect(aged.every((t) => t.includes('tool: file_read'))).toBe(true);
  });

  it('should keep the aged view byte-stable across rebuilds (cache-stable)', async () => {
    const engine = new DefaultContextEngine({
      historyAging: { rawWindow: 1, freezeBatch: 2 },
    });
    const messages = Array.from({ length: 3 }, () => toolTurn(2)).flat();
    const first = await engine.assemble({ sessionId: 's-stable', messages, systemPrompt: 'sys', tools: [] });
    const second = await engine.assemble({ sessionId: 's-stable', messages, systemPrompt: 'sys', tools: [] });
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
  });

  it('should shrink the measured request consistently (estimator sees the aged view)', async () => {
    const messages = Array.from({ length: 4 }, () => toolTurn(2)).flat();
    const agedEngine = new DefaultContextEngine({
      historyAging: { rawWindow: 0, freezeBatch: 1 },
    });
    const rawEngine = new DefaultContextEngine({ historyAging: { enabled: false } });
    const aged = await agedEngine.assemble({ sessionId: 's-est', messages, systemPrompt: 'sys', tools: [] });
    const raw = await rawEngine.assemble({ sessionId: 's-est', messages, systemPrompt: 'sys', tools: [] });
    // 尺子一致性：估算作用于老化视图（6 条跨轮降级为指针）
    expect(aged.estimatedTokens).toBeLessThan(raw.estimatedTokens);
    expect(aged.estimatedTokens).toBeGreaterThan(0);
  });

  it('should never degrade error results in the LLM view (fidelity first)', async () => {
    const engine = new DefaultContextEngine({
      historyAging: { rawWindow: 0, freezeBatch: 1, maxPointerChars: 20 },
    });
    const messages = [...toolTurn(1, { errorAt: 0 }), ...toolTurn(1)];
    const result = await engine.assemble({ sessionId: 's-err', messages, systemPrompt: 'sys', tools: [] });
    const toolTexts = result.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    // error 结果即使过窗也保持原文（含错误文案），且视图内无任何指针
    expect(toolTexts.some((t) => t.includes('ENOENT'))).toBe(true);
    expect(toolTexts.some((t) => t.includes('[aged tool result'))).toBe(false);
  });
});
