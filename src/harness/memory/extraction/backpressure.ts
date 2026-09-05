/**
 * Memory Extraction — PendingExtractor backpressure
 *
 * 为 PendingExtractor 增加回压控制：
 * - pendingCount 超阈值时，主动降速（延长扫描间隔）
 * - 并发触发上限（per-agent），避免一次性打爆模型/IO
 *
 * 本模块提供 BackpressureController，可与 PendingExtractor 配合使用。
 *
 * @module harness/memory/extraction/backpressure
 */

export interface BackpressureOptions {
  /** 正常扫描间隔（毫秒） */
  baseIntervalMs: number;
  /** 回压阈值（pending 数量） */
  pendingThreshold: number;
  /** 回压时的扫描间隔（毫秒） */
  backoffIntervalMs: number;
  /** 每轮最大并发触发数（默认 2） */
  maxConcurrentTriggers?: number;
}

export class BackpressureController {
  private options: BackpressureOptions;
  private activeTriggers = 0;
  private queue: Array<() => void> = [];

  constructor(options: BackpressureOptions) {
    this.options = {
      maxConcurrentTriggers: 2,
      ...options,
    };
  }

  /** 根据 pendingCount 决定扫描间隔 */
  getIntervalMs(pendingCount: number): number {
    return pendingCount >= this.options.pendingThreshold
      ? this.options.backoffIntervalMs
      : this.options.baseIntervalMs;
  }

  /** 获取触发令牌（并发控制） */
  async acquire(): Promise<void> {
    if (this.activeTriggers < (this.options.maxConcurrentTriggers ?? 2)) {
      this.activeTriggers += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /** 释放触发令牌 */
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      // 保持 activeTriggers 不变，直接交给下一个
      next();
      return;
    }
    this.activeTriggers = Math.max(0, this.activeTriggers - 1);
  }

  get active(): number {
    return this.activeTriggers;
  }

  get waiting(): number {
    return this.queue.length;
  }
}
