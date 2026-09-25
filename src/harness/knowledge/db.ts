/**
 * KnowledgeDatabase — OCTOPI_HOME/knowledge/knowledge.db
 *
 * 全 scope Source 权威 + Project 挂载 + Global 屏蔽。
 * 不存 chunk/vector（Index 可重建投影，P2+）。
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export interface KnowledgeDatabaseOptions {
  dbPath?: string;
  wal?: boolean;
  busyTimeoutMs?: number;
}

export class KnowledgeDatabase {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * 打开/创建 knowledge.db（Node >= 24 node:sqlite）
   */
  static async create(options?: KnowledgeDatabaseOptions): Promise<KnowledgeDatabase> {
    let DatabaseSyncCtor: typeof DatabaseSync;
    try {
      const mod = await import('node:sqlite');
      DatabaseSyncCtor = mod.DatabaseSync;
    } catch {
      throw new Error(
        `KnowledgeDatabase requires Node.js >= 24 built-in "node:sqlite". process.version=${process.version}`,
      );
    }

    const dbPath = options?.dbPath ?? ':memory:';
    if (dbPath !== ':memory:') {
      await mkdir(dirname(dbPath), { recursive: true });
    }

    const db = new DatabaseSyncCtor(dbPath, {
      timeout: options?.busyTimeoutMs ?? 5000,
      enableForeignKeyConstraints: false,
    });
    if (options?.wal !== false) {
      db.exec('PRAGMA journal_mode = WAL');
    }

    const kdb = new KnowledgeDatabase(db);
    kdb.createTables();
    return kdb;
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id                    TEXT PRIMARY KEY,
        kind                  TEXT NOT NULL,
        location              TEXT NOT NULL,
        scope_level           TEXT NOT NULL,
        scope_key             TEXT NOT NULL,
        sync_json             TEXT NOT NULL DEFAULT '{}',
        status                TEXT NOT NULL DEFAULT 'pending',
        coverage              REAL,
        errors_json           TEXT NOT NULL DEFAULT '[]',
        display_name          TEXT NOT NULL,
        description           TEXT,
        generated_description TEXT,
        catalog_priority      INTEGER,
        hidden_from_catalog   INTEGER NOT NULL DEFAULT 0,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_sources_scope
        ON knowledge_sources(scope_level, scope_key);
      CREATE INDEX IF NOT EXISTS idx_knowledge_sources_status
        ON knowledge_sources(status);

      -- Project 显式挂载（默认拒绝）：project_key + agent_id
      CREATE TABLE IF NOT EXISTS knowledge_projects (
        project_key  TEXT PRIMARY KEY,
        display_name TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_project_agents (
        project_key  TEXT NOT NULL,
        agent_id     TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (project_key, agent_id)
      );

      -- Global 源对 agent 的屏蔽
      CREATE TABLE IF NOT EXISTS knowledge_agent_hidden (
        agent_id   TEXT NOT NULL,
        source_id  TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, source_id)
      );

      -- 会话可见视图 overlay（资产归属不变；只改本场 effective view）
      CREATE TABLE IF NOT EXISTS knowledge_session_visibility (
        session_id   TEXT NOT NULL,
        target_type  TEXT NOT NULL CHECK (target_type IN ('project', 'source')),
        target_id    TEXT NOT NULL,
        op           TEXT NOT NULL CHECK (op IN ('include', 'exclude')),
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (session_id, target_type, target_id)
      );

      -- ── Index 投影（可重建；P2 Phase A）──
      CREATE TABLE IF NOT EXISTS knowledge_files (
        id            TEXT PRIMARY KEY,
        source_id     TEXT NOT NULL,
        path          TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        size          INTEGER NOT NULL DEFAULT 0,
        mtime         INTEGER NOT NULL DEFAULT 0,
        adapter_id    TEXT,
        status        TEXT NOT NULL DEFAULT 'indexed',
        error         TEXT,
        chunk_count   INTEGER NOT NULL DEFAULT 0,
        indexed_at    INTEGER NOT NULL,
        UNIQUE (source_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_files_source ON knowledge_files(source_id);

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id          TEXT PRIMARY KEY,
        file_id     TEXT NOT NULL,
        source_id   TEXT NOT NULL,
        path        TEXT NOT NULL,
        ordinal     INTEGER NOT NULL,
        text        TEXT NOT NULL,
        start_line  INTEGER NOT NULL DEFAULT 1,
        end_line    INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks(source_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_file ON knowledge_chunks(file_id);

      -- Phase B 向量（可关；未配 embedding 则不写）
      CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
        chunk_id      TEXT PRIMARY KEY,
        dimensions    INTEGER NOT NULL,
        embedding_json TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );

      -- 使用痕迹（P5；提升候选计量，非权威）
      CREATE TABLE IF NOT EXISTS knowledge_hits (
        id          TEXT PRIMARY KEY,
        source_id   TEXT NOT NULL,
        chunk_id    TEXT,
        path        TEXT NOT NULL,
        agent_id    TEXT,
        session_id  TEXT,
        query       TEXT NOT NULL,
        mode        TEXT NOT NULL DEFAULT 'inject',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hits_path ON knowledge_hits(path);
      CREATE INDEX IF NOT EXISTS idx_knowledge_hits_source ON knowledge_hits(source_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_hits_created ON knowledge_hits(created_at);

      -- ingest 任务队列（背压排队，不丢任务）
      CREATE TABLE IF NOT EXISTS knowledge_jobs (
        id           TEXT PRIMARY KEY,
        source_id    TEXT NOT NULL,
        kind         TEXT NOT NULL,
        path         TEXT,
        priority     INTEGER NOT NULL DEFAULT 2,
        status       TEXT NOT NULL DEFAULT 'queued',
        attempts     INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_status
        ON knowledge_jobs(status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_source ON knowledge_jobs(source_id);
    `);
    this.migrate();
  }

  /** 幂等迁移：外源 ingest / 凭证引用列 */
  private migrate(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(knowledge_files)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('external_url')) {
      this.db.exec(`ALTER TABLE knowledge_files ADD COLUMN external_url TEXT`);
    }
    if (!names.has('etag')) {
      this.db.exec(`ALTER TABLE knowledge_files ADD COLUMN etag TEXT`);
    }
    if (!names.has('last_modified')) {
      this.db.exec(`ALTER TABLE knowledge_files ADD COLUMN last_modified TEXT`);
    }

    const srcCols = this.db
      .prepare(`PRAGMA table_info(knowledge_sources)`)
      .all() as Array<{ name: string }>;
    const srcNames = new Set(srcCols.map((c) => c.name));
    if (!srcNames.has('auth_ref')) {
      this.db.exec(`ALTER TABLE knowledge_sources ADD COLUMN auth_ref TEXT`);
    }
    if (!srcNames.has('network_json')) {
      this.db.exec(`ALTER TABLE knowledge_sources ADD COLUMN network_json TEXT`);
    }
    if (!srcNames.has('last_polled_at')) {
      this.db.exec(`ALTER TABLE knowledge_sources ADD COLUMN last_polled_at INTEGER`);
    }
    if (!srcNames.has('discover_json')) {
      this.db.exec(`ALTER TABLE knowledge_sources ADD COLUMN discover_json TEXT`);
    }
  }

  get raw(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  stats(): Record<string, number> {
    const counts: Record<string, string> = {
      sources: 'SELECT COUNT(*) AS count FROM knowledge_sources',
      projectAgents: 'SELECT COUNT(*) AS count FROM knowledge_project_agents',
      agentHidden: 'SELECT COUNT(*) AS count FROM knowledge_agent_hidden',
      sessionVisibility: 'SELECT COUNT(*) AS count FROM knowledge_session_visibility',
      files: 'SELECT COUNT(*) AS count FROM knowledge_files',
      chunks: 'SELECT COUNT(*) AS count FROM knowledge_chunks',
      embeddings: 'SELECT COUNT(*) AS count FROM knowledge_chunk_embeddings',
      hits: 'SELECT COUNT(*) AS count FROM knowledge_hits',
      jobsQueued: "SELECT COUNT(*) AS count FROM knowledge_jobs WHERE status = 'queued'",
      jobsRunning: "SELECT COUNT(*) AS count FROM knowledge_jobs WHERE status = 'running'",
    };
    const result: Record<string, number> = {};
    for (const [key, sql] of Object.entries(counts)) {
      try {
        const row = this.db.prepare(sql).get() as { count: number };
        result[key] = row.count;
      } catch {
        result[key] = 0;
      }
    }
    return result;
  }
}
