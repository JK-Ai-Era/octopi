# Human-in-the-Loop — 人机交互

> Layer: Layer 2 · SEC-7 单模型

确认决策缓存与统一 resolve。**不做**独立审批管理器。

## 核心理念

宿主只通过 `confirmHighRisk` / `confirmEffect` 两条钩子**表达** `HitlDecision`；
引擎用 `HitlDecisionCache` 记住 `approve_session` / `approve_always`，避免重复弹窗。
`deny` 与一次 `approve` 不缓存。无人值守 / 无钩子 / 异常一律 fail-closed。

## 职责

- `HitlDecisionCache` — session / always 决策缓存
- `resolveHitlDecision` — 查缓存 → 调钩子 → 记账 → 布尔结果

## 不做什么？

- 不做风险评估（那是 security 的事）
- 不做 UI 展示（那是 Gateway / WebUI 的事，走 `pendingApprovals`）
- 不保留 `ApprovalManager` / `ApprovalProvider` / `ApprovalLevel`（SEC-7 已删除）

## 文件说明

- `types.ts` — `HitlDecision` 等契约再导出
- `decision-cache.ts` — 缓存 + `resolveHitlDecision`
- `index.ts` — 统一导出
