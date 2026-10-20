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
    expect(tail).toContain('conversation summarizer');
    expect(tail).toContain('HANDOFF');
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
  });
});
