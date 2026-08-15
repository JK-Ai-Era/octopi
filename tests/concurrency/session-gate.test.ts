import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionGate } from '../../src/harness/concurrency/session-gate.js';

describe('SessionGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow concurrent sessions up to max', async () => {
    const gate = new SessionGate({ maxConcurrent: 3 });

    const r1 = await gate.enter();
    const r2 = await gate.enter();
    const r3 = await gate.enter();

    expect(gate.activeCount).toBe(3);
    expect(gate.available).toBe(false);

    r1();
    expect(gate.activeCount).toBe(2);
    expect(gate.available).toBe(true);

    r2();
    r3();
    expect(gate.activeCount).toBe(0);
  });

  it('should queue when max reached and dequeue on release', async () => {
    const gate = new SessionGate({ maxConcurrent: 2 });

    const r1 = await gate.enter();
    const r2 = await gate.enter();

    // 第三个应该排队
    let resolved = false;
    const p3 = gate.enter().then(() => { resolved = true; });

    expect(gate.pendingCount).toBe(1);

    // 释放一个
    r1();

    // 排队的应该立即获取
    await p3;
    expect(resolved).toBe(true);
    expect(gate.activeCount).toBe(2);

    r2();
  });

  it('should timeout on long waits', async () => {
    const gate = new SessionGate({
      maxConcurrent: 1,
      waitTimeoutMs: 1000,
    });

    const r1 = await gate.enter();

    // 第二个应该超时
    const p2 = gate.enter().catch((e: Error) => e);

    await vi.advanceTimersByTimeAsync(1100);

    const result = await p2;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('Session gate timeout');

    r1();
  });

  it('should try enter without waiting', () => {
    const gate = new SessionGate({ maxConcurrent: 2 });

    const r1 = gate.tryEnter();
    expect(r1).not.toBeNull();
    expect(gate.activeCount).toBe(1);

    const r2 = gate.tryEnter();
    expect(r2).not.toBeNull();
    expect(gate.activeCount).toBe(2);

    // 第三个应该失败
    const r3 = gate.tryEnter();
    expect(r3).toBeNull();
    expect(gate.activeCount).toBe(2);

    r1?.();
    r2?.();
  });

  it('should provide accurate metrics', async () => {
    const gate = new SessionGate({ maxConcurrent: 5 });

    const r1 = await gate.enter();
    const r2 = await gate.enter();

    const metrics = gate.metrics();
    expect(metrics.active).toBe(2);
    expect(metrics.maxConcurrent).toBe(5);
    expect(metrics.queueLength).toBe(0);
    expect(metrics.totalRequests).toBe(2);

    r1();
    r2();
  });

  it('should chain releases correctly', async () => {
    const gate = new SessionGate({ maxConcurrent: 1 });

    const releaseHolder: (() => void)[] = [];

    const r1 = await gate.enter();
    const p = gate.enter().then((release) => {
      releaseHolder.push(release);
    });

    r1();
    await p;

    expect(releaseHolder.length).toBe(1);
    expect(gate.activeCount).toBe(1);

    releaseHolder[0]();
    expect(gate.activeCount).toBe(0);
  });

  it('should track rejected requests in metrics', async () => {
    const gate = new SessionGate({
      maxConcurrent: 1,
      waitTimeoutMs: 500,
    });

    await gate.enter();

    // 排队一个会超时的
    const p = gate.enter().catch(() => {});
    await vi.advanceTimersByTimeAsync(600);
    await p;

    const metrics = gate.metrics();
    expect(metrics.rejectedRequests).toBe(1);
  });

  it('should validate maxConcurrent > 0', () => {
    expect(() => new SessionGate({ maxConcurrent: 0 })).toThrow('maxConcurrent must be positive');
    expect(() => new SessionGate({ maxConcurrent: -1 })).toThrow('maxConcurrent must be positive');
  });

  it('should throw on enter after destroy', async () => {
    const gate = new SessionGate({ maxConcurrent: 2 });
    gate.destroy();

    await expect(gate.enter()).rejects.toThrow('SessionGate has been destroyed');
  });

  it('should return null on tryEnter after destroy', () => {
    const gate = new SessionGate({ maxConcurrent: 2 });
    gate.destroy();

    expect(gate.tryEnter()).toBeNull();
  });

  it('should reject queued waiters on destroy', async () => {
    const gate = new SessionGate({ maxConcurrent: 1, waitTimeoutMs: 10000 });

    await gate.enter();

    // 排队
    const p = gate.enter().catch((e: Error) => e);

    gate.destroy();

    const result = await p;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('SessionGate destroyed');
  });

  it('should report isDestroyed', () => {
    const gate = new SessionGate({ maxConcurrent: 2 });
    expect(gate.isDestroyed).toBe(false);

    gate.destroy();
    expect(gate.isDestroyed).toBe(true);
  });

  it('should be safe to destroy twice', () => {
    const gate = new SessionGate({ maxConcurrent: 2 });
    gate.destroy();
    gate.destroy(); // should not throw
    expect(gate.isDestroyed).toBe(true);
  });

  it('should report available as false after destroy', () => {
    const gate = new SessionGate({ maxConcurrent: 2 });
    expect(gate.available).toBe(true);

    gate.destroy();
    expect(gate.available).toBe(false);
  });

  it('should handle multiple queued waiters dequeued in order', async () => {
    const gate = new SessionGate({ maxConcurrent: 1 });

    const order: number[] = [];
    const releaseHolders: (() => void)[] = [];

    const r1 = await gate.enter();

    const p2 = gate.enter().then((release) => { order.push(1); releaseHolders.push(release); });
    const p3 = gate.enter().then((release) => { order.push(2); releaseHolders.push(release); });

    r1();
    await p2;

    expect(order).toEqual([1]);
    expect(gate.activeCount).toBe(1);
    expect(gate.pendingCount).toBe(1); // p3 still waiting

    releaseHolders[0]();
    await p3;

    expect(order).toEqual([1, 2]);
    expect(gate.activeCount).toBe(1);
    expect(gate.pendingCount).toBe(0);

    releaseHolders[1]();
    expect(gate.activeCount).toBe(0);
  });
});
