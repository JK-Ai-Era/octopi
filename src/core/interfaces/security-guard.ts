/**
 * SecurityGuard — 安全守卫接口
 *
 * 职责：在 Agent 循环的关键节点执行安全检查。
 * Core 层定义接口，Harness 层提供默认实现（DefaultSecurityGuard）。
 */

import type { ToolCall } from '../types.js';

// ── 类型定义 ──

/** 安全违规类型 */
export type SecurityViolationType =
  | 'injection'
  | 'sensitive_data'
  | 'policy_violation'
  | 'command_injection'
  | 'path_traversal'
  | 'unauthorized_tool'
  | 'behavior_anomaly'
  | 'prompt_leak'
  /** 确定灾难性破坏（递归删根/系统保护路径等） */
  | 'destructive_operation';

/** 安全违规 */
export interface SecurityViolation {
  type: SecurityViolationType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  range?: { start: number; end: number };
}

/** 安全检查结果 */
export interface SecurityCheckResult {
  isClean: boolean;
  violations: SecurityViolation[];
  sanitized?: string;
  /** 风险策略返回 unknown，需要安全智能体进一步判断 */
  riskUnknown?: boolean;
}

/** 安全动作 */
export type SecurityAction =
  | { action: 'block'; reason: string }
  | { action: 'reject'; reason: string }
  | { action: 'warn'; reason: string }
  | { action: 'sanitize'; replacement: string };

/** 行为上下文（供 BehaviorGuard 使用） */
export interface BehaviorContext {
  consecutiveErrors: number;
  consecutiveSameTool: number;
  lastToolName?: string;
  recentToolCalls: Array<{ name: string; success: boolean }>;
  uniqueTools: number;
}

/**
 * ToolCallRiskPolicy — 工具调用风险策略接口
 *
 * Core 层定义的接口，由 Harness 层实现，通过 Builder 注入。
 */
export interface ToolCallRiskPolicy {
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
  };
}

/**
 * 安全策略配置
 *
 * 边界约定（安全不可绕过）：
 * - **硬边界**（未注册工具 / 路径遍历 / allowedPaths 越界 / 下载执行·IEX·反弹 shell·清盘 / 递归删根·保护路径·file_delete）永远执行，不受 `enforce` 影响
 * - **风险评估**（ToolCallRiskPolicy）永远接线；有争议、不确定的操作由策略分档，不在硬边界拦
 * - 可配置的只有**处置**（`enforce`）、**范围**（`allowedPaths`）与**灵敏度**，没有总开关
 */
export interface SecurityGuardConfig {
  /**
   * 风险命中后的处置模式（硬边界除外）
   * - `block`（默认）：按 severity 拦截
   * - `audit`：只记事件，不拦
   */
  enforce?: 'block' | 'audit';
  /** prompt injection / 敏感信息灵敏度 */
  injectionSensitivity?: 'low' | 'medium' | 'high';
  sensitivePatterns?: RegExp[];
  /** 绝对路径额外允许范围；空 = 不额外限制 */
  allowedPaths?: string[];
  systemPrompt?: string;
}

// ── 接口定义 ──

/**
 * SecurityGuard 接口（供 Core 层使用）
 *
 * 边界：恶意 / 敏感 / 策略违规。
 * 「跑飞」（连续同工具、错误循环、无进展）归 RunGuard，不在 Security 重复裁决。
 */
export interface SecurityGuard {
  checkUserInput(input: string): SecurityCheckResult;
  checkToolOutput(output: string): SecurityCheckResult;
  checkModelOutput(output: string): SecurityCheckResult;
  checkToolCall(call: ToolCall): SecurityCheckResult;
  /**
   * 行为异常检查。
   * 主路径不调用；仅保留高危工具组合等攻击形态。
   * loop/error 类规则已上收 RunGuard。
   */
  checkBehavior(ctx: BehaviorContext): SecurityCheckResult;
  setRegisteredTools?(tools: Set<string>): void;
  setSystemPrompt?(prompt: string): void;
  setToolCallRiskPolicy?(policy: ToolCallRiskPolicy): void;
}
