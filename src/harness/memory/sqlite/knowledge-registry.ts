/**
 * KnowledgeRegistry — 知识源注册表
 *
 * @module
 */

import { AgentDatabase } from './agent-db.js';

export interface KnowledgeSourceEntry {
  id: string;
  type: 'directory' | 'file' | 'url' | 'api' | 'database';
  location: string;
  scope: string;
  metadata: {
    description?: string;
    filePatterns?: string[];
    maxDepth?: number;
  };
  createdAt: number;
}

export class KnowledgeRegistry {
  private db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.db = db;
  }

  /**
   * 注册知识源
   */
  register(source: Omit<KnowledgeSourceEntry, 'createdAt'>): void {
    this.db.raw.prepare(`
      INSERT OR REPLACE INTO knowledge_sources (id, type, location, scope, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      source.id,
      source.type,
      source.location,
      source.scope,
      JSON.stringify(source.metadata),
      Date.now(),
    );
  }

  /**
   * 获取所有知识源
   */
  list(): KnowledgeSourceEntry[] {
    const rows = this.db.raw.prepare('SELECT * FROM knowledge_sources ORDER BY created_at').all() as any[];
    return rows.map(r => this.rowToEntry(r));
  }

  /**
   * 按 scope 获取知识源
   */
  listByScope(scope: string): KnowledgeSourceEntry[] {
    const rows = this.db.raw.prepare(
      'SELECT * FROM knowledge_sources WHERE scope = ? ORDER BY created_at'
    ).all(scope) as any[];
    return rows.map(r => this.rowToEntry(r));
  }

  /**
   * 获取单个知识源
   */
  get(id: string): KnowledgeSourceEntry | null {
    const row = this.db.raw.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(id) as any;
    return row ? this.rowToEntry(row) : null;
  }

  /**
   * 删除知识源
   */
  remove(id: string): void {
    this.db.raw.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);
  }

  private rowToEntry(row: any): KnowledgeSourceEntry {
    return {
      id: row.id,
      type: row.type,
      location: row.location,
      scope: row.scope,
      metadata: JSON.parse(row.metadata),
      createdAt: row.created_at,
    };
  }
}
