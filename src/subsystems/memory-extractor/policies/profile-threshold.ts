/**
 * Memory Extractor Subsystem — Agent Profile 阈值策略
 *
 * 让不同 agent 类型（profile）拥有不同的默认保守度，同时保留动态阈值的自适应能力。
 *
 * @module subsystems/memory-extractor/policies/profile-threshold
 */

import { defaultThresholdPolicy, type ThresholdPolicy, type ThresholdPolicyInput, type ThresholdPolicyResult } from './threshold.js';

export interface ProfileThresholdConfig {
  /** profile 名称 → 基线阈值 */
  profiles: Record<string, { baseConfidence: number; baseImportance: number }>;
  /** 默认 profile（未匹配时使用） */
  defaultProfile?: string;
}

/**
 * 创建基于 profile 的阈值策略
 */
export function createProfileThresholdPolicy(config: ProfileThresholdConfig): ThresholdPolicy {
  const defaultProfile = config.defaultProfile ?? 'default';

  return (input: ThresholdPolicyInput): ThresholdPolicyResult => {
    const profile = input.agentProfile ?? defaultProfile;
    const base = config.profiles[profile] ?? config.profiles[defaultProfile] ?? { baseConfidence: 0.6, baseImportance: 0.6 };

    // 用默认策略获取修正量
    const dynamic = defaultThresholdPolicy(input);

    // 将 dynamic 视为修正增量
    const confDelta = dynamic.minConfidence - 0.6;
    const impDelta = dynamic.minImportance - 0.6;

    const minConfidence = Math.min(0.95, Math.max(0.5, base.baseConfidence + confDelta));
    const minImportance = Math.min(0.95, Math.max(0.5, base.baseImportance + impDelta));

    return { minConfidence, minImportance };
  };
}
