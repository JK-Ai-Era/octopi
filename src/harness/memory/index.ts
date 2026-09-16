/**
 * Memory 领域 — 记忆系统
 *
 * 职责：记忆存储/检索、认知图谱、智慧生成、会话提取。
 * system prompt 七层组装契约在 `harness/context/`（ContextLayer）。
 *
 * 三层抽象：
 * - Information → Memory（提炼：什么值得记住）
 * - Memory → Cognition（结构化：概念之间的关系）
 * - Memory → Wisdom（升华：思维模式）
 *
 * 依赖：
 * - 契约：本域 types.ts（MemoryStore / WisdomStore / ConceptGraphStore）
 * - Core: types/messages
 */

// ── 契约类型 ──
export type {
  MemoryType,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryStore,
  WisdomEntry,
  WisdomStore,
  ConceptNode,
  ConceptEdge,
  ConceptGraph,
  ConceptGraphStore,
} from './types.js';

// ── 内存实现 ──
export { InMemoryMemoryStore } from './store.js';
export { InMemoryConceptGraph } from './cognition.js';

// ── SQLite 实现 ──
export { AgentDatabase, SqliteMemoryStore, SqliteWisdomStore, SqliteConceptGraph, KnowledgeRegistry, createEmbeddingProvider } from './sqlite/index.js';
export type { AgentDatabaseOptions, SqliteMemoryStoreOptions, SqliteConceptGraphOptions, EmbeddingProvider, EmbeddingConfig, KnowledgeSourceEntry } from './sqlite/index.js';

// ── 提取/采集（Memory Extraction） ──
export { SessionExtractCollector } from './extraction/session-extract-collector.js';
export { MemoryExtractorBridge } from './extraction/memory-extractor-bridge.js';
export { InMemoryExtractorStore } from './extraction/extractor-store.js';
export type { ExtractorMeta, ExtractorStore } from './extraction/extractor-store.js';
export { JsonlExtractorStore } from './extraction/jsonl-extractor-store.js';
export { PendingExtractor } from './extraction/pending-extractor.js';
export { ExtractionMetricsBridge } from './extraction/extraction-metrics-bridge.js';
export { AlertEvaluator } from './extraction/alert-evaluator.js';
export { BackpressureController } from './extraction/backpressure.js';
export type { BackpressureOptions } from './extraction/backpressure.js';

// ── Memory Extractor Subsystem ──
export { extractCandidates, callHandler as callMemoryExtractorHandler } from '../../subsystems/memory-extractor/handler.js';
export type { MemoryExtractorConfig } from '../../subsystems/memory-extractor/types.js';
export type {
  SessionExtractEventType,
  SessionExtractEvent,
  SessionExtractBundle,
  MemoryCandidate,
  ExtractionResult,
  CondensedTurn,
  RunSummary,
} from '../../subsystems/memory-extractor/contracts/bundle.js';
export { defaultThresholdPolicy } from '../../subsystems/memory-extractor/policies/threshold.js';
export type { ThresholdPolicy, ThresholdPolicyInput, ThresholdPolicyResult } from '../../subsystems/memory-extractor/policies/threshold.js';
export { MemoryDeduplicator } from '../../subsystems/memory-extractor/policies/dedup.js';
export type { MemoryDeduplicatorOptions } from '../../subsystems/memory-extractor/policies/dedup.js';
export { createProfileThresholdPolicy } from '../../subsystems/memory-extractor/policies/profile-threshold.js';
export type { ProfileThresholdConfig } from '../../subsystems/memory-extractor/policies/profile-threshold.js';
export { enrichWithLLM, condenseEvents } from '../../subsystems/memory-extractor/llm-enrichment.js';
export type { LLMEnrichmentConfig, EnrichmentChat } from '../../subsystems/memory-extractor/llm-enrichment.js';
