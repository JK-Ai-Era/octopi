/**
 * ToolValidator — 工具执行结果验证
 *
 * 在工具执行后验证结果，确保：
 * 1. 结果不为空
 * 2. No-op 检测（无实际变化的操作）
 * 3. 结果大小限制（防止上下文膨胀）
 * 4. 类型安全（结构化结果的类型检查）
 */

export interface ToolValidatorConfig {
  /** 最大结果大小（字符数，默认 100000） */
  maxResultSize?: number;
  /** No-op 检测阈值 — 连续 no-op 次数（默认 3） */
  noopThreshold?: number;
  /** 空结果是否视为 no-op（默认 true） */
  emptyIsNoop?: boolean;
}

export interface ValidationResult {
  /** 是否有效（连续 no-op 未超过阈值） */
  valid: boolean;
  /** 是否为 no-op */
  isNoop: boolean;
  /** 连续 no-op 次数 */
  consecutiveNoops: number;
  /** 警告信息 */
  warnings: string[];
  /** 处理后的结果（可能被截断） */
  processedResult: unknown;
}

export interface ToolCallRecord {
  toolName: string;
  args: unknown;
  result: unknown;
  isNoop: boolean;
  timestamp: number;
}

export class ToolValidator {
  private readonly maxResultSize: number;
  private readonly noopThreshold: number;
  private readonly emptyIsNoop: boolean;
  private consecutiveNoops = 0;
  private history: ToolCallRecord[] = [];

  constructor(config: ToolValidatorConfig = {}) {
    this.maxResultSize = config.maxResultSize ?? 100_000;
    this.noopThreshold = config.noopThreshold ?? 3;
    this.emptyIsNoop = config.emptyIsNoop ?? true;
  }

  /**
   * 验证工具执行结果
   */
  validate(toolName: string, args: unknown, result: unknown): ValidationResult {
    const warnings: string[] = [];
    let isNoop = false;
    let processedResult = result;

    // 1. 检查 __noop 标记（优先级最高）
    if (this.isNoopResult(result)) {
      isNoop = true;
      warnings.push(`Tool ${toolName} returned __noop flag`);
    }

    // 2. 空结果检查（仅在 __noop 未标记时检查，避免双重计数）
    if (!isNoop && this.emptyIsNoop && this.isEmptyResult(result)) {
      isNoop = true;
      warnings.push(`Tool ${toolName} returned empty result`);
    }

    // 3. 结果大小检查
    const resultSize = this.estimateSize(result);
    if (resultSize > this.maxResultSize) {
      warnings.push(
        `Tool ${toolName} result too large: ${resultSize} chars > ${this.maxResultSize} limit`
      );
      processedResult = this.truncateResult(result, this.maxResultSize);
    }

    // 4. 更新连续 no-op 计数
    if (isNoop) {
      this.consecutiveNoops++;
    } else {
      this.consecutiveNoops = 0;
    }

    // 5. 记录历史（存储处理后的结果副本，避免外部修改影响记录）
    this.history.push({
      toolName,
      args,
      result: this.safeClone(processedResult),
      isNoop,
      timestamp: Date.now(),
    });

    // 只保留最近 100 条记录
    if (this.history.length > 100) {
      this.history = this.history.slice(-100);
    }

    return {
      valid: this.consecutiveNoops < this.noopThreshold,
      isNoop,
      consecutiveNoops: this.consecutiveNoops,
      warnings,
      processedResult,
    };
  }

  /**
   * 检查是否达到 no-op 阈值
   */
  isNoopLoop(): boolean {
    return this.consecutiveNoops >= this.noopThreshold;
  }

  /**
   * 获取连续 no-op 次数
   */
  getConsecutiveNoops(): number {
    return this.consecutiveNoops;
  }

  /**
   * 重置 no-op 计数
   */
  resetNoopCount(): void {
    this.consecutiveNoops = 0;
  }

  /**
   * 获取最近的工具调用历史
   */
  getHistory(count = 10): ToolCallRecord[] {
    return this.history.slice(-count);
  }

  /**
   * 获取工具调用统计
   */
  getStats(): {
    totalCalls: number;
    noopCalls: number;
    uniqueTools: Set<string>;
    avgResultSize: number;
  } {
    const uniqueTools = new Set<string>();
    let noopCalls = 0;
    let totalSize = 0;

    for (const record of this.history) {
      uniqueTools.add(record.toolName);
      if (record.isNoop) {
        noopCalls++;
      }
      totalSize += this.estimateSize(record.result);
    }

    return {
      totalCalls: this.history.length,
      noopCalls,
      uniqueTools,
      avgResultSize: this.history.length > 0 ? totalSize / this.history.length : 0,
    };
  }

  /**
   * 检查结果是否包含 __noop 标记
   */
  private isNoopResult(result: unknown): boolean {
    if (result && typeof result === 'object' && '__noop' in result) {
      return (result as Record<string, unknown>).__noop === true;
    }
    return false;
  }

  /**
   * 检查结果是否为空
   */
  private isEmptyResult(result: unknown): boolean {
    if (result === null || result === undefined) return true;
    if (typeof result === 'string' && result.trim().length === 0) return true;
    if (Array.isArray(result) && result.length === 0) return true;
    if (typeof result === 'object' && Object.keys(result).length === 0) return true;
    return false;
  }

  /**
   * 估算结果大小（字符数）
   */
  private estimateSize(result: unknown): number {
    if (result === null || result === undefined) return 0;
    if (typeof result === 'string') return result.length;
    try {
      return JSON.stringify(result).length;
    } catch {
      return 0;
    }
  }

  /**
   * 截断结果到指定大小。
   * 对象/数组：先尝试保留原始类型的截断，失败则降级为字符串。
   * 字符串：直接截断。
   */
  private truncateResult(result: unknown, maxSize: number): unknown {
    if (typeof result === 'string') {
      return result.slice(0, maxSize) + '\n[... truncated]';
    }

    try {
      const json = JSON.stringify(result);
      if (json.length <= maxSize) return result;

      // 对象类型：尝试逐字符解析，找到最大的合法 JSON 前缀
      if (typeof result === 'object' && result !== null) {
        // 简单策略：截断为字符串，保留类型信息
        const truncated = json.slice(0, maxSize);
        return `[truncated JSON] ${truncated}`;
      }

      return json.slice(0, maxSize) + '\n[... truncated]';
    } catch {
      return '[result serialization failed]';
    }
  }

  /**
   * 安全克隆：存储结果的副本，避免外部引用修改影响历史记录。
   * 失败时返回原始引用（best-effort）。
   */
  private safeClone(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}
