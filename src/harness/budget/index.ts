/**
 * Budget 模块 — ResourceBudget 资源 soft/hard 约束
 *
 * harness 非领域模块。与 RunGuard 组合：Budget 管资源总闸，Guard 管行为跑飞。
 */
export { IterationBudget, DEFAULT_BUDGET } from './budget.js';
export type {
  IterationBudgetConfig,
  BudgetStatus,
  BudgetReport,
  BudgetEvaluation,
} from './budget.js';
