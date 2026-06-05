/**
 * ErrorStrategy — 错误处理策略接口
 *
 * 职责：决定 Agent 循环中遇到错误时的行为。
 * Core 层在错误发生时调用此接口，由 Harness 层实现具体策略。
 *
 * 设计要点：
 * - 每种错误类型有独立的处理方法
 * - 返回值是 discriminated union，Core 据此执行动作
 * - Harness 层可以实现复杂的重试/fallback/降级逻辑
 */

import type { ToolCall } from '../types.js';

// ── 错误分类 ──

/** 错误原因 */
export type ErrorReason =
  | 'rate_limit'
  | 'context_length'
  | 'auth'
  | 'billing'
  | 'network'
  | 'timeout'
  | 'server'
  | 'unknown';

/** 分类后的错误 */
export interface ClassifiedError {
  reason: ErrorReason;
  provider?: string;
  model?: string;
  statusCode?: number;
  retryAfterMs?: number;
  message: string;
  originalError: unknown;
}

// ── 动作类型 ──

/** 错误处理动作 */
export type ErrorAction =
  | { action: 'retry'; delayMs: number }
  | { action: 'fallback'; provider: string; model: string }
  | { action: 'skip'; reason: string }
  | { action: 'abort'; reason: string };

/** 上下文溢出动作 */
export type OverflowAction =
  | { action: 'compact' }
  | { action: 'truncate'; keepRecent: number }
  | { action: 'abort' };

/** 安全违规动作 */
export type SecurityAction =
  | { action: 'block'; reason: string }
  | { action: 'warn'; reason: string }
  | { action: 'sanitize'; replacement: string };

// ── 接口定义 ──

/**
 * ErrorStrategy 接口
 */
export interface ErrorStrategy {
  /**
   * 模型调用失败
   * @param error - 分类后的错误
   * @param attempt - 当前重试次数（从 0 开始）
   */
  onModelError(error: ClassifiedError, attempt: number): ErrorAction;

  /**
   * 工具执行失败
   * @param error - 分类后的错误
   * @param call - 失败的工具调用
   */
  onToolError(error: ClassifiedError, call: ToolCall): ErrorAction;

  /**
   * 上下文溢出（token 超限）
   * @param tokenCount - 当前 token 数
   * @param limit - token 上限
   */
  onContextOverflow(tokenCount: number, limit: number): OverflowAction;

  /**
   * 安全违规
   * @param violation - 违规详情
   */
  onSecurityViolation(violation: SecurityViolation): SecurityAction;
}

/** 安全违规详情 */
export interface SecurityViolation {
  type: 'injection' | 'sensitive_data' | 'policy_violation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  source: 'user_input' | 'tool_output' | 'model_output';
  range?: { start: number; end: number };
}
