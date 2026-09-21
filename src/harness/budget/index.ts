/**
 * Budget 模块 — BudgetPolicyEngine 安全阀（wall-clock / 显式 iteration·tool 上限）
 *
 * 见 arch/budget-redesign.md：默认不做 nominal token hard；Policy 账本另层。
 */
export { BudgetPolicyEngine, DEFAULT_BUDGET } from './budget.js';
export type {
  BudgetPolicyConfig,
  BudgetStatus,
  BudgetReport,
  BudgetEvaluation,
} from './budget.js';