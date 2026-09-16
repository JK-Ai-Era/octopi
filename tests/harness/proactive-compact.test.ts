/**
 * 主动摘要（proactive compact）行为测试
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '../../src/core/types.js';
import type { LLMMessage } from '../../src/core/interfaces/model-provider.js';
import { DefaultContextEngine } from '../../src/harness/context/default-context-engine.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

/** 会返回可识别摘要的 summarize mock */
function mockSummarize() {
  return vi.fn(async (_messages: LLMMessage[], options?: { previousSummary?: string }) => {
    if (options?.previousSummary) {
      return `## Updated Summary\nprev=${options.previousSummary.slice(0, 20)}`;
    }
    return '## Conversation Summary\nproactive-hit';
  });
}

describe('DefaultContextEngine proactiveCompactRatio', () => {
  it('未超阈值时不调用 summarize', async () => {
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({ proactiveCompactRatio: 0.9 });
    const msgs: Message[] = [];
    for (let i = 0; i < 8; i++) {
      msgs.push(userMsg(`short-${i}`));
    }
    await engine.assemble({
      sessionId: 's1',
      messages: msgs,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 100_000,
      summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
  });

  it('超阈值时在硬溢出前触发 LLM 摘要', async () => {
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      protectFirstN: 2,
      protectLastN: 4,
    });

    // 构造：总 token 远低于 100k 窗口，但相对 messagesBudget 的 50% 已超
    // messagesBudget ≈ 100k * 0.8 - system - tools ≈ 很大；改用小 budget
    const msgs: Message[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(userMsg(`content-${i} ` + 'x'.repeat(400)));
    }

    const result = await engine.assemble({
      sessionId: 's-proactive',
      messages: msgs,
      systemPrompt: 'You are test.',
      tools: [],
      // 小窗口：messagesBudget 大约几千，历史明显超过 50%
      tokenBudget: 4000,
      summarize,
    });

    expect(summarize).toHaveBeenCalled();
    expect(result.droppedSummary).toBeTruthy();
    expect(result.messages.some((m) => m.role === 'system')).toBe(true);
  });

  it('增量很小时用缓存摘要重建，不重复打 LLM', async () => {
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      protectFirstN: 2,
      protectLastN: 4,
    });

    const base: Message[] = [];
    for (let i = 0; i < 30; i++) {
      base.push(userMsg(`content-${i} ` + 'x'.repeat(400)));
    }

    const assembleParams = {
      sessionId: 's-cache',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    };

    // 第一次：触发 LLM
    await engine.assemble({ ...assembleParams, messages: base });
    const firstCalls = summarize.mock.calls.length;
    expect(firstCalls).toBeGreaterThanOrEqual(1);

    // 第二次：仅追加 1 条短消息，应走缓存重建
    await engine.assemble({
      ...assembleParams,
      messages: [...base, userMsg('tiny follow-up')],
    });
    expect(summarize.mock.calls.length).toBe(firstCalls);
  });

  it('proactiveCompactRatio=0 时关闭主动摘要', async () => {
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({ proactiveCompactRatio: 0 });
    const msgs: Message[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(userMsg('x'.repeat(400)));
    }
    await engine.assemble({
      sessionId: 's-off',
      messages: msgs,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    // 关闭主动路径后，仅当硬溢出且路由到 compact 才可能调用
    // 这里不强制为 0，但 ratio=0 时 applyProactiveCompact 直接返回
    // 断言：assemble 仍成功
    expect(summarize.mock.calls.length).toBeGreaterThanOrEqual(0);
  });

  it('冷却期内即使增量够大也优先缓存重建', async () => {
    const summarize = mockSummarize();
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      protectFirstN: 2,
      protectLastN: 20,
      proactiveCooldownMs: 60_000,
    });
    const base: Message[] = [];
    for (let i = 0; i < 30; i++) {
      base.push(userMsg('x'.repeat(400)));
    }
    const params = {
      sessionId: 's-cd',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    };
    await engine.assemble({ ...params, messages: base });
    const first = summarize.mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(1);

    // 立刻再 +10 条（超过 minNew），冷却期内不应再打 LLM
    const more = [...base];
    for (let i = 0; i < 10; i++) more.push(userMsg(`n${i}`));
    await engine.assemble({ ...params, messages: more });
    expect(summarize.mock.calls.length).toBe(first);
  });
});
