/**
 * 冷却诚实性消费锚（F8R-01）：`lastProactiveLlmAt` 只随「真正发起过摘要 LLM 调用」推进。
 *
 * 钉死 `DefaultContextEngine.structuralCompact` 用 `outcome.summarizeAttempted` 判定，
 * 而非「注入了 summarize 函数」——内置引擎上两者恒等（fresh ⇒ attempted），
 * 但外部 `CompactEngine` 实现返回 fresh:true 时也必须被如实判定，不得静默推进冷却。
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type {
  CompactEngine,
  CompactOutcome,
} from '@octopi-agent/engine/harness/context/capabilities/compact/types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function stubEngine(summarizeAttempted: boolean): CompactEngine {
  const outcome: CompactOutcome = {
    ok: true,
    compacted: true,
    reason: 'structure_only',
    tokensBefore: 100,
    tokensAfter: 50,
    summary: 'handover summary',
    fresh: true,
    summarizeAttempted,
    view: [userMsg('compacted')],
  };
  return {
    compactMessages: async () => outcome,
    compactText: async () => ({ ...outcome, view: 'compacted text' }),
  };
}

function readState(engine: DefaultContextEngine): { lastProactiveLlmAt?: number } {
  // 白盒读内部状态表（无公开访问器）：消费锚只关心冷却时间戳这一个字段
  const states = (engine as unknown as { states: Map<string, { lastProactiveLlmAt?: number }> })
    .states;
  return [...states.values()][0] ?? {};
}

function conversation(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => userMsg(`m${i}-content`));
}

describe('冷却诚实性（summarizeAttempted 消费锚）', () => {
  it('外部 CompactEngine 返回 fresh:true 但未发起摘要 → 冷却不推进', async () => {
    const engine = new DefaultContextEngine({ compactEngine: stubEngine(false) });
    const summarize = vi.fn(async () => 'summary');
    await engine.compactStructural({
      sessionId: 's-cool-1',
      agentId: 'a1',
      messages: conversation(30),
      summarize,
    });
    expect(readState(engine).lastProactiveLlmAt).toBeUndefined();
  });

  it('真正发起过摘要（summarizeAttempted:true）→ 冷却时间戳推进', async () => {
    const engine = new DefaultContextEngine({ compactEngine: stubEngine(true) });
    await engine.compactStructural({
      sessionId: 's-cool-2',
      agentId: 'a1',
      messages: conversation(30),
      summarize: async () => 'summary',
    });
    expect(typeof readState(engine).lastProactiveLlmAt).toBe('number');
  });
});
