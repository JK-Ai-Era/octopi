/**
 * Human-in-the-Loop 领域 — 人机交互
 *
 * 职责：审批请求管理、审批策略、用户决策缓存。
 * 契约见 ./types.ts。
 */

export { ApprovalManager, createApprovalPolicy } from './approval-manager.js';
export type { ApprovalManagerConfig } from './approval-manager.js';
export type {
  ApprovalLevel, ApprovalRequest, ApprovalDecision, ApprovalProvider, ApprovalPolicy,
} from './types.js';