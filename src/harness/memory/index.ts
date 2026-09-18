/**
 * Memory 领域 — 记忆系统
 *
 * 价值模型：fact / method / norm（见 docs/memory-system-redesign.md）。
 * system prompt 七层组装契约在 harness/context/。
 */

// ── 契约类型 ──
export type {
  MemoryType,
  MemoryChannel,
  MemoryStatus,
  SoftDeleteReason,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryStore,
  MemoryWriteSlot,
  WisdomEntry,
  WisdomStore,
  ConceptNode,
  ConceptEdge,
  ConceptGraph,
  ConceptGraphStore,
} from './types.js';
export { MEMORY_TYPES } from './types.js';

// ── 内存实现 ──
export { InMemoryMemoryStore } from './store.js';
export { InMemoryConceptGraph } from './cognition.js';

// ── SQLite 实现 ──
export { AgentDatabase, SqliteMemoryStore, SqliteWisdomStore, SqliteConceptGraph, KnowledgeRegistry, createEmbeddingProvider } from './sqlite/index.js';
export type { AgentDatabaseOptions, SqliteMemoryStoreOptions, SqliteConceptGraphOptions, EmbeddingProvider, EmbeddingConfig, KnowledgeSourceEntry } from './sqlite/index.js';

// ── 置信度与门控 ──
export {
  provisionalConfidence,
  injectFilter,
  searchFilter,
  profileToConfidenceConfig,
  hasQuoteEvidence,
  DEFAULT_CHANNEL_PRIORS,
} from './confidence.js';
export type { ChannelPriors, ConfidenceProfileConfig, MemoryProfileName, ProvisionalInput, ProvisionalResult } from './confidence.js';
export { evaluateGates, mapLegacyType } from './gates.js';
export type { GateCandidate, GateConfig, GateOutcome, GateRejectReason } from './gates.js';

// ── Steward 共享策略（subsystem 相对引用亦可） ──
export {
  admitCandidates,
  applySoftDeletes,
  planSoftDeletes,
  resolvePolicy,
  DEFAULT_SOFT_DELETE_POLICY,
} from '../../subsystems/memory-steward/shared/policy.js';
export type { SoftDeletePolicyConfig, StewardCandidate, GovernPlanItem } from '../../subsystems/memory-steward/shared/policy.js';
