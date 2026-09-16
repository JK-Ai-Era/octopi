/**
 * system 去重 + 摘要 user 角色
 */

import { describe, it, expect } from 'vitest';
import { DefaultContextEngine } from '../../src/harness/context/default-context-engine.js';
import type { Message } from '../../src/core/types.js';
import type { LLMMessage } from '../../src/core/interfaces/model-provider.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

describe('buildLlmMessages 托管 system 去重', () => {
  it('messages 里已有 systemPrompt 托管消息时只保留一条 system', async () => {
    const engine = new DefaultContextEngine({ proactiveCompactRatio: 0 });
    const managedSystem: Message = {
      role: 'system',
      content: 'You are octopi.',
      timestamp: Date.now(),
      metadata: { source: 'systemPrompt' as const },
    };
    const messages: Message[] = [managedSystem, userMsg('hello')];

    const result = await engine.assemble({
      sessionId: 's-dup',
      messages,
      systemPrompt: 'You are octopi.',
      tools: [],
      tokenBudget: 32000,
    });

    const systems = result.messages.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(1);
    expect(String(systems[0]?.content)).toBe('You are octopi.');
  });

  it('无 metadata 的外部 system 仍保留', async () => {
    const engine = new DefaultContextEngine({ proactiveCompactRatio: 0 });
    const external: Message = {
      role: 'system',
      content: 'imported policy',
      timestamp: Date.now(),
    };
    const result = await engine.assemble({
      sessionId: 's-ext',
      messages: [external, userMsg('hi')],
      systemPrompt: 'persona',
      tools: [],
      tokenBudget: 32000,
    });
    const systems = result.messages.filter((m) => m.role === 'system');
    expect(systems.length).toBe(2);
    expect(result.messages.some((m) => m.content === 'imported policy')).toBe(true);
  });
});

describe('压缩摘要使用 user 角色', () => {
  it('主动摘要缓存重建产出 user + contextSummary，无中段 system', async () => {
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      protectFirstN: 2,
      protectLastN: 4,
    });
    const summarize = async (_m: LLMMessage[]) => '## Conversation Summary\nbody';

    const base: Message[] = [];
    for (let i = 0; i < 30; i++) {
      base.push(userMsg('x'.repeat(400)));
    }
    await engine.assemble({
      sessionId: 's-role',
      messages: base,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });

    const second = await engine.assemble({
      sessionId: 's-role',
      messages: [...base, userMsg('tiny')],
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });

    const summaryMsgs = second.messages.filter(
      (m) => m.metadata?.source === 'contextSummary' || String(m.content).includes('[Conversation Summary]'),
    );
    expect(summaryMsgs.length).toBeGreaterThan(0);
    expect(summaryMsgs[0]?.role).toBe('user');
    // 唯一 system 来自 systemPrompt 参数
    const systems = second.messages.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(1);
    expect(String(systems[0]?.content)).toBe('sys');
  });
});
