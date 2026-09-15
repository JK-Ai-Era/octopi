/**
 * ReliabilityHarness — 可靠性装备接口
 *
 * 定义可靠性包装所需的外部依赖。
 * 消费方：`harness/agent` 的 `Agent.run()`（底层实现 `runAgentWithReliability`）。
 * 实现在 harness/reliability/，由 builder 组装注入。
 *
 * 提取到 Core 层（v0.8.0）：这是跨域契约，不是实现细节。
 * 多个领域（run-guard、multi-agent）依赖此接口。
 */

import type { SecurityGuard } from './security-guard.js';
import type { ErrorStrategy } from './error-strategy.js';
import type { RunGuard } from './run-guard.js';

/**
 * ResourceBudget 最小契约（Core）
 *
 * 实现在 harness/budget/（非领域模块）。reliability 每轮消费。
 * 注意：harness 上的实例是「模板/配置源」；每次 run 应克隆或 reset，
 * 避免长驻进程 / 并发 session 共享计数。
 */
export interface ResourceBudgetLike {
  /** 累计 token */
  consumeTokens(tokens: number): void;
  /** 记录一次迭代 */
  recordIteration(): void;
  /** 记录工具调用 */
  recordToolCall(n?: number): void;
  /**
   * 评估预算
   * @param hasProgress - 是否有实质进展（soft 续租用）
   */
  evaluate(hasProgress?: boolean): {
    status: 'ok' | 'soft' | 'hard';
    reason?: 'tokens' | 'wall_clock' | 'iteration' | 'tool_calls';
    report: unknown;
  };
  /** 仅检查 hard（不触发 soft 续租） */
  checkHardOnly(): {
    status: 'ok' | 'hard';
    reason?: 'tokens' | 'wall_clock' | 'iteration' | 'tool_calls';
    report: unknown;
  };
  /** 重置本轮计数（长驻场景；优先用 per-run 克隆代替共享 reset） */
  reset(): void;
  /** 读取配置，供 per-run 克隆 */
  getConfig(): object;
}

/** 可靠性装备 — Agent.run() / runAgentWithReliability() 的外部依赖 */
export interface ReliabilityHarness {
  /** 可靠性配置（类型由实现方定义，这里用 unknown 保持接口独立） */
  config: unknown;
  /** 安全守卫（可选） */
  security?: SecurityGuard;
  /** 错误策略（可选） */
  errorStrategy?: ErrorStrategy;
  /** 过程监督（可选） */
  runGuard?: RunGuard;
  /** 资源预算（可选）— token/time soft-hard；与 Guard 组合 */
  budget?: ResourceBudgetLike;
  /** 当前 agentId（用于检查点） */
  agentId?: string;
  /** 当前 sessionId（用于检查点） */
  sessionId?: string;
}
