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
  | 'prompt_leak';

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

/** 安全策略配置 */
export interface SecurityGuardConfig {
  injectionSensitivity?: 'low' | 'medium' | 'high';
  sensitivePatterns?: RegExp[];
  checkInput?: boolean;
  checkOutput?: boolean;
  checkToolOutput?: boolean;
  allowedPaths?: string[];
  allowShellMeta?: boolean;
  maxConsecutiveSameTool?: number;
  maxConsecutiveErrors?: number;
  systemPrompt?: string;
}

// ── 接口定义 ──

/** SecurityGuard 接口（供 Core 层使用） */
export interface SecurityGuard {
  checkUserInput(input: string): SecurityCheckResult;
  checkToolOutput(output: string): SecurityCheckResult;
  checkModelOutput(output: string): SecurityCheckResult;
  checkToolCall(call: ToolCall): SecurityCheckResult;
  checkBehavior(ctx: BehaviorContext): SecurityCheckResult;
  setRegisteredTools?(tools: Set<string>): void;
  setSystemPrompt?(prompt: string): void;
  setToolCallRiskPolicy?(policy: ToolCallRiskPolicy): void;
}
