/**
 * P0-3/P0-4 回归
 * - overflow 重组严格时间序（旧 middle 在新 middle 之前）
 * - lastProactiveCoverEnd = tailStart：滑出 tail 的消息进 extra，不丢、不每轮改写
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';

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

describe('P0-4 cover 终点 = tailStart', () => {
  it('压缩后滑出 tail 的消息进入 extra（不丢）', async () => {
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
      proactiveCooldownMs: 0,
    });
    const summarize = async (_m: LLMMessage[]) => '## Conversation Summary\nSUM';

    const base: Message[] = [];
    for (let i = 0; i < 20; i++) {
      base.push(userMsg(`m${i}-` + 'y'.repeat(300)));
    }

    const r1 = await engine.assemble({
      sessionId: 'cover',
      messages: base,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    // tail 起点 = 20-4 = 16；覆盖终点不得是 20
    expect(r1.compactState?.lastProactiveCoverEnd).toBe(16);
    expect(r1.compactState?.lastProactiveMessageCount).toBe(20);

    // 再 +1 条：原 tail 的 m16 滑出 tail，必须进入 extra（在摘要覆盖点之后）
    const grown = [...base, userMsg('new0')];
    const r2 = await engine.assemble({
      sessionId: 'cover',
      messages: grown,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    const text = r2.messages.map((m) => String(m.content ?? '')).join('\n');
    // m15 及更早属于摘要覆盖区间，不回放原文；m16 曾是 tail，滑出后必须在 extra
    expect(text).toContain('m16-');
    expect(text).not.toContain('m15-');
    expect(text).toContain('new0');
    expect(text).toContain('SUM');
  });
});

describe('P0-3 overflow 时间序', () => {
  it('重组顺序为 protectHead → 旧 middle → 新 middle → tail', async () => {
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
      messages.push(userMsg(`OLD-${String(i).padStart(2, '0')}-` + 'z'.repeat(200)));
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

    const texts = result.messages.map((m) => String(m.content ?? ''));
    const text = texts.join('\n');
    const head = text.indexOf('HEAD-0');
    const tailA = text.indexOf('TAIL-A');
    const tailB = text.indexOf('TAIL-B');

    expect(head).toBeGreaterThanOrEqual(0);
    expect(tailA).toBeGreaterThan(head);
    expect(tailB).toBeGreaterThan(tailA);

    // 时间序硬约束：HEAD 所在消息必须在 TAIL 之前，且任何 OLD-* 残迹不得出现在 TAIL-B 之后
    const headIdx = texts.findIndex((t) => t.includes('HEAD-0'));
    const tailBIdx = texts.findIndex((t) => t.includes('TAIL-B'));
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(tailBIdx).toBeGreaterThan(headIdx);
    for (let i = tailBIdx + 1; i < texts.length; i++) {
      expect(texts[i]).not.toMatch(/OLD-\d\d/);
    }
    // 压缩段（若有残迹）必须整段位于 TAIL-A 之前
    const firstTail = texts.findIndex((t) => t.includes('TAIL-A'));
    for (let i = 0; i < texts.length; i++) {
      if (/OLD-\d\d/.test(texts[i]!)) {
        expect(i).toBeLessThan(firstTail);
      }
    }
  });
});
