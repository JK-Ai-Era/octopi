/**
 * ProviderPool — 多 Key LLM Provider 负载均衡池
 *
 * 核心能力：
 * - 多 key 分发：多个 API key 分散 rate limit 压力
 * - 粘滞路由：同一 session 尽量路由到同一 key（prompt cache 命中）
 * - 自动故障转移：key 限流/故障时自动切换
 * - per-key 限流：每个 key 独立的令牌桶限流器
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

  constructor(
    poolConfig: ProviderPoolConfig,
    providerMap: Map<string, ModelProvider>,
  ) {
    this.strategy = poolConfig.routing?.strategy ?? 'sticky';
    this.stickyTtlMs = poolConfig.routing?.stickyTtlMs ?? 30 * 60 * 1000;

    // 构建 slot
    for (const slotConfig of poolConfig.slots) {
      const provider = providerMap.get(slotConfig.provider);
      if (!provider) {
        throw new Error(
          `ProviderPool: provider "${slotConfig.provider}" not found in provider map. ` +
          `Available: ${[...providerMap.keys()].join(', ')}`
        );
      }

      // 合并限流配置：slot 级 > 全局级 > 默认值
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

    // 默认模型：第一个 slot 的 defaultModel
    this.defaultModel = this.slots[0].provider.defaultModel;

    // 定期清理过期粘滞映射
    this.cleanupTimer = setInterval(() => this.cleanupSticky(), 60_000);
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
    // 从第一个健康的 slot 获取
    for (const slot of this.slots) {
      if (slot.healthy) {
        const info = slot.provider.getModelInfo(model);
        if (info) return info;
      }
    }
    // fallback: 任意 slot
    return this.slots[0]?.provider.getModelInfo(model) ?? null;
  }

  getModelInfos(): ModelInfo[] {
    // 合并所有 slot 的 provider 的 model infos（去重）
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
    // 至少一个 slot 健康即可
    return this.slots.some(s => s.healthy);
  }

  // ── 生命周期 ──

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    for (const slot of this.slots) {
      slot.rateLimiter.destroy();
    }
    this.stickyMap.clear();
  }

  // ── 监控 ──

  /**
   * 获取所有 slot 的指标
   */
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

  /**
   * 获取粘滞映射统计
   */
  getStickyStats(): { activeSessions: number; ttlMs: number; strategy: string } {
    return {
      activeSessions: this.stickyMap.size,
      ttlMs: this.stickyTtlMs,
      strategy: this.strategy,
    };
  }

  // ── 路由逻辑 ──

  /**
   * 选择 slot（带粘滞路由 + 故障转移）
   */
  private async selectSlot(sessionId?: string): Promise<{ slot: ProviderSlot; index: number }> {
    // 1. 粘滞路由：同一 session 尽量用同一个 slot
    if (sessionId && this.strategy === 'sticky') {
      const sticky = this.stickyMap.get(sessionId);
      if (sticky !== undefined) {
        const slot = this.slots[sticky.slotIndex];
        if (slot.healthy) {
          sticky.lastUsed = Date.now();
          return { slot, index: sticky.slotIndex };
        }
        // slot 不健康，走故障转移
        this.stickyMap.delete(sessionId);
      }
    }

    // 2. 选择新 slot
    const index = this.pickSlot(sessionId);
    const slot = this.slots[index];

    // 3. 记录粘滞映射
    if (sessionId) {
      this.stickyMap.set(sessionId, { slotIndex: index, lastUsed: Date.now() });
    }

    return { slot, index };
  }

  /**
   * 根据策略选择 slot
   */
  private pickSlot(sessionId?: string): number {
    const healthy = this.slots
      .map((s, i) => ({ slot: s, index: i }))
      .filter(s => s.slot.healthy);

    if (healthy.length === 0) {
      // 全部不健康，强制选一个（让调用方决定是否重试）
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

  /**
   * 加权随机选择
   */
  private pickWeightedRandom(indices: number[]): number {
    const totalWeight = indices.reduce((sum, i) => sum + (this.slots[i].config.weight ?? 1), 0);
    let rand = Math.random() * totalWeight;
    for (const i of indices) {
      rand -= this.slots[i].config.weight ?? 1;
      if (rand <= 0) return i;
    }
    return indices[indices.length - 1];
  }

  /**
   * 加权轮询
   */
  private pickRoundRobin(indices: number[]): number {
    // 按权重展开
    const expanded: number[] = [];
    for (const i of indices) {
      const w = this.slots[i].config.weight ?? 1;
      for (let j = 0; j < w; j++) expanded.push(i);
    }
    const idx = this.roundRobinIndex % expanded.length;
    this.roundRobinIndex++;
    return expanded[idx];
  }

  /**
   * 最少负载选择
   */
  private pickLeastLoaded(indices: number[]): number {
    let best = indices[0];
    let bestLoad = Infinity;
    for (const i of indices) {
      const metrics = this.slots[i].rateLimiter.metrics();
      // 负载 = 队列长度 + (总请求 - 已完成) / 权重
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

    // 连续 5 次错误 → 标记不健康
    if (slot.consecutiveErrors >= 5) {
      slot.healthy = false;
    }

    // TODO: 定期探活不健康的 slot
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

  /**
   * 从请求中提取 sessionId（用于粘滞路由）
   *
   * 约定：LLMRequest.signal 上挂载 __sessionId 元数据。
   * 如果没有 signal 或没有 sessionId，退化为轮询/随机路由。
   */
  private extractSessionId(request: LLMRequest): string | undefined {
    // signal 上可能挂了 sessionId（由 Harness 层设置）
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
