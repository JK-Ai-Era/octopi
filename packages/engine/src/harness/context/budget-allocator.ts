/**
 * DefaultBudgetAllocator — 不变量驱动的预算分配
 *
 * 唯一硬不变量（provider 侧事实）：
 *
 *     input_tokens + max_tokens ≤ contextWindow
 *
 * 因此分配顺序是「先扣输出，再扣固定开销，剩下的才是消息」：
 *
 *     outputReserve = maxOutputTokens（模型能力上限；未知时比例回退）
 *     inputLimit    = effectiveLimit − outputReserve      ← 硬
 *     messagesLimit = inputLimit − system − tools − 信封  ← 硬（强制点用它）
 *     messagesBudget= messagesLimit                       ← 软（压缩策略提示）
 *
 * 历史实现的缺陷（本次修正）：`outputReserve = clamp(window × 20%, 2k, 8k)`
 * 与请求真实的 `max_tokens` 完全脱节——mimo-v2.6-pro（窗口 1,048,576 /
 * maxTokens 131,072）会算出 1,040,076 的输入上限，加上 131,072 输出共
 * 1,171,148，超出窗口 122,572，且无任何环节察觉。
 */

import type {
  BudgetAllocator,
  BudgetAllocateParams,
  BudgetAllocateResult,
} from './types.js';

/**
 * 输出预留回退比例（仅在 maxOutputTokens 未知时使用）
 */
const DEFAULT_OUTPUT_RATIO = 0.20;

/**
 * 输出预留回退下限（仅回退路径）
 */
const MIN_OUTPUT_RESERVE = 2000;

/**
 * 输出预留回退上限（仅回退路径）
 */
const MAX_OUTPUT_RESERVE = 8000;

/**
 * 请求信封预留（tool_choice / metadata / 网关包装等）。
 * 与按条开销不重复：后者由 TokenEstimator 的 MESSAGE_OVERHEAD_TOKENS 计入。
 */
const REQUEST_ENVELOPE_TOKENS = 500;

export class DefaultBudgetAllocator implements BudgetAllocator {
  private outputRatio: number;
  private minOutputReserve: number;
  private maxOutputReserve: number;
  private requestEnvelopeTokens: number;

  constructor(options?: {
    outputRatio?: number;
    minOutputReserve?: number;
    maxOutputReserve?: number;
    requestEnvelopeTokens?: number;
  }) {
    this.outputRatio = options?.outputRatio ?? DEFAULT_OUTPUT_RATIO;
    this.minOutputReserve = options?.minOutputReserve ?? MIN_OUTPUT_RESERVE;
    this.maxOutputReserve = options?.maxOutputReserve ?? MAX_OUTPUT_RESERVE;
    this.requestEnvelopeTokens = options?.requestEnvelopeTokens ?? REQUEST_ENVELOPE_TOKENS;
  }

  /**
   * 分配 token 预算
   *
   * @param params - 分配参数（窗口、模型输出上限、固定开销）
   * @returns 硬上限（inputLimit / messagesLimit）、软目标（messagesBudget）与输出预留
   */
  allocate(params: BudgetAllocateParams): BudgetAllocateResult {
    const { tokenBudget, contextWindow, maxOutputTokens, systemPromptTokens, toolTokens } = params;

    // 窗口/预算均未知：无物理边界可守（仅 target 路径会到这里）
    if (tokenBudget == null && contextWindow == null) {
      const unbounded = Number.MAX_SAFE_INTEGER;
      return {
        inputLimit: unbounded,
        messagesLimit: unbounded,
        messagesBudget: unbounded,
        outputReserve: 0,
      };
    }

    const effectiveLimit = contextWindow
      ? Math.min(tokenBudget ?? contextWindow, contextWindow)
      : (tokenBudget as number);

    const fixedOverhead = systemPromptTokens + toolTokens + this.requestEnvelopeTokens;
    const physical = contextWindow != null && contextWindow > 0;
    const outputReserve = this.resolveOutputReserve(
      effectiveLimit,
      // 只有物理窗口存在时，输出预留才是硬不变量的一部分；
      // 仅有 compactTargetTokens 这类策略目标时按比例回退，避免把目标当窗口。
      physical ? maxOutputTokens : undefined,
    );
    const inputLimit = Math.max(0, effectiveLimit - outputReserve);
    const rawMessagesLimit = inputLimit - fixedOverhead;

    if (!physical) {
      // 策略目标模式（无物理窗口）：不存在「物理边界」，目标过小只是策略设定不佳，
      // 保底继续而不是报不可行——否则会把一个配置问题升级成运行失败。
      return {
        inputLimit,
        messagesLimit: Math.max(1000, rawMessagesLimit),
        messagesBudget: Math.max(1000, rawMessagesLimit),
        outputReserve,
      };
    }

    const messagesLimit = Math.max(0, rawMessagesLimit);
    return {
      inputLimit,
      messagesLimit,
      // 软目标当前等于硬上限：策略若需提前压缩，应调低这里而非挪动强制点
      messagesBudget: messagesLimit,
      outputReserve,
      ...(messagesLimit > 0 ? {} : { infeasible: true }),
    };
  }

  /**
   * 解析输出预留
   *
   * 有模型输出上限时按**硬预留**（不变量要求，不得打折）；缺失时按窗口比例回退。
   *
   * @param effectiveLimit - 实际可用上限
   * @param maxOutputTokens - 模型单次输出上限（可选）
   * @returns 输出预留 token 数
   */
  private resolveOutputReserve(effectiveLimit: number, maxOutputTokens?: number): number {
    if (maxOutputTokens != null && maxOutputTokens > 0) {
      // 上限夹到 effectiveLimit − 1：任何情况下给输入留出至少 1 token，
      // 让 inputLimit 不为负（真正的不可行由 messagesLimit ≤ 0 上报）
      return Math.min(maxOutputTokens, Math.max(0, effectiveLimit - 1));
    }
    const reserve = Math.floor(effectiveLimit * this.outputRatio);
    return Math.max(this.minOutputReserve, Math.min(this.maxOutputReserve, reserve));
  }
}
