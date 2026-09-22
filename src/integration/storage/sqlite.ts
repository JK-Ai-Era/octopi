/**
 * SQLite Session Store
 *
 * 基于内置 node:sqlite 的 Session 存储后端（Node.js >= 24）。
 * 主键 = sessionId（Session 一等）；agent_id 列保留作参与过滤投影。
 *
 * 表结构：
 * - sessions: session 元数据 + 完整数据（JSON blob）
 *
 * 使用 SqliteSessionStore.create() 工厂方法创建实例。
 *
 * @module
 */

import type { DatabaseSync } from 'node:sqlite';
import type { SessionStore, SessionListFilter } from '../../core/interfaces/session-store.js';
import type { SessionData, SessionLifecycleMeta, SessionLifecycleStatus, MemoryExtractionStatus } from '../../harness/session-types.js';
import type { SessionMeta } from '../../core/types.js';
import { sessionMatchesAgent } from './memory.js';

export interface SqliteSessionStoreOptions {
  /** 数据库文件路径（默认 ':memory:'） */
  dbPath?: string;
  /** WAL 模式（默认 true，提升并发读性能） */
  wal?: boolean;
  /** busy timeout（毫秒，默认 5000；多进程写同一 sessions.db 时避免立刻 SQLITE_BUSY） */
  busyTimeoutMs?: number;
}

function toMeta(s: SessionData): SessionMeta {
  return {
    ...s.meta,
    primaryAgentId: s.primaryAgentId ?? s.meta.primaryAgentId,
    preferredAgentId: s.preferredAgentId ?? s.meta.preferredAgentId,
    participantAgentIds:
      s.meta.participantAgentIds ??
      (s.participants ?? []).map((p) => p.agentId),
  };
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

  private db: DatabaseSync;
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
   * 异步工厂方法（内置 node:sqlite，需 Node.js >= 24）
   */
  static async create(options?: SqliteSessionStoreOptions): Promise<SqliteSessionStore> {
    let DatabaseSyncCtor: typeof DatabaseSync;
    try {
      const mod = await import('node:sqlite');
      DatabaseSyncCtor = mod.DatabaseSync;
    } catch {
      throw new Error(
        `SqliteSessionStore requires Node.js >= 24 built-in "node:sqlite". Current process.version=${process.version}`
      );
    }
    return new SqliteSessionStore(DatabaseSyncCtor, options);
  }

  private constructor(DatabaseSyncCtor: typeof DatabaseSync, options?: SqliteSessionStoreOptions) {
    const dbPath = options?.dbPath ?? ':memory:';
    this.db = new DatabaseSyncCtor(dbPath, {
      timeout: options?.busyTimeoutMs ?? 5000,
      enableForeignKeyConstraints: false,
    });

    if (options?.wal !== false) {
      this.db.exec('PRAGMA journal_mode = WAL');
    }

    // 创建表（id = sessionId 一等主键；agent_id 为创建/归属投影）
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
          agent_id = excluded.agent_id,
          updated_at = excluded.updated_at
      `),
      delete: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
      list: this.db.prepare('SELECT data FROM sessions'),
      listByLifecycle: this.db.prepare('SELECT data, lifecycle, memory_extraction, ended_at, archived_at FROM sessions WHERE lifecycle = ?'),
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
    const json = JSON.stringify({ ...data, id: sessionId });
    const createdAt = data.meta?.createdAt ?? now;
    const agentId = data.primaryAgentId ?? data.agentId ?? data.meta?.agentId ?? 'default';

    this.stmts.upsert.run(sessionId, agentId, json, createdAt, now);
  }

  async list(filter?: SessionListFilter): Promise<SessionMeta[]> {
    const rows = this.stmts.list.all() as { data: string }[];
    const metas = rows
      .map(r => {
        try {
          const s = JSON.parse(r.data) as SessionData;
          return toMeta(s);
        } catch { return null; }
      })
      .filter((m): m is SessionMeta => m !== null);
    if (!filter?.agentId) return metas;
    const agentId = filter.agentId;
    return metas.filter((m) => sessionMatchesAgent(m, agentId));
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
    const row = this.db.prepare(
      'SELECT lifecycle, memory_extraction, ended_at, archived_at FROM sessions WHERE id = ?'
    ).get(sessionId) as { lifecycle: string; memory_extraction: string; ended_at: number | null; archived_at: number | null } | undefined;
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
  async listByLifecycle(lifecycle: SessionLifecycleStatus): Promise<SessionData[]> {
    const rows = this.stmts.listByLifecycle.all(lifecycle) as Array<{ data: string; lifecycle: string; memory_extraction: string; ended_at: number | null; archived_at: number | null }>;
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
   * 获取所有 agent ID（参与投影）
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
