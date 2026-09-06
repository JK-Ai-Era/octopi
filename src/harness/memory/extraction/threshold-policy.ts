/**
 * Memory Extraction — 动态阈值策略（向后兼容 re-export）
 *
 * 核心逻辑已迁移至 subsystems/memory-extractor/policies/threshold.ts。
 *
 * @module harness/memory/extraction/threshold-policy
 * @deprecated 使用 subsystems/memory-extractor/policies/threshold 替代
 */

/** @deprecated Use subsystems/memory-extractor/policies/threshold instead. */
export {
  defaultThresholdPolicy,
  type ThresholdPolicy,
  type ThresholdPolicyInput,
  type ThresholdPolicyResult,
} from '../../../subsystems/memory-extractor/policies/threshold.js';
