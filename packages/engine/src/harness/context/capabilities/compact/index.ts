/**
 * Compact 公用能力门面
 *
 * @module harness/context/capabilities/compact
 */

export { createCompactEngine, summarySoftTargetTokens, detectSummaryContamination } from './engine.js';
export {
  asSummaryMessage,
  wrapSummaryText,
  isMechanicalNotice,
  SUMMARY_MARKER,
  MECHANICAL_NOTICE_TRUNCATED,
  MECHANICAL_NOTICE_COMPRESSED,
  MECHANICAL_NOTICE_STRUCTURAL,
} from './messages.js';
export { alignViewSplit, semanticHistory } from './view-split.js';
export {
  isToolResultMessage,
  hasToolCall,
} from './messages.js';
export {
  buildToolCallLedger,
  asLedgerMessage,
  ledgerTruncate,
  mechanicalDegrade,
  toolExecutionLedgerTrim,
} from './mechanical.js';
export {
  HANDOVER_SUMMARY_TASK,
  buildHandoverPrompt,
  buildHandoverUserContent,
  clampSummaryProviderCap,
} from './handover.js';
export type { HandoverFoldRange, HandoverPromptOptions } from './handover.js';
export type {
  CompactEngine,
  CompactMode,
  CompactOptions,
  CompactOutcome,
  CompactTransportOutcome,
  SummarizeFunction,
  CompactTokenEstimator,
  CreateCompactEngineOptions,
} from './types.js';
