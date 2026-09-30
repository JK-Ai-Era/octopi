/**
 * AgentDatabase — Per-agent SQLite 数据库管理
 *
 * 每个 agent 拥有独立的 SQLite 数据库文件（agent.db），
 * 存储 Memory、Cognition、Wisdom、Knowledge 注册表数据。
 *
 * 路径约定：由宿主通过 `dbPath` 传入。推荐放在 agent home 下
 * （例如 `<agentHome>/agent.db`）；init **不会**预建 `memory/`、`wisdom/`
 * 目录——那两层已不是文件目录，而是本库中的表。
 * 未传 `dbPath` 时默认 `:memory:`（仅开发/测试）。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ensureMemoryVecTable, tryLoadSqliteVec } from './sqlite-vec.js';

export interface AgentDatabaseOptions {
  /** 数据库文件路径（默认 ':memory:'） */
  dbPath?: string;
  /** WAL 模式（默认 true） */
  wal?: boolean;
  /** busy timeout（毫秒，默认 5000；与 journal mode 无关） */
  busyTimeoutMs?: number;
  /** 尝试加载 sqlite-vec 扩展（默认 false） */
  sqliteVec?: boolean | { extensionPath?: string };
  /** 向量维度；配合 sqlite-vec 时用于创建 memory_vec 虚拟表 */
  vectorDimensions?: number;
}

export class AgentDatabase {
  private db: DatabaseSync;
  private _sqliteVec = false;
  private _vecDimensions: number | null = null;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * 异步工厂方法（内置 node:sqlite，需 Node.js >= 24）
   */
  static async create(options?: AgentDatabaseOptions): Promise<AgentDatabase> {
    let DatabaseSyncCtor: typeof DatabaseSync;
    try {
      const mod = await import('node:sqlite');
      DatabaseSyncCtor = mod.DatabaseSync;
    } catch {
      throw new Error(
        `AgentDatabase requires Node.js >= 24 built-in "node:sqlite". Current process.version=${process.version}`
      );
    }

    const dbPath = options?.dbPath ?? ':memory:';

    // 确保目录存在
    if (dbPath !== ':memory:') {
      await mkdir(dirname(dbPath), { recursive: true });
    }

    const wantVec = Boolean(options?.sqliteVec);
    // timeout 独立于 WAL：对齐 better-sqlite3 默认 busy_timeout=5000
    // FK 保持关闭以对齐 better-sqlite3 默认行为（concept_edges 旧数据兼容）
    // allowExtension 仅在请求 sqlite-vec 时打开（Node 构造后无法补开）
    const db = new DatabaseSyncCtor(dbPath, {
      timeout: options?.busyTimeoutMs ?? 5000,
      allowExtension: wantVec,
      enableForeignKeyConstraints: false,
    });

    if (options?.wal !== false) {
      db.exec('PRAGMA journal_mode = WAL');
    }

    const agentDb = new AgentDatabase(db);
    agentDb.createTables();

    // 可选：sqlite-vec + memory_vec 虚拟表
    const vecOpt = options?.sqliteVec;
    if (vecOpt) {
      const extensionPath = typeof vecOpt === 'object' ? vecOpt.extensionPath : undefined;
      const loaded = await tryLoadSqliteVec(db, extensionPath);
      agentDb._sqliteVec = loaded;
      if (loaded && options?.vectorDimensions) {
        const ok = ensureMemoryVecTable(db, options.vectorDimensions);
        agentDb._vecDimensions = ok ? options.vectorDimensions : null;
      }
    }

    return agentDb;
  }

  /** sqlite-vec 扩展是否已加载 */
  get sqliteVecEnabled(): boolean {
    return this._sqliteVec;
  }

  /** 已创建的 vec 表维度；未启用时为 null */
  get vectorDimensions(): number | null {
    return this._vecDimensions;
  }

  /** 旧库升级：补齐 memories 治理列 + 旧类型映射（必须在依赖新列的 INDEX 之前） */
  private migrateMemoryColumns(): void {
    const cols = [
      ["status", "TEXT NOT NULL DEFAULT 'active'"],
      ['channel', 'TEXT'],
      ['future_use', 'TEXT'],
      ["anchors", "TEXT NOT NULL DEFAULT '[]'"],
      ['evidence', 'TEXT'],
      ['reinforced_at', 'INTEGER'],
      ['deleted', 'INTEGER NOT NULL DEFAULT 0'],
      ['deleted_at', 'INTEGER'],
      ['deleted_by', 'TEXT'],
      ['deleted_reason', 'TEXT'],
      ['deleted_meta', 'TEXT'],
    ] as const;
    for (const [name, ddl] of cols) {
      try {
        this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${ddl}`);
      } catch {
        // column already exists
      }
    }

    // 旧 MemoryType → fact/method/norm（一次数据迁移，幂等）
    this.db.exec(`
      UPDATE memories SET type = CASE type
        WHEN 'preference' THEN 'norm'
        WHEN 'decision' THEN 'norm'
        WHEN 'lesson' THEN 'method'
        WHEN 'discovery' THEN 'fact'
        WHEN 'context' THEN 'fact'
        WHEN 'relationship' THEN 'fact'
        ELSE type
      END
      WHERE type IN ('preference','decision','lesson','discovery','context','relationship')
    `);
  }

  /**
   * 创建所有表结构
   *
   * 顺序：CREATE TABLE IF NOT EXISTS → migrate 旧库列 → CREATE INDEX。
   * 否则旧 agent.db 上对 `deleted` 建索引会直接 SQLITE_ERROR，导致 memoryStore 无法注入。
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
        embedding       TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        channel         TEXT,
        future_use      TEXT,
        anchors         TEXT NOT NULL DEFAULT '[]',
        evidence        TEXT,
        reinforced_at   INTEGER,
        deleted         INTEGER NOT NULL DEFAULT 0,
        deleted_at      INTEGER,
        deleted_by      TEXT,
        deleted_reason  TEXT,
        deleted_meta    TEXT
      );
    `);

    // 旧库可能仍是无 deleted/status 的 schema —— 先补列再建索引
    this.migrateMemoryColumns();

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted);

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

      -- ── 补录覆盖表（steward 进度；可重建） ──
      CREATE TABLE IF NOT EXISTS memory_backfill (
        session_id    TEXT PRIMARY KEY,
        agent_id      TEXT,
        fingerprint   TEXT NOT NULL,
        status        TEXT NOT NULL,
        reason        TEXT,
        accepted      INTEGER,
        trigger       TEXT,
        attempted_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_backfill_status ON memory_backfill(status);
    `);
  }

  /**
   * 获取原始数据库实例（供子模块使用）
   */
  get raw(): DatabaseSync {
    return this.db;
  }

  /**
   * 确保 memory_vec 虚拟表维度匹配（store 侧在已知 dimensions 后调用）。
   *
   * @returns 是否可用
   */
  ensureMemoryVec(dimensions: number): boolean {
    if (!this._sqliteVec) return false;
    if (this._vecDimensions === dimensions) return true;
    const ok = ensureMemoryVecTable(this.db, dimensions);
    this._vecDimensions = ok ? dimensions : null;
    return ok;
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
