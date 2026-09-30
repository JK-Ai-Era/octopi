/**
 * Memory / Wisdom / Cognition 契约
 *
 * @layer harness/memory — Context Intelligence 存储协议。
 * 实现：InMemory* / Sqlite*（AgentDatabase）。非 Kernel。
 */

// ── Memory ──

/**
 * 记忆类型 — 蒸馏产物三类（见 docs/memory.md）
 *
 * - fact：稳定事实与已定结论（含环境、约定、否定结论）
 * - method：可复用做法或因果
 * - norm：以后怎么做（行为开关）
 */
export type MemoryType = 'fact' | 'method' | 'norm';

export const MEMORY_TYPES: readonly MemoryType[] = ['fact', 'method', 'norm'] as const;

/** 写入通道 — LLM 判断后结构化传入；代码只做映射不做 NL 意图识别 */
export type MemoryChannel =
  | 'user_directive'
  | 'decision'
  | 'fail_fix'
  | 'model_inference'
  | 'admin';

/** 运行时置信状态 */
export type MemoryStatus = 'shadow' | 'active' | 'strengthened';

/** 软删除原因 */
export type SoftDeleteReason =
  | 'junk_recheck'
  | 'duplicate_loser'
  | 'superseded'
  | 'shadow_expired'
  | 'decay_unused'
  | 'capacity';

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
  /** 写入通道 */
  channel?: MemoryChannel;
  /** 置信状态；缺省视为 active */
  status?: MemoryStatus;
  /** 何时/如何使用（条件句） */
  futureUse?: string;
  /** 检索锚点 */
  anchors?: string[];
  /** 证据原话/定位 */
  evidence?: string;
  /** 最近强化时间 */
  reinforcedAt?: number;
  /** 软删除 */
  deleted?: boolean;
  deletedAt?: number;
  deletedBy?: string;
  deletedReason?: SoftDeleteReason | string;
  deletedMeta?: Record<string, unknown>;
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
  /** 是否包含 shadow（默认 false：注入路径；search 工具为 true） */
  includeShadow?: boolean;
  /** 是否包含已软删（默认 false） */
  includeDeleted?: boolean;
  status?: MemoryStatus | MemoryStatus[];
  channel?: MemoryChannel | MemoryChannel[];
}

/** 记忆统计 */
export interface MemoryStats {
  /** 未软删条数 */
  totalEntries: number;
  byType: Record<MemoryType, number>;
  avgConfidence: number;
  avgImportance: number;
  /** 已软删条数 */
  deletedEntries?: number;
  /** shadow 条数（未删） */
  shadowEntries?: number;
}

/** MemoryStore — 记忆存储接口 */
export interface MemoryStore {
  readonly name: string;
  store(entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>): Promise<string>;
  retrieve(query: MemoryQuery): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | null>;
  update(id: string, patch: Partial<MemoryEntry>): Promise<void>;
  delete(id: string): Promise<void>;
  /** 软删除（治理默认路径） */
  softDelete(id: string, meta: { by: string; reason: SoftDeleteReason | string; winnerId?: string }): Promise<void>;
  undelete(id: string): Promise<void>;
  /** 治理批量读取 */
  listForGovern(filter?: { includeDeleted?: boolean }): Promise<MemoryEntry[]>;
  /** 按类型曲线衰减 idle 条目；返回本轮改动条数 */
  decay(options?: {
    typeParams?: Partial<Record<MemoryType, { idleDays?: number; factor?: number; min?: number }>>;
  }): Promise<number>;
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

// ── 写入槽位（memory 工具 / Steward 共用） ──

export interface MemoryWriteSlot {
  type: MemoryType;
  /** 原子命题 */
  proposition: string;
  /** 证据原话或定位 */
  evidence: string;
  /** 当…时应/不应… */
  futureUse?: string;
  anchors?: string[];
  channel: MemoryChannel;
  importance?: number;
  tags?: string[];
}

/** 门控/置信度可调用的 store 入参 */
export type MemoryStoreInput = Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>;
