/**
 * TUI 断线重连策略——指数退避与上限行为。
 */

import { describe, it, expect } from 'vitest';
import { reconnectDelay, DEFAULT_RECONNECT_PLAN } from '../src/integration/tui/reconnect.js';

describe('reconnectDelay（指数退避）', () => {
  it('默认计划：1s → 2s → 4s → 8s → 16s 封顶', () => {
    expect(reconnectDelay(1)).toBe(1000);
    expect(reconnectDelay(2)).toBe(2000);
    expect(reconnectDelay(3)).toBe(4000);
    expect(reconnectDelay(4)).toBe(8000);
    expect(reconnectDelay(5)).toBe(16_000);
    expect(reconnectDelay(6)).toBe(16_000); // 封顶
  });

  it('attempt 归一：非正数/小数按第 1 次处理', () => {
    expect(reconnectDelay(0)).toBe(1000);
    expect(reconnectDelay(-3)).toBe(1000);
    expect(reconnectDelay(2.9)).toBe(2000);
  });

  it('自定义计划生效', () => {
    const plan = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 900 };
    expect(reconnectDelay(1, plan)).toBe(500);
    expect(reconnectDelay(2, plan)).toBe(900); // 1000 被封顶
    expect(reconnectDelay(3, plan)).toBe(900);
  });

  it('默认计划上限 5 次（放弃语义由调用方按 maxAttempts 判定）', () => {
    expect(DEFAULT_RECONNECT_PLAN.maxAttempts).toBe(5);
  });
});
