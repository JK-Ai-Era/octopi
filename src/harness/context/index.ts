/**
 * Harness Context 模块导出
 */

export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleParams,
  AssembleResult,
  IngestParams,
  CompactParams,
  CompactResult,
  AfterTurnParams,
  TokenEstimator,
  SummarizeFunction,
  MessageSelector,
  SelectResult,
  SelectOptions,
  Compressor,
  CompressParams,
  CompressResult,
  BudgetAllocator,
  BudgetAllocateParams,
  BudgetAllocateResult,
  ContextCompactReason,
  ContextCompactEvent,
  ContextEmitFn,
  ContextCompactSnapshot,
} from './types.js';
export { DefaultContextEngine } from './default-context-engine.js';
export type { DefaultContextEngineConfig } from './default-context-engine.js';

// ── 七层内容契约与装配 ──
export {
  LAYER_ORDER,
  LAYER_PRIORITY,
  LAYER_DEFAULT_SHARE,
  extractLayerQuery,
  hasLayerText,
} from './layer-types.js';
export type {
  ContextLayerId,
  LayerAssembleContext,
  LayerContent,
  ContextLayer,
  LayerManifestEntry,
  AssembleManifest,
  SystemAssembleResult,
  ContextAssembler,
  ContextAssembleParams,
} from './layer-types.js';
export { DefaultContextAssembler, truncateTextToTokens } from './assembler.js';
export type { DefaultContextAssemblerConfig } from './assembler.js';
export {
  PersonaLayer,
  SkillLayer,
  RuntimeLayer,
  KnowledgeLayer,
  MemoryLayer,
  CognitionLayer,
  WisdomLayer,
  createDefaultLayers,
} from './layers.js';
export type { CreateDefaultLayersOptions } from './layers.js';
export { createProviderSummarize, pickSummarizeProvider } from './summarize.js';
export type { CreateProviderSummarizeOptions } from './summarize.js';
export { createDefaultSystemPromptAssembler } from './system-prompt-assembler.js';
export type {
  SystemPromptAssembleInput,
  SystemPromptAssembleOutput,
} from './system-prompt-assembler.js';
