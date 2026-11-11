/**
 * PulseScheduler — gateway 脉搏调度器（P0c A′）
 *
 * 覆盖：周期单发 / runOnStart 首跳 / resync 对账（增删改）/ 失败 fail-soft / stop。
 * 驱动面用假 target，验「单发 + 归属」契约，不碰真进程。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PulseScheduler, type PulseTarget } from '../packages/gateway/src/gateway/pulse-scheduler.js';
import type { PulseSpec } from '../packages/engine/src/harness/activation/run-protocol.js';

interface FakeTarget extends PulseTarget {
  specs: PulseSpec[];
  fired: string[];
  failKeys: Set<string>;
}

function makeTarget(specs: PulseSpec[]): FakeTarget {
  const target: FakeTarget = {
    instanceId: 'run-0',
    specs,
    fired: [],
    failKeys: new Set(),
    async pulses() {
      return this.specs;
    },
    async pulse(key: string) {
      if (this.failKeys.has(key)) throw new Error(`boom: ${key}`);
      this.fired.push(key);
    },
  };
  return target;
}

describe('PulseScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires each key on its interval (single source, single fire)', async () => {
    const target = makeTarget([
      { key: 'a:fast', intervalMs: 1000 },
      { key: 'a:slow', intervalMs: 5000 },
    ]);
    const scheduler = new PulseScheduler({ target });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(target.fired).toEqual(['a:fast']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(target.fired).toEqual(['a:fast', 'a:fast', 'a:fast', 'a:fast', 'a:fast', 'a:slow']);
    scheduler.stop();
  });

  it('runOnStart fires exactly one immediate first hop', async () => {
    const target = makeTarget([
      { key: 'a:first', intervalMs: 100_000, runOnStart: true },
      { key: 'a:lazy', intervalMs: 100_000 },
    ]);
    const scheduler = new PulseScheduler({ target });
    await scheduler.start();

    expect(target.fired).toEqual(['a:first']);
    await vi.advanceTimersByTimeAsync(200_000);
    // 首跳 1 次 + interval(100s) 在 t=100s/200s 各 1 次 = a:first×3；a:lazy×2（同刻按注册序交错）
    expect(target.fired).toEqual(['a:first', 'a:first', 'a:lazy', 'a:first', 'a:lazy']);
    scheduler.stop();
  });

  it('resync drops vanished keys and rebuilds changed intervals', async () => {
    const target = makeTarget([
      { key: 'a:keep', intervalMs: 1000 },
      { key: 'a:gone', intervalMs: 1000 },
    ]);
    const scheduler = new PulseScheduler({ target });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(target.fired).toHaveLength(2);

    // a:gone 消失；a:keep 周期 1000→5000（重建不重发首跳）
    target.specs = [
      { key: 'a:keep', intervalMs: 5000 },
      { key: 'a:new', intervalMs: 1000 },
    ];
    await scheduler.resync();
    expect(target.fired).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(target.fired.slice(2)).toEqual(['a:new']);
    scheduler.stop();
  });

  it('pulse failure is fail-soft (warn only, scheduling continues)', async () => {
    const target = makeTarget([{ key: 'a:bad', intervalMs: 1000 }]);
    target.failKeys.add('a:bad');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scheduler = new PulseScheduler({ target });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(2000);
    expect(target.fired).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    scheduler.stop();
  });

  it('resync failure keeps existing schedule (no silent reset)', async () => {
    const target = makeTarget([{ key: 'a:keep', intervalMs: 1000 }]);
    const scheduler = new PulseScheduler({ target });
    await scheduler.start();

    target.pulses = async () => {
      throw new Error('instance down');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scheduler.resync();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    await vi.advanceTimersByTimeAsync(1000);
    expect(target.fired).toEqual(['a:keep']);
    scheduler.stop();
  });

  it('stop halts all scheduling', async () => {
    const target = makeTarget([{ key: 'a:x', intervalMs: 1000 }]);
    const scheduler = new PulseScheduler({ target });
    await scheduler.start();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(target.fired).toHaveLength(0);
    expect(scheduler.activeKeys()).toHaveLength(0);
  });
});
