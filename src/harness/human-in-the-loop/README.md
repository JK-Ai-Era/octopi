# Human-in-the-Loop — 人机交互

> Layer: Layer 2

审批请求管理、审批策略、用户决策缓存。

**核心理念**：安全层的风险评估结果触发审批流程，用户决策可以被缓存避免重复询问。

## 职责

- ApprovalManager — 审批请求生命周期管理
- ApprovalPolicy — 审批策略（auto / confirm-all / confirm-high-risk）
- DecisionCache — 用户决策缓存（session 级 / 永久）

## 不做什么

- 不做风险评估（那是 security 的事）
- 不做 UI 展示（那是 TUI/Gateway 的事，它们实现 ApprovalProvider 接口）

## 依赖

- Core: interfaces/human-in-the-loop、types/messages

## 文件说明

- approval-manager.ts — ApprovalManager + createApprovalPolicy()
- index.ts — 统一导出
