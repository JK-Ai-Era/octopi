/**
 * Memory 类型定义
 *
 * @layer harness/memory — 记忆领域的类型和接口。
 *
 * 包含：MemoryType、MemoryEntry、MemoryQuery、MemoryStore、MemoryStats
 */

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
}

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

/** 记忆统计 */
export interface MemoryStats {
  totalEntries: number;
  byType: Record<MemoryType, number>;
  avgConfidence: number;
  avgImportance: number;
}

/**
 * MemoryStore — 记忆存储接口
 */
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
