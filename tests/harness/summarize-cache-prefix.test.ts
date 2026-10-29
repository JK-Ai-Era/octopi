/**
 * 缓存友好摘要请求：system+history 与会话请求同形，指令只挂在尾部。
 * 红线：摘要调用不得改写/重排前缀字节，否则 provider 前缀缓存全灭。
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import { LLMSummaryCompressor } from '@octopi-agent/engine/harness/context/llm-summarizer.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

describe('LLMSummaryCompressor 缓存前缀', () => {
  it('有 llmPrefix 时请求 = 前缀原样 + 尾部一条 user 指令', async () => {
    const compressor = new LLMSummaryCompressor();
    const llmPrefix: LLMMessage[] = [
      { role: 'system', content: 'SESSION-SYS-EXACT' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ];
    let captured: LLMMessage[] = [];
    const summarize = async (msgs: LLMMessage[]) => {
      captured = msgs;
      return '## Conversation Summary\nok';
    };

    const out = await compressor.compress({
      messages: [userMsg('q1'), userMsg('q2')],
      targetTokens: 50,
      summarize,
      requireSummary: true,
      llmPrefix,
    });

    expect(out.result.length).toBe(1);
    // 前缀逐条字节不变
    expect(captured.slice(0, llmPrefix.length)).toEqual(llmPrefix);
    // 仅尾部多一条 user
    expect(captured.length).toBe(llmPrefix.length + 1);
    expect(captured[captured.length - 1]!.role).toBe('user');
    const tail = String(captured[captured.length - 1]!.content);
    // F8 统一契约：指令 = 交接式四段式（与手动压缩逐字同源），旧 Done/ToDo 模板不得回归
    expect(tail).toContain('handoff summary');
    expect(tail).toContain('Goal & status');
    expect(tail).toContain('Evidence pointers');
    expect(tail).toContain('does not redo it');
    expect(tail).not.toContain('#### Done');
    // system 不得被改写或附加摘要指令
    expect(String(captured[0]!.content)).toBe('SESSION-SYS-EXACT');
  });

  it('previousSummary 只进尾部指令，不进 system', async () => {
    const compressor = new LLMSummaryCompressor();
    const llmPrefix: LLMMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'old' },
    ];
    let captured: LLMMessage[] = [];
    await compressor.compress({
      messages: [userMsg('old')],
      targetTokens: 50,
      previousSummary: 'PREV-SUM',
      summarize: async (msgs) => {
        captured = msgs;
        return '## Conversation Summary\nv2';
      },
      requireSummary: true,
      llmPrefix,
    });
    expect(String(captured[0]!.content)).toBe('SYS');
    const tail = String(captured[captured.length - 1]!.content);
    expect(tail).toContain('PREV-SUM');
    // F8：合并语义同源（防跨格式漂移）+ P1c 软目标行
    expect(tail).toContain('merge the new work in');
    expect(tail).toContain('Keep output under');
  });

  it('统一契约：预算语义 = clamp(2%, 2k, 8k) 软目标 + 4× 保险丝（F8）', async () => {
    const compressor = new LLMSummaryCompressor();
    let seen: { maxTokens?: number } = {};
    // ~10k 字符 ≈ 2.5k tokens 输入 → 软目标 clamp(2%, 2k, 8k) = 2000 → 硬顶 4× = 8000
    const messages = Array.from({ length: 10 }, (_, i) => userMsg(`m${i}-${'x'.repeat(1000)}`));
    await compressor.compress({
      messages,
      targetTokens: 50,
      summarize: async (_msgs, o) => {
        seen = o ?? {};
        return '1. Goal & status: ok.\n2. Open items: none.\n3. Conclusions: n/a.\n4. Evidence: none.';
      },
      requireSummary: true,
    });
    expect(seen.maxTokens).toBe(8000);
  });
});
