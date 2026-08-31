/**
 * SQLite Session Store
 *
 * 基于 better-sqlite3 的 Session 存储后端。
 * 适用于需要高性能、结构化查询的场景。
 *
 * 表结构：
 * - sessions: session 元数据 + 完整数据（JSON blob）
 *
 * 使用 SqliteSessionStore.create() 工厂方法创建实例（异步加载 better-sqlite3）。
 *
 * @module
 */

import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData, SessionLifecycleMeta, SessionLifecycleStatus, MemoryExtractionStatus } from '../../harness/session-types.js';
import type { SessionMeta } from '../../core/types.js';

export interface SqliteSessionStoreOptions {
  /** 数据库文件路径（默认 ':memory:'） */
  dbPath?: string;
  /** WAL 模式（默认 true，提升并发读性能） */
  wal?: boolean;
}

/**
 * SQLite Session Store
 *
 * @example
 * ```ts
 * const store = await SqliteSessionStore.create({ dbPath: './data/sessions.db' });
 * await store.save('sess-1', sessionData);
 * const session = await store.load('sess-1');
 * ```
 */
export class SqliteSessionStore implements SessionStore<SessionData> {

  private db: any;
  private stmts: {
    get: any;
    upsert: any;
    delete: any;
    list: any;
    listByLifecycle: any;
    exists: any;
    updateLifecycle: any;
  };

  /**
   * 异步工厂方法
   *
   * 使用 dynamic import 加载 better-sqlite3，避免硬依赖。
   * 未安装 better-sqlite3 时抛出明确错误。
   */
  static async create(options?: SqliteSessionStoreOptions): Promise<SqliteSessionStore> {
    let Database: any;
    try {
      const mod = await import('better-sqlite3');
      Database = mod.default ?? mod;
    } catch {
      throw new Error(
        'SqliteSessionStore requires "better-sqlite3". Install it with: npm install better-sqlite3'
      );
    }
    return new SqliteSessionStore(Database, options);
  }

  private constructor(Database: any, options?: SqliteSessionStoreOptions) {
    const dbPath = options?.dbPath ?? ':memory:';
    this.db = new Database(dbPath);

    // WAL 模式
    if (options?.wal !== false) {
      this.db.pragma('journal_mode = WAL');
    }

    // 创建表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'active',
        memory_extraction TEXT NOT NULL DEFAULT 'pending',
        ended_at INTEGER,
        archived_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_lifecycle ON sessions(lifecycle);
    `);

    // 预编译语句
    this.stmts = {
      get: this.db.prepare('SELECT data, lifecycle, memory_extraction, ended_at, archived_at FROM sessions WHERE id = ?'),
      upsert: this.db.prepare(`
        INSERT INTO sessions (id, agent_id, data, created_at, updated_at, lifecycle, memory_extraction)
        VALUES (?, ?, ?, ?, ?, 'active', 'pending')
        ON CONFLICT(id) DO UPDATE SET
          data = excluded.data,
          updated_at = excluded.updated_at
      `),
      delete: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
      list: this.db.prepare('SELECT data FROM sessions WHERE agent_id = ?'),
      listByLifecycle: this.db.prepare('SELECT data, lifecycle, memory_extraction, ended_at, archived_at FROM sessions WHERE agent_id = ? AND lifecycle = ?'),
      exists: this.db.prepare('SELECT 1 FROM sessions WHERE id = ?'),
      updateLifecycle: this.db.prepare(`
        UPDATE sessions SET lifecycle = ?, memory_extraction = ?, ended_at = ?, archived_at = ?
        WHERE id = ?
      `),
    };
  }

  async load(sessionId: string): Promise<SessionData | null> {
    const row = this.stmts.get.get(sessionId) as { data: string; lifecycle: string; memory_extraction: string; ended_at: number | null; archived_at: number | null } | undefined;
    if (!row) return null;
    try {
      const data = JSON.parse(row.data) as SessionData;
      data.lifecycle = {
        lifecycle: row.lifecycle as SessionLifecycleStatus,
        memoryExtraction: row.memory_extraction as MemoryExtractionStatus,
        endedAt: row.ended_at ?? undefined,
        archivedAt: row.archived_at ?? undefined,
      };
      return data;
    } catch {
      return null;
    }
  }

  async save(sessionId: string, data: SessionData): Promise<void> {
    const now = Date.now();
    const json = JSON.stringify(data);
    const agentId = data.agentId ?? 'default';
    const createdAt = data.meta?.createdAt ?? now;

    this.stmts.upsert.run(sessionId, agentId, json, createdAt, now);
  }

  async list(agentId: string): Promise<SessionMeta[]> {
    const rows = this.stmts.list.all(agentId) as { data: string }[];
    return rows
      .map(r => {
        try {
          const s = JSON.parse(r.data) as SessionData;
          return s.meta;
        } catch { return null; }
      })
      .filter((m): m is SessionMeta => m !== null);
  }

  async delete(sessionId: string): Promise<void> {
    this.stmts.delete.run(sessionId);
  }

  async exists(sessionId: string): Promise<boolean> {
    return !!this.stmts.exists.get(sessionId);
  }

  /**
   * 更新 session 生命周期状态
   */
  async updateLifecycle(sessionId: string, lifecycle: Partial<SessionLifecycleMeta>): Promise<void> {
    const row = this.stmts.get.get(sessionId) as { lifecycle: string; memory_extraction: string; ended_at: number | null; archived_at: number | null } | undefined;
    if (!row) return;

    this.stmts.updateLifecycle.run(
      lifecycle.lifecycle ?? row.lifecycle,
      lifecycle.memoryExtraction ?? row.memory_extraction,
      lifecycle.endedAt ?? row.ended_at,
      lifecycle.archivedAt ?? row.archived_at,
      sessionId,
    );
  }

  /**
   * 按生命周期状态列出 session
   */
  async listByLifecycle(agentId: string, lifecycle: SessionLifecycleStatus): Promise<SessionData[]> {
    const rows = this.stmts.listByLifecycle.all(agentId, lifecycle) as Array<{ data: string; lifecycle: string; memory_extraction: string; ended_at: number | null; archived_at: number | null }>;
    return rows
      .map(r => {
        try {
          const data = JSON.parse(r.data) as SessionData;
          data.lifecycle = {
            lifecycle: r.lifecycle as SessionLifecycleStatus,
            memoryExtraction: r.memory_extraction as MemoryExtractionStatus,
            endedAt: r.ended_at ?? undefined,
            archivedAt: r.archived_at ?? undefined,
          };
          return data;
        } catch { return null; }
      })
      .filter((d): d is SessionData => d !== null);
  }

  /**
   * 标记 session 结束
   */
  async markEnded(sessionId: string): Promise<void> {
    await this.updateLifecycle(sessionId, {
      lifecycle: 'recent',
      endedAt: Date.now(),
    });
  }

  /**
   * 获取所有 agent ID
   */
  getAgentIds(): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT agent_id FROM sessions'
    ).all() as Array<{ agent_id: string }>;
    return rows.map(r => r.agent_id);
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
  }

  /**
   * 获取统计信息
   */
  stats(): { totalSessions: number; agentCount: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count;
    const agents = (this.db.prepare('SELECT COUNT(DISTINCT agent_id) as count FROM sessions').get() as { count: number }).count;
    return { totalSessions: total, agentCount: agents };
  }
}
