/**
 * DefaultBudgetAllocator — 默认预算分配器
 *
 * 负责分配 token 预算给各个组件：
 * - 系统提示词
 * - 工具定义
 * - 消息历史
 * - 模型输出预留
 *
 * 分配策略：
 * 1. 计算固定开销（system prompt + tools）
 * 2. 预留输出空间（默认 20% 的 context window，上下限 2000-8000）
 * 3. 剩余空间分配给消息历史
 */

import type {
  BudgetAllocator,
  BudgetAllocateParams,
  BudgetAllocateResult,
} from '../../core/interfaces/context-engine.js';

/**
 * 默认输出预留比例
 */
const DEFAULT_OUTPUT_RATIO = 0.20;

/**
 * 输出预留最小值
 */
const MIN_OUTPUT_RESERVE = 2000;

/**
 * 输出预留最大值
 */
const MAX_OUTPUT_RESERVE = 8000;

/**
 * 系统开销预留（用于消息结构、分隔符等）
 */
const SYSTEM_OVERHEAD = 500;

export class DefaultBudgetAllocator implements BudgetAllocator {
  private outputRatio: number;
  private minOutputReserve: number;
  private maxOutputReserve: number;
  private systemOverhead: number;

  constructor(options?: {
    outputRatio?: number;
    minOutputReserve?: number;
    maxOutputReserve?: number;
    systemOverhead?: number;
  }) {
    this.outputRatio = options?.outputRatio ?? DEFAULT_OUTPUT_RATIO;
    this.minOutputReserve = options?.minOutputReserve ?? MIN_OUTPUT_RESERVE;
    this.maxOutputReserve = options?.maxOutputReserve ?? MAX_OUTPUT_RESERVE;
    this.systemOverhead = options?.systemOverhead ?? SYSTEM_OVERHEAD;
  }

  /**
   * 分配 token 预算
   *
   * @param params - 分配参数
   * @returns 分配结果
   */
  allocate(params: BudgetAllocateParams): BudgetAllocateResult {
    const { tokenBudget, contextWindow, systemPromptTokens, toolTokens } = params;

    // 确定有效上限：取 tokenBudget 和 contextWindow 的较小值
    const effectiveLimit = contextWindow
      ? Math.min(tokenBudget, contextWindow)
      : tokenBudget;

    // 计算固定开销
    const fixedOverhead = systemPromptTokens + toolTokens + this.systemOverhead;

    // 计算输出预留
    const outputReserve = this.calculateOutputReserve(effectiveLimit);

    // 计算消息可用预算
    const messagesBudget = effectiveLimit - fixedOverhead - outputReserve;

    // 确保消息预算至少为 1000 token
    const safeMessagesBudget = Math.max(1000, messagesBudget);

    return {
      messagesBudget: safeMessagesBudget,
      outputReserve,
    };
  }

  /**
   * 计算输出预留
   *
   * 公式：effectiveLimit × outputRatio
   * 上下限：minOutputReserve - maxOutputReserve
   */
  private calculateOutputReserve(effectiveLimit: number): number {
    const reserve = Math.floor(effectiveLimit * this.outputRatio);
    return Math.max(this.minOutputReserve, Math.min(this.maxOutputReserve, reserve));
  }
}
