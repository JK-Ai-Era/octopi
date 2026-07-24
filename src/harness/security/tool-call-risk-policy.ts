/**
 * ToolCallRiskPolicy — 注入到 Core SecurityGuard 的风险策略接口
 *
 * 这是 Core 和 Harness 之间的桥梁：
 * - Core 定义接口（Core 不知道 Harness 的存在）
 * - Harness 实现接口
 * - Builder 在组装时注入
 */

import type { ToolCall } from '../../core/types.js';
import type { RiskDecision } from './risk-types.js';

/**
 * ToolCallRiskPolicy 接口
 *
 * Core 层定义。SecurityGuard 在 checkToolCall 时调用。
 */
export interface ToolCallRiskPolicy {
  /**
   * 评估工具调用的风险
   *
   * @param call - 工具调用
   * @param context - 上下文信息（可选）
   * @returns 风险决策
   */
  assess(
    call: ToolCall,
    context?: {
      cwd?: string;
      recentToolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    },
  ): RiskDecision;
}
