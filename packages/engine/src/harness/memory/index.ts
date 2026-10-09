/**
 * Memory 领域 — 记忆系统
 *
 * 价值模型：fact / method / norm（见 docs/memory.md、arch/memory-system-redesign.md）。
 * system prompt ContextLayer 契约在 harness/context/。
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
  WisdomStatus,
  WisdomOrigin,
  WisdomKind,
  WisdomRetireReason,
  WisdomScenario,
  WisdomEffect,
  WisdomDerivation,
  WisdomCounterevidence,
  WisdomOutcomes,
  WisdomEntry,
  WisdomGateReason,
  WisdomGateOutcome,
  AdmitWisdomInput,
  AdmitWisdomAction,
  AdmitWisdomResult,
  WisdomInjectQuery,
  WisdomInjectPick,
  WisdomOutcomeSignal,
  WisdomOutcomeEvent,
  WisdomStats,
  WisdomStore,
  ConceptKind,
  ConceptRelationType,
  ConceptStatus,
  EvidenceClass,
  EdgeBasis,
  ConceptNode,
  ConceptEdge,
  ConceptGraph,
  MergeCandidate,
  EdgeAux,
  AdmitConceptInput,
  AdmitConceptResult,
  AdmitEdgeInput,
  AdmitEdgeResult,
  ConceptGateReason,
  SpreadingActivateOptions,
  ActivatedGraph,
  ConceptGraphStats,
  DecayResult,
  ConceptGraphStore,
} from './types.js';
export {
  MEMORY_TYPES,
  WISDOM_STATUSES,
  WISDOM_INJECTABLE_STATUSES,
  WISDOM_ORIGINS,
  WISDOM_KINDS,
  CONCEPT_KINDS,
  CONCEPT_RELATION_TYPES,
  STRONG_RELATION_TYPES,
} from './types.js';

// ── Wisdom 门控 / 策略 / 形成 ──
export {
  evaluateWisdomGate,
  resolveInitialWisdomStatus,
  normalizeStatement,
  looksOpposed,
  WISDOM_DEFAULT_MIN_SUPPORT,
} from './wisdom-gates.js';
export {
  DEFAULT_WISDOM_EVALUATION,
  DEFAULT_WISDOM_GOVERN,
  foldOutcomeEvents,
  planConfidenceUpdate,
  planWisdomGovern,
  wisdomUtility,
  wisdomInjectScore,
} from './wisdom-policy.js';
export type {
  WisdomEvaluationConfig,
  WisdomGovernConfig,
  WisdomConfidenceUpdate,
  WisdomGoverPlanItem,
} from './wisdom-policy.js';
export {
  parseWisdomFormationJson,
  normalizeWisdomFormation,
  toAdmitWisdomInput,
  formAndAdmit,
  scenarioMatchScore,
  pickForInjection,
  formatWisdomBody,
} from './wisdom-formation.js';
export type {
  RawWisdomFormationOutput,
  ParsedWisdomItem,
  ParsedWisdomFormation,
} from './wisdom-formation.js';

// ── Cognition 门控 / 可塑 / 概念化 ──
export {
  evaluateConceptGate,
  licenseEdge,
  edgeBasisFromLicense,
  normalizeForCue,
} from './cognition-gates.js';
export type {
  ConceptGateOutcome,
  EdgeLicenseInput,
  EdgeLicenseOutcome,
} from './cognition-gates.js';
export {
  DEFAULT_EDGE_DECAY_PER_DAY,
  DEFAULT_EDGE_DECAY_FLOOR,
  DEFAULT_RETRIEVE_STATUSES,
  decayMultiplier,
  nextEdgeStrength,
  hebbianStrengthen,
  counterEvidenceWeaken,
} from './cognition-decay.js';
export type { EdgeDecayConfig } from './cognition-decay.js';
export {
  conceptualizeAndAdmit,
  parseConceptualizerJson,
} from './conceptualizer.js';
export type {
  ConceptualizerInput,
  ConceptualizerResult,
  ConceptualizerNodeOut,
  ConceptualizerEdgeOut,
  RawConceptualizerOutput,
} from './conceptualizer.js';
export {
  COGNITIZE_REQUEST_EVENT,
  emitConceptualizeRequest,
} from './cognition-trigger.js';
export type { ConceptualizeRequestPayload } from './cognition-trigger.js';

// ── 内存实现 ──
export { InMemoryMemoryStore } from './store.js';
export { InMemoryWisdomStore } from './wisdom.js';
export { InMemoryConceptGraph } from './cognition.js';

// ── SQLite 实现 ──
export { AgentDatabase, SqliteMemoryStore, SqliteWisdomStore, SqliteConceptGraph, createEmbeddingProvider, SqliteBackfillCoverageStore } from './sqlite/index.js';
export type { AgentDatabaseOptions, SqliteMemoryStoreOptions, SqliteConceptGraphOptions, EmbeddingProvider, EmbeddingConfig } from './sqlite/index.js';
export {
  createEmbeddingProviderFromModels,
  resolveEmbeddingRuntime,
  isEmbeddingEnabled,
  resolveEmbeddingEndpoint,
} from './sqlite/index.js';
export type { ResolvedEmbeddingRuntime } from './sqlite/index.js';
export {
  tokenizeKeywordQuery,
  tokenizeKeywordDetail,
  scoreKeywordFields,
  buildKeywordLikeSql,
} from './sqlite/index.js';
export type { KeywordFields, KeywordTokens } from './sqlite/index.js';

// ── 检索排序 ──
export {
  DEFAULT_MIN_SIMILARITY,
  DEFAULT_SIMILARITY_WEIGHT,
  DEFAULT_MIN_KEYWORD_SCORE,
  qualityScore,
  blendRank,
  passesSimilarityFloor,
  resolveRetrievalKnobs,
} from './retrieval-rank.js';

// ── 写入去重 ──
export { findDuplicate, normalizedProposition, charTrigramSimilarity } from './similarity.js';
export type { FindDuplicateOptions, DuplicateHit } from './similarity.js';

export {
  DEFAULT_DECAY_TYPE_PARAMS,
  resolveDecayParams,
  nextDecayFactor,
  isDecayDue,
} from './decay-policy.js';
export type { DecayTypeParams, DecayParamsConfig } from './decay-policy.js';

export { MemoryHealthProbe } from './health-probe.js';
export type { MemoryHealthProbeOptions } from './health-probe.js';

// ── 补录覆盖与触发 ──
export {
  InMemoryBackfillCoverageStore,
  measureSessionDensity,
  passesPrefilter,
  shouldAttempt,
  DEFAULT_PREFILTER,
} from './backfill-coverage.js';
export type {
  BackfillCoverageRecord,
  BackfillCoverageStore,
  BackfillCoverageStatus,
  BackfillTriggerKind,
  SessionDensity,
  PrefilterConfig,
} from './backfill-coverage.js';
export { BackfillTrigger, BACKFILL_REQUEST_EVENT } from './backfill-trigger.js';
export type { BackfillTriggerOptions } from './backfill-trigger.js';

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

// ── Steward 共享策略（subsystem 从 @octopi-agent/engine 引用） ──
export {
  admitCandidates,
  applySoftDeletes,
  planSoftDeletes,
  applyBoosts,
  planBoosts,
  planPromotionCandidates,
  resolvePolicy,
  DEFAULT_SOFT_DELETE_POLICY,
  MAX_ENTRIES_PER_SOURCE,
} from './steward-policy.js';
export type {
  SoftDeletePolicyConfig,
  StewardCandidate,
  GovernPlanItem,
  BoostPlanItem,
  AdmitResult,
} from './steward-policy.js';
