/**
 * 参数老化改为 per-tool opt-in（2026-11-13 拍板）
 *
 * 背景：会话视图里历史 `assistant.tool_calls` 上的降级标记会被模型模仿回抄
 * （`arch/open-problems.md` OP-TOOL-1 定案「主因=模型从老化视图模仿降级标记形态」）。
 * 因此参数默认**原样保留**，只有「参数本身会变成污染源」的工具才 opt-in：
 * 当前仅 `file_write`（`content` 是整份文件正文，占空间且随文件后续改动变成过期副本）。
 *
 * 本用例锁三件事：
 * 1. 未 opt-in 的工具，结果老化后参数仍逐字保留；
 * 2. opt-in 的工具（`file_write`），参数长值被降级为对象形标记；
 * 3. 参数老化仍与结果老化锁步（结果未老化 → 参数不动）。
 */

import { describe, it, expect } from 'vitest';
import {
  ageOneToolResult,
  applyAgingToMessages,
  shouldAgeArgs,
  collectToolArgAgers,
  collectToolAgers,
  computeToolResultAgingPlan,
  resolveToolResultAgingOptions,
} from '@octopi-agent/engine/harness/context/tool-result-aging.js';
import { createFileEditTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-edit.js';
import { createFileReadTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import { createFileWriteTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import type { Message } from '@octopi-agent/core/types.js';

const OPTS = resolveToolResultAgingOptions({ rawWindow: 0, freezeBatch: 1 });

/** 构造一段「旧轮调用 + 后续新 turn」的历史 */
function history(calls: Array<{ id: string; name: string; args: Record<string, unknown>; result: unknown }>): Message[] {
  const messages: Message[] = [{ role: 'user', content: 'q0', timestamp: 1 } as Message];
  for (const c of calls) {
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: c.id, name: c.name, arguments: c.args }],
      timestamp: 2,
    } as unknown as Message);
    messages.push({
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: c.id, name: c.name, result: c.result }],
      timestamp: 3,
    } as unknown as Message);
  }
  messages.push({ role: 'user', content: 'q1', timestamp: 9 } as Message);
  return messages;
}

const BIG = 'x'.repeat(5000);

describe('参数老化默认关闭：未 opt-in 的工具参数逐字保留', () => {
  it('file_edit 结果成指针，old_text/new_text 仍原样', () => {
    const args = { path: '/a/b.ts', old_text: BIG, new_text: BIG + 'y', purpose: 'edit it' };
    const messages = history([
      {
        id: 'c1',
        name: 'file_edit',
        args,
        // 大结果才会被老化（preview 是真实形态里的大头）
        result: { path: '/a/b.ts', matchCount: 1, replacedCount: 1, preview: { before: BIG, old: 'x', new: 'y', after: BIG } },
      },
    ]);
    const plan = computeToolResultAgingPlan(messages, OPTS);
    expect(plan.agedIds.has('c1')).toBe(true); // 结果被老化
    expect(plan.argAgedIds.size).toBe(0); // 参数不在老化集合

    const [out] = applyAgingToMessages(messages, plan, OPTS).filter((m) => m.toolCalls?.length);
    expect(out.toolCalls![0].arguments).toEqual(args); // 逐字保留
  });

  it('collectToolArgAgers 只收声明了 ageArgs 的工具', () => {
    const set = collectToolArgAgers([{ name: 'file_write', ageArgs: true }, { name: 'file_edit' }]);
    expect(set?.has('file_write')).toBe(true);
    expect(set?.has('file_edit')).toBe(false);
    expect(collectToolArgAgers([])).toBeUndefined();
  });
});

describe('参数老化 opt-in：file_write 的 content 被降级', () => {
  it('file_write 声明了 ageArgs', () => {
    expect(createFileWriteTool().ageArgs).toBe(true);
  });

  // collectToolArgAgers 消费的是 AgentTool 投影（扁平 name），与 collectToolAgers 同源
  const fileWriteAgentTool = { name: 'file_write', ageArgs: createFileWriteTool().ageArgs };

  it('content 变对象形标记，path 等锚点保留', () => {
    const args = { path: '/a/b.ts', content: BIG, append: false, purpose: 'write it' };
    const messages = history([
      { id: 'w1', name: 'file_write', args, result: { path: '/a/b.ts', bytesWritten: 5000, mode: 'overwrite' } },
    ]);
    const plan = computeToolResultAgingPlan(messages, OPTS, {
      toolArgAgers: collectToolArgAgers([fileWriteAgentTool]),
    });
    // 注意：file_write 结果仅 ~120 字符、不会被结果老化；参数老化与结果解耦后仍应命中
    expect(plan.agedIds.has('w1')).toBe(false);
    expect(plan.argAgedIds.has('w1')).toBe(true);

    const [out] = applyAgingToMessages(messages, plan, OPTS).filter((m) => m.toolCalls?.length);
    const aged = out.toolCalls![0].arguments as Record<string, unknown>;
    // 内容载荷 → 对象形标记（放进 string 参数即 schema 违规，被执行边界拒收）
    expect(JSON.stringify(aged.content)).toContain('$octopi_elided');
    // 锚点与 purpose 不动
    expect(aged.path).toBe('/a/b.ts');
    expect(aged.purpose).toBe('write it');
  });

  it('未到冻结区（rawWindow 内）的调用参数不动', () => {
    const args = { path: '/a/b.ts', content: BIG };
    const messages = history([
      { id: 'w2', name: 'file_write', args, result: { path: '/a/b.ts', bytesWritten: 5000, mode: 'overwrite' } },
    ]);
    // rawWindow 默认 20 → 唯一一条候选落在近窗内，冻结区为空
    const plan = computeToolResultAgingPlan(messages, resolveToolResultAgingOptions({}), {
      toolArgAgers: collectToolArgAgers([fileWriteAgentTool]),
    });
    expect(plan.argAgedIds.has('w2')).toBe(false);
  });
});

describe('file_edit 结果 ager：只留执行事实', () => {
  it('保留 N/M replaced 与文件名，丢弃 preview/before/after', () => {
    const out = createFileEditTool().ageResult!({
      args: {},
      result: {
        path: '/repo/CHANGELOG.md',
        matchCount: 9,
        replacedCount: 1,
        occurrence: 'first',
        dryRun: false,
        preview: { before: 'X'.repeat(400), old: 'a', new: 'b', after: 'Y'.repeat(400) },
        totalLines: 1257,
      },
      chars: 9000,
    });
    expect(out).toBe('[aged] file_edit 1/9 replaced in CHANGELOG.md — 8 other match(es) left unchanged');
    expect(out).not.toContain('XXX'); // 不含任何 preview 正文
  });

  it('匹配=替换时不产生额外噪音', () => {
    const out = createFileEditTool().ageResult!({
      args: {},
      result: { path: '/a/b.ts', matchCount: 1, replacedCount: 1 },
      chars: 9000,
    });
    expect(out).toBe('[aged] file_edit 1/1 replaced in b.ts');
  });
});

describe('file_read 结果 ager：正文全丢，留定位', () => {
  it('输出行范围与截断标记', () => {
    const out = createFileReadTool().ageResult!({
      args: {},
      result: { content: 'X'.repeat(9000), totalLines: 3125, truncated: true, fromLine: 1, toLine: 2000 },
      chars: 9000,
    });
    expect(out).toBe('[aged] file_read lines 1-2000/3125, truncated — call file_read for current text');
  });

  it('已摘要的结果不老化（返回 undefined = 保留原文）', () => {
    const out = createFileReadTool().ageResult!({
      args: {},
      result: { content: 'short summary', totalLines: 3125, fromLine: 1, toLine: 3125, summary: { applied: true } },
      chars: 9000,
    });
    expect(out).toBeUndefined();
  });
});

describe('两条视图构建路径必须一致（防逻辑漂移）', () => {
  /**
   * 2026-11-13 实测事故：per-tool ager 只在 applyAgingToMessages 生效，
   * 而真实 wire 路径走 buildLlmMessages 的另一份内联实现，导致 file_edit
   * 在生产仍是默认指针、参数仍被全局降级。两边共用一个裁决点后必须永远一致。
   */
  it('同一计划下，ageOneToolResult 与 applyAgingToMessages 输出同字节', () => {
    const messages = history([
      {
        id: 'e9',
        name: 'file_edit',
        args: { path: '/repo/a.ts', old_text: 'x', new_text: 'y', purpose: 'p' },
        result: { path: '/repo/a.ts', matchCount: 3, replacedCount: 1, preview: { before: 'B'.repeat(600) } },
      },
    ]);
    const agers = collectToolAgers([{ name: 'file_edit', ageResult: createFileEditTool().ageResult }]);
    const plan = computeToolResultAgingPlan(messages, OPTS, { toolAgers: agers });
    expect(plan.agedIds.has('e9')).toBe(true);

    const viaApply = applyAgingToMessages(messages, plan, OPTS).find((m) => m.toolResults?.length)!.toolResults![0]
      .result as string;
    const viaOne = ageOneToolResult(
      { toolCallId: 'e9', name: 'file_edit', result: { path: '/repo/a.ts', matchCount: 3, replacedCount: 1, preview: { before: 'B'.repeat(600) } } },
      { path: '/repo/a.ts', old_text: 'x', new_text: 'y', purpose: 'p' },
      plan,
      OPTS,
    );
    expect(viaApply).toBe(viaOne);
    expect(viaApply).toBe('[aged] file_edit 1/3 replaced in a.ts — 2 other match(es) left unchanged');
  });

  it('shouldAgeArgs 只看 argAgedIds，不回退 agedIds', () => {
    // file_edit 结果被老化，但参数未 opt-in → 不得降级
    const plan = { agedIds: new Set(['e1']), argAgedIds: new Set<string>() };
    expect(shouldAgeArgs('e1', plan, OPTS)).toBe(false);
    expect(shouldAgeArgs('e1', { argAgedIds: new Set(['e1']) }, OPTS)).toBe(true);
    // 总开关关闭时不降级
    expect(shouldAgeArgs('e1', { argAgedIds: new Set(['e1']) }, { ...OPTS, ageToolArgs: false })).toBe(false);
  });
});
