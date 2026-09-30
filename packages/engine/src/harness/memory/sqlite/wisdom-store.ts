/**
 * SqliteWisdomStore — SQLite 智慧存储
 *
 * @module
 */

import type {
  WisdomStore,
  WisdomEntry,
} from '../wisdom-types.js';
import { AgentDatabase } from './agent-db.js';

export class SqliteWisdomStore implements WisdomStore {
  private db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.db = db;
  }

  async store(entry: Omit<WisdomEntry, 'id' | 'createdAt'>): Promise<string> {
    const id = AgentDatabase.generateId('wis');
    const now = Date.now();

    this.db.raw.prepare(`
      INSERT INTO wisdom (id, content, derived_from, priority, confidence, applicable_scenarios, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      id,
      entry.content,
      JSON.stringify(entry.derivedFrom),
      entry.priority,
      entry.confidence ?? 0.5,
      JSON.stringify(entry.applicableScenarios ?? []),
      now,
      now,
    );

    return id;
  }

  async getAll(): Promise<WisdomEntry[]> {
    const rows = this.db.raw.prepare(
      "SELECT * FROM wisdom WHERE status = 'active' ORDER BY priority DESC"
    ).all() as any[];

    return rows.map(r => this.rowToEntry(r));
  }

  async delete(id: string): Promise<void> {
    this.db.raw.prepare("UPDATE wisdom SET status = 'retired' WHERE id = ?").run(id);
  }

  /**
   * 获取数量
   */
  count(): number {
    const row = this.db.raw.prepare("SELECT COUNT(*) as count FROM wisdom WHERE status = 'active'").get() as { count: number };
    return row.count;
  }

  /**
   * 淘汰最低优先级的 wisdom（超过上限时调用）
   */
  async evict(maxCount: number): Promise<number> {
    const current = this.count();
    if (current <= maxCount) return 0;

    const toEvict = current - maxCount;
    this.db.raw.prepare(`
      UPDATE wisdom SET status = 'retired'
      WHERE id IN (
        SELECT id FROM wisdom
        WHERE status = 'active'
        ORDER BY priority ASC, confidence ASC
        LIMIT ?
      )
    `).run(toEvict);

    return toEvict;
  }

  private rowToEntry(row: any): WisdomEntry {
    return {
      id: row.id,
      content: row.content,
      derivedFrom: JSON.parse(row.derived_from),
      priority: row.priority,
      createdAt: row.created_at,
      applicableScenarios: JSON.parse(row.applicable_scenarios),
    };
  }
}
