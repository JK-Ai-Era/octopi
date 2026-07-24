/**
 * DefaultToolCallRiskPolicy — ToolCallRiskPolicy 的默认实现
 *
 * 包装 Shell 解析器 + 风险评估引擎 + 降级策略，
 * 实现 Core 层定义的 ToolCallRiskPolicy 接口。
 *
 * 通过 Builder 注入到 Core 的 SecurityGuard。
 */

import type { ToolCall } from '../../core/types.js';
import type { ToolCallRiskPolicy } from '../../core/security-guard.js';
import { evaluateRisk } from './risk-evaluator.js';
import { suggestDegradation } from './degradation.js';
import type { RiskDecision } from './risk-types.js';

/**
 * DefaultToolCallRiskPolicy 配置
 */
export interface DefaultToolCallRiskPolicyConfig {
  /** 工作目录（用于路径风险分类） */
  cwd?: string;
  /**
   * 风险阈值：level >= threshold 时返回对应等级
   * 默认全部返回（不做阈值过滤）
   */
  threshold?: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * DefaultToolCallRiskPolicy
 *
 * 实现 Core 的 ToolCallRiskPolicy 接口。
 * 内部调用 risk-evaluator 做风险评估，degradation 做降级建议。
 */
export class DefaultToolCallRiskPolicy implements ToolCallRiskPolicy {
  private cwd?: string;

  constructor(config?: DefaultToolCallRiskPolicyConfig) {
    this.cwd = config?.cwd;
  }

  /**
   * 设置工作目录（运行时更新）
   */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /**
   * 评估工具调用的风险
   *
   * 返回值直接映射到 Core SecurityGuard 的决策流程：
   * - low → 放行
   * - medium → 记录 + 放行
   * - high → SecurityGuard 根据 violations 决定 reject/warn
   * - critical → SecurityGuard block
   * - unknown → SecurityGuard 放行 + emit 事件 → 分布式安全智能体
   */
  assess(
    call: ToolCall,
    context?: {
      cwd?: string;
      recentToolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    },
  ): {
    level: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
    factors: Array<{ source: string; description: string; level: string }>;
    alternative?: { description: string; command?: string; steps?: string[] };
    reason: string;
  } {
    const cwd = context?.cwd ?? this.cwd;

    // 1. 风险评估
    const decision: RiskDecision = evaluateRisk(call, {
      cwd,
      recentToolCalls: context?.recentToolCalls,
    });

    // 2. 如果有风险，尝试生成降级建议
    let alternative = decision.alternative;
    if (decision.level !== 'low' && decision.level !== 'unknown' && !alternative) {
      // 尝试从 shell 命令中提取降级建议
      const command = getCommandString(call);
      if (command) {
        alternative = suggestDegradation(command) ?? undefined;
      }
    }

    return {
      level: decision.level,
      factors: decision.factors.map(f => ({
        source: f.source,
        description: f.description,
        level: f.level,
      })),
      alternative,
      reason: decision.reason,
    };
  }
}

// ── 辅助函数 ──

function getCommandString(call: ToolCall): string | null {
  if (typeof call.arguments?.command === 'string') return call.arguments.command;
  if (typeof call.arguments?.cmd === 'string') return call.arguments.cmd;
  if (typeof call.arguments?.script === 'string') return call.arguments.script;
  return null;
}
