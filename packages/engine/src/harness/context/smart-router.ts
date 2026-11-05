/**
 * SmartRouter — 智能路由器
 *
 * 预判性压缩策略：构建 prompt 前判断是否主动压缩。
 *
 * Q2 B′（2026-11-03 拍板「弃路由、留打码」）后收敛为两种路由：
 * 1. fits — 消息在预算内，不需要压缩
 * 2. compact — 需要压缩：走 compact 能力（有 summarize 出真摘要；无 summarize /
 *    摘要失败走机械降级阶梯「打码 → 账本截断」）
 *
 * 已退休（随 B′）：`truncate_tool_results_only` 路由与其两个魔数阈值
 * （truncateOnlyThresholdChars=2000 / toolResultMaxLength=200）——「机械够用不花 LLM」
 * 正是 v0.83 requireSummary 反对的模式，工具胖溢出应出真摘要；打码保留为机械降级
 * 阶梯第一级（见 capabilities/compact/mechanical.ts）。原 `compact_only` /
 * `compact_then_truncate` 自 v0.83 起就是同一处理分支，判据删除后无区分基础，一并退休。
 */

import type { Message } from '@octopi-agent/core/types.js';
import type { TokenEstimator } from './types.js';
import { HeuristicTokenEstimator } from './token-estimator.js';
import { SAFETY_MARGIN } from './token-constants.js';

// ── 路由类型 ──

export type Route = 'fits' | 'compact';

// ── 路由决策结果 ──

export interface RoutingDecision {
  /** 路由类型 */
  route: Route;
  /** 是否需要压缩 */
  shouldCompact: boolean;
  /** 溢出 token 数 */
  overflowTokens: number;
  /** 估算的总 token 数 */
  estimatedTokens: number;
  /** 消息 token 预算 */
  messagesBudget: number;
}

// ── 路由配置 ──

export interface SmartRouterConfig {
  /** Token 估算器 */
  tokenEstimator?: TokenEstimator;
}

// ── 路由器实现 ──

export class SmartRouter {
  private estimator: TokenEstimator;

  constructor(config?: SmartRouterConfig) {
    this.estimator = config?.tokenEstimator ?? new HeuristicTokenEstimator();
  }

  /**
   * 决定路由
   *
   * @param messages - 消息历史
   * @param messagesBudget - 消息 token 预算
   * @param estimator - 读数估算器（调用方注入校准读数，R1；缺省用构造时的原始估算器）
   * @returns 路由决策
   */
  evaluate(messages: Message[], messagesBudget: number, estimator?: TokenEstimator): RoutingDecision {
    // 估算当前 token 数（含安全余量）
    const rawEstimatedTokens = (estimator ?? this.estimator).estimateMessages(messages);
    const estimatedTokens = Math.ceil(rawEstimatedTokens * SAFETY_MARGIN);

    // 计算溢出
    const overflowTokens = Math.max(0, estimatedTokens - messagesBudget);

    return {
      route: overflowTokens > 0 ? 'compact' : 'fits',
      shouldCompact: overflowTokens > 0,
      overflowTokens,
      estimatedTokens,
      messagesBudget,
    };
  }
}
