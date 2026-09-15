/**
 * Memory / Wisdom / Cognition 契约
 *
 * @layer harness/memory — Context Intelligence 存储协议。
 * 实现：InMemory* / Sqlite*（AgentDatabase）。非 Kernel。
 */

// ── Memory ──

/** 记忆类型 */
export type MemoryType =
  | 'preference'
  | 'decision'
  | 'lesson'
  | 'discovery'
  | 'context'
  | 'relationship';

/** 记忆条目 */
export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  source: string;
  confidence: number;
  importance: number;
  accessCount: number;
  lastAccessedAt: number;
  createdAt: number;
  decayFactor: number;
  tags: string[];
}

/** 记忆查询 */
export interface MemoryQuery {
  text: string;
  type?: MemoryType | MemoryType[];
  tags?: string[];
  minConfidence?: number;
  minImportance?: number;
  limit?: number;
  updateAccess?: boolean;
}

/** 记忆统计 */
export interface MemoryStats {
  totalEntries: number;
  byType: Record<MemoryType, number>;
  avgConfidence: number;
  avgImportance: number;
}

/** MemoryStore — 记忆存储接口 */
export interface MemoryStore {
  readonly name: string;
  store(entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>): Promise<string>;
  retrieve(query: MemoryQuery): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | null>;
  update(id: string, patch: Partial<MemoryEntry>): Promise<void>;
  delete(id: string): Promise<void>;
  decay(): Promise<number>;
  stats(): Promise<MemoryStats>;
}

// ── Wisdom ──

/** 智慧条目 — 思维范式 */
export interface WisdomEntry {
  id: string;
  content: string;
  derivedFrom: string[];
  priority: number;
  confidence?: number;
  createdAt: number;
  applicableScenarios?: string[];
}

/** WisdomStore — 智慧存储接口 */
export interface WisdomStore {
  store(entry: Omit<WisdomEntry, 'id' | 'createdAt'>): Promise<string>;
  getAll(): Promise<WisdomEntry[]>;
  delete(id: string): Promise<void>;
}

// ── Cognition ──

/** 概念节点 */
export interface ConceptNode {
  id: string;
  name: string;
  description?: string;
  frequency: number;
  memoryIds: string[];
}

/** 概念关系 */
export interface ConceptEdge {
  sourceId: string;
  targetId: string;
  relationType: 'causes' | 'part_of' | 'opposes' | 'similar_to' | 'evolves_to' | 'related';
  strength: number;
  description?: string;
}

/** 认知图谱 */
export interface ConceptGraph {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
}

/** ConceptGraphStore — 认知图谱存储接口 */
export interface ConceptGraphStore {
  addConcept(concept: Omit<ConceptNode, 'id' | 'frequency' | 'memoryIds'>): Promise<string>;
  addEdge(edge: ConceptEdge): Promise<void>;
  queryRelated(conceptName: string, depth?: number): Promise<ConceptGraph>;
  extractFromText(text: string, memoryId: string): Promise<void>;
  getFullGraph(): Promise<ConceptGraph>;
}
