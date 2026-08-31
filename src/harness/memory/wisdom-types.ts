/**
 * Wisdom 类型定义
 *
 * @layer harness/memory — 智慧领域的类型和接口。
 */

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

/**
 * WisdomStore — 智慧存储接口
 */
export interface WisdomStore {
  store(entry: Omit<WisdomEntry, 'id' | 'createdAt'>): Promise<string>;
  getAll(): Promise<WisdomEntry[]>;
  delete(id: string): Promise<void>;
}
