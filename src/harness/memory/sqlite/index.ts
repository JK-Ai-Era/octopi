/**
 * SQLite 存储层 — 七层上下文模型的 SQLite 存储实现
 *
 * @module
 */

export { AgentDatabase } from './agent-db.js';
export type { AgentDatabaseOptions } from './agent-db.js';

export { createEmbeddingProvider } from './embedding.js';
export type { EmbeddingProvider, EmbeddingConfig } from './embedding.js';

export { cosineSimilarity, cosineDistance, searchTopK, parseEmbedding, serializeEmbedding } from './vector-search.js';
export type { VectorSearchResult } from './vector-search.js';

export { SqliteMemoryStore } from './memory-store.js';
export type { SqliteMemoryStoreOptions } from './memory-store.js';

export { SqliteWisdomStore } from './wisdom-store.js';

export { SqliteConceptGraph } from './cognition-store.js';
export type { SqliteConceptGraphOptions } from './cognition-store.js';

export { KnowledgeRegistry } from './knowledge-registry.js';
export type { KnowledgeSourceEntry } from './knowledge-registry.js';
