/**
 * ResourceManager — 资源管理器
 *
 * 统一管理 token 预算、成本追踪、速率限制。
 * Agent 持续运行后，资源消耗需要被监控和控制。
 */

// ── Token 预算 ──

/** Token 预算配置 */
export interface TokenBudgetConfig {
  /** 单次调用最大 token */
  perCall?: number;
  /** 每分钟最大 token */
  perMinute?: number;
  /** 每小时最大 token */
  perHour?: number;
  /** 总预算（0=不限） */
  total?: number;
}

/** Token 使用记录 */
export interface TokenUsageRecord {
  timestamp: number;
  input: number;
  output: number;
  model: string;
  taskType?: string;
}

// ── 成本追踪 ──

/** 模型定价（每 1M token） */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

/** 成本记录 */
export interface CostRecord {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  taskType?: string;
}

// ── 速率限制 ──

/** 速率限制配置 */
export interface RateLimitConfig {
  /** 每分钟最大请求数 */
  requestsPerMinute?: number;
  /** 最大并发请求数 */
  maxConcurrent?: number;
}

// ── ResourceManager ──

export class ResourceManager {
  // Token 预算
  private _tokenBudget: Required<TokenBudgetConfig>;
  private _tokenUsage: TokenUsageRecord[] = [];
  private _totalTokensUsed = 0;

  // 成本追踪
  private _pricing: Map<string, ModelPricing> = new Map();
  private _costRecords: CostRecord[] = [];
  private _totalCost = 0;

  // 速率限制
  private _rateLimit: Required<RateLimitConfig>;
  private _requestTimestamps: number[] = [];
  private _concurrentRequests = 0;

  constructor(options?: {
    tokenBudget?: TokenBudgetConfig;
    pricing?: Record<string, ModelPricing>;
    rateLimit?: RateLimitConfig;
  }) {
    this._tokenBudget = {
      perCall: options?.tokenBudget?.perCall ?? 100000,
      perMinute: options?.tokenBudget?.perMinute ?? 500000,
      perHour: options?.tokenBudget?.perHour ?? 10000000,
      total: options?.tokenBudget?.total ?? 0,
    };

    if (options?.pricing) {
      for (const [model, price] of Object.entries(options.pricing)) {
        this._pricing.set(model, price);
      }
    }

    this._rateLimit = {
      requestsPerMinute: options?.rateLimit?.requestsPerMinute ?? 60,
      maxConcurrent: options?.rateLimit?.maxConcurrent ?? 5,
    };
  }

  // ── Token 预算 ──

  /**
   * 检查是否允许使用指定数量的 token
   */
  checkTokenBudget(tokens: number): TokenCheckResult {
    const now = Date.now();

    // 单次调用限制
    if (tokens > this._tokenBudget.perCall) {
      return { allowed: false, reason: `Exceeds per-call limit (${this._tokenBudget.perCall})` };
    }

    // 总预算
    if (this._tokenBudget.total > 0 && this._totalTokensUsed + tokens > this._tokenBudget.total) {
      return { allowed: false, reason: `Exceeds total budget (${this._tokenBudget.total})` };
    }

    // 每分钟限制
    const minuteUsage = this._sumUsage(now - 60000);
    if (minuteUsage + tokens > this._tokenBudget.perMinute) {
      return { allowed: false, reason: `Exceeds per-minute limit (${this._tokenBudget.perMinute})`, retryAfterMs: 5000 };
    }

    // 每小时限制
    const hourUsage = this._sumUsage(now - 3600000);
    if (hourUsage + tokens > this._tokenBudget.perHour) {
      return { allowed: false, reason: `Exceeds per-hour limit (${this._tokenBudget.perHour})`, retryAfterMs: 60000 };
    }

    return { allowed: true };
  }

  /**
   * 记录 token 使用
   */
  recordTokenUsage(input: number, output: number, model: string, taskType?: string): void {
    const record: TokenUsageRecord = { timestamp: Date.now(), input, output, model, taskType };
    this._tokenUsage.push(record);
    this._totalTokensUsed += input + output;

    // 清理 1 小时前的记录
    const cutoff = Date.now() - 3600000;
    this._tokenUsage = this._tokenUsage.filter(r => r.timestamp > cutoff);

    // 记录成本
    const pricing = this._pricing.get(model);
    if (pricing) {
      const cost = (input * pricing.inputPer1M + output * pricing.outputPer1M) / 1000000;
      this._costRecords.push({ timestamp: Date.now(), model, inputTokens: input, outputTokens: output, cost, taskType });
      this._totalCost += cost;
    }
  }

  // ── 速率限制 ──

  /**
   * 检查是否允许发送请求
   */
  checkRateLimit(): RateLimitCheckResult {
    const now = Date.now();

    // 并发限制
    if (this._concurrentRequests >= this._rateLimit.maxConcurrent) {
      return { allowed: false, reason: `Max concurrent requests (${this._rateLimit.maxConcurrent})` };
    }

    // 每分钟请求限制
    this._requestTimestamps = this._requestTimestamps.filter(t => t > now - 60000);
    if (this._requestTimestamps.length >= this._rateLimit.requestsPerMinute) {
      const oldestInWindow = Math.min(...this._requestTimestamps);
      const retryAfterMs = oldestInWindow + 60000 - now;
      return { allowed: false, reason: `Rate limit (${this._rateLimit.requestsPerMinute}/min)`, retryAfterMs };
    }

    return { allowed: true };
  }

  /**
   * 标记请求开始
   */
  acquireRequest(): void {
    this._requestTimestamps.push(Date.now());
    this._concurrentRequests++;
  }

  /**
   * 标记请求结束
   */
  releaseRequest(): void {
    this._concurrentRequests = Math.max(0, this._concurrentRequests - 1);
  }

  // ── 统计 ──

  /**
   * 获取资源使用统计
   */
  stats(): ResourceStats {
    const now = Date.now();
    return {
      token: {
        total: this._totalTokensUsed,
        lastMinute: this._sumUsage(now - 60000),
        lastHour: this._sumUsage(now - 3600000),
      },
      cost: {
        total: this._totalCost,
        byModel: this._costByModel(),
      },
      rate: {
        concurrent: this._concurrentRequests,
        requestsLastMinute: this._requestTimestamps.filter(t => t > now - 60000).length,
      },
    };
  }

  /**
   * 设置模型定价
   */
  setPricing(model: string, pricing: ModelPricing): void {
    this._pricing.set(model, pricing);
  }

  // ── 内部方法 ──

  private _sumUsage(since: number): number {
    return this._tokenUsage
      .filter(r => r.timestamp > since)
      .reduce((sum, r) => sum + r.input + r.output, 0);
  }

  private _costByModel(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const record of this._costRecords) {
      result[record.model] = (result[record.model] ?? 0) + record.cost;
    }
    return result;
  }
}

// ── 结果类型 ──

export interface TokenCheckResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export interface ResourceStats {
  token: { total: number; lastMinute: number; lastHour: number };
  cost: { total: number; byModel: Record<string, number> };
  rate: { concurrent: number; requestsLastMinute: number };
}
