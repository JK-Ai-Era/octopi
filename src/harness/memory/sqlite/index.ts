/**
 * SQLite 存储层 — Memory / Wisdom / Cognition / Knowledge 注册的 SQLite 实现
 *
 * @module
 */

export { AgentDatabase } from './agent-db.js';
export type { AgentDatabaseOptions } from './agent-db.js';

export { createEmbeddingProvider } from './embedding.js';
export type { EmbeddingProvider, EmbeddingConfig } from './embedding.js';

export {
  createEmbeddingProviderFromModels,
  resolveEmbeddingRuntime,
  isEmbeddingEnabled,
  resolveEmbeddingEndpoint,
} from './embedding-from-models.js';
export type { ResolvedEmbeddingRuntime } from './embedding-from-models.js';

export { cosineSimilarity, cosineDistance, searchTopK, parseEmbedding, serializeEmbedding } from './vector-search.js';
export type { VectorSearchResult } from './vector-search.js';

export {
  tokenizeKeywordQuery,
  scoreKeywordFields,
  buildKeywordLikeSql,
} from './keyword-search.js';
export type { KeywordFields } from './keyword-search.js';

export {
  tryLoadSqliteVec,
  ensureMemoryVecTable,
  upsertMemoryVector,
  deleteMemoryVector,
  searchMemoryVectors,
  MEMORY_VEC_TABLE,
} from './sqlite-vec.js';

export { SqliteMemoryStore } from './memory-store.js';
export type { SqliteMemoryStoreOptions } from './memory-store.js';

export { SqliteWisdomStore } from './wisdom-store.js';

export { SqliteConceptGraph } from './cognition-store.js';
export type { SqliteConceptGraphOptions } from './cognition-store.js';

export { KnowledgeRegistry } from './knowledge-registry.js';
export type { KnowledgeSourceEntry } from './knowledge-registry.js';

export { SqliteBackfillCoverageStore } from './backfill-coverage.js';
