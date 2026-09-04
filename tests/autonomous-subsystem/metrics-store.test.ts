/**
 * MetricsStore 测试
 */

import { describe, it, expect } from 'vitest';
import { MetricsStore } from '../../src/harness/autonomous-subsystem/sense/metrics.js';

describe('MetricsStore', () => {
  it('update / get', () => {
    const store = new MetricsStore();
    store.update('turn.count', 10);
    expect(store.get('turn.count')).toBe(10);
  });

  it('increment 默认 +1', () => {
    const store = new MetricsStore();
    store.increment('errors');
    store.increment('errors');
    expect(store.get('errors')).toBe(2);
  });

  it('increment 自定义 delta', () => {
    const store = new MetricsStore();
    store.increment('token.used', 500);
    store.increment('token.used', 300);
    expect(store.get('token.used')).toBe(800);
  });

  it('get 不存在的 key 返回 undefined', () => {
    const store = new MetricsStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('increment 不存在的 key 从 0 开始', () => {
    const store = new MetricsStore();
    store.increment('new.metric', 5);
    expect(store.get('new.metric')).toBe(5);
  });

  it('snapshot 返回当前所有指标', () => {
    const store = new MetricsStore();
    store.update('a', 1);
    store.update('b', 2);
    store.update('c', 3);
    const snap = store.snapshot();
    expect(snap).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('snapshot 返回副本，不影响原数据', () => {
    const store = new MetricsStore();
    store.update('x', 10);
    const snap = store.snapshot();
    snap['x'] = 999;
    expect(store.get('x')).toBe(10);
  });

  it('reset 清空所有指标', () => {
    const store = new MetricsStore();
    store.update('a', 1);
    store.update('b', 2);
    store.reset();
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeUndefined();
    expect(store.snapshot()).toEqual({});
  });
});
