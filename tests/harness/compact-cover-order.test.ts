/**
 * P0-3/P0-4 回归（转换记录语义重述，step-4）
 * - overflow 重组严格时间序（旧 middle 在新 middle 之前）
 * - 记录覆盖 [headEnd, tailStart)：滑出 tail 的未覆盖消息逐字回放，不丢
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { InMemoryTransformStore } from '@octopi-agent/engine/harness/session/transform-store.js';
import { resolveRun } from '@octopi-agent/engine/harness/context/transform/anchors.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function toolTurn(n: number, chars: number): Message[] {
  return [
    {
      role: 'assistant',
      content: `call ${n}`,
      timestamp: Date.now(),
      toolCalls: [{ id: `c${n}`, name: 'file_read', arguments: { path: `f${n}` } }],
    },
    {
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolResults: [
        { toolCallId: `c${n}`, name: 'file_read', result: 'x'.repeat(chars) },
      ],
    },
  ];
}

describe('P0-4 记录覆盖终点 = tailStart', () => {
  it('压缩后滑出 tail 的消息逐字回放（不丢）', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    const summarize = async (_m: LLMMessage[]) => '## Conversation Summary\nSUM';

    const base: Message[] = [];
    for (let i = 0; i < 20; i++) {
      base.push(userMsg(`m${i}-` + 'y'.repeat(300)));
    }

    const r1 = await engine.assemble({
      sessionId: 'cover',
      agentId: 'a',
      messages: base,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    // 覆盖区间 = [headEnd=2, tailStart=16)：m15 及更早被记录覆盖，覆盖终点不得是 20
    const ledger = await store.load('cover', 'a');
    expect(ledger.records).toHaveLength(1);
    const rec = ledger.records[0]!;
    expect(rec.type).toBe('summary');
    expect(rec.covers.map((run) => resolveRun(base, run))).toEqual([[2, 15]]);
    const text1 = r1.messages.map((m) => String(m.content ?? '')).join('\n');
    expect(text1).toContain('SUM');
    expect(text1).not.toContain('m15-');
    expect(text1).toContain('m16-');

    // 再 +1 条：原 tail 的 m16 滑出 tail，未被任何记录覆盖 → 必须逐字在视图里
    const grown = [...base, userMsg('new0')];
    const r2 = await engine.assemble({
      sessionId: 'cover',
      agentId: 'a',
      messages: grown,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    const text = r2.messages.map((m) => String(m.content ?? '')).join('\n');
    // m15 及更早属于记录覆盖区间，不回放原文；m16 曾是 tail，滑出后必须逐字可见
    expect(text).toContain('m16-');
    expect(text).not.toContain('m15-');
    expect(text).toContain('new0');
    expect(text).toContain('SUM');
  });
});

describe('P0-3 overflow 时间序', () => {
  it('收敛产物保序：幸存消息/占位符覆盖区间的相对时间序不乱（Q1 纯机械换代）', async () => {
    // 极小预算逼 overflow：kept=尾侧 middle+tail，overflow=旧 middle
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 2,
      targetTokens: 0,
      proactiveCompactRatio: 1, // 关闭 proactive，只走 MessageSelector overflow
    });

    const messages: Message[] = [];
    // 可识别顺序的标记
    messages.push(userMsg('HEAD-0'));
    for (let i = 0; i < 30; i++) {
      // OLD 用 tool 执行（user 不可账本化——账本化对象是工具执行）
      messages.push({ role: 'tool', content: '', toolResults: [{ toolCallId: `o${i}`, name: 'old_op', result: `OLD-${String(i).padStart(2, '0')}-` + 'z'.repeat(200) }], timestamp: Date.now() + i } as Message);
    }
    messages.push(userMsg('TAIL-A'));
    messages.push(userMsg('TAIL-B'));

    const result = await engine.assemble({
      sessionId: 'order',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 800,
    });

    // Q1 纯机械收敛后旧区内容可能被账本化（占位符），但幸存者必须保序：
    // 幸存消息在视图里的顺序 = 原始序列里的顺序（收敛砍原对象、不重排）
    const texts = result.messages.map((m) => String(m.content ?? ''));
    const origins = [ 'HEAD-0', ...Array.from({ length: 30 }, (_, i) => `OLD-${String(i).padStart(2, '0')}-`), 'TAIL-A', 'TAIL-B' ];
    const survivorIdx = texts
      .map((t) => origins.findIndex((o) => t.includes(o)))
      .filter((i) => i >= 0);
    expect(survivorIdx.length).toBeGreaterThan(1);
    // 真信号（补强「同义反复」批评）：账本 notice 必须落在时间序锚上——
    // head 之后、tail 之前（账本占据被砍区间的位置，不得漂到视图两端）
    const noticeIdx = texts.findIndex((t) => t.includes('Tool call ledger'));
    const headIdx = texts.findIndex((t) => t.includes('HEAD-0'));
    const tailIdx = texts.findIndex((t) => t.includes('TAIL-A'));
    expect(noticeIdx, '账本 notice 必须在场').toBeGreaterThanOrEqual(0);
    expect(noticeIdx, 'notice 在 head 之后（时间序锚）').toBeGreaterThan(headIdx);
    expect(noticeIdx, 'notice 在 tail 之前（时间序锚）').toBeLessThan(tailIdx);
    for (let i = 1; i < survivorIdx.length; i++) {
      expect(survivorIdx[i]).toBeGreaterThan(survivorIdx[i - 1]!);
    }
    // 最后一条 user（锚，硬保护）必须幸存
    expect(texts.some((t) => t.includes('TAIL-B'))).toBe(true);
  });
});
