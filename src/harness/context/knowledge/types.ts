/**
 * KnowledgeStore 类型
 *
 * @layer harness/context/knowledge — Context Intelligence 第 4 层存储协议。
 */

/** 知识类型 */
export type KnowledgeType = 'fact' | 'pattern' | 'lesson' | 'preference' | 'skill';

/** 知识条目 */
export interface KnowledgeEntry {
  id: string;
  type: KnowledgeType;
  content: string;
  source: string;
  confidence: number;
  accessCount: number;
  lastAccessedAt: number;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  metadata?: Record<string, unknown>;
}

/** 检索选项 */
export interface RetrieveOptions {
  type?: KnowledgeType | KnowledgeType[];
  tags?: string[];
  minConfidence?: number;
  limit?: number;
  updateAccess?: boolean;
}

/** 知识统计 */
export interface KnowledgeStats {
  totalEntries: number;
  byType: Record<KnowledgeType, number>;
  avgConfidence: number;
  totalAccesses: number;
}

/** KnowledgeStore — 知识存储接口 */
export interface KnowledgeStore {
  readonly name: string;
  store(entry: Omit<KnowledgeEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'updatedAt'>): Promise<string>;
  update(id: string, patch: Partial<KnowledgeEntry>): Promise<void>;
  retrieve(query: string, options?: RetrieveOptions): Promise<KnowledgeEntry[]>;
  get(id: string): Promise<KnowledgeEntry | null>;
  delete(id: string): Promise<void>;
  list(options?: RetrieveOptions): Promise<KnowledgeEntry[]>;
  stats(): Promise<KnowledgeStats>;
}
