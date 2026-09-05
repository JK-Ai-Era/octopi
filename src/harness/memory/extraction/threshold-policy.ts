/**
 * Memory Extraction — 动态阈值策略（语言无关）
 *
 * 目标：
 * - 避免固定阈值“一刀切”误杀
 * - 根据 session 运行质量（failureRate / majorErrors / eventCount）自适应调整 minConfidence/minImportance
 *
 * 设计：
 * - 纯函数，无副作用
 * - 输入是 bundle 的 RunSummary 与事件数
 * - 输出是 { minConfidence, minImportance }
 *
 * @module harness/memory/extraction/threshold-policy
 */

import type { RunSummary } from './session-extractor.js';

export interface ThresholdPolicyInput {
  runSummary: RunSummary;
  eventCount: number;
}

export interface ThresholdPolicyResult {
  minConfidence: number;
  minImportance: number;
}

export type ThresholdPolicy = (input: ThresholdPolicyInput) => ThresholdPolicyResult;

/**
 * 默认动态阈值策略
 *
 * 规则（可按业务演进）：
 * - failureRate 越高 → 阈值越高（更保守）
 * - majorErrors 越多 → 阈值越高
 * - eventCount 越少 → 阈值越高（样本少时更保守）
 */
export function defaultThresholdPolicy(input: ThresholdPolicyInput): ThresholdPolicyResult {
  const { runSummary, eventCount } = input;

  const baseConf = 0.6;
  const baseImp = 0.6;

  const failureDelta = Math.min(0.2, runSummary.failureRate * 0.4);
  const majorDelta = Math.min(0.1, (runSummary.majorErrors.length) * 0.02);

  // 样本量修正：事件越少越保守
  const eventFactor = eventCount >= 10 ? 0 : Math.min(0.1, (10 - eventCount) * 0.01);

  const minConfidence = Math.min(0.95, baseConf + failureDelta + majorDelta + eventFactor);
  const minImportance = Math.min(0.95, baseImp + failureDelta + majorDelta + eventFactor);

  return { minConfidence, minImportance };
}
