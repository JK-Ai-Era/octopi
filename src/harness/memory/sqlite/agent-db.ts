/**
 * AgentDatabase — Per-agent SQLite 数据库管理
 *
 * 每个 agent 拥有独立的 SQLite 数据库文件（agent.db），
 * 存储 Memory、Cognition、Wisdom、Knowledge 注册表数据。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AgentDatabaseOptions {
  /** 数据库文件路径（默认 ':memory:'） */
  dbPath?: string;
  /** WAL 模式（默认 true） */
  wal?: boolean;
}

export class AgentDatabase {
  private db: any;

  private constructor(db: any) {
    this.db = db;
  }

  /**
   * 异步工厂方法
   */
  static async create(options?: AgentDatabaseOptions): Promise<AgentDatabase> {
    let Database: any;
    try {
      const mod = await import('better-sqlite3');
      Database = mod.default ?? mod;
    } catch {
      throw new Error(
        'AgentDatabase requires "better-sqlite3". Install it with: npm install better-sqlite3'
      );
    }

    const dbPath = options?.dbPath ?? ':memory:';

    // 确保目录存在
    if (dbPath !== ':memory:') {
      await mkdir(dirname(dbPath), { recursive: true });
    }

    const db = new Database(dbPath);

    // WAL 模式
    if (options?.wal !== false) {
      db.pragma('journal_mode = WAL');
    }

    const agentDb = new AgentDatabase(db);
    agentDb.createTables();
    return agentDb;
  }

  /**
   * 创建所有表结构
   */
  private createTables(): void {
    this.db.exec(`
      -- ── Memory 表 ──
      CREATE TABLE IF NOT EXISTS memories (
        id              TEXT PRIMARY KEY,
        type            TEXT NOT NULL,
        content         TEXT NOT NULL,
        source          TEXT NOT NULL,
        confidence      REAL NOT NULL DEFAULT 0.5,
        importance      REAL NOT NULL DEFAULT 0.5,
        access_count    INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        decay_factor    REAL NOT NULL DEFAULT 1.0,
        tags            TEXT NOT NULL DEFAULT '[]',
        embedding       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

      -- ── Concept 表 ──
      CREATE TABLE IF NOT EXISTS concepts (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        frequency   INTEGER NOT NULL DEFAULT 1,
        memory_ids  TEXT NOT NULL DEFAULT '[]',
        properties  TEXT NOT NULL DEFAULT '[]',
        embedding   TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_concepts_name ON concepts(name);

      -- ── Concept Edge 表 ──
      CREATE TABLE IF NOT EXISTS concept_edges (
        id            TEXT PRIMARY KEY,
        source_id     TEXT NOT NULL REFERENCES concepts(id),
        target_id     TEXT NOT NULL REFERENCES concepts(id),
        relation_type TEXT NOT NULL,
        strength      REAL NOT NULL DEFAULT 0.5,
        description   TEXT,
        constraints   TEXT NOT NULL DEFAULT '[]',
        created_at    INTEGER NOT NULL,
        UNIQUE(source_id, target_id, relation_type)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON concept_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON concept_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON concept_edges(relation_type);

      -- ── Wisdom 表 ──
      CREATE TABLE IF NOT EXISTS wisdom (
        id                    TEXT PRIMARY KEY,
        content               TEXT NOT NULL,
        derived_from          TEXT NOT NULL DEFAULT '[]',
        priority              INTEGER NOT NULL DEFAULT 0,
        confidence            REAL NOT NULL DEFAULT 0.5,
        applicable_scenarios  TEXT NOT NULL DEFAULT '[]',
        status                TEXT NOT NULL DEFAULT 'active',
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      -- ── Knowledge Sources 注册表 ──
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        location    TEXT NOT NULL,
        scope       TEXT NOT NULL,
        metadata    TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL
      );
    `);
  }

  /**
   * 获取原始数据库实例（供子模块使用）
   */
  get raw(): any {
    return this.db;
  }

  /**
   * 生成短 ID
   */
  static generateId(prefix?: string): string {
    const id = randomUUID().slice(0, 12);
    return prefix ? `${prefix}_${id}` : id;
  }

  /**
   * 关闭数据库
   */
  close(): void {
    this.db.close();
  }

  /**
   * 统计信息
   */
  stats(): Record<string, number> {
    const tables = ['memories', 'concepts', 'concept_edges', 'wisdom', 'knowledge_sources'];
    const result: Record<string, number> = {};
    for (const table of tables) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
        result[table] = row.count;
      } catch {
        result[table] = 0;
      }
    }
    return result;
  }
}
