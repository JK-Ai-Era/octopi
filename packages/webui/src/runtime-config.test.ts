// @vitest-environment jsdom
/**
 * runtime-config — window.__OCTOPI_WEB__ 下发值的校验与回落。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getGitStatusPollSeconds } from './runtime-config';

describe('getGitStatusPollSeconds', () => {
  afterEach(() => {
    delete window.__OCTOPI_WEB__;
  });

  it('下发缺失 / null 时回退默认 5s', () => {
    expect(getGitStatusPollSeconds()).toBe(5);
    window.__OCTOPI_WEB__ = null;
    expect(getGitStatusPollSeconds()).toBe(5);
  });

  it('0 是合法值（不自动轮询），不得被回落吞掉', () => {
    window.__OCTOPI_WEB__ = { gitStatusPollSeconds: 0 };
    expect(getGitStatusPollSeconds()).toBe(0);
  });

  it('接受 1..3600 的整数', () => {
    window.__OCTOPI_WEB__ = { gitStatusPollSeconds: 10 };
    expect(getGitStatusPollSeconds()).toBe(10);
    window.__OCTOPI_WEB__ = { gitStatusPollSeconds: 3600 };
    expect(getGitStatusPollSeconds()).toBe(3600);
    window.__OCTOPI_WEB__ = { gitStatusPollSeconds: 1 };
    expect(getGitStatusPollSeconds()).toBe(1);
  });

  it('非法值（越界/小数/字符串/NaN）一律回退 5s', () => {
    for (const bad of [-1, 3601, 1.5, '5', NaN, Number.POSITIVE_INFINITY]) {
      window.__OCTOPI_WEB__ = { gitStatusPollSeconds: bad } as { gitStatusPollSeconds: number };
      expect(getGitStatusPollSeconds(), String(bad)).toBe(5);
    }
    window.__OCTOPI_WEB__ = {};
    expect(getGitStatusPollSeconds()).toBe(5);
  });
});
