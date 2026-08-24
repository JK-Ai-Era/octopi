/**
 * @canonical 从 src/core/tool-loop-detection.ts 重新导出
 * @deprecated 原始文件仍在 core/，此模块建立 harness 规范路径
 */
export {
  recordToolCall,
  detectNoProgressLoop,
  hashToolCall,
  hashToolOutcome,
} from '../../core/tool-loop-detection.js';
export type {
  ToolCallRecord,
  ToolLoopDetectionConfig,
  LoopDetectionResult,
  LoopDetectorKind,
} from '../../core/tool-loop-detection.js';
