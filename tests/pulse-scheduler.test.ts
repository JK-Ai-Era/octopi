/**
 * PulseScheduler — gateway 脉搏调度器（P0c A′，fleet 形状）
 *
 * 覆盖：周期单发 / runOnStart 首跳 / resync 对账（增删改）/ 归属决策（首见分配 +
 * 持有者消失转移 + key 拆除）/ 失败 fail-soft / stop。驱动面用假 fleet，验契约不碰真进程。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PulseScheduler, type PulseFleet } from '../packages/gateway/src/gateway/pulse-scheduler.js';
import type { PulseSpec } from '../packages/engine/src/harness/activation/run-protocol.js';

interface FakeFleet extends PulseFleet {
  inventory: Array<{ instanceId: string; spec: PulseSpec }>;
  fired: Array<{ instanceId: string; key: string }>;
  failKeys: Set<string>;
  owners: Map<string, string>;
}

function makeFleet(inventory: Array<{ instanceId: string; spec: PulseSpec }>): FakeFleet {
  return {
    inventory,
    fired: [],
    failKeys: new Set(),
    owners: new Map(),
    async pulseInventory() {
      return this.inventory;
    },
    async pulse(key: string) {
      if (this.failKeys.has(key)) throw new Error(`boom: ${key}`);
      this.fired.push({ instanceId: this.owners.get(key) ?? '?', key });
    },
    setPulseOwner(key: string, instanceId: string) {
      this.owners.set(key, instanceId);
    },
    resolvePulseOwner(key: string) {
      return this.owners.get(key);
    },
    clearPulseOwner(key: string) {
      this.owners.delete(key);
    },
  };
}

const keys = (fleet: FakeFleet): string[] => fleet.fired.map((f) => f.key);

describe('PulseScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires each key on its interval (single source, single fire)', async () => {
    const fleet = makeFleet([
      { instanceId: 'run-0', spec: { key: 'a:fast', intervalMs: 1000 } },
      { instanceId: 'run-0', spec: { key: 'a:slow', intervalMs: 5000 } },
    ]);
    const scheduler = new PulseScheduler({ fleet });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(keys(fleet)).toEqual(['a:fast']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(keys(fleet)).toEqual(['a:fast', 'a:fast', 'a:fast', 'a:fast', 'a:fast', 'a:slow']);
    scheduler.stop();
  });

  it('runOnStart fires exactly one immediate first hop', async () => {
    const fleet = makeFleet([
      { instanceId: 'run-0', spec: { key: 'a:first', intervalMs: 100_000, runOnStart: true } },
      { instanceId: 'run-0', spec: { key: 'a:lazy', intervalMs: 100_000 } },
    ]);
    const scheduler = new PulseScheduler({ fleet });
    await scheduler.start();

    expect(keys(fleet)).toEqual(['a:first']);
    await vi.advanceTimersByTimeAsync(200_000);
    // 首跳 1 次 + interval(100s) 在 t=100s/200s 各 1 次 = a:first×3；a:lazy×2（同刻按注册序交错）
    expect(keys(fleet)).toEqual(['a:first', 'a:first', 'a:lazy', 'a:first', 'a:lazy']);
    scheduler.stop();
  });

  it('resync drops vanished keys and rebuilds changed intervals', async () => {
    const fleet = makeFleet([
      { instanceId: 'run-0', spec: { key: 'a:keep', intervalMs: 1000 } },
      { instanceId: 'run-0', spec: { key: 'a:gone', intervalMs: 1000 } },
    ]);
    const scheduler = new PulseScheduler({ fleet });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fleet.fired).toHaveLength(2);

    // a:gone 消失（归属表随之拆除）；a:keep 周期 1000→5000（重建不重发首跳）；a:new 加入
    fleet.inventory = [
      { instanceId: 'run-0', spec: { key: 'a:keep', intervalMs: 5000 } },
      { instanceId: 'run-0', spec: { key: 'a:new', intervalMs: 1000 } },
    ];
    await scheduler.resync();
    expect(fleet.fired).toHaveLength(2);
    expect(fleet.owners.has('a:gone')).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(keys(fleet).slice(2)).toEqual(['a:new']);
    scheduler.stop();
  });

  it('assigns ownership on first sight and transfers when holder vanishes', async () => {
    // 同 key 双副本自述：首见分配 run-a；run-a 消失后转移 run-b
    const fleet = makeFleet([
      { instanceId: 'run-a', spec: { key: 'x:shared', intervalMs: 1000 } },
      { instanceId: 'run-b', spec: { key: 'x:shared', intervalMs: 1000 } },
    ]);
    const scheduler = new PulseScheduler({ fleet });
    await scheduler.start();

    expect(fleet.owners.get('x:shared')).toBe('run-a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fleet.fired).toEqual([{ instanceId: 'run-a', key: 'x:shared' }]);

    // 持有实例消失 → 归属转移（不再双发：同 key 全 fleet 同时至多一个持有者）
    fleet.inventory = [{ instanceId: 'run-b', spec: { key: 'x:shared', intervalMs: 1000 } }];
    await scheduler.resync();
    expect(fleet.owners.get('x:shared')).toBe('run-b');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fleet.fired.at(-1)).toEqual({ instanceId: 'run-b', key: 'x:shared' });
    scheduler.stop();
  });

  it('pulse failure is fail-soft (warn only, scheduling continues)', async () => {
    const fleet = makeFleet([{ instanceId: 'run-0', spec: { key: 'a:bad', intervalMs: 1000 } }]);
    fleet.failKeys.add('a:bad');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scheduler = new PulseScheduler({ fleet });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(2000);
    expect(fleet.fired).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    scheduler.stop();
  });

  it('resync failure keeps existing schedule (no silent reset)', async () => {
    const fleet = makeFleet([{ instanceId: 'run-0', spec: { key: 'a:keep', intervalMs: 1000 } }]);
    const scheduler = new PulseScheduler({ fleet });
    await scheduler.start();

    fleet.pulseInventory = async () => {
      throw new Error('instance down');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scheduler.resync();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    await vi.advanceTimersByTimeAsync(1000);
    expect(keys(fleet)).toEqual(['a:keep']);
    scheduler.stop();
  });

  it('stop halts all scheduling', async () => {
    const fleet = makeFleet([{ instanceId: 'run-0', spec: { key: 'a:x', intervalMs: 1000 } }]);
    const scheduler = new PulseScheduler({ fleet });
    await scheduler.start();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(fleet.fired).toHaveLength(0);
    expect(scheduler.activeKeys()).toHaveLength(0);
  });

  it('首跳按 startupDelayMs 错峰：deadline 首见即定，key 重现不重置、已首跳不重发', async () => {
    const lateSpec: PulseSpec = {
      key: 'a:late',
      intervalMs: 10_000_000,
      runOnStart: true,
      startupDelayMs: 600_000,
    };
    const fleet = makeFleet([
      { instanceId: 'run-0', spec: { key: 'a:now', intervalMs: 10_000_000, runOnStart: true, startupDelayMs: 0 } },
      { instanceId: 'run-0', spec: lateSpec },
    ]);
    const scheduler = new PulseScheduler({ fleet });
    await scheduler.start();
    expect(keys(fleet)).toEqual(['a:now']); // delay 0 立即；late 延后

    // pending 中 key 拆除再重现：deadline 不重置（防重挂载快于延迟时饿死）
    fleet.inventory = [
      { instanceId: 'run-0', spec: { key: 'a:now', intervalMs: 10_000_000, runOnStart: true, startupDelayMs: 0 } },
    ];
    await scheduler.resync();
    fleet.inventory = [
      { instanceId: 'run-0', spec: { key: 'a:now', intervalMs: 10_000_000, runOnStart: true, startupDelayMs: 0 } },
      { instanceId: 'run-0', spec: { ...lateSpec, startupDelayMs: 600_000 } },
    ];
    await scheduler.resync();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(keys(fleet).filter((k) => k === 'a:late')).toHaveLength(1); // 按原 deadline 恰好一次

    // 已首跳的 key 拆除重现 → 不再首跳（重挂载 ≠ 重启）
    fleet.inventory = [];
    await scheduler.resync();
    fleet.inventory = [{ instanceId: 'run-0', spec: { ...lateSpec, startupDelayMs: 0 } }];
    await scheduler.resync();
    expect(keys(fleet).filter((k) => k === 'a:late')).toHaveLength(1);
    scheduler.stop();
  });

  it('pending 首跳不因重复 resync 二次 arm；stop 清 pending', async () => {
    const fleet = makeFleet([
      { instanceId: 'run-0', spec: { key: 'a:hold', intervalMs: 10_000_000, runOnStart: true, startupDelayMs: 600_000 } },
    ]);
    const scheduler = new PulseScheduler({ fleet });
    await scheduler.start();
    await scheduler.resync();
    await scheduler.resync(); // 同参重复对账 → 不重 arm
    await vi.advanceTimersByTimeAsync(600_000);
    expect(keys(fleet).filter((k) => k === 'a:hold')).toHaveLength(1);

    const fleet2 = makeFleet([
      { instanceId: 'run-0', spec: { key: 'a:pend', intervalMs: 10_000_000, runOnStart: true, startupDelayMs: 600_000 } },
    ]);
    const s2 = new PulseScheduler({ fleet: fleet2 });
    await s2.start();
    s2.stop();
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(keys(fleet2)).toEqual([]); // pending 已随 stop 清掉
  });

  it('stop 后 resync 不再重建调度（停机闸门 + await 后代际复检）', async () => {
    const fleet = makeFleet([
      { instanceId: 'run-0', spec: { key: 'a:gate', intervalMs: 10_000_000, runOnStart: true } },
    ]);
    const scheduler = new PulseScheduler({ fleet });
    await scheduler.start(); // 首跳 1 次
    scheduler.stop();
    await scheduler.resync(); // 闸门挡：不得重建 timer/首跳
    await vi.advanceTimersByTimeAsync(300_000);
    expect(keys(fleet).filter((k) => k === 'a:gate')).toHaveLength(1); // 仅 start 的首跳，无 tick
  });
});
