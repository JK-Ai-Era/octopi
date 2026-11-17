/**
 * B-1 — 回环判定（无钥告警分级的依据）与 resolveListenHost 语义联动。
 */
import { describe, expect, it } from 'vitest';
import { isLoopbackListenHost, resolveListenHost } from '@octopi-agent/engine/config.js';

describe('isLoopbackListenHost', () => {
  it('回环地址 → true', () => {
    expect(isLoopbackListenHost('127.0.0.1')).toBe(true);
    expect(isLoopbackListenHost('127.0.0.53')).toBe(true);
    expect(isLoopbackListenHost('::1')).toBe(true);
    expect(isLoopbackListenHost('localhost')).toBe(true);
    expect(isLoopbackListenHost(' LOCALHOST ')).toBe(true);
  });

  it('非回环 → false；与 resolveListenHost 联动（local=回环，lan=非回环）', () => {
    expect(isLoopbackListenHost('0.0.0.0')).toBe(false);
    expect(isLoopbackListenHost('192.168.1.10')).toBe(false);
    expect(isLoopbackListenHost(resolveListenHost('local'))).toBe(true);
    expect(isLoopbackListenHost(resolveListenHost())).toBe(true);
    expect(isLoopbackListenHost(resolveListenHost('lan'))).toBe(false);
    expect(isLoopbackListenHost(resolveListenHost('10.0.0.5'))).toBe(false);
  });
});
