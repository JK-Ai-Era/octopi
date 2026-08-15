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
 * - 可销毁：支持优雅退出，清理所有排队等待
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
  /** 已进入的请求数 */
  enteredRequests: number;
  /** 超时/拒绝的请求数 */
  rejectedRequests: number;
  /** 总等待时间（毫秒） */
  totalWaitMs: number;
  /** 平均等待时间（毫秒） */
  avgWaitMs: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionGate {
  private active = 0;
  private queue: Waiter[] = [];
  private totalRequests = 0;
  private enteredRequests = 0;
  private rejectedRequests = 0;
  private totalWaitMs = 0;
  private readonly maxConcurrent: number;
  private readonly waitTimeoutMs: number;
  private destroyed = false;

  constructor(config: SessionGateConfig = {}) {
    const max = config.maxConcurrent ?? 10;
    if (max <= 0) {
      throw new Error(`maxConcurrent must be positive, got ${max}`);
    }
    this.maxConcurrent = max;
    this.waitTimeoutMs = config.waitTimeoutMs ?? 30_000;
  }

  /**
   * 进入 session（获取通行证）
   * @returns 释放函数，调用后允许其他 session 运行
   * @throws 超时或已销毁时抛出错误
   */
  async enter(): Promise<() => void> {
    if (this.destroyed) {
      throw new Error('SessionGate has been destroyed');
    }

    this.totalRequests++;
    const enqueuedAt = Date.now();

    if (this.active < this.maxConcurrent) {
      this.active++;
      this.enteredRequests++;
      this.totalWaitMs += Date.now() - enqueuedAt;
      return this.createExit(enqueuedAt);
    }

    // 排队等待
    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(waiter);
        if (idx >= 0) this.queue.splice(idx, 1);
        this.rejectedRequests++;
        reject(new Error(`Session gate timeout: waited ${this.waitTimeoutMs}ms for a slot`));
      }, this.waitTimeoutMs);

      const waiter: Waiter = {
        resolve: (release: () => void) => {
          clearTimeout(timer);
          const waitTime = Date.now() - enqueuedAt;
          this.totalWaitMs += waitTime;
          this.enteredRequests++;
          resolve(release);
        },
        reject: (err: Error) => {
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
    if (this.destroyed) return null;

    if (this.active < this.maxConcurrent) {
      this.active++;
      this.enteredRequests++;
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
      enteredRequests: this.enteredRequests,
      rejectedRequests: this.rejectedRequests,
      totalWaitMs: this.totalWaitMs,
      avgWaitMs: this.totalRequests > 0 ? this.totalWaitMs / this.totalRequests : 0,
    };
  }

  /**
   * 检查是否有可用槽位
   */
  get available(): boolean {
    return !this.destroyed && this.active < this.maxConcurrent;
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

  /**
   * 检查是否已销毁
   */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * 销毁 gate，拒绝所有排队中的等待者
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    const error = new Error('SessionGate destroyed');
    for (const waiter of this.queue) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.queue = [];
  }

  private createExit(enqueuedAt: number): () => void {
    let exited = false;
    return () => {
      if (exited) return;
      exited = true;
      this.active--;

      // 唤醒队列中的下一个等待者
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        // 检查 timer 是否还在（可能已被 timeout 或 destroy 清除）
        // 如果 waiter 已经被 reject，resolve 不会生效（Promise 只能 settle 一次）
        this.active++;
        next.resolve(this.createExit(Date.now()));
        break;
      }
    };
  }
}
