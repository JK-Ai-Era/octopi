/**
 * Human-in-the-Loop 领域 — 人机交互
 *
 * 职责：审批请求管理、审批策略、用户决策缓存。
 *
 * 依赖：
 * - Core: interfaces/human-in-the-loop, types/messages
 */

export { ApprovalManager, createApprovalPolicy } from './approval-manager.js';
export type { ApprovalManagerConfig } from './approval-manager.js';
