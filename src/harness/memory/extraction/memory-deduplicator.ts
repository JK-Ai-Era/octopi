/**
 * Memory Extraction — 记忆去重与升级策略（向后兼容 re-export）
 *
 * 核心逻辑已迁移至 subsystems/memory-extractor/policies/dedup.ts。
 *
 * @module harness/memory/extraction/memory-deduplicator
 * @deprecated 使用 subsystems/memory-extractor/policies/dedup 替代
 */

/** @deprecated Use subsystems/memory-extractor/policies/dedup instead. */
export {
  MemoryDeduplicator,
  type MemoryDeduplicatorOptions,
} from '../../../subsystems/memory-extractor/policies/dedup.js';
