/**
 * MemoryHealthProbe — 轻量 health 事件（govern 双脉搏补充触发）
 *
 * 不写库；只读 stats 并 emit：
 * - memory.health.high_count
 * - memory.health.shadow_backlog
 *
 * @module harness/memory/health-probe
 */

import type { EventBus } from '../../core/primitives/event-bus.js';
import type { MemoryStore, MemoryType } from './types.js';

export interface MemoryHealthProbeOptions {
  events: EventBus;
  memoryStore: MemoryStore;
  /** 默认 1h */
  intervalMs?: number;
  /** 各 type 活跃数上限（默认与 govern capacity 对齐） */
  limits?: Partial<Record<MemoryType, number>>;
  /** shadow 积压阈值（默认 50） */
  shadowBacklogLimit?: number;
  now?: () => number;
}

const DEFAULT_LIMITS: Record<MemoryType, number> = {
  fact: 200,
  method: 100,
  norm: 150,
};

export class MemoryHealthProbe {
  private readonly events: EventBus;
  private readonly memoryStore: MemoryStore;
  private readonly intervalMs: number;
  private readonly limits: Record<MemoryType, number>;
  private readonly shadowBacklogLimit: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: MemoryHealthProbeOptions) {
    this.events = options.events;
    this.memoryStore = options.memoryStore;
    this.intervalMs = options.intervalMs ?? 3600_000;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.shadowBacklogLimit = options.shadowBacklogLimit ?? 50;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 立即检查一轮；返回发出的事件类型 */
  async check(): Promise<string[]> {
    const emitted: string[] = [];
    let stats;
    try {
      stats = await this.memoryStore.stats();
    } catch {
      return emitted;
    }

    for (const type of ['fact', 'method', 'norm'] as MemoryType[]) {
      const count = stats.byType[type] ?? 0;
      const limit = this.limits[type];
      if (count > limit) {
        this.events.emit({
          type: 'memory.health.high_count',
          timestamp: this.now(),
          data: { type, count, limit },
        });
        emitted.push('memory.health.high_count');
      }
    }

    const shadow = stats.shadowEntries ?? 0;
    if (shadow >= this.shadowBacklogLimit) {
      this.events.emit({
        type: 'memory.health.shadow_backlog',
        timestamp: this.now(),
        data: { count: shadow, limit: this.shadowBacklogLimit },
      });
      emitted.push('memory.health.shadow_backlog');
    }

    return emitted;
  }
}
