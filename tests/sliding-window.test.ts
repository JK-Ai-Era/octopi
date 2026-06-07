/**
 * 滑动窗口压缩策略测试
 */

import { describe, test, expect } from 'vitest';
import { slidingWindow, createSlidingWindowCompressor } from '../src/harness/context/strategies/sliding-window.js';
import type { Message } from '../src/core/types.js';

function makeMsg(role: 'system' | 'user' | 'assistant' | 'tool', content: string): Message {
  return { role, content, timestamp: Date.now() };
}

describe('滑动窗口压缩策略', () => {
  test('消息数量不超过阈值时不压缩', () => {
    const messages = [
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi'),
    ];

    const { messages: result, result: stats } = slidingWindow(messages, {
      preserveRecent: 10,
      preserveSystem: false,
      preserveTools: false,
    });

    expect(result).toHaveLength(2);
    expect(stats.removedCount).toBe(0);
  });

  test('超过阈值时保留最近的消息', () => {
    const messages = [
      makeMsg('user', 'msg1'),
      makeMsg('assistant', 'msg2'),
      makeMsg('user', 'msg3'),
      makeMsg('assistant', 'msg4'),
      makeMsg('user', 'msg5'),
    ];

    const { messages: result, result: stats } = slidingWindow(messages, {
      preserveRecent: 2,
      preserveSystem: false,
      preserveTools: false,
    });

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('msg4');
    expect(result[1].content).toBe('msg5');
    expect(stats.removedCount).toBe(3);
  });

  test('保留系统消息', () => {
    const messages = [
      makeMsg('system', '你是一个助手'),
      makeMsg('user', 'msg1'),
      makeMsg('assistant', 'msg2'),
      makeMsg('user', 'msg3'),
      makeMsg('assistant', 'msg4'),
    ];

    const { messages: result } = slidingWindow(messages, {
      preserveRecent: 2,
      preserveSystem: true,
      preserveTools: false,
    });

    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('你是一个助手');
    expect(result[1].content).toBe('msg3');
    expect(result[2].content).toBe('msg4');
  });

  test('保留工具消息', () => {
    const messages = [
      makeMsg('user', 'msg1'),
      makeMsg('tool', 'tool result'),
      makeMsg('assistant', 'msg2'),
      makeMsg('user', 'msg3'),
    ];

    const { messages: result } = slidingWindow(messages, {
      preserveRecent: 1,
      preserveSystem: false,
      preserveTools: true,
    });

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('tool result');
    expect(result[1].content).toBe('msg3');
  });

  test('createSlidingWindowCompressor 返回压缩函数', () => {
    const compress = createSlidingWindowCompressor({
      preserveRecent: 2,
      preserveSystem: false,
      preserveTools: false,
    });

    const messages = [
      makeMsg('user', 'msg1'),
      makeMsg('assistant', 'msg2'),
      makeMsg('user', 'msg3'),
    ];

    const result = compress(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('msg2');
  });
});
