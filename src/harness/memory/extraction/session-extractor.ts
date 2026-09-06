/**
 * Memory Extraction — Session 提取器（向后兼容 re-export）
 *
 * 核心类型和提取逻辑已迁移至 subsystems/memory-extractor/contracts/bundle.ts 和 handler.ts。
 * 本文件保留 re-export，确保现有导入路径不中断。
 *
 * @module harness/memory/extraction/session-extractor
 * @deprecated 使用 subsystems/memory-extractor/contracts/bundle 和 subsystems/memory-extractor/handler 替代
 */

// ── 类型 re-export（规范定义在 contracts/bundle.ts） ──
export type {
  SessionExtractEventType,
  SessionExtractEvent,
  CondensedTurn,
  RunSummary,
  SessionExtractBundle,
  MemoryCandidate,
} from '../../../subsystems/memory-extractor/contracts/bundle.js';

// ── SessionExtractor 类（薄包装，向后兼容） ──
import type { SessionExtractBundle, MemoryCandidate } from '../../../subsystems/memory-extractor/contracts/bundle.js';
import { extractCandidates } from '../../../subsystems/memory-extractor/handler.js';

/** @deprecated Use {@link extractCandidates} from subsystems/memory-extractor/handler.js instead. */
export class SessionExtractor {
  extract(bundle: SessionExtractBundle): MemoryCandidate[] {
    return extractCandidates(bundle);
  }
}
