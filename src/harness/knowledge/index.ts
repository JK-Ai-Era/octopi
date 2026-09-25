/**
 * Knowledge 服务面 — 源注册 / 可见性 / catalog（独立于 Agent 基质库）
 *
 * 数据面：OCTOPI_HOME/knowledge/knowledge.db
 * 规格：arch/knowledge-layer.md
 */

export { KnowledgeDatabase } from './db.js';
export type { KnowledgeDatabaseOptions } from './db.js';
export { KnowledgeSourceStore } from './source-store.js';
export { KnowledgeIndexStore, hashContent } from './index-store.js';
export type { IndexedFileRecord, ChunkHit } from './index-store.js';
export {
  FormatAdapterRegistry,
  textAdapter,
  markdownAdapter,
  htmlAdapter,
  codeAdapter,
  chunkCodeBySymbols,
  IGNORED_DIRS,
  BINARY_EXTENSIONS,
} from './adapters.js';
export type { FormatAdapter, KnowledgeChunkDraft } from './adapters.js';
export { KnowledgeIngest } from './ingest.js';
export type { KnowledgeIngestOptions, IngestProgressEvent, IngestJobKind } from './ingest.js';
export {
  LocalFsFetcher,
  UrlFetcher,
} from './fetchers.js';
export type {
  SourceFetcher,
  DiscoveredDocRef,
  VirtualDocument,
} from './fetchers.js';
export { ConnectorRegistry, RestConnector } from './connectors.js';
export type { KnowledgeConnector, ConnectorContext, RestConnectorConfig } from './connectors.js';
export { ConnectorFetcher } from './connector-fetcher.js';
export { assertUrlAllowed, guardedFetch, isRestrictedIp } from './network-guard.js';
export type { NetworkGuardOptions, FetchResult } from './network-guard.js';
export { htmlToStructuredText, looksLikeHtml } from './html.js';
export { KnowledgeRetriever } from './retriever.js';
export type {
  HybridSearchOptions,
  HybridSearchResult,
  AutoGroundDecision,
  GroundingMode,
  KnowledgeRecallMode,
  KnowledgeRetrieverOptions,
} from './retriever.js';
export {
  GroundingAssembler,
  formatKnowledgeGroundingMessage,
  resolveGroundingQuery,
  wrapUntrustedKnowledgeBlock,
  isKnowledgeGroundingMessage,
  stripKnowledgeGrounding,
  KNOWLEDGE_GROUNDING_SOURCE,
} from './grounding.js';
export type { GroundingPack, GroundingAssemblerOptions } from './grounding.js';
export { KnowledgeHitLog } from './hit-log.js';
export type {
  KnowledgeHitRecord,
  KnowledgeHitStats,
  PromotionCandidate,
} from './hit-log.js';
export { KnowledgePurger } from './purge.js';
export type { PurgeResult } from './purge.js';
export { resolveKnowledgePaths } from './paths.js';
export type { KnowledgePaths } from './paths.js';
export {
  generateKnowledgeDescription,
  heuristicDescription,
} from './describe.js';
export type {
  KnowledgeDescribePort,
  KnowledgeDescribeOptions,
  KnowledgeDescribeResult,
} from './describe.js';
export { scanSecretShapes } from './secret-scan.js';
export type {
  KnowledgeSource,
  KnowledgeSourceInput,
  KnowledgeSourcePatch,
  KnowledgeSourceKind,
  KnowledgeSourceStatus,
  KnowledgeSourceSync,
  KnowledgeSourceError,
  KnowledgeSourceNetwork,
  KnowledgeSourceDiscover,
  KnowledgeScopeRef,
  KnowledgeScopeLevel,
  KnowledgeSourceId,
  KnowledgeChunkId,
  KnowledgeVisibilityTargetType,
  KnowledgeVisibilityOp,
  KnowledgeSessionVisibilityItem,
  KnowledgeSessionVisibilityInput,
  Branded,
} from './types.js';
export { asSourceId, asChunkId } from './types.js';
