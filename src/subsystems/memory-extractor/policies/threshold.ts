/**
 * Memory Extractor Subsystem — 动态阈值策略
 *
 * 根据 session 运行质量自适应调整 minConfidence/minImportance。
 *
 * 核心设计：
 * - failureRate 高 → 阈值升高（更保守）
 * - 但如果有修复记录（resolvedErrors），修正对冲——"修好了的问题"反而产生高价值经验
 * - eventCount 少 → 阈值升高（样本不足时更保守）
 *
 * @module subsystems/memory-extractor/policies/threshold
 */

import type { RunSummary } from '../contracts/bundle.js';

export interface ThresholdPolicyInput {
  runSummary: RunSummary;
  eventCount: number;
  agentProfile?: string;
}

export interface ThresholdPolicyResult {
  minConfidence: number;
  minImportance: number;
}

export type ThresholdPolicy = (input: ThresholdPolicyInput) => ThresholdPolicyResult;

/**
 * 默认动态阈值策略
 */
export function defaultThresholdPolicy(input: ThresholdPolicyInput): ThresholdPolicyResult {
  const { runSummary, eventCount } = input;

  const baseConf = 0.6;
  const baseImp = 0.6;

  // 失败惩罚：failureRate 越高惩罚越大
  const failureDelta = Math.min(0.2, runSummary.failureRate * 0.4);

  // 修复奖励：如果 session 有修复记录，部分对冲失败惩罚
  const totalErrors = runSummary.majorErrors.length + runSummary.resolvedErrors.length;
  const resolvedRatio = totalErrors > 0
    ? runSummary.resolvedErrors.length / totalErrors
    : 0;
  const resolvedRelief = failureDelta * resolvedRatio * 0.8;

  // majorError 惩罚（已修复的不重复惩罚）
  const unresolvedMajor = Math.max(0, runSummary.majorErrors.length - runSummary.resolvedErrors.length);
  const majorDelta = Math.min(0.1, unresolvedMajor * 0.03);

  // 样本量修正：事件越少越保守
  const eventFactor = eventCount >= 10 ? 0 : Math.min(0.1, (10 - eventCount) * 0.01);

  const minConfidence = Math.min(0.95, Math.max(0.5, baseConf + failureDelta - resolvedRelief + majorDelta + eventFactor));
  const minImportance = Math.min(0.95, Math.max(0.5, baseImp + failureDelta - resolvedRelief + majorDelta + eventFactor));

  return { minConfidence, minImportance };
}
