/**
 * Memory Extraction — Agent Profile 阈值策略（向后兼容 re-export）
 *
 * 核心逻辑已迁移至 subsystems/memory-extractor/policies/profile-threshold.ts。
 *
 * @module harness/memory/extraction/profile-threshold-policy
 * @deprecated 使用 subsystems/memory-extractor/policies/profile-threshold 替代
 */

/** @deprecated Use subsystems/memory-extractor/policies/profile-threshold instead. */
export {
  createProfileThresholdPolicy,
  type ProfileThresholdConfig,
} from '../../../subsystems/memory-extractor/policies/profile-threshold.js';
