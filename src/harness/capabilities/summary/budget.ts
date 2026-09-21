/**
 * Summary 输入预算
 *
 * @module harness/capabilities/summary/budget
 */

import type { SummaryPolicy } from './types.js';

export const DEFAULT_INPUT_BUDGET_TOKENS = 24000;
export const DEFAULT_SAFETY_MARGIN_TOKENS = 2000;

export interface InputBudgetParams {
  policy: SummaryPolicy;
  /** 模型 catalog 窗口；未知为 undefined */
  contextWindow?: number;
  defaultInputBudgetTokens?: number;
  safetyMarginTokens?: number;
  systemPromptTokens?: number;
}

/**
 * 计算可用于 LLM 的输入 token 预算
 *
 * @param params - 策略与窗口信息
 * @returns inputBudget（恒 > 0）
 */
export function computeInputBudget(params: InputBudgetParams): number {
  const defaultIn = params.defaultInputBudgetTokens ?? DEFAULT_INPUT_BUDGET_TOKENS;
  const margin = params.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  const system = params.systemPromptTokens ?? 0;
  const maxOut = params.policy.budget.maxOutputTokens;
  const policyMaxIn = params.policy.budget.maxInputTokens;

  let windowBudget = defaultIn;
  if (params.contextWindow != null && params.contextWindow > 0) {
    windowBudget = params.contextWindow - system - maxOut - margin;
  }

  const budget = Math.min(policyMaxIn, Math.max(256, windowBudget));
  return budget;
}
