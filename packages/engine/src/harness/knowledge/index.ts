/**
 * Knowledge 服务面 — 源注册 / 可见性 / catalog（独立于 Agent 基质库）
 *
 * 数据面：OCTOPI_HOME/knowledge/knowledge.db
 * 规格：arch/knowledge-layer.md
 */

export { KnowledgeDatabase } from './db.js';
export type { KnowledgeDatabaseOptions } from './db.js';
export {
  identifyLocalFile,
  identifyUrl,
  identifyConnector,
  normalizeFsPath,
  normalizePathLexical,
  urlIdentityKey,
  connectorIdentityKey,
  logicalPathFrom,
  isPathPrefix,
  canonicalizeUrl,
} from './file-identity.js';
export type { FileIdentity } from './file-identity.js';
export { MembershipStore } from './membership-store.js';
export type { MembershipRow, FileRow, ReconcileResult } from './membership-store.js';
export { FileIndexStore } from './file-index-store.js';
export type { ChunkDraft, UpsertFileResult } from './file-index-store.js';
export { KnowledgeSourceStore } from './source-store.js';
export { KnowledgeIndexStore, hashContent } from './index-store.js';
export type { IndexedFileRecord, ChunkHit } from './index-store.js';
export { KnowledgeFts, buildFtsTokens, buildFtsQuery } from './fts.js';
export {
  vectorBucket,
  queryBuckets,
  scoreAnnCandidates,
  VECTOR_BUCKETS,
} from './vector-ann.js';
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
export type {
  KnowledgeIngestOptions,
  IngestProgressEvent,
  IngestJobKind,
} from './ingest.js';
export { KnowledgeJobControl } from './job-control.js';
export { JobQueue } from './job-queue.js';
export type { IngestJobKind as JobKind, JobRow } from './job-queue.js';
export { EmbedRunner } from './embed-runner.js';
export type { EmbedSecretPolicy } from './embed-runner.js';
export {
  DEFAULT_KNOWLEDGE_FILE_LIMITS,
  classifyFileKind,
  decideBySize,
  formatMaxBytes,
  isRetryableSkipReason,
  parseTimeoutForSize,
  resolveKnowledgeFileLimits,
} from './file-limits.js';
export type {
  KnowledgeFileKind,
  KnowledgeFileLimits,
  KnowledgeFileLimitsInput,
  OversizePolicy,
} from './file-limits.js';
export {
  LocalFsFetcher,
  UrlFetcher,
} from './fetchers.js';
export type {
  SourceFetcher,
  DiscoveredDocRef,
  DiscoverResult,
  VirtualDocument,
} from './fetchers.js';
export { ConnectorRegistry, RestConnector } from './connectors.js';
export type { KnowledgeConnector, ConnectorContext, RestConnectorConfig } from './connectors.js';
export { ConnectorFetcher } from './connector-fetcher.js';
export { assertUrlAllowed, authHeadersForUrl, guardedFetch, isRestrictedIp } from './network-guard.js';
export type { NetworkGuardOptions, FetchResult } from './network-guard.js';
export { htmlToStructuredText, looksLikeHtml } from './html.js';
export { KnowledgeRetriever } from './retriever.js';
export {
  LocalKnowledgeQueryService,
  createKnowledgeQueryService,
} from './query-service.js';
export type {
  KnowledgeQueryService,
  SearchQuery,
  ListSourcesQuery,
  QueryIdentity,
  PrincipalStats,
  ReadChunkResult,
  SourceStatsBundle,
  SourceDetail,
  ListJobsQuery,
  ReadySnapshot,
  QueryWorkerRole,
} from './query-service.js';
export { readJobControlState } from './job-control-state.js';
export type { KnowledgeJobControlState } from './job-control-state.js';
export {
  handleKnowledgeReadHttp,
  isPureReadRoute,
  authenticateRead,
} from './read-http.js';
export type { ReadHttpDeps } from './read-http.js';
export { KnowledgeHttpApp, createKnowledgeHttpApp } from './http-app.js';
export type { KnowledgeServiceToken, KnowledgeServiceOptions, AuthContext } from './http-app.js';
export {
  LocalKnowledgeWriteService,
} from './writer-service.js';
export type {
  KnowledgeWriteService,
  WriteIdentity,
  WriteAbortStats,
  WriteResumeStats,
  WriteRegisterResult,
  WriteDescribeResult,
} from './writer-service.js';
export { WorkerWriteService } from './writer-worker-client.js';
export type { WorkerWriteStartOptions } from './writer-worker-client.js';
export { createLocalKnowledgeStack } from './local-stack.js';
export type { LocalKnowledgeStack } from './local-stack.js';
export { startKnowledgeService } from './serve.js';
export type { KnowledgeServeOptions, KnowledgeServeHandle } from './serve.js';
export { startKnowledgeServiceProcess } from './start-service-process.js';
export type {
  KnowledgeServiceProcessOptions,
  KnowledgeServiceProcessHandle,
} from './start-service-process.js';
export { acquireKnowledgeWriterLock } from './writer-lock.js';
export type { WriterLockHolder } from './writer-lock.js';
export { parseTextInWorker } from './parse-text-in-worker.js';
export type { TextParseResult, TextParseWorkerOptions } from './parse-text-in-worker.js';
export { KnowledgeClient } from './client.js';
export type { KnowledgeClientOptions } from './client.js';
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
export { deriveTopicsFromPaths } from './topics.js';
export type { KnowledgeCatalogItem, KnowledgeCatalogProvider } from './catalog-types.js';
export {
  generateKnowledgeDescription,
  heuristicDescription,
} from './describe.js';
export type {
  KnowledgeDescribePort,
  KnowledgeDescribeOptions,
  KnowledgeDescribeResult,
} from './describe.js';
export { scanSecretShapes, redactSecretShapes } from './secret-scan.js';
export type { RedactResult } from './secret-scan.js';
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
