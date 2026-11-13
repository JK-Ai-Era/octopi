/**
 * L1 截断保留策略（head / tail / both）
 *
 * 背景（2026-11-13 生产实测）：`project_run` 43 次输出中 17 次触发 L1 硬顶，
 * 而旧的 head-only 实现把测试汇总（在末尾）整个丢掉——43 次里仅 4 次能看到
 * 「Tests N passed」。`shell` 同理：开头是命令回显与进度，结论在末尾。
 *
 * 本组测试钉住三件事：
 * 1. 缺省仍为 head（既有工具行为不变）；
 * 2. tail/both 确实保留末尾结论；
 * 3. 三种模式下「输出总长 ≤ maxChars」的硬约束都不被破坏。
 */
import { describe, expect, it } from 'vitest';
import { applyL1Truncate } from '@octopi-agent/engine/harness/context/capabilities/summary/gate.js';

/** 构造「大量进度行 + 末尾结论」的真实形态（必须超过 8000 字符才触发 L1） */
function buildRunOutput(): string {
  return `\n RUN  v4.1.7\n${' ✓ tests/harness/example.test.ts (12 tests) 34ms\n'.repeat(300)}\n Test Files  12 passed (12)\n      Tests  660 passed (660)\n   Duration  2621ms\n`;
}

const SUMMARY_RE = /Tests\s+\d+\s+passed/;

describe('applyL1Truncate keep modes', () => {
  it('缺省 head：不改变既有行为，尾部结论被省略', () => {
    const raw = buildRunOutput();
    expect(applyL1Truncate(raw, 8000, 'hint').keep, '未声明 keep 时必须解析为 head').toBe('head');
    const r = applyL1Truncate(raw, 8000, 'hint', 'head');
    expect(r.text.startsWith('\n RUN  v4.1.7'), 'head 模式必须保留开头').toBe(true);
    expect(SUMMARY_RE.test(r.text), 'head 模式丢掉末尾汇总——这正是本次要修的问题').toBe(false);
    expect(r.text).toContain('[truncated: showing first');
  });

  it('tail：保留末尾结论，开头被省略', () => {
    const r = applyL1Truncate(buildRunOutput(), 8000, 'hint', 'tail');
    expect(SUMMARY_RE.test(r.text), 'tail 模式必须保留测试汇总').toBe(true);
    expect(r.text).toContain('Duration');
    expect(r.text.startsWith('[truncated: showing last'), '通知必须在头部，否则会遮住要保留的尾部').toBe(true);
    expect(r.text).not.toContain(' RUN  v4.1.7');
  });

  it('both：头尾都保留，中间省略', () => {
    const r = applyL1Truncate(buildRunOutput(), 8000, 'hint', 'both');
    expect(r.text.startsWith('\n RUN  v4.1.7'), 'both 模式头段保留').toBe(true);
    expect(SUMMARY_RE.test(r.text), 'both 模式尾段保留结论').toBe(true);
    expect(r.text).toContain('omitted');
  });

  it('三种模式都不突破 maxChars 硬顶', () => {
    const raw = buildRunOutput();
    for (const keep of ['head', 'tail', 'both'] as const) {
      const r = applyL1Truncate(raw, 8000, 'hint', keep);
      expect(r.text.length, `${keep} 模式突破 maxChars`).toBeLessThanOrEqual(8000);
      expect(r.truncated).toBe(true);
      expect(r.rawLength).toBe(raw.length);
      expect(r.keep).toBe(keep);
    }
  });

  it('未超限时不截断，keep 原样回传', () => {
    const raw = 'short output';
    for (const keep of ['head', 'tail', 'both'] as const) {
      const r = applyL1Truncate(raw, 8000, 'hint', keep);
      expect(r.text).toBe(raw);
      expect(r.truncated).toBe(false);
      expect(r.keep).toBe(keep);
    }
  });

  it('极小 maxChars 仍保留可操作 hint（三种模式一致）', () => {
    for (const keep of ['head', 'tail', 'both'] as const) {
      const r = applyL1Truncate('x'.repeat(5000), 120, 'do the thing', keep);
      expect(r.text.length, `${keep} 在极小配额下突破上限`).toBeLessThanOrEqual(120);
      expect(r.text, `${keep} 在极小配额下丢失了 hint`).toContain('truncated');
    }
  });
});
