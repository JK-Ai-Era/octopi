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
export { FileWisdomStore } from './wisdom.js';
export { FileProjectMemory } from './project-memory.js';
export { InMemoryConceptGraph } from './cognition.js';
export { ContextIntelligence } from './context-intelligence.js';
export type { ContextIntelligenceConfig, AssembledContext } from './context-intelligence.js';

// ── SQLite 实现 ──
export { AgentDatabase, SqliteMemoryStore, SqliteWisdomStore, SqliteConceptGraph, KnowledgeRegistry, createEmbeddingProvider } from './sqlite/index.js';
export type { AgentDatabaseOptions, SqliteMemoryStoreOptions, SqliteConceptGraphOptions, EmbeddingProvider, EmbeddingConfig, KnowledgeSourceEntry } from './sqlite/index.js';
