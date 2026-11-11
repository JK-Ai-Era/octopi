/**
 * PulseScheduler — gateway 侧脉搏调度器（P0c 脉搏单源，arch/service-topology-p0c.md §3 方案 A′）。
 *
 * 职责：收 run 实例的脉搏自述（PulseSpec），按 intervalMs **单发**驱动——周期触发源
 * 结构性只存在于此（gateway 调度器单例，§5.4 触发面归属），run 实例零 self-arm 定时器。
 *
 * pulse lease 归属：同一 pulseKey 全 fleet 同时至多一个持有实例；P0c-1 单实例恒持，
 * P0c-2 supervise 多实例时由本组件按持有表转移（持有实例 drain/失联 → 换 key 归属）。
 * gateway 不解释 key 的产品语义（opaque）。
 *
 * @module gateway/pulse-scheduler
 */

import type { PulseSpec } from '@octopi-agent/engine/harness/activation/run-protocol.js';

/** 脉搏目标端口（P0c-1 单实例；P0c-2 换 FleetRunBackend 同形状） */
export interface PulseTarget {
  /** 实例标识（pulse lease 归属键） */
  readonly instanceId: string;
  /** 拉取脉搏自述（health 载荷的 pulses） */
  pulses(): Promise<PulseSpec[]>;
  /** 向实例单发一跳 */
  pulse(key: string): Promise<void>;
}

export class PulseScheduler {
  private readonly target: PulseTarget;
  private readonly resyncMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly specs = new Map<string, PulseSpec>();
  /** pulse lease 归属表：key → 持有 instanceId */
  private readonly holders = new Map<string, string>();
  private resyncTimer?: ReturnType<typeof setInterval>;
  private started = false;

  /**
   * @param options - target（脉搏目标端口）+ resyncMs（自述重收周期，默认 60s）
   */
  constructor(options: { target: PulseTarget; resyncMs?: number }) {
    this.target = options.target;
    this.resyncMs = options.resyncMs ?? 60_000;
  }

  /** 启动：首收自述并开周期重收（实例换代后脉搏集可变） */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.resync();
    this.resyncTimer = setInterval(() => {
      void this.resync();
    }, this.resyncMs);
    (this.resyncTimer as { unref?: () => void }).unref?.();
  }

  /**
   * 重收自述并对账调度表：新增/周期变更（重）建定时器，消失的 key 拆除。
   * 拉取失败保持既有调度（fail-soft：实例短暂不可达不丢调度），fail-loud 打 warning。
   */
  async resync(): Promise<void> {
    let specs: PulseSpec[];
    try {
      specs = await this.target.pulses();
    } catch (err) {
      console.warn(
        `[Pulse] resync failed（保持既有调度）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const seen = new Set<string>();
    for (const spec of specs) {
      seen.add(spec.key);
      this.holders.set(spec.key, this.target.instanceId);
      const existing = this.specs.get(spec.key);
      if (existing && existing.intervalMs === spec.intervalMs && this.timers.has(spec.key)) {
        continue;
      }
      const stale = this.timers.get(spec.key);
      if (stale) {
        clearInterval(stale);
        this.timers.delete(spec.key);
      }
      this.specs.set(spec.key, spec);
      const timer = setInterval(() => {
        void this.fire(spec.key);
      }, spec.intervalMs);
      (timer as { unref?: () => void }).unref?.();
      this.timers.set(spec.key, timer);
      // 首跳（替代原 runOnStart 自跳；仅新 key，周期变更重建不重发）
      if (spec.runOnStart && !existing) {
        void this.fire(spec.key);
      }
    }
    for (const key of [...this.specs.keys()]) {
      if (seen.has(key)) continue;
      const t = this.timers.get(key);
      if (t) clearInterval(t);
      this.timers.delete(key);
      this.specs.delete(key);
      this.holders.delete(key);
    }
  }

  private async fire(key: string): Promise<void> {
    if (this.holders.get(key) !== this.target.instanceId) return;
    try {
      await this.target.pulse(key);
    } catch (err) {
      console.warn(`[Pulse] ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 停止全部调度 */
  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.specs.clear();
    this.holders.clear();
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = undefined;
    }
    this.started = false;
  }

  /** 诊断：在调脉搏键 */
  activeKeys(): string[] {
    return [...this.timers.keys()];
  }
}
