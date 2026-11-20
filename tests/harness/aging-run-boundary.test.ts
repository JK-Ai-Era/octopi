/**
 * 老化边界 = 当前 run 起点（2026-11-20 拍板方案 A）
 *
 * 回归钉：
 * - 同 run 插话（v0.95 起同 run 多 turn）不推进老化边界——任务中途的工具工作数据
 *   不被降级。修复前边界取「最近一条真实 user」，插话一落库即把同 run 先前结果
 *   整体划入跨轮候选（插话即触发老化）。
 * - agentId 归因 user（appendCommandDiscourse 命令话语）不推进边界——与
 *   isMidTurn/compact 的边界谓词收敛（单一真源 isTurnBoundaryAnchor）。
 * - 无 runId 的历史数据（升级前）回落 turn 语义，旧行为不变。
 */

import { describe, it, expect } from 'vitest';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { currentRunStartAnchorIndex } from '@octopi-agent/engine/harness/context/layer-types.js';
import {
  computeToolResultAgingPlan,
  resolveToolResultAgingOptions,
  type ToolResultAgingOptions,
} from '@octopi-agent/engine/harness/context/tool-result-aging.js';
import type { Message } from '@octopi-agent/core/types.js';

const OPTS = (over?: Partial<ToolResultAgingOptions>): ToolResultAgingOptions => ({
  ...resolveToolResultAgingOptions({}),
  rawWindow: 0,
  freezeBatch: 1,
  ...over,
});

let seq = 0;

/** 锚点消息（真实 user 发言；runId 缺省 = 升级前历史，无 run 归因） */
function anchor(runId?: string, content?: string): Message {
  seq += 1;
  return {
    role: 'user',
    content: content ?? `question ${seq}`,
    timestamp: seq,
    ...(runId ? { metadata: { runId } } : {}),
  } as Message;
}

/** 「assistant(tool_calls) → tool(results)」一轮工具活动（结果 ~800 字符，可被降级） */
function toolActivity(resultCount: number): Message[] {
  seq += 1;
  const calls = Array.from({ length: resultCount }, (_, j) => ({
    id: `call-${seq}-${j}`,
    name: 'file_read',
    arguments: { path: `src/f${seq}-${j}.ts`, purpose: 'read fixture' },
  }));
  const results = calls.map((tc, j) => ({
    toolCallId: tc.id,
    name: tc.name,
    result: `file body ${seq}-${j} ${'x'.repeat(800)}`,
  }));
  return [
    { role: 'assistant', content: '', toolCalls: calls, timestamp: seq } as unknown as Message,
    { role: 'tool', content: '', toolResults: results, timestamp: seq } as unknown as Message,
  ];
}

/** 一个 run 段：锚点 + turns × perTurn 条工具结果 */
function segment(runId: string | undefined, turns: number, perTurn = 2): Message[] {
  return [anchor(runId), ...Array.from({ length: turns }, () => toolActivity(perTurn)).flat()];
}

/** 插话 / 接续注入（同 run 的第二个 turn 锚点） */
function interjection(runId: string): Message {
  return anchor(runId, 'interjection: keep going but also check X');
}

/** appendCommandDiscourse 形态的命令话语（agentId 归因 user + assistant 对） */
function commandDiscourse(): Message[] {
  seq += 1;
  return [
    {
      role: 'user',
      content: '/status',
      timestamp: seq,
      agentId: 'agent-main',
      metadata: { kind: 'command' },
    } as Message,
    {
      role: 'assistant',
      content: 'status: ok',
      timestamp: seq,
      agentId: 'agent-main',
      metadata: { kind: 'command_result' },
    } as Message,
  ];
}

function allResultIds(messages: Message[]): string[] {
  return messages.flatMap((m) => (m.toolResults ?? []).map((tr: { toolCallId: string }) => tr.toolCallId));
}

describe('老化边界 = 当前 run 起点（方案 A）', () => {
  it('同 run 插话不推进老化边界：任务中途工作数据全保（插话即触发老化的回归钉）', () => {
    const messages = [...segment('R1', 3, 2), ...toolActivity(2), interjection('R1')];
    // 修复前：边界跳到插话处 → 8 条结果全成跨轮候选 → 全降级
    const plan = computeToolResultAgingPlan(messages, OPTS());
    expect(plan.agedIds.size).toBe(0);
  });

  it('跨 run 老化照常：新 run 锚点推进边界，前一 run 结果过线即降级', () => {
    const messages = [...segment('R0', 2, 2), ...segment('R1', 1, 2)];
    const plan = computeToolResultAgingPlan(messages, OPTS());
    const ids = allResultIds(messages);
    expect(ids).toHaveLength(6);
    // 前 4 条属 R0（跨 run）→ 降级；R1 的 2 条全保
    expect(ids.slice(0, 4).every((id) => plan.agedIds.has(id))).toBe(true);
    expect(ids.slice(4).every((id) => !plan.agedIds.has(id))).toBe(true);
  });

  it('无 runId 历史回落 turn 语义（旧行为不变）', () => {
    const messages = [...segment(undefined, 2, 2), ...segment(undefined, 1, 2)];
    const plan = computeToolResultAgingPlan(messages, OPTS());
    const ids = allResultIds(messages);
    // 与旧行为一致：边界 = 最后锚点 → 前 4 条降级、末轮 2 条原文
    expect(ids.slice(0, 4).every((id) => plan.agedIds.has(id))).toBe(true);
    expect(ids.slice(4).every((id) => !plan.agedIds.has(id))).toBe(true);
  });

  it('agentId 命令话语不推进老化边界（与 isMidTurn/compact 谓词收敛的回归钉）', () => {
    // 带 runId：边界钉在 run 起点
    const stamped = [...segment('R1', 2, 2), ...commandDiscourse()];
    expect(computeToolResultAgingPlan(stamped, OPTS()).agedIds.size).toBe(0);

    // 无 runId（升级前历史）：命令话语同样不是锚点——旧实现会把它当 turn 边界、
    // 把前面 4 条结果降级；收敛后回落「最后真实锚点 = run 起点」→ 全保
    const legacy = [...segment(undefined, 2, 2), ...commandDiscourse()];
    expect(computeToolResultAgingPlan(legacy, OPTS()).agedIds.size).toBe(0);
  });

  it('混合历史：升级前无归因锚点不拉回边界，新 run 起点即分界', () => {
    const messages = [...segment(undefined, 2, 2), ...segment('R2', 1, 2), interjection('R2')];
    const plan = computeToolResultAgingPlan(messages, OPTS());
    const ids = allResultIds(messages);
    // 旧段 4 条跨 run → 降级；R2 run（含插话前后）4 条全保
    expect(ids.slice(0, 4).every((id) => plan.agedIds.has(id))).toBe(true);
    expect(ids.slice(4).every((id) => !plan.agedIds.has(id))).toBe(true);
  });

  it('无归因锚点作 run 分界：不把旧数据归入新 run（保守方向）', () => {
    // 混合历史：升级前锚点（无 runId）不能被归入后续 run——边界钉在首个可归因锚点
    const messages = [...segment(undefined, 2, 2), interjection('R2')];
    const plan = computeToolResultAgingPlan(messages, OPTS());
    expect(plan.agedIds.size).toBe(4); // 无归因段跨 run，照常老化
  });

  it('边界单调前进（write-once 前提；评审 del-5ca70159 P1-1 反例钉）', () => {
    // 未打标锚点夹在同 run 打标锚点之间：回溯「跳过」会把边界拉回
    // （已降级条目回原文、批量段翻转的 F1 事故形态），「即停」保证单调。
    const history: Message[] = [
      anchor('R1'),
      ...toolActivity(1),
      anchor(undefined), // 无归因锚点
      ...toolActivity(1),
      anchor('R1'),
    ];
    let prev = -1;
    for (let i = 1; i <= history.length; i++) {
      const b = currentRunStartAnchorIndex(history.slice(0, i));
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
    // 终态：边界 = 最后一个 R1 锚点（未打标锚点是 run 分界，不拉回更早的 R1）
    expect(prev).toBe(6);
  });
});

describe('DefaultContextEngine — run 起点边界的 LLM 视图', () => {
  it('插话后的装配视图：插话前工具结果仍为原文（工作现场不丢）', async () => {
    const engine = new DefaultContextEngine({ historyAging: { rawWindow: 0, freezeBatch: 1 } });
    const messages = [...segment('R1', 3, 2), interjection('R1')];
    const result = await engine.assemble({ sessionId: 's-run-b', messages, systemPrompt: 'sys', tools: [] });
    const toolTexts = result.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(toolTexts).toHaveLength(6);
    expect(toolTexts.some((t) => t.includes('[aged tool result'))).toBe(false);
  });

  it('跨 run 装配视图：前一 run 结果为指针、当前 run 为原文', async () => {
    const engine = new DefaultContextEngine({ historyAging: { rawWindow: 0, freezeBatch: 1 } });
    const messages = [...segment('R0', 2, 2), ...segment('R1', 1, 2), interjection('R1')];
    const result = await engine.assemble({ sessionId: 's-run-b2', messages, systemPrompt: 'sys', tools: [] });
    const toolTexts = result.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    const aged = toolTexts.filter((t) => t.includes('[aged tool result'));
    expect(aged).toHaveLength(4); // R0 的 4 条
    expect(toolTexts.filter((t) => !t.includes('[aged tool result'))).toHaveLength(2); // R1 的 2 条
  });
});
