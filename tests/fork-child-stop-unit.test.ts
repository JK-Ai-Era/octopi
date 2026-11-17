/**
 * `stopChild()` 升级链的单测：用假 child（EventEmitter + kill spy + 可控 connected/send），
 * 把每条路径都钉住——真实 fork 的端到端锚（knowledge-stop-semantics.test.ts）只覆盖
 * disconnected 一条，删掉整段升级逻辑它仍能绿。
 *
 * 覆盖：
 * 1. connected + 子进程收到 close 自行退出 → 只等 exit，不发信号；
 * 2. **初始 disconnected（本次修的 EPERM 路径）→ 直接升级并等 exit**；
 * 3. connected + 不理 close → 3s SIGTERM；仍不理 → 2s SIGKILL；仍无 exit → 1s 兜底放行 + warn；
 * 4. SIGKILL 后 1s 内拿到 exit → 立刻返回且**不**打兜底 warn；
 * 5. `send` 回调报错（通道刚断，不抛异常）→ 立即升级，不干等 3s；
 * 6. `send` 同步抛 → 同样立即升级；
 * 7. 升级单发：grace 先升级后，迟到的 send 错误不得二次发信号；
 * 8. exit 先到、错误后到：不得在 stop() resolve 之后重装定时器或打假告警。
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stopForkedChild } from '../packages/engine/src/fork-child.js';

/** 假子进程：只实现 stopChild 用到的面 */
class FakeChild extends EventEmitter {
  pid = 4242;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: NodeJS.Signals[] = [];
  /** send 的行为：null = 正常发送；Error = 走回调报错；'throw' = 同步抛；'hang' = 永不回调 */
  sendBehavior: Error | 'throw' | 'hang' | null = null;
  /** 收到信号后是否真的退出 */
  exitsOnSignal = true;
  /** 'hang' 模式下由测试手动触发的迟到回调 */
  lateCallback: ((err: Error | null) => void) | null = null;

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    if (this.exitsOnSignal) {
      this.signalCode = signal ?? 'SIGTERM';
      process.nextTick(() => this.emit('exit', null, signal));
    }
    return true;
  }

  send(message: unknown, cb?: (err: Error | null) => void): boolean {
    void message;
    if (this.sendBehavior === 'throw') throw new Error('channel closed');
    if (this.sendBehavior === 'hang') {
      this.lateCallback = cb ?? null;
      return true;
    }
    if (this.sendBehavior instanceof Error) {
      const err = this.sendBehavior;
      process.nextTick(() => cb?.(err));
      return false;
    }
    return true;
  }
}

const asChild = (fake: FakeChild): ChildProcess => fake as unknown as ChildProcess;

/** knowledge 侧的历史预算：3s 宽限 / 2s SIGTERM / 1s 兜底（与 start-service-process 一致） */
const stop = (child: ChildProcess): Promise<void> =>
  stopForkedChild(child, { graceMs: 3_000, termMs: 2_000, reapFallbackMs: 1_000, label: 'test' });

it('调用方预算被真实装配：run 侧是 5s/3s，knowledge 侧是 3s/2s', () => {
  // 两个调用点的预算写反/写成同一个值都不会影响其余用例（它们自带 options），
  // 所以在这里直接读源码装配结果，锁住"谁用哪一档"。
  const runSrc = readFileSync(
    new URL('../packages/gateway/src/gateway/remote-run-backend.ts', import.meta.url),
    'utf8',
  );
  const knSrc = readFileSync(
    new URL('../packages/engine/src/harness/knowledge/start-service-process.ts', import.meta.url),
    'utf8',
  );
  expect(runSrc).toMatch(/graceMs:\s*5_000[^)]*termMs:\s*3_000[^)]*reapFallbackMs:\s*1_000/s);
  expect(knSrc).toMatch(/graceMs:\s*3_000[^)]*termMs:\s*2_000[^)]*reapFallbackMs:\s*1_000/s);
  expect(runSrc).toContain("label: 'run'");
  expect(knSrc).toContain("label: 'knowledge'");
});

describe('stopChild 升级链', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connected + 子进程自行退出：不发任何信号', async () => {
    const fake = new FakeChild();
    const p = stop(asChild(fake));
    fake.exitCode = 0;
    fake.emit('exit', 0, null);
    await p;
    expect(fake.kills).toEqual([]);
  });

  it('初始 disconnected（宿主硬死）：立即升级并等 exit，不干等 close 宽限', async () => {
    const fake = new FakeChild();
    fake.connected = false;
    const p = stop(asChild(fake));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.kills).toEqual(['SIGTERM']); // 未到 3s 就已发信号
    await vi.advanceTimersByTimeAsync(0); // 让 nextTick 的 exit 落地
    await p;
    expect(fake.signalCode).toBe('SIGTERM');
  });

  it('connected + 不理 close：3s SIGTERM → 2s SIGKILL → 1s 兜底放行并告警', async () => {
    const fake = new FakeChild();
    fake.exitsOnSignal = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = stop(asChild(fake));

    await vi.advanceTimersByTimeAsync(2_999);
    expect(fake.kills).toEqual([]); // 宽限期内不动手

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.kills).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.kills).toEqual(['SIGTERM', 'SIGKILL']);

    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unobservable after SIGKILL'));
  });

  it('SIGKILL 后 1s 内拿到 exit：立即返回且不打兜底告警', async () => {
    const fake = new FakeChild();
    fake.exitsOnSignal = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = stop(asChild(fake));

    await vi.advanceTimersByTimeAsync(3_000); // SIGTERM
    await vi.advanceTimersByTimeAsync(2_000); // SIGKILL
    fake.emit('exit', null, 'SIGKILL'); // 在 1s 兜底到期前退出
    await p;

    await vi.advanceTimersByTimeAsync(2_000); // 越过原兜底时刻
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // 兜底 timer 已被清
  });

  it('send 回调报错（通道刚断，不抛异常）：立即升级，不干等 3s 宽限', async () => {
    const fake = new FakeChild();
    fake.sendBehavior = Object.assign(new Error('channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
    const p = stop(asChild(fake));
    await vi.advanceTimersByTimeAsync(0); // 只放行微任务
    expect(fake.kills).toEqual(['SIGTERM']); // 未到 3s 就已经发信号
    await vi.advanceTimersByTimeAsync(0);
    await p;
  });

  it('send 同步抛：同样立即升级', async () => {
    const fake = new FakeChild();
    fake.sendBehavior = 'throw';
    const p = stop(asChild(fake));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(0);
    await p;
  });

  it('升级单发：grace 先升级后，迟到的 send 错误不得二次发信号', async () => {
    const fake = new FakeChild();
    fake.exitsOnSignal = false;
    fake.sendBehavior = 'hang'; // 回调挂起，稍后模拟迟到错误
    const p = stop(asChild(fake));

    await vi.advanceTimersByTimeAsync(3_000); // grace 到期 → escalate #1
    expect(fake.kills).toEqual(['SIGTERM']);

    fake.lateCallback?.(new Error('ERR_IPC_CHANNEL_CLOSED')); // 迟到错误想再升级
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.kills.filter((s) => s === 'SIGTERM')).toHaveLength(1);

    fake.emit('exit', null, 'SIGTERM');
    await p;
  });

  it('exit 先到、错误后到：resolve 之后不得重装定时器或打假告警', async () => {
    const fake = new FakeChild();
    fake.sendBehavior = 'hang';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = stop(asChild(fake));

    fake.exitCode = 0;
    fake.emit('exit', 0, null); // 先退出
    await p;
    expect(vi.getTimerCount()).toBe(0);

    fake.lateCallback?.(new Error('ERR_IPC_CHANNEL_CLOSED')); // 迟到错误
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fake.kills).toEqual([]); // 不得对已退出进程发信号
    expect(warn).not.toHaveBeenCalled(); // 不得打假 unobservable 告警
    expect(vi.getTimerCount()).toBe(0); // 不得重装定时器
  });

  it('已退出的 child 直接返回，不注册任何定时器', async () => {
    const fake = new FakeChild();
    fake.exitCode = 1;
    await stop(asChild(fake));
    expect(fake.kills).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
