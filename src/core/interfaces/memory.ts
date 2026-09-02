/**
 * Memory 接口定义 — 向后兼容 re-export
 *
 * @layer core — 这些类型的实际定义在 harness/memory/ 领域。
 * 此文件仅提供向后兼容的 re-export，新代码应直接从 harness/memory/ 导入。
 *
 * 三层抽象：
 * - Memory：从交互中提取的有价值内容
 * - Cognition：概念关系网络（从记忆和知识中提取）
 * - Wisdom：思维范式（从反思中提炼）
 */

export type {
  MemoryType,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryStore,
} from '../../harness/memory/types.js';

export type {
  WisdomEntry,
  WisdomStore,
} from '../../harness/memory/wisdom-types.js';

export type {
  ConceptNode,
  ConceptEdge,
  ConceptGraph,
  ConceptGraphStore,
} from '../../harness/memory/cognition-types.js';
