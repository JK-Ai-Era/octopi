/**
 * ProviderPool — 多 Key LLM Provider 负载均衡池
 *
 * 核心能力：
 * - 多 key 分发：多个 API key 分散 rate limit 压力
 * - 粘滞路由：同一 session 尽量路由到同一 key（prompt cache 命中）
 * - 自动故障转移：key 限流/故障时自动切换
 * - per-key 限流：每个 key 独立的令牌桶限流器
 * - 主动探活：定期检查不健康 slot，恢复后立即回到路由池
 *
 * 设计原则：
 * - 实现 ModelProvider 接口，对 Engine 透明
 * - 配置驱动，所有参数从 config 读取
 * - 粘滞映射有 TTL，过期自动解除
 */

import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '../../core/interfaces/model-provider.js';
import type { ModelInfo } from '../../core/types.js';
import { RateLimiter } from './rate-limiter.js';

// ── 配置类型 ──

export interface PoolSlotConfig {
  /** 引用 providers[].name */
  provider: string;
  /** 权重（轮询时按权重分配，默认 1） */
  weight?: number;
  /** slot 级别的限流配置（覆盖全局默认） */
  rateLimit?: {
    requestsPerMinute: number;
    burstCapacity?: number;
    maxWaitMs?: number;
  };
}

export interface RoutingConfig {
  /** 路由策略（默认 sticky） */
  strategy?: 'sticky' | 'round-robin' | 'least-loaded';
  /** 粘滞超时（毫秒，默认 1800000 = 30 分钟） */
  stickyTtlMs?: number;
  /** 故障转移模式（默认 auto） */
  failover?: 'auto' | 'manual';
}

export interface HealthCheckConfig {
  /** 探活间隔（毫秒），默认 30_000 */
  intervalMs?: number;
  /** 单次探活超时（毫秒），默认 5_000 */
  timeoutMs?: number;
}

export interface ProviderPoolConfig {
  /** 池中的 slot 列表 */
  slots: PoolSlotConfig[];
  /** 路由配置 */
  routing?: RoutingConfig;
  /** 全局默认限流配置 */
  rateLimit?: {
    requestsPerMinute: number;
    burstCapacity?: number;
    maxWaitMs?: number;
  };
  /** 主动探活配置 */
  healthCheck?: HealthCheckConfig;
}

// ── 内部类型 ──

interface ProviderSlot {
  config: PoolSlotConfig;
  provider: ModelProvider;
  rateLimiter: RateLimiter;
  healthy: boolean;
  consecutiveErrors: number;
  totalCalls: number;
  totalErrors: number;
}

interface StickyEntry {
  slotIndex: number;
  lastUsed: number;
}

// ── ProviderPool 实现 ──

/**
 * ProviderPool — 对外暴露 ModelProvider 接口
 *
 * 内部管理多个 provider slot，根据策略路由请求。
 * 对 Engine 完全透明，可直接替换单个 provider。
 */
export class ProviderPool implements ModelProvider {
  readonly name = 'provider-pool';
  readonly defaultModel?: string;

  private slots: ProviderSlot[] = [];
  private stickyMap = new Map<string, StickyEntry>();
  private roundRobinIndex = 0;
  private readonly strategy: 'sticky' | 'round-robin' | 'least-loaded';
  private readonly stickyTtlMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private readonly healthIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private lastProbeAt = 0;
  private lastRecoverAt = 0;

  constructor(
    poolConfig: ProviderPoolConfig,
    providerMap: Map<string, ModelProvider>,
  ) {
    this.strategy = poolConfig.routing?.strategy ?? 'sticky';
    this.stickyTtlMs = poolConfig.routing?.stickyTtlMs ?? 30 * 60 * 1000;
    this.healthIntervalMs = poolConfig.healthCheck?.intervalMs ?? 30_000;
    this.healthTimeoutMs = poolConfig.healthCheck?.timeoutMs ?? 5_000;

    for (const slotConfig of poolConfig.slots) {
      const provider = providerMap.get(slotConfig.provider);
      if (!provider) {
        throw new Error(
          `ProviderPool: provider "${slotConfig.provider}" not found in provider map. ` +
          `Available: ${[...providerMap.keys()].join(', ')}`
        );
      }

      const rpm = slotConfig.rateLimit?.requestsPerMinute
        ?? poolConfig.rateLimit?.requestsPerMinute
        ?? 60;
      const burst = slotConfig.rateLimit?.burstCapacity
        ?? poolConfig.rateLimit?.burstCapacity;
      const maxWait = slotConfig.rateLimit?.maxWaitMs
        ?? poolConfig.rateLimit?.maxWaitMs
        ?? 30_000;

      this.slots.push({
        config: slotConfig,
        provider,
        rateLimiter: new RateLimiter({
          requestsPerMinute: rpm,
          burstCapacity: burst,
          maxWaitMs: maxWait,
        }),
        healthy: true,
        consecutiveErrors: 0,
        totalCalls: 0,
        totalErrors: 0,
      });
    }

    if (this.slots.length === 0) {
      throw new Error('ProviderPool: at least one slot is required');
    }

    this.defaultModel = this.slots[0].provider.defaultModel;
    this.cleanupTimer = setInterval(() => this.cleanupSticky(), 60_000);
    this.healthTimer = setInterval(() => this.runHealthCheck(), this.healthIntervalMs);
  }

  // ── ModelProvider 接口 ──

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const sessionId = this.extractSessionId(request);
    const { slot, index } = await this.selectSlot(sessionId);

    try {
      await slot.rateLimiter.acquire();
      slot.totalCalls++;
      const response = await slot.provider.chat(request);
      this.onSuccess(index);
      return response;
    } catch (err) {
      this.onError(index, err);
      throw err;
    }
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    const sessionId = this.extractSessionId(request);
    const { slot, index } = await this.selectSlot(sessionId);

    try {
      await slot.rateLimiter.acquire();
      slot.totalCalls++;
      const gen = slot.provider.stream(request);
      yield* gen;
      this.onSuccess(index);
    } catch (err) {
      this.onError(index, err);
      throw err;
    }
  }

  getModelInfo(model: string): ModelInfo | null {
    for (const slot of this.slots) {
      if (slot.healthy) {
        const info = slot.provider.getModelInfo(model);
        if (info) return info;
      }
    }
    return this.slots[0]?.provider.getModelInfo(model) ?? null;
  }

  getModelInfos(): ModelInfo[] {
    const seen = new Set<string>();
    const result: ModelInfo[] = [];
    for (const slot of this.slots) {
      for (const info of slot.provider.getModelInfos()) {
        if (!seen.has(info.name)) {
          seen.add(info.name);
          result.push(info);
        }
      }
    }
    return result;
  }

  async isAvailable(): Promise<boolean> {
    return this.slots.some(s => s.healthy);
  }

  // ── 生命周期 ──

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    for (const slot of this.slots) {
      slot.rateLimiter.destroy();
    }
    this.stickyMap.clear();
  }

  // ── 监控 ──

  getSlotMetrics(): SlotMetrics[] {
    return this.slots.map((slot, i) => ({
      index: i,
      provider: slot.config.provider,
      healthy: slot.healthy,
      weight: slot.config.weight ?? 1,
      totalCalls: slot.totalCalls,
      totalErrors: slot.totalErrors,
      consecutiveErrors: slot.consecutiveErrors,
      rateLimiter: slot.rateLimiter.metrics(),
    }));
  }

  getStickyStats(): { activeSessions: number; ttlMs: number; strategy: string } {
    return {
      activeSessions: this.stickyMap.size,
      ttlMs: this.stickyTtlMs,
      strategy: this.strategy,
    };
  }

  getHealthStats(): { lastProbeAt: number; lastRecoverAt: number; intervalMs: number; timeoutMs: number } {
    return {
      lastProbeAt: this.lastProbeAt,
      lastRecoverAt: this.lastRecoverAt,
      intervalMs: this.healthIntervalMs,
      timeoutMs: this.healthTimeoutMs,
    };
  }

  /**
   * 手动触发一次探活，便于编排或测试。
   */
  async runHealthCheck(): Promise<void> {
    await this.probeUnhealthySlots();
  }

  // ── 路由逻辑 ──

  private async selectSlot(sessionId?: string): Promise<{ slot: ProviderSlot; index: number }> {
    if (sessionId && this.strategy === 'sticky') {
      const sticky = this.stickyMap.get(sessionId);
      if (sticky !== undefined) {
        const slot = this.slots[sticky.slotIndex];
        if (slot.healthy) {
          sticky.lastUsed = Date.now();
          return { slot, index: sticky.slotIndex };
        }
        this.stickyMap.delete(sessionId);
      }
    }

    const index = this.pickSlot(sessionId);
    const slot = this.slots[index];

    if (sessionId) {
      this.stickyMap.set(sessionId, { slotIndex: index, lastUsed: Date.now() });
    }

    return { slot, index };
  }

  private pickSlot(sessionId?: string): number {
    const healthy = this.slots
      .map((s, i) => ({ slot: s, index: i }))
      .filter(s => s.slot.healthy);

    if (healthy.length === 0) {
      return 0;
    }

    switch (this.strategy) {
      case 'round-robin':
        return this.pickRoundRobin(healthy.map(h => h.index));
      case 'least-loaded':
        return this.pickLeastLoaded(healthy.map(h => h.index));
      case 'sticky':
      default:
        return this.pickWeightedRandom(healthy.map(h => h.index));
    }
  }

  private pickWeightedRandom(indices: number[]): number {
    const totalWeight = indices.reduce((sum, i) => sum + (this.slots[i].config.weight ?? 1), 0);
    let rand = Math.random() * totalWeight;
    for (const i of indices) {
      rand -= this.slots[i].config.weight ?? 1;
      if (rand <= 0) return i;
    }
    return indices[indices.length - 1];
  }

  private pickRoundRobin(indices: number[]): number {
    const expanded: number[] = [];
    for (const i of indices) {
      const w = this.slots[i].config.weight ?? 1;
      for (let j = 0; j < w; j++) expanded.push(i);
    }
    const idx = this.roundRobinIndex % expanded.length;
    this.roundRobinIndex++;
    return expanded[idx];
  }

  private pickLeastLoaded(indices: number[]): number {
    let best = indices[0];
    let bestLoad = Infinity;
    for (const i of indices) {
      const metrics = this.slots[i].rateLimiter.metrics();
      const pending = metrics.totalRequests - metrics.fulfilledRequests;
      const load = (metrics.queueLength + pending) / (this.slots[i].config.weight ?? 1);
      if (load < bestLoad) {
        bestLoad = load;
        best = i;
      }
    }
    return best;
  }

  // ── 健康管理 ──

  private onSuccess(index: number): void {
    const slot = this.slots[index];
    slot.consecutiveErrors = 0;
    if (!slot.healthy) {
      slot.healthy = true;
    }
  }

  private onError(index: number, err: unknown): void {
    const slot = this.slots[index];
    slot.consecutiveErrors++;
    slot.totalErrors++;

    if (slot.consecutiveErrors >= 5) {
      slot.healthy = false;
    }

    // 失败后立即触发一次探活，缩短恢复窗口
    void this.runHealthCheck().catch(() => {});
  }

  private async probeUnhealthySlots(): Promise<void> {
    const now = Date.now();
    this.lastProbeAt = now;

    for (const slot of this.slots) {
      if (slot.healthy) {
        continue;
      }

      const healthy = await this.checkSlotHealth(slot);
      if (healthy) {
        slot.healthy = true;
        slot.consecutiveErrors = 0;
        this.lastRecoverAt = now;
      }
    }
  }

  private async checkSlotHealth(slot: ProviderSlot): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);

    try {
      const result = await Promise.race([
        slot.provider.isAvailable(),
        this.waitForAbort(controller.signal),
      ]);
      return result === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private waitForAbort(signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }

      const onAbort = () => resolve(false);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ── 粘滞映射管理 ──

  private cleanupSticky(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.stickyMap) {
      if (now - entry.lastUsed > this.stickyTtlMs) {
        this.stickyMap.delete(sessionId);
      }
    }
  }

  private extractSessionId(request: LLMRequest): string | undefined {
    const signal = request.signal as (AbortSignal & { __sessionId?: string }) | undefined;
    return signal?.__sessionId;
  }
}

// ── 监控类型 ──

export interface SlotMetrics {
  index: number;
  provider: string;
  healthy: boolean;
  weight: number;
  totalCalls: number;
  totalErrors: number;
  consecutiveErrors: number;
  rateLimiter: {
    availableTokens: number;
    queueLength: number;
    totalRequests: number;
    fulfilledRequests: number;
  };
}
