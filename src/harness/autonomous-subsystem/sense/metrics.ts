/**
 * Autonomous Subsystem — MetricsStore
 *
 * 指标存储，供 condition 表达式引用。
 * 主循环在关键节点调用 updateMetric 注入指标。
 *
 * @module autonomous-subsystem/sense/metrics
 */

/**
 * MetricsStore — 线程安全的指标存储
 *
 * 存储主循环注入的运行时指标（如 turn.count、token.used 等），
 * 供 SenseEngine 的 condition 表达式评估使用。
 */
export class MetricsStore {
  private metrics = new Map<string, number>();

  /**
   * 更新指标值
   *
   * @param key - 指标名（如 'turn.count'）
   * @param value - 指标值
   */
  update(key: string, value: number): void {
    this.metrics.set(key, value);
  }

  /**
   * 递增指标值（默认 +1）
   *
   * @param key - 指标名
   * @param delta - 增量
   */
  increment(key: string, delta: number = 1): void {
    const current = this.metrics.get(key) ?? 0;
    this.metrics.set(key, current + delta);
  }

  /**
   * 获取指标值
   *
   * @param key - 指标名
   * @returns 指标值，不存在返回 undefined
   */
  get(key: string): number | undefined {
    return this.metrics.get(key);
  }

  /**
   * 获取当前指标快照
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.metrics);
  }

  /**
   * 重置所有指标
   */
  reset(): void {
    this.metrics.clear();
  }
}
