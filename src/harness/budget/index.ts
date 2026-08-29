/**
 * Budget 模块 — IterationBudget 资源约束
 *
 * 从 core/budget.ts 迁移到 harness/budget/（v0.8.0）。
 * IterationBudget 是策略实现，不是核心机制。
 */
export { IterationBudget, DEFAULT_BUDGET } from './budget.js';
export type { IterationBudgetConfig, BudgetStatus, BudgetReport } from './budget.js';
