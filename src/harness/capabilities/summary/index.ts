/**
 * Summary 公用能力门面
 *
 * @module harness/capabilities/summary
 */

export type {
  ContentChannel,
  ContentFieldType,
  ContentKind,
  ContentSourceMeta,
  ContentUnit,
  CreateSummaryPortOptions,
  OversizedPolicy,
  ResolvedSummaryModel,
  ResolveSummaryModelInput,
  StructuredValidator,
  SummaryCachePort,
  SummaryCoverage,
  SummaryExtractRules,
  SummaryGateConfig,
  SummaryPolicy,
  SummaryPort,
  SummaryResult,
  ToolSummaryBinding,
  ToolSummaryMode,
} from './types.js';

export { createDefaultSummaryPolicies } from './policies.js';
export {
  createDefaultToolBindings,
  defaultKindForTool,
  defaultPolicyIdForKind,
  kindFromContentType,
  kindFromExtension,
  resolveToolBinding,
} from './registry.js';
export { buildPolicyRegistry, resolveKind, resolvePolicyForUnit, resolveSummaryModel } from './resolver.js';
export { applyL1Truncate, DEFAULT_GATE, mergeGate, shouldProcessUnit } from './gate.js';
export { computeInputBudget, DEFAULT_INPUT_BUDGET_TOKENS, DEFAULT_SAFETY_MARGIN_TOKENS } from './budget.js';
export { extractStructured, parseLooseJson, validateStructured } from './structured.js';
export { executeSummary, buildSystemPrompt } from './executor.js';
export { createSummaryPort, getToolSummaryBinding, createToolSummarySupport } from './port.js';
export { applyToolSummary, resolveSupportBinding } from './tool-binding.js';
export type { ApplyToolSummaryInput, ApplyToolSummaryOutput, ToolSummarySupport } from './tool-binding.js';
export { createMemorySummaryCache } from './memory-cache.js';
