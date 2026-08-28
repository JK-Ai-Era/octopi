/**
 * ErrorStrategy — 错误处理策略接口
 *
 * 职责：决定 Agent 循环中遇到错误时的行为。
 * Harness 层实现具体策略，通过 Builder 注入。
 *
 * 与 Core 循环层的关系（两层包装）：
 * - Core 循环 (agentLoop) 使用 OnErrorFn 回调（loop/types.ts）
 *   OnErrorFn 签名：(error: ClassifiedError) => Promise<'retry' | 'abort' | 'throw'>
 * - Harness 层的 ErrorStrategy 被包装为 OnErrorFn 注入到循环中
 *   包装逻辑在 harness/reliability/run-agent.ts：
 *     onModelError() → retry/abort/fallback/skip 映射为 OnErrorFn 的 retry/abort/throw
 * - ErrorStrategy 提供更丰富的决策（retry/fallback/skip/abort），
 *   OnErrorFn 简化为 retry/abort/throw
 *
 * 实现方：
 * - DefaultErrorStrategy（harness/builder.ts 内置，简单规则匹配）
 * - 用户自定义（通过 AgentBuilder.errorStrategy() 注入）
 */

import type { ToolCall } from '../types.js';

// ── 错误分类（规范定义在此处，loop/types.ts re-export） ──

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
  message: string;
  originalError: unknown;
  retryAfterMs?: number;
}

// ── 安全动作（规范定义在 security-guard.ts） ──

import type { SecurityAction, SecurityViolation } from './security-guard.js';

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
