/**
 * 熔断器（Circuit Breaker）
 *
 * 三态模型：Closed → Open → Half-Open → Closed
 *
 * - Closed: 正常状态，请求正常通过
 * - Open: 熔断状态，请求直接拒绝
 * - Half-Open: 半开状态，允许少量探测请求通过
 *
 * @module
 */

export interface CircuitBreakerOptions {
  /** 连续失败多少次后触发熔断（默认 5） */
  failureThreshold?: number;
  /** 熔断恢复时间（毫秒，默认 30000） */
  recoveryTimeoutMs?: number;
  /** 半开状态允许的探测请求数（默认 1） */
  halfOpenMaxAttempts?: number;
  /** 名称（用于日志） */
  name?: string;
}

type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * 熔断器
 *
 * @example
 * ```ts
 * const breaker = new CircuitBreaker({ failureThreshold: 3 });
 *
 * // 使用
 * if (!breaker.allowRequest()) {
 *   throw new Error('Circuit breaker is open');
 * }
 *
 * try {
 *   const result = await callProvider();
 *   breaker.recordSuccess();
 *   return result;
 * } catch (err) {
 *   breaker.recordFailure();
 *   throw err;
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  private readonly options: Required<CircuitBreakerOptions>;

  constructor(options?: CircuitBreakerOptions) {
    this.options = {
      failureThreshold: options?.failureThreshold ?? 5,
      recoveryTimeoutMs: options?.recoveryTimeoutMs ?? 30_000,
      halfOpenMaxAttempts: options?.halfOpenMaxAttempts ?? 1,
      name: options?.name ?? 'circuit-breaker',
    };
  }

  /** 当前状态 */
  get currentState(): CircuitState {
    // 检查是否应该从 open 转为 half-open
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.options.recoveryTimeoutMs) {
        this.state = 'half-open';
        this.halfOpenAttempts = 0;
      }
    }
    return this.state;
  }

  /**
   * 检查是否允许请求通过
   */
  allowRequest(): boolean {
    const current = this.currentState;

    if (current === 'closed') return true;

    if (current === 'open') return false;

    // half-open：允许有限的探测请求
    if (this.halfOpenAttempts < this.options.halfOpenMaxAttempts) {
      this.halfOpenAttempts++;
      return true;
    }

    return false;
  }

  /**
   * 记录成功
   *
   * 在 half-open 状态下，成功后回到 closed。
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.reset();
    }
    // closed 状态下成功不需要操作
    this.failureCount = 0;
  }

  /**
   * 记录失败
   *
   * 达到阈值后触发熔断。
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      // 半开状态下失败 → 重新熔断
      this.trip();
      return;
    }

    if (this.failureCount >= this.options.failureThreshold) {
      this.trip();
    }
  }

  /**
   * 强制熔断（用于手动干预）
   */
  trip(): void {
    this.state = 'open';
    this.lastFailureTime = Date.now();
  }

  /**
   * 强制重置（用于手动恢复）
   */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
  }

  /**
   * 获取状态快照
   */
  snapshot(): { state: CircuitState; failureCount: number; lastFailureTime: number } {
    return {
      state: this.currentState,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}
