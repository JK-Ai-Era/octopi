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
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }

    const metrics = limiter.metrics();
    expect(metrics.availableTokens).toBe(0);
    expect(metrics.totalRequests).toBe(5);
    expect(metrics.fulfilledRequests).toBe(5);
    expect(metrics.totalWaitMs).toBe(0);

    limiter.destroy();
  });

  it('should throw when estimated wait exceeds max', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60,
      burstCapacity: 1,
      maxWaitMs: 100,
    });

    // 耗尽令牌
    await limiter.acquire();

    // 第二个请求：估算等待超 maxWaitMs → 立即抛出
    const result = await limiter.acquire().catch((e: Error) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('Rate limit exceeded');

    limiter.destroy();
  });

  it('should try acquire without waiting', () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60,
      burstCapacity: 2,
    });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);

    // 第三个应该失败
    expect(limiter.tryAcquire()).toBe(false);

    limiter.destroy();
  });

  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60, // 1 per second
      burstCapacity: 2,
    });

    // 耗尽令牌
    await limiter.acquire();
    await limiter.acquire();

    expect(limiter.tryAcquire()).toBe(false);

    // 推进 2 秒
    vi.advanceTimersByTime(2000);

    // 应该有 2 个新令牌
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);

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
    expect(metrics.fulfilledRequests).toBe(2);
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

  it('should throw on acquire after destroy', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60 });
    limiter.destroy();

    await expect(limiter.acquire()).rejects.toThrow('RateLimiter has been destroyed');
  });

  it('should return false on tryAcquire after destroy', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60 });
    limiter.destroy();

    expect(limiter.tryAcquire()).toBe(false);
  });

  it('should report isDestroyed', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60 });
    expect(limiter.isDestroyed).toBe(false);

    limiter.destroy();
    expect(limiter.isDestroyed).toBe(true);
  });

  it('should be safe to destroy twice', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60 });
    limiter.destroy();
    limiter.destroy(); // should not throw
    expect(limiter.isDestroyed).toBe(true);
  });

  it('should reject with correct error on queue timeout', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60,
      burstCapacity: 1,
      maxWaitMs: 500,
    });

    await limiter.acquire();

    // 排队一个，但桶会慢慢补充——用极低速率让它超时
    const slowLimiter = new RateLimiter({
      requestsPerMinute: 1, // 1 per minute ≈ 0.0000167 per ms
      burstCapacity: 1,
      maxWaitMs: 100,
    });

    await slowLimiter.acquire();
    const result = await slowLimiter.acquire().catch((e: Error) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('Rate limit exceeded');

    limiter.destroy();
    slowLimiter.destroy();
  });

  it('should fulfill queued requests after refill', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 60, // 1 per second
      burstCapacity: 1,
      maxWaitMs: 10000,
    });

    // 耗尽
    await limiter.acquire();

    // 排队
    let fulfilled = false;
    const p = limiter.acquire().then(() => { fulfilled = true; });

    // 推进 1 秒，触发 refill
    vi.advanceTimersByTime(1000);

    await p;
    expect(fulfilled).toBe(true);

    limiter.destroy();
  });

  it('should validate requestsPerMinute > 0', () => {
    expect(() => new RateLimiter({ requestsPerMinute: 0 })).toThrow('requestsPerMinute must be positive');
    expect(() => new RateLimiter({ requestsPerMinute: -1 })).toThrow('requestsPerMinute must be positive');
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

  it('should throw on register after destroy', () => {
    const manager = new ProviderRateLimitManager();
    manager.destroy();

    expect(() => manager.register('openai', { requestsPerMinute: 60 })).toThrow(
      'ProviderRateLimitManager has been destroyed'
    );
  });

  it('should report isDestroyed', () => {
    const manager = new ProviderRateLimitManager();
    expect(manager.isDestroyed).toBe(false);

    manager.destroy();
    expect(manager.isDestroyed).toBe(true);
  });

  it('should be safe to destroy twice', () => {
    const manager = new ProviderRateLimitManager();
    manager.destroy();
    manager.destroy(); // should not throw
  });

  it('should return existing limiter on getOrCreate', () => {
    const manager = new ProviderRateLimitManager();

    const l1 = manager.getOrCreate('openai', { requestsPerMinute: 60 });
    const l2 = manager.getOrCreate('openai', { requestsPerMinute: 120 });
    expect(l1).toBe(l2); // getOrCreate 不替换已有的

    manager.destroy();
  });

  it('should replace limiter on re-register', () => {
    const manager = new ProviderRateLimitManager();

    const l1 = manager.getOrCreate('openai', { requestsPerMinute: 60 });
    manager.register('openai', { requestsPerMinute: 120 });
    const l2 = manager.get('openai');

    expect(l1).not.toBe(l2);
    expect(l1.isDestroyed).toBe(true); // 旧的应该被 register 销毁

    manager.destroy();
  });
});
