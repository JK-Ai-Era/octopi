import { describe, expect, it } from 'vitest';
import { applyAgingToMessages, computeToolResultAgingPlan, resolveToolResultAgingOptions } from '@octopi-agent/engine/harness/context/tool-result-aging.js';
import type { Message } from '@octopi-agent/core/types.js';

/**
 * manual 压缩的摘要前缀必须与会话请求同形——同一份历史、同一老化计划，
 * 产出的 messages 必须逐字节相同。
 *
 * 2026-11-13 生产事故形状：manual 路径没透传 toolAgers，摘要视图退回默认机械指针
 * （`[aged tool result · pointer] file_read; result N chars: ...`），而会话请求用
 * per-tool ager（`[aged] file_read lines 1-31/31 — ...`）。678 个共同工具结果中
 * 515 个（76%）形态不同 → 前缀从第 2 条消息起分叉，缓存 0 命中。
 */

const ager = (input: { result?: unknown }) => {
  const r = input.result as { content?: string } | undefined;
  if (!r || typeof r.content !== 'string') return undefined;
  return '[aged] file_read lines 1-31/31 — call file_read for current text';
};

function history(): Message[] {
  return [
    { role: 'system', content: 'sys', metadata: { source: 'systemPrompt' } } as unknown as Message,
    { role: 'user', content: 'go' } as unknown as Message,
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'file_read', arguments: { path: 'a.md' } }],
      toolResults: [
        { toolCallId: 'c1', name: 'file_read', result: { content: 'X'.repeat(4000) } },
      ] as never,
    } as never,
  ].concat(
    // 造足够的跨轮历史，跨过 rawWindow 进入老化区
    Array.from({ length: 60 }, (_, i) => [
      { role: 'user', content: `u${i}` } as unknown as Message,
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${i}`, name: 'file_read', arguments: { path: 'a.md' } }],
        toolResults: [
          { toolCallId: `c${i}`, name: 'file_read', result: { content: 'Y'.repeat(3000) } },
        ] as never,
      } as never,
    ]).flat(),
  );
}

function agedWith(toolAgers: ReadonlyMap<string, never> | undefined): string {
  const opts = resolveToolResultAgingOptions({});
  // ignoreTurnBoundary：全历史候选、rawWindow 归 0（与 overflow 第 0 轮同式），
  // 让测试直接观测「透传/不透传 agers」的形态差异，而不被 turn 边界保护挡住
  const plan = computeToolResultAgingPlan(history(), opts, {
    toolAgers: toolAgers as never,
    ignoreTurnBoundary: true,
  });
  const aged = applyAgingToMessages(history(), plan, opts);
  return JSON.stringify(aged);
}

describe('manual 压缩摘要前缀与会话请求同形（老化策略必须透传）', () => {
  it('红线：缺 toolAgers 时退回默认机械指针——这正是 2026-11-13 前缀分叉的形状', () => {
    const withoutAgers = agedWith(undefined);
    expect(withoutAgers).toContain('[aged tool result · pointer]');
    expect(withoutAgers).not.toContain('[aged] file_read lines');
  });

  it('红线：透传 toolAgers 后使用 per-tool 指针（与会话请求同形）', () => {
    const withAgers = agedWith(new Map([['file_read', ager]]) as never);
    expect(withAgers).toContain('[aged] file_read lines');
    expect(withAgers).not.toContain('[aged tool result · pointer]');
  });

  it('红线：两种口径产出的字节必然不同——证明「漏传 agers」会打穿前缀缓存', () => {
    expect(agedWith(undefined)).not.toBe(agedWith(new Map([['file_read', ager]]) as never));
  });

  it('红线：同输入同 agers 逐字节稳定（老化计划每次装配都重算，不得漂移）', () => {
    const a = agedWith(new Map([['file_read', ager]]) as never);
    const b = agedWith(new Map([['file_read', ager]]) as never);
    expect(a).toBe(b);
  });
});
