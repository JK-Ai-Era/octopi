/**
 * Memory 接口定义
 *
 * @layer core — 定义记忆系统的契约，由 harness/memory/ 实现。
 *
 * 三层抽象：
 * - Memory：从交互中提取的有价值内容
 * - Cognition：概念关系网络（从记忆和知识中提取）
 * - Wisdom：思维范式（从反思中提炼）
 */

// ── 记忆条目 ──

/** 记忆类型 */
export type MemoryType =
  | 'preference'    // 用户偏好
  | 'decision'      // 重要决策
  | 'lesson'        // 踩过的坑
  | 'discovery'     // 关键发现
  | 'context'       // 项目/任务上下文
  | 'relationship'; // 实体关系

/** 记忆条目 */
export interface MemoryEntry {
  /** 唯一 ID */
  id: string;
  /** 记忆类型 */
  type: MemoryType;
  /** 记忆内容（自然语言描述） */
  content: string;
  /** 来源（session ID、task ID 等） */
  source: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 重要性 0-1（影响检索优先级） */
  importance: number;
  /** 访问次数 */
  accessCount: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 创建时间 */
  createdAt: number;
  /** 衰减因子（每次检索时衰减） */
  decayFactor: number;
  /** 标签 */
  tags: string[];
  /** 关联概念（用于认知图谱） */
  concepts?: string[];
}

// ── 智慧条目 ──

/** 智慧条目 — 思维范式 */
export interface WisdomEntry {
  /** 唯一 ID */
  id: string;
  /** 智慧内容（思维框架描述） */
  content: string;
  /** 来源（从哪些记忆/反思中提炼） */
  derivedFrom: string[];
  /** 优先级（影响在 system prompt 中的位置） */
  priority: number;
  /** 创建时间 */
  createdAt: number;
  /** 适用场景 */
  applicableScenarios?: string[];
}

// ── 认知图谱 ──

/** 概念节点 */
export interface ConceptNode {
  /** 概念 ID */
  id: string;
  /** 概念名称 */
  name: string;
  /** 概念描述 */
  description?: string;
  /** 出现次数 */
  frequency: number;
  /** 关联的记忆 ID */
  memoryIds: string[];
}

/** 概念关系 */
export interface ConceptEdge {
  /** 源概念 */
  sourceId: string;
  /** 目标概念 */
  targetId: string;
  /** 关系类型 */
  relationType: 'causes' | 'part_of' | 'opposes' | 'similar_to' | 'evolves_to' | 'related';
  /** 关系强度 0-1 */
  strength: number;
  /** 关系描述 */
  description?: string;
}

/** 认知图谱 */
export interface ConceptGraph {
  /** 概念节点 */
  nodes: ConceptNode[];
  /** 概念关系 */
  edges: ConceptEdge[];
}

// ── 查询类型 ──

/** 记忆查询 */
export interface MemoryQuery {
  /** 查询文本 */
  text: string;
  /** 按类型过滤 */
  type?: MemoryType | MemoryType[];
  /** 按标签过滤 */
  tags?: string[];
  /** 最小置信度 */
  minConfidence?: number;
  /** 最小重要性 */
  minImportance?: number;
  /** 返回数量限制 */
  limit?: number;
  /** 是否更新访问计数 */
  updateAccess?: boolean;
}

// ── MemoryStore 接口 ──

/**
 * MemoryStore — 记忆存储接口
 *
 * 存储和检索 Agent 积累的记忆。
 */
export interface MemoryStore {
  /** 存储名称 */
  readonly name: string;

  /** 存储一条记忆 */
  store(entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>): Promise<string>;

  /** 检索相关记忆 */
  retrieve(query: MemoryQuery): Promise<MemoryEntry[]>;

  /** 获取单条记忆 */
  get(id: string): Promise<MemoryEntry | null>;

  /** 更新记忆 */
  update(id: string, patch: Partial<MemoryEntry>): Promise<void>;

  /** 删除记忆 */
  delete(id: string): Promise<void>;

  /** 衰减所有记忆（定期调用） */
  decay(): Promise<number>;

  /** 统计信息 */
  stats(): Promise<MemoryStats>;
}

/** 记忆统计 */
export interface MemoryStats {
  totalEntries: number;
  byType: Record<MemoryType, number>;
  avgConfidence: number;
  avgImportance: number;
}

// ── WisdomStore 接口 ──

/**
 * WisdomStore — 智慧存储接口
 */
export interface WisdomStore {
  /** 存储一条智慧 */
  store(entry: Omit<WisdomEntry, 'id' | 'createdAt'>): Promise<string>;

  /** 获取所有智慧（按优先级排序） */
  getAll(): Promise<WisdomEntry[]>;

  /** 删除智慧 */
  delete(id: string): Promise<void>;
}

// ── ConceptGraphStore 接口 ──

/**
 * ConceptGraphStore — 认知图谱存储接口
 */
export interface ConceptGraphStore {
  /** 添加概念 */
  addConcept(concept: Omit<ConceptNode, 'id' | 'frequency' | 'memoryIds'>): Promise<string>;

  /** 添加关系 */
  addEdge(edge: ConceptEdge): Promise<void>;

  /** 查询相关概念 */
  queryRelated(conceptName: string, depth?: number): Promise<ConceptGraph>;

  /** 从文本提取概念和关系 */
  extractFromText(text: string, memoryId: string): Promise<void>;

  /** 获取完整图谱 */
  getFullGraph(): Promise<ConceptGraph>;
}

// ── 项目记忆接口 ──

/**
 * ProjectMemory — 项目记忆接口
 *
 * 类似 CLAUDE.md 的项目级指令文件。
 */
export interface ProjectMemory {
  /** 项目根目录 */
  readonly root: string;

  /** 加载项目记忆 */
  load(): Promise<string>;

  /** 追加内容 */
  append(content: string): Promise<void>;

  /** 更新内容 */
  update(content: string): Promise<void>;
}
