/**
 * harness/run/model — 模型解析与 run 级快照收口
 *
 * @module harness/run/model
 */

export type {
  ResolvedModel,
  ModelCatalogEntry,
  ModelCapabilitySource,
} from './types.js';

export {
  parseModelRef,
  bindModelName,
  lookupModelCapability,
  resolveModel,
  resolveModelRef,
  resolveCatalogEntry,
  lookupDeclaredContextWindow,
} from './resolver.js';
export type { ParsedModelRef, ResolveModelInput } from './resolver.js';

export {
  withResolvedModel,
  getResolvedModel,
  updateResolvedModel,
  getRunModelProvider,
  getRunContextWindow,
  getRunModelName,
} from './run-scope.js';

export { recordWindowTruth, getWindowTruth, resetWindowTruth } from './window-truth.js';
export type { WindowTruthEntry } from './window-truth.js';
