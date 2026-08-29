/**
 * KnowledgeStore 类型定义
 */

// ── 知识条目 ──

/** 知识类型 */
export type KnowledgeType = 'fact' | 'pattern' | 'lesson' | 'preference' | 'skill';

/** 知识条目 */
export interface KnowledgeEntry {
  /** 唯一 ID */
  id: string;
  /** 知识类型 */
  type: KnowledgeType;
  /** 知识内容 */
  content: string;
  /** 来源（session、task、user 等） */
  source: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 访问次数 */
  accessCount: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 标签（用于过滤和分类） */
  tags: string[];
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

// ── 查询选项 ──

/** 检索选项 */
export interface RetrieveOptions {
  /** 按类型过滤 */
  type?: KnowledgeType | KnowledgeType[];
  /** 按标签过滤 */
  tags?: string[];
  /** 最小置信度 */
  minConfidence?: number;
  /** 返回数量限制 */
  limit?: number;
  /** 是否更新访问计数 */
  updateAccess?: boolean;
}

// ── KnowledgeStore 接口 ──

/**
 * KnowledgeStore — 知识存储接口
 *
 * 存储和检索 Agent 积累的知识。
 * Harness 层可以实现多种后端：内存、文件、向量数据库。
 */
export interface KnowledgeStore {
  /** 存储名称 */
  readonly name: string;

  /**
   * 存储一条知识
   */
  store(entry: Omit<KnowledgeEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'updatedAt'>): Promise<string>;

  /**
   * 更新一条知识
   */
  update(id: string, patch: Partial<KnowledgeEntry>): Promise<void>;

  /**
   * 检索相关知识（关键词匹配）
   */
  retrieve(query: string, options?: RetrieveOptions): Promise<KnowledgeEntry[]>;

  /**
   * 获取单条知识
   */
  get(id: string): Promise<KnowledgeEntry | null>;

  /**
   * 删除一条知识
   */
  delete(id: string): Promise<void>;

  /**
   * 列出所有知识（支持过滤）
   */
  list(options?: RetrieveOptions): Promise<KnowledgeEntry[]>;

  /**
   * 统计信息
   */
  stats(): Promise<KnowledgeStats>;
}

/** 知识统计 */
export interface KnowledgeStats {
  totalEntries: number;
  byType: Record<KnowledgeType, number>;
  avgConfidence: number;
  totalAccesses: number;
}
