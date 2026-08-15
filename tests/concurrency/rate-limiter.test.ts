import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter, ProviderRateLimitManager } from '../../src/harness/concurrency/rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow requests within burst capacity', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60,
      burstCapacity: 5,
    });

    // 应该能立即获取 5 个令牌
    const releases = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await limiter.acquire());
    }

    const metrics = limiter.metrics();
    expect(metrics.availableTokens).toBe(0);
    expect(metrics.totalRequests).toBe(5);
    expect(metrics.totalWaitMs).toBe(0);

    // 清理
    for (const release of releases) release();
    limiter.destroy();
  });

  it('should throw when estimated wait exceeds max', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60,
      burstCapacity: 1,
      maxWaitMs: 100,
    });

    // 耗尽令牌
    const r1 = await limiter.acquire();

    // 第二个请求：估算等待 1000ms > maxWaitMs 100ms → 立即抛出
    // 用 .catch 防止 unhandled rejection
    const result = await limiter.acquire().catch((e: Error) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('Rate limit exceeded');

    r1();
    limiter.destroy();
  });

  it('should try acquire without waiting', () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60,
      burstCapacity: 2,
    });

    const r1 = limiter.tryAcquire();
    expect(r1).not.toBeNull();

    const r2 = limiter.tryAcquire();
    expect(r2).not.toBeNull();

    // 第三个应该失败
    const r3 = limiter.tryAcquire();
    expect(r3).toBeNull();

    r1?.();
    r2?.();
    limiter.destroy();
  });

  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60, // 1 per second
      burstCapacity: 2,
    });

    // 耗尽令牌
    const r1 = await limiter.acquire();
    const r2 = await limiter.acquire();

    expect(limiter.tryAcquire()).toBeNull();

    // 推进 2 秒
    vi.advanceTimersByTime(2000);

    // 应该有 2 个新令牌
    const r3 = limiter.tryAcquire();
    const r4 = limiter.tryAcquire();
    expect(r3).not.toBeNull();
    expect(r4).not.toBeNull();

    r1();
    r2();
    r3?.();
    r4?.();
    limiter.destroy();
  });

  it('should provide metrics', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60,
      burstCapacity: 10,
    });

    await limiter.acquire();
    await limiter.acquire();

    const metrics = limiter.metrics();
    expect(metrics.availableTokens).toBe(8);
    expect(metrics.totalRequests).toBe(2);
    expect(metrics.queueLength).toBe(0);

    limiter.destroy();
  });

  it('should destroy and reject queued requests', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60,
      burstCapacity: 1,
      maxWaitMs: 10000,
    });

    await limiter.acquire();

    // 排队一个请求
    const p = limiter.acquire();

    // 立即销毁
    limiter.destroy();

    await expect(p).rejects.toThrow('RateLimiter destroyed');
  });
});

describe('ProviderRateLimitManager', () => {
  it('should manage multiple providers', () => {
    const manager = new ProviderRateLimitManager();

    manager.register('openai', { requestsPerMinute: 60 });
    manager.register('anthropic', { requestsPerMinute: 50 });

    expect(manager.get('openai')).toBeDefined();
    expect(manager.get('anthropic')).toBeDefined();
    expect(manager.get('unknown')).toBeUndefined();

    manager.destroy();
  });

  it('should get or create limiter', () => {
    const manager = new ProviderRateLimitManager();

    const limiter = manager.getOrCreate('openai', { requestsPerMinute: 60 });
    expect(limiter).toBeDefined();

    // 再次获取应该返回同一个
    const same = manager.getOrCreate('openai');
    expect(same).toBe(limiter);

    manager.destroy();
  });

  it('should throw if no limiter and no default config', () => {
    const manager = new ProviderRateLimitManager();

    expect(() => manager.getOrCreate('unknown')).toThrow('No rate limiter registered');

    manager.destroy();
  });

  it('should collect metrics from all providers', () => {
    const manager = new ProviderRateLimitManager();

    manager.register('openai', { requestsPerMinute: 60 });
    manager.register('anthropic', { requestsPerMinute: 50 });

    const metrics = manager.metrics();
    expect(Object.keys(metrics)).toEqual(['openai', 'anthropic']);
    expect(metrics.openai.availableTokens).toBe(60);
    expect(metrics.anthropic.availableTokens).toBe(50);

    manager.destroy();
  });
});
