/**
 * Memory 领域 — 记忆系统
 *
 * 职责：记忆存储/检索、认知图谱、智慧生成、项目记忆、七层智能组装。
 *
 * 三层抽象：
 * - Information → Memory（提炼：什么值得记住）
 * - Memory → Cognition（结构化：概念之间的关系）
 * - Memory → Wisdom（升华：思维模式）
 *
 * 依赖：
 * - Core: interfaces/memory, types/messages
 */

// ── 内存实现（保留向后兼容） ──
export { InMemoryMemoryStore } from './store.js';
export { InMemoryConceptGraph } from './cognition.js';
export { ContextIntelligence } from './context-intelligence.js';
export type { ContextIntelligenceConfig, AssembledContext } from './context-intelligence.js';

// ── SQLite 实现 ──
export { AgentDatabase, SqliteMemoryStore, SqliteWisdomStore, SqliteConceptGraph, KnowledgeRegistry, createEmbeddingProvider } from './sqlite/index.js';
export type { AgentDatabaseOptions, SqliteMemoryStoreOptions, SqliteConceptGraphOptions, EmbeddingProvider, EmbeddingConfig, KnowledgeSourceEntry } from './sqlite/index.js';


// ── 提取/采集（Memory Extraction） ──
export { SessionExtractor } from './extraction/session-extractor.js';
export type { SessionExtractBundle, SessionExtractEvent, MemoryCandidate } from './extraction/session-extractor.js';
export { SessionExtractCollector } from './extraction/session-extract-collector.js';
export { MemoryExtractorBridge } from './extraction/memory-extractor-bridge.js';

export { InMemoryExtractorStore } from './extraction/extractor-store.js';
export type { ExtractorMeta, ExtractorStore } from './extraction/extractor-store.js';
export { JsonlExtractorStore } from './extraction/jsonl-extractor-store.js';

export { MemoryDeduplicator } from './extraction/memory-deduplicator.js';
export { PendingExtractor } from './extraction/pending-extractor.js';

export { defaultThresholdPolicy } from './extraction/threshold-policy.js';
export type { ThresholdPolicy, ThresholdPolicyInput, ThresholdPolicyResult } from './extraction/threshold-policy.js';

export { createProfileThresholdPolicy } from './extraction/profile-threshold-policy.js';
export type { ProfileThresholdConfig } from './extraction/profile-threshold-policy.js';

export { ExtractionMetricsBridge } from './extraction/extraction-metrics-bridge.js';
export { AlertEvaluator } from './extraction/alert-evaluator.js';
export { BackpressureController } from './extraction/backpressure.js';
export type { BackpressureOptions } from './extraction/backpressure.js';

// ── Memory Extractor Subsystem（定义文件驱动） ──
export { extractCandidates } from '../../subsystems/memory-extractor/handler.js';
export { callHandler as callMemoryExtractorHandler } from '../../subsystems/memory-extractor/handler.js';
export type { MemoryExtractorDeps, MemoryExtractorConfig } from '../../subsystems/memory-extractor/types.js';
export type {
  SessionExtractEventType as SessionExtractEventTypeV2,
  SessionExtractEvent as SessionExtractEventV2,
  SessionExtractBundle as SessionExtractBundleV2,
  MemoryCandidate as MemoryCandidateV2,
  ExtractionResult,
  CondensedTurn as CondensedTurnV2,
  RunSummary as RunSummaryV2,
} from '../../subsystems/memory-extractor/contracts/bundle.js';
export { defaultThresholdPolicy as subsystemThresholdPolicy } from '../../subsystems/memory-extractor/policies/threshold.js';
export { MemoryDeduplicator as SubsystemMemoryDeduplicator } from '../../subsystems/memory-extractor/policies/dedup.js';
export { enrichWithLLM, condenseEvents } from '../../subsystems/memory-extractor/llm-enrichment.js';
export type { LLMEnrichmentConfig } from '../../subsystems/memory-extractor/llm-enrichment.js';
export { DEP_MODEL_PROVIDER } from '../../subsystems/memory-extractor/types.js';
