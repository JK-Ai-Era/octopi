/**
 * token 估算缓存回归（性能修复：每轮 context 装配对全历史反复估算/序列化）
 *
 * 对照纪律：缓存路径的结果必须与「绕过缓存的独立手算公式」一致，
 * 且跨 estimator 实例一致（缓存是模块级 WeakMap，纯函数语义不得漂移）。
 */
import { describe, it, expect } from 'vitest';
import { HeuristicTokenEstimator, estimateTextTokens } from '@octopi-agent/engine/harness/context/token-estimator.js';
import { toolResultBody } from '@octopi-agent/engine/harness/context/tool-result-body.js';
import type { Message } from '@octopi-agent/core/types.js';

describe('toolResultBody cache', () => {
  it('serializes error / string / object results identically to the spec', () => {
    const errTr = { error: 'boom', result: null };
    const strTr = { result: 'plain text body' };
    const objTr = { result: { a: 1, b: [2, 3] } };

    expect(toolResultBody(errTr)).toBe(JSON.stringify({ error: 'boom' }));
    expect(toolResultBody(strTr)).toBe('plain text body');
    expect(toolResultBody(objTr)).toBe(JSON.stringify({ a: 1, b: [2, 3] }));

    // 重复调用（缓存命中）结果一致
    expect(toolResultBody(errTr)).toBe(JSON.stringify({ error: 'boom' }));
    expect(toolResultBody(objTr)).toBe(JSON.stringify({ a: 1, b: [2, 3] }));
  });
});

describe('HeuristicTokenEstimator message cache', () => {
  it('matches the uncached hand-computed formula', () => {
    const message: Message = {
      role: 'tool',
      content: '',
      timestamp: 1,
      toolResults: [
        { toolCallId: 'c1', name: 'file_read', result: { content: 'x'.repeat(500) } },
        { toolCallId: 'c2', name: 'shell', result: null, error: 'failed' },
      ],
    };
    const estimator = new HeuristicTokenEstimator();

    // 手算（独立路径，不经过缓存）：overhead + Σ ceil(adjustedChars(body) / 2)
    const expected =
      12 +
      Math.ceil(
        // estimateAdjustedChars 的语义对纯 ASCII = 长度
        JSON.stringify({ content: 'x'.repeat(500) }).length / 2,
      ) +
      Math.ceil(JSON.stringify({ error: 'failed' }).length / 2);

    const first = estimator.estimateMessage(message);
    const second = estimator.estimateMessage(message);
    expect(first).toBe(expected);
    expect(second).toBe(expected);
  });

  it('is consistent across estimator instances (module-level cache semantics)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello world', timestamp: 1 },
      {
        role: 'assistant',
        content: 'working',
        timestamp: 2,
        toolCalls: [{ id: 't1', name: 'file_search', arguments: { pattern: 'foo' } }],
      },
      { role: 'tool', content: '', timestamp: 3, toolResults: [{ toolCallId: 't1', name: 'file_search', result: 'hit' }] },
    ];
    const a = new HeuristicTokenEstimator();
    const b = new HeuristicTokenEstimator();
    expect(a.estimateMessages(messages)).toBe(b.estimateMessages(messages));
    // 重复估算稳定（缓存幂等）
    expect(a.estimateMessages(messages)).toBe(a.estimateMessages(messages));
  });

  it('text estimation is unchanged by caching layer', () => {
    const text = '多语言 mixed content 测试 123';
    expect(estimateTextTokens(text)).toBe(new HeuristicTokenEstimator().estimateText(text));
  });
});
