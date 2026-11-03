/**
 * DefaultMessageSelector — 尺子与作用域同源（measureMessages）
 *
 * 回归背景（2026-11-04）：选择器按**原文**估算时会与实际请求体量脱节。
 * 老化把结果换成指针后，原文仍巨大 → 每请求都判溢出 → 每请求触发一次溢出
 * 摘要 → 摘要插在中段 → 前缀缓存整段报废（生产实测命中率 98% → 29%）。
 *
 * 契约：切分按原文（溢出段必须吃原文做摘要，F-b），估算按 `measureMessages`。
 */

import { describe, expect, it } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultMessageSelector } from '@octopi-agent/engine/harness/context/message-selector.js';
import {
  applyAgingToMessages,
  computeToolResultAgingPlan,
  resolveToolResultAgingOptions,
} from '@octopi-agent/engine/harness/context/tool-result-aging.js';

/**
 * 构造 N 组 [user, assistant(toolCall), tool(30k 正文)] —— 原文远大于老化视图
 *
 * @param n - 工具调用组数
 * @returns 消息序列
 */
function bigToolHistory(n: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < n; i++) {
    const id = `call_${i}`;
    messages.push({
      role: 'user',
      content: `step ${i}`,
      timestamp: i,
    });
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id, name: 'file_read', arguments: { purpose: `read f${i}`, path: `/x/${i}` } },
      ],
      timestamp: i,
    });
    messages.push({
      role: 'tool',
      content: '',
      toolResults: [
        { toolCallId: id, name: 'file_read', result: { content: 'x'.repeat(30_000) } },
      ],
      timestamp: i,
    });
  }
  return messages;
}

describe('DefaultMessageSelector — measureMessages（老化视图度量）', () => {
  const selector = new DefaultMessageSelector();
  const baseOptions = { maxTokens: 200_000, protectFirstN: 5, protectLastN: 20 };

  it('量原文时误判溢出；量老化视图时全部放得下', () => {
    const messages = bigToolHistory(50);
    const opts = resolveToolResultAgingOptions({ enabled: true, rawWindow: 5, freezeBatch: 5 });
    const plan = computeToolResultAgingPlan(messages, opts);
    const aged = applyAgingToMessages(messages, plan, opts);

    // 前置：老化确实发生且不改变条数/顺序（下标映射成立）
    expect(plan.agedIds.size).toBeGreaterThan(0);
    expect(aged).toHaveLength(messages.length);

    const measuredRaw = selector.select(messages, baseOptions);
    const measuredAged = selector.select(messages, { ...baseOptions, measureMessages: aged });

    // 旧行为：原文口径下大面积误判溢出（这正是每请求烧缓存的来源）
    expect(measuredRaw.overflow.length).toBeGreaterThan(0);
    // 新行为：按实际发送体量，一切放得下 → 不触发溢出压缩
    expect(measuredAged.overflow).toHaveLength(0);
    expect(measuredAged.kept).toHaveLength(messages.length);
  });

  it('切分仍返回原文对象（溢出段必须吃原文做摘要）', () => {
    const messages = bigToolHistory(50);
    const opts = resolveToolResultAgingOptions({ enabled: true, rawWindow: 5, freezeBatch: 5 });
    const plan = computeToolResultAgingPlan(messages, opts);
    const aged = applyAgingToMessages(messages, plan, opts);

    // 极紧预算逼出溢出
    const tight = selector.select(messages, {
      maxTokens: 20_000,
      protectFirstN: 5,
      protectLastN: 20,
      measureMessages: aged,
    });

    expect(tight.overflow.length).toBeGreaterThan(0);
    // 返回的是原数组里的对象本身，不是老化副本
    const returned = [...tight.kept, ...tight.overflow, ...tight.tail];
    for (const m of returned) {
      expect(messages).toContain(m);
    }
  });

  it('省略 measureMessages 时行为与旧实现一致（量原文）', () => {
    const messages = bigToolHistory(10);
    const a = selector.select(messages, { ...baseOptions, maxTokens: 100_000 });
    const b = selector.select(messages, {
      ...baseOptions,
      maxTokens: 100_000,
      measureMessages: messages,
    });
    expect(a.kept.length).toBe(b.kept.length);
    expect(a.overflow.length).toBe(b.overflow.length);
  });
});
