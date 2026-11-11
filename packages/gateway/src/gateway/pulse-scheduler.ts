/**
 * PulseScheduler — gateway 侧脉搏调度器（P0c 脉搏单源，arch/service-topology-p0c.md §3 方案 A′）。
 *
 * 职责：收 run 实例池的脉搏自述（PulseSpec），按 intervalMs **单发**驱动——周期触发源
 * 结构性只存在于此（gateway 调度器单例，§5.4 触发面归属），run 实例零 self-arm 定时器。
 *
 * pulse lease（§5.2）：同一 pulseKey 全 fleet 同时至多一个持有实例。归属**表**在
 * FleetRunBackend（单一事实源），归属**决策**在此：首见分配 / 持有实例消失转移 /
 * key 消失拆除。gateway 不解释 key 的产品语义（opaque）。
 *
 * @module gateway/pulse-scheduler
 */

import type { PulseSpec } from '@octopi-agent/engine/harness/activation/run-protocol.js';

/** 脉搏 fleet 端口（FleetRunBackend 即其实现） */
export interface PulseFleet {
  /** 全实例脉搏自述（带来源实例；不可达实例缺席） */
  pulseInventory(): Promise<Array<{ instanceId: string; spec: PulseSpec }>>;
  /** 按归属表定向单发一跳（无归属 fail-loud） */
  pulse(key: string): Promise<void>;
  /** 归属写入（幂等；未注册实例 fail-loud） */
  setPulseOwner(key: string, instanceId: string): void;
  /** 归属查询（无归属 undefined） */
  resolvePulseOwner(key: string): string | undefined;
  /** 归属拆除（key 消失时清理） */
  clearPulseOwner(key: string): void;
}

export class PulseScheduler {
  private readonly fleet: PulseFleet;
  private readonly resyncMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly specs = new Map<string, PulseSpec>();
  /** 同 key 的候选持有实例（key → instanceId 集合；归属转移的输入） */
  private readonly candidates = new Map<string, Set<string>>();
  private resyncTimer?: ReturnType<typeof setInterval>;
  private started = false;

  /**
   * @param options - fleet（脉搏 fleet 端口）+ resyncMs（自述重收周期，默认 60s）
   */
  constructor(options: { fleet: PulseFleet; resyncMs?: number }) {
    this.fleet = options.fleet;
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
   * 重收自述并对账：归属决策（首见分配 / 持有者消失转移）、定时器增删改、key 拆除。
   * 拉取失败保持既有调度（fail-soft：实例短暂不可达不丢调度），fail-loud 打 warning。
   */
  async resync(): Promise<void> {
    let inventory: Array<{ instanceId: string; spec: PulseSpec }>;
    try {
      inventory = await this.fleet.pulseInventory();
    } catch (err) {
      console.warn(
        `[Pulse] resync failed（保持既有调度）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // 按 key 归并候选实例（同 key 多副本自述同名——归属即去重）
    const byKey = new Map<string, { spec: PulseSpec; instances: Set<string> }>();
    for (const { instanceId, spec } of inventory) {
      let entry = byKey.get(spec.key);
      if (!entry) {
        entry = { spec, instances: new Set() };
        byKey.set(spec.key, entry);
      }
      entry.instances.add(instanceId);
    }

    // 归属决策：原持有者仍在候选中则保持；否则转移给首个候选
    for (const [key, entry] of byKey) {
      this.candidates.set(key, entry.instances);
      const owner = this.fleet.resolvePulseOwner(key);
      if (!owner || !entry.instances.has(owner)) {
        const next = [...entry.instances][0];
        this.fleet.setPulseOwner(key, next);
      }
    }

    // 定时器对账
    const seen = new Set(byKey.keys());
    for (const [key, entry] of byKey) {
      const existing = this.specs.get(key);
      if (existing && existing.intervalMs === entry.spec.intervalMs && this.timers.has(key)) {
        continue;
      }
      const stale = this.timers.get(key);
      if (stale) {
        clearInterval(stale);
        this.timers.delete(key);
      }
      this.specs.set(key, entry.spec);
      const timer = setInterval(() => {
        void this.fire(key);
      }, entry.spec.intervalMs);
      (timer as { unref?: () => void }).unref?.();
      this.timers.set(key, timer);
      // 首跳（替代原 runOnStart 自跳；仅新 key，周期变更重建不重发）
      if (entry.spec.runOnStart && !existing) {
        void this.fire(key);
      }
    }
    for (const key of [...this.specs.keys()]) {
      if (seen.has(key)) continue;
      const t = this.timers.get(key);
      if (t) clearInterval(t);
      this.timers.delete(key);
      this.specs.delete(key);
      this.candidates.delete(key);
      this.fleet.clearPulseOwner(key);
    }
  }

  private async fire(key: string): Promise<void> {
    try {
      await this.fleet.pulse(key);
    } catch (err) {
      console.warn(`[Pulse] ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 停止全部调度（归属表留在 fleet，随实例注销清理） */
  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.specs.clear();
    this.candidates.clear();
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

  /** 诊断：key 的候选持有实例 */
  candidatesOf(key: string): string[] {
    return [...(this.candidates.get(key) ?? [])];
  }
}
