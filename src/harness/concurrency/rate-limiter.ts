/**
 * RateLimiter — 令牌桶限流器
 *
 * 用于控制 LLM API 调用频率，避免触发 provider 的速率限制。
 *
 * 设计原则：
 * - 令牌桶算法：平滑限流，允许突发流量
 * - 支持多 provider：每个 provider 独立限流
 * - 自动等待：请求超限时自动排队等待
 * - 可观测：提供等待时间和队列长度指标
 */

export interface RateLimiterConfig {
  /** 每分钟最大请求数 */
  requestsPerMinute: number;
  /** 突发容量（令牌桶大小，默认等于 requestsPerMinute） */
  burstCapacity?: number;
  /** 令牌补充间隔（毫秒，默认 1000） */
  refillIntervalMs?: number;
  /** 最大等待时间（毫秒，默认 60000） */
  maxWaitMs?: number;
}

export interface RateLimiterMetrics {
  /** 当前可用令牌数 */
  availableTokens: number;
  /** 等待队列长度 */
  queueLength: number;
  /** 总请求数 */
  totalRequests: number;
  /** 总等待时间（毫秒） */
  totalWaitMs: number;
  /** 平均等待时间（毫秒） */
  avgWaitMs: number;
}

interface QueueEntry {
  resolve: () => void;
  reject: (error: Error) => void;
  requestedAt: number;
}

export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefill: number;
  private queue: QueueEntry[] = [];
  private totalRequests = 0;
  private totalWaitMs = 0;
  private refillTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: RateLimiterConfig) {
    this.maxTokens = config.burstCapacity ?? config.requestsPerMinute;
    this.tokens = this.maxTokens;
    this.refillRate = config.requestsPerMinute / (60 * 1000); // tokens per ms
    this.lastRefill = Date.now();

    // 定期补充令牌
    this.refillTimer = setInterval(() => this.refill(), config.refillIntervalMs ?? 1000);
  }

  /**
   * 获取一个令牌
   * @returns 释放令牌的函数
   * @throws 超时时抛出错误
   */
  async acquire(): Promise<() => void> {
    const requestedAt = Date.now();
    this.totalRequests++;

    // 尝试立即获取令牌
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return this.createRelease(requestedAt);
    }

    // 需要等待
    const waitMs = this.estimateWaitMs();
    if (waitMs > this.config.maxWaitMs) {
      throw new Error(
        `Rate limit exceeded: estimated wait ${waitMs}ms exceeds max ${this.config.maxWaitMs}ms`
      );
    }

    // 排队等待
    return new Promise<() => void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // 超时，从队列中移除
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error(`Rate limit timeout: waited ${this.config.maxWaitMs}ms`));
      }, this.config.maxWaitMs);

      const entry: QueueEntry = {
        resolve: () => {
          clearTimeout(timeout);
          const waitTime = Date.now() - requestedAt;
          this.totalWaitMs += waitTime;
          resolve(this.createRelease(requestedAt));
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        requestedAt,
      };

      this.queue.push(entry);
      this.processQueue();
    });
  }

  /**
   * 尝试获取令牌，不等待
   * @returns 释放令牌的函数，或 null
   */
  tryAcquire(): (() => void) | null {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return this.createRelease(Date.now());
    }
    return null;
  }

  /**
   * 获取当前指标
   */
  metrics(): RateLimiterMetrics {
    this.refill();
    return {
      availableTokens: Math.floor(this.tokens),
      queueLength: this.queue.length,
      totalRequests: this.totalRequests,
      totalWaitMs: this.totalWaitMs,
      avgWaitMs: this.totalRequests > 0 ? this.totalWaitMs / this.totalRequests : 0,
    };
  }

  /**
   * 销毁限流器
   */
  destroy(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = undefined;
    }
    // 拒绝所有等待中的请求
    for (const entry of this.queue) {
      entry.reject(new Error('RateLimiter destroyed'));
    }
    this.queue = [];
  }

  private createRelease(requestedAt: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.processQueue();
    };
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;

    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;

    this.processQueue();
  }

  private processQueue(): void {
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const entry = this.queue.shift()!;
      entry.resolve();
    }
  }

  private estimateWaitMs(): number {
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return deficit / this.refillRate;
  }
}

/**
 * 多 Provider 限流管理器
 */
export class ProviderRateLimitManager {
  private limiters = new Map<string, RateLimiter>();

  /**
   * 注册 provider 限流器
   */
  register(provider: string, config: RateLimiterConfig): void {
    if (this.limiters.has(provider)) {
      this.limiters.get(provider)!.destroy();
    }
    this.limiters.set(provider, new RateLimiter(config));
  }

  /**
   * 获取 provider 限流器
   */
  get(provider: string): RateLimiter | undefined {
    return this.limiters.get(provider);
  }

  /**
   * 获取或创建默认限流器
   */
  getOrCreate(provider: string, defaultConfig?: RateLimiterConfig): RateLimiter {
    let limiter = this.limiters.get(provider);
    if (!limiter && defaultConfig) {
      limiter = new RateLimiter(defaultConfig);
      this.limiters.set(provider, limiter);
    }
    if (!limiter) {
      throw new Error(`No rate limiter registered for provider: ${provider}`);
    }
    return limiter;
  }

  /**
   * 获取所有 provider 的指标
   */
  metrics(): Record<string, RateLimiterMetrics> {
    const result: Record<string, RateLimiterMetrics> = {};
    for (const [provider, limiter] of this.limiters) {
      result[provider] = limiter.metrics();
    }
    return result;
  }

  /**
   * 销毁所有限流器
   */
  destroy(): void {
    for (const limiter of this.limiters.values()) {
      limiter.destroy();
    }
    this.limiters.clear();
  }
}
