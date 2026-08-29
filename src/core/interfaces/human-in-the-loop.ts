/**
 * Human-in-the-Loop 接口定义
 *
 * @layer core — 定义人机交互的契约，由 harness/human-in-the-loop/ 实现。
 */

import type { ToolCall } from '../types/messages.js';

// ── 审批请求 ──

/** 审批级别 */
export type ApprovalLevel = 'auto' | 'confirm_high_risk' | 'confirm_all';

/** 审批请求 */
export interface ApprovalRequest {
  /** 请求 ID */
  id: string;
  /** 触发的工具调用 */
  toolCall: ToolCall;
  /** 风险评估结果 */
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  /** 风险描述 */
  riskDescription: string;
  /** 操作描述（人类可读） */
  actionDescription: string;
  /** 创建时间 */
  createdAt: number;
  /** 超时时间（毫秒） */
  timeoutMs: number;
}

/** 审批决策 */
export interface ApprovalDecision {
  /** 决策类型 */
  decision: 'approve' | 'deny' | 'approve_always' | 'approve_session';
  /** 决策理由 */
  reason?: string;
  /** 决策时间 */
  decidedAt: number;
}

// ── 审批提供者接口 ──

/**
 * ApprovalProvider — 审批提供者接口
 *
 * 由 TUI/Gateway 实现，负责向用户展示审批请求并收集决策。
 * harness 层的 ApprovalManager 调用此接口。
 */
export interface ApprovalProvider {
  /**
   * 请求用户审批
   *
   * @returns 审批决策（如果超时，返回 deny）
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;

  /**
   * 检查是否支持交互式审批
   * （非交互环境如 CI/CD 中，返回 false）
   */
  isInteractive(): boolean;
}

// ── 审批策略接口 ──

/**
 * ApprovalPolicy — 审批策略接口
 *
 * 决定某个工具调用是否需要审批。
 */
export interface ApprovalPolicy {
  /**
   * 判断是否需要审批
   *
   * @returns true 表示需要审批，false 表示自动放行
   */
  requiresApproval(toolCall: ToolCall, riskLevel: string): boolean;
}
