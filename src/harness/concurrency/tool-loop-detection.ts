/**
 * 工具循环检测
 *
 * 从 core/tool-loop-detection.ts 迁移到 harness/concurrency/（v0.8.0）。
 * 循环检测是策略实现，不是核心机制。
 */
export {
  recordToolCall,
  detectNoProgressLoop,
  hashToolCall,
  hashToolOutcome,
} from './tool-loop-detection-core.js';
export type {
  ToolCallRecord,
  ToolLoopDetectionConfig,
  LoopDetectionResult,
  LoopDetectorKind,
} from './tool-loop-detection-core.js';
