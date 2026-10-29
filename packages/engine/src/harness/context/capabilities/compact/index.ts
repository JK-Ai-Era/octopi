/**
 * Compact 公用能力门面
 *
 * @module harness/context/capabilities/compact
 */

export { createCompactEngine, summarySoftTargetTokens, detectSummaryContamination } from './engine.js';
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
  CompactSummarizeFn,
  CompactTokenEstimator,
  CreateCompactEngineOptions,
} from './types.js';
