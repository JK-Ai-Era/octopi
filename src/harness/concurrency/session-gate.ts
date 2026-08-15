/**
 * SessionGate — 跨 Session 并发控制
 *
 * 控制全局并发 session 数量，防止资源耗尽。
 *
 * 设计原则：
 * - 信号量模式：限制同时运行的 session 数量
 * - 公平队列：FIFO 等待，防止饥饿
 * - 可配置超时：避免无限等待
 * - 可观测：提供等待时间和队列长度指标
 */

export interface SessionGateConfig {
  /** 最大并发 session 数（默认 10） */
  maxConcurrent?: number;
  /** 等待超时（毫秒，默认 30000） */
  waitTimeoutMs?: number;
}

export interface SessionGateMetrics {
  /** 当前运行中的 session 数 */
  active: number;
  /** 最大并发数 */
  maxConcurrent: number;
  /** 等待队列长度 */
  queueLength: number;
  /** 总请求数 */
  totalRequests: number;
  /** 总等待时间（毫秒） */
  totalWaitMs: number;
  /** 平均等待时间（毫秒） */
  avgWaitMs: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionGate {
  private active = 0;
  private queue: Waiter[] = [];
  private totalRequests = 0;
  private totalWaitMs = 0;
  private readonly maxConcurrent: number;
  private readonly waitTimeoutMs: number;

  constructor(config: SessionGateConfig = {}) {
    this.maxConcurrent = config.maxConcurrent ?? 10;
    this.waitTimeoutMs = config.waitTimeoutMs ?? 30_000;
  }

  /**
   * 进入 session（获取通行证）
   * @returns 释放函数，调用后允许其他 session 运行
   * @throws 超时时抛出错误
   */
  async enter(): Promise<() => void> {
    this.totalRequests++;
    const enqueuedAt = Date.now();

    if (this.active < this.maxConcurrent) {
      this.active++;
      return this.createExit(enqueuedAt);
    }

    // 排队等待
    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(waiter);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error(`Session gate timeout: waited ${this.waitTimeoutMs}ms for a slot`));
      }, this.waitTimeoutMs);

      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          const waitTime = Date.now() - enqueuedAt;
          this.totalWaitMs += waitTime;
          resolve(this.createExit(enqueuedAt));
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        enqueuedAt,
        timer,
      };

      this.queue.push(waiter);
    });
  }

  /**
   * 尝试进入，不等待
   * @returns 释放函数或 null
   */
  tryEnter(): (() => void) | null {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return this.createExit(Date.now());
    }
    return null;
  }

  /**
   * 获取当前指标
   */
  metrics(): SessionGateMetrics {
    return {
      active: this.active,
      maxConcurrent: this.maxConcurrent,
      queueLength: this.queue.length,
      totalRequests: this.totalRequests,
      totalWaitMs: this.totalWaitMs,
      avgWaitMs: this.totalRequests > 0 ? this.totalWaitMs / this.totalRequests : 0,
    };
  }

  /**
   * 检查是否有可用槽位
   */
  get available(): boolean {
    return this.active < this.maxConcurrent;
  }

  /**
   * 获取当前活跃数
   */
  get activeCount(): number {
    return this.active;
  }

  /**
   * 获取等待队列长度
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  private createExit(enqueuedAt: number): () => void {
    let exited = false;
    return () => {
      if (exited) return;
      exited = true;
      this.active--;

      // 唤醒队列中的下一个等待者
      if (this.queue.length > 0) {
        this.active++;
        const next = this.queue.shift()!;
        next.resolve();
      }
    };
  }
}
