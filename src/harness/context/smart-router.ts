/**
 * SmartRouter — 智能路由器
 *
 * 参考 OpenClaw 的 shouldPreemptivelyCompactBeforePrompt 策略。
 *
 * 四种路由：
 * 1. fits — 消息在预算内，不需要压缩
 * 2. truncate_tool_results_only — 只截断工具输出
 * 3. compact_only — 只做 LLM 摘要
 * 4. compact_then_truncate — 先 LLM 摘要，再截断
 *
 * 路由决策基于：
 * - 溢出 token 数（含 1.2x 安全余量）
 * - 工具结果可压缩空间（用 TOOL_RESULT_CHARS_PER_TOKEN=2 估算）
 * - 摘要函数是否可用
 */

import type { Message } from '../../core/types.js';
import type { TokenEstimator } from '../../core/interfaces/context-engine.js';
import { HeuristicTokenEstimator } from './token-estimator.js';
import { SAFETY_MARGIN, TOOL_RESULT_CHARS_PER_TOKEN } from './token-constants.js';

// ── 路由类型 ──

export type Route =
  | 'fits'
  | 'truncate_tool_results_only'
  | 'compact_only'
  | 'compact_then_truncate';

// ── 路由决策结果 ──

export interface RoutingDecision {
  /** 路由类型 */
  route: Route;
  /** 是否需要压缩 */
  shouldCompact: boolean;
  /** 溢出 token 数 */
  overflowTokens: number;
  /** 工具结果可压缩字符数 */
  toolResultReducibleChars: number;
  /** 工具结果截断阈值 */
  truncateOnlyThresholdChars: number;
  /** 估算的总 token 数 */
  estimatedTokens: number;
  /** 消息 token 预算 */
  messagesBudget: number;
}

// ── 路由配置 ──

export interface SmartRouterConfig {
  /** Token 估算器 */
  tokenEstimator?: TokenEstimator;
  /**
   * 截断工具结果阈值（字符数）
   *
   * 当工具结果可压缩空间 >= 此阈值时，只截断工具结果就够了。
   * 默认：2000 字符
   */
  truncateOnlyThresholdChars?: number;
  /**
   * 工具结果最大长度阈值（字符数）
   *
   * 超过此长度的工具结果被认为是可压缩的。
   * 默认：200 字符
   */
  toolResultMaxLength?: number;
}

// ── 路由器实现 ──

export class SmartRouter {
  private estimator: TokenEstimator;
  private truncateOnlyThresholdChars: number;
  private toolResultMaxLength: number;

  constructor(config?: SmartRouterConfig) {
    this.estimator = config?.tokenEstimator ?? new HeuristicTokenEstimator();
    this.truncateOnlyThresholdChars = config?.truncateOnlyThresholdChars ?? 2000;
    this.toolResultMaxLength = config?.toolResultMaxLength ?? 200;
  }

  /**
   * 决定路由
   *
   * @param messages - 消息历史
   * @param messagesBudget - 消息 token 预算
   * @param hasSummarize - 是否有摘要函数可用
   * @returns 路由决策
   */
  evaluate(
    messages: Message[],
    messagesBudget: number,
    hasSummarize: boolean,
  ): RoutingDecision {
    // 估算当前 token 数（含安全余量）
    const rawEstimatedTokens = this.estimator.estimateMessages(messages);
    const estimatedTokens = Math.ceil(rawEstimatedTokens * SAFETY_MARGIN);

    // 计算溢出
    const overflowTokens = Math.max(0, estimatedTokens - messagesBudget);

    // 如果没有溢出，fits
    if (overflowTokens <= 0) {
      return {
        route: 'fits',
        shouldCompact: false,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        truncateOnlyThresholdChars: this.truncateOnlyThresholdChars,
        estimatedTokens,
        messagesBudget,
      };
    }

    // 计算工具结果可压缩空间（用正确的 TOOL_RESULT_CHARS_PER_TOKEN 比率）
    const toolResultReducibleChars = this.calculateToolResultReducibleChars(messages);

    // 决定路由
    let route: Route;

    if (!hasSummarize) {
      // 没有摘要函数：只能截断
      if (toolResultReducibleChars > 0) {
        route = 'truncate_tool_results_only';
      } else {
        route = 'compact_only'; // 会回退到截断
      }
    } else {
      // 有摘要函数：智能路由
      if (toolResultReducibleChars <= 0) {
        // 没有可压缩的工具结果
        route = 'compact_only';
      } else if (toolResultReducibleChars >= this.truncateOnlyThresholdChars) {
        // 工具结果可压缩空间足够大，只截断就够了
        route = 'truncate_tool_results_only';
      } else {
        // 工具结果可压缩空间不够，需要先摘要再截断
        route = 'compact_then_truncate';
      }
    }

    return {
      route,
      shouldCompact: true,
      overflowTokens,
      toolResultReducibleChars,
      truncateOnlyThresholdChars: this.truncateOnlyThresholdChars,
      estimatedTokens,
      messagesBudget,
    };
  }

  /**
   * 计算工具结果可压缩字符数
   *
   * 扫描所有工具结果消息，计算超过阈值的字符数。
   * 注意：这里用原始字符数（非 CJK 加权），因为截断操作是按字符进行的。
   */
  private calculateToolResultReducibleChars(messages: Message[]): number {
    let reducibleChars = 0;

    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolResults) {
        for (const tr of msg.toolResults) {
          const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
          if (resultStr.length > this.toolResultMaxLength) {
            reducibleChars += resultStr.length - this.toolResultMaxLength;
          }
        }
      }
    }

    return reducibleChars;
  }
}
