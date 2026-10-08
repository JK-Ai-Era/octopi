/**
 * KnowledgeDatabase — OCTOPI_HOME/knowledge/knowledge.db
 *
 * Source 权威 + Project 挂载 + Global 屏蔽 + **Index 投影**
 * （files/chunks/embeddings/FTS/jobs/control）。Index 非权威，可整库 rebuild。
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export interface KnowledgeDatabaseOptions {
  dbPath?: string;
  wal?: boolean;
  busyTimeoutMs?: number;
  /** 尝试加载 sqlite-vec（默认 true；失败则 JS 余弦）；可指定扩展路径 */
  sqliteVec?: boolean | { extensionPath?: string };
  /**
   * 只读打开（Query Worker / Engine 残留短读）：跳过 DDL/升列，不抢写锁。
   * 业务写路径必须走 Writer Worker 唯一写者；此模式仅用于同库只读连接。
   */
  readOnly?: boolean;
  /** 跳过 createTables/upgrade（默认 false；readOnly 时强制 true） */
  skipMigrate?: boolean;
}

export class KnowledgeDatabase {
  private db: DatabaseSync;
  private _sqliteVec = false;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  get sqliteVecEnabled(): boolean {
    return this._sqliteVec;
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

    const vecOpt = options?.sqliteVec;
    const readOnly = options?.readOnly === true;
    const skipMigrate = readOnly || options?.skipMigrate === true;
    const db = new DatabaseSyncCtor(dbPath, {
      // 索引写入与管理面读并发时需要更长 busy 窗口
      timeout: options?.busyTimeoutMs ?? 15_000,
      enableForeignKeyConstraints: false,
      // sqlite-vec 扩展（可选）；构造后无法补开
      allowExtension: vecOpt !== false,
      ...(readOnly ? { readOnly: true } : {}),
    });
    // 只读连接不改 journal_mode（WAL 由写者建立）
    if (!readOnly && options?.wal !== false) {
      db.exec('PRAGMA journal_mode = WAL');
    }

    const kdb = new KnowledgeDatabase(db);
    if (!skipMigrate) {
      kdb.createTables();
    }
    if (vecOpt !== false) {
      try {
        const { tryLoadSqliteVec } = await import('../memory/sqlite/sqlite-vec.js');
        const extensionPath = typeof vecOpt === 'object' ? vecOpt.extensionPath : undefined;
        kdb._sqliteVec = await tryLoadSqliteVec(db, extensionPath);
      } catch {
        kdb._sqliteVec = false;
      }
    }
    return kdb;
  }

  private createTables(): void {
    // 旧库先升列/重建，再 CREATE INDEX（否则索引引用新列会炸）
    this.upgradeLegacySchema();
    // v2.1 File 本位（arch/knowledge-service-http.md）：无兼容迁移，一次建对。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_principals (
        tenant_id       TEXT NOT NULL,
        gateway_id      TEXT NOT NULL,
        local_agent_id  TEXT NOT NULL,
        display_name    TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        last_seen_at    INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, gateway_id, local_agent_id)
      );

      CREATE TABLE IF NOT EXISTS knowledge_projects (
        tenant_id     TEXT NOT NULL DEFAULT 'default',
        project_key   TEXT NOT NULL,
        display_name  TEXT,
        registered_by TEXT NOT NULL DEFAULT 'default',
        visibility    TEXT NOT NULL DEFAULT 'private',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, project_key)
      );

      CREATE TABLE IF NOT EXISTS knowledge_project_agents (
        tenant_id      TEXT NOT NULL DEFAULT 'default',
        gateway_id     TEXT NOT NULL DEFAULT 'default',
        local_agent_id TEXT NOT NULL,
        project_key    TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, gateway_id, local_agent_id, project_key)
      );

      CREATE TABLE IF NOT EXISTS knowledge_agent_hidden (
        tenant_id      TEXT NOT NULL DEFAULT 'default',
        gateway_id     TEXT NOT NULL DEFAULT 'default',
        local_agent_id TEXT NOT NULL,
        source_id      TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, gateway_id, local_agent_id, source_id)
      );

      CREATE TABLE IF NOT EXISTS knowledge_session_visibility (
        tenant_id      TEXT NOT NULL DEFAULT 'default',
        gateway_id     TEXT NOT NULL DEFAULT 'default',
        local_session_id TEXT NOT NULL,
        target_type    TEXT NOT NULL CHECK (target_type IN ('project', 'source')),
        target_id      TEXT NOT NULL,
        op             TEXT NOT NULL CHECK (op IN ('include', 'exclude')),
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, gateway_id, local_session_id, target_type, target_id)
      );

      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id                    TEXT PRIMARY KEY,
        tenant_id             TEXT NOT NULL DEFAULT 'default',
        registered_by         TEXT NOT NULL DEFAULT 'default',
        visibility            TEXT NOT NULL DEFAULT 'private',
        kind                  TEXT NOT NULL,
        location              TEXT NOT NULL,
        scope_level           TEXT NOT NULL,
        scope_key             TEXT NOT NULL,
        sync_json             TEXT NOT NULL DEFAULT '{}',
        network_json          TEXT,
        discover_json         TEXT,
        auth_ref              TEXT,
        status                TEXT NOT NULL DEFAULT 'pending',
        coverage              REAL,
        errors_json           TEXT NOT NULL DEFAULT '[]',
        display_name          TEXT NOT NULL,
        description           TEXT,
        generated_description TEXT,
        catalog_priority      INTEGER,
        hidden_from_catalog   INTEGER NOT NULL DEFAULT 0,
        last_polled_at        INTEGER,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_sources_scope
        ON knowledge_sources(scope_level, scope_key);
      CREATE INDEX IF NOT EXISTS idx_knowledge_sources_tenant
        ON knowledge_sources(tenant_id);

      -- 物理 File：identity 稳定，size/mtime 为版本
      CREATE TABLE IF NOT EXISTS knowledge_files (
        id            TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL DEFAULT 'default',
        identity_key  TEXT NOT NULL,
        size          INTEGER NOT NULL DEFAULT 0,
        mtime         INTEGER NOT NULL DEFAULT 0,
        content_hash  TEXT,
        adapter_id    TEXT,
        status        TEXT NOT NULL DEFAULT 'indexed',
        error         TEXT,
        chunk_count   INTEGER NOT NULL DEFAULT 0,
        indexed_at    INTEGER NOT NULL,
        external_url  TEXT,
        etag          TEXT,
        last_modified TEXT,
        UNIQUE (tenant_id, identity_key)
      );

      -- 逻辑认领：path 只活在 Membership
      CREATE TABLE IF NOT EXISTS knowledge_memberships (
        source_id     TEXT NOT NULL,
        file_id       TEXT NOT NULL,
        logical_path  TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (source_id, logical_path)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_memberships_file
        ON knowledge_memberships(file_id);

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id          TEXT PRIMARY KEY,
        file_id     TEXT NOT NULL,
        ordinal     INTEGER NOT NULL,
        text        TEXT NOT NULL,
        start_line  INTEGER NOT NULL DEFAULT 1,
        end_line    INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_file ON knowledge_chunks(file_id);

      CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
        chunk_id      TEXT PRIMARY KEY,
        dimensions    INTEGER NOT NULL,
        embedding     BLOB NOT NULL,
        bucket        INTEGER NOT NULL DEFAULT -1,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_hits (
        id          TEXT PRIMARY KEY,
        file_id     TEXT,
        chunk_id    TEXT,
        source_id   TEXT,
        path        TEXT NOT NULL,
        agent_id    TEXT,
        session_id  TEXT,
        query       TEXT NOT NULL,
        mode        TEXT NOT NULL DEFAULT 'inject',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hits_created ON knowledge_hits(created_at);

      CREATE TABLE IF NOT EXISTS knowledge_jobs (
        id           TEXT PRIMARY KEY,
        file_id      TEXT,
        source_id    TEXT,
        kind         TEXT NOT NULL,
        path         TEXT,
        priority     INTEGER NOT NULL DEFAULT 2,
        status       TEXT NOT NULL DEFAULT 'queued',
        attempts     INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_source_control (
        source_id   TEXT PRIMARY KEY,
        aborted     INTEGER NOT NULL DEFAULT 0,
        aborted_at  INTEGER,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_status
        ON knowledge_jobs(status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_file ON knowledge_jobs(file_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_source_status
        ON knowledge_jobs(source_id, status);
    `);
    this.migrate();
  }

  /**
   * 旧库升级：补缺失列 + 重建 File identity 投影。
   * 必须在 CREATE INDEX 之前跑，否则旧表上建新列索引会 `no such column`。
   */
  private upgradeLegacySchema(): void {
    // 1) 各表补列（幂等）
    const alterIfMissing = (table: string, cols: Array<{ name: string; ddl: string }>): void => {
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const names = new Set(existing.map((c) => c.name));
      for (const col of cols) {
        if (!names.has(col.name)) {
          try {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.ddl}`);
          } catch {
            // 表可能尚不存在（createTables 随后会建）
          }
        }
      }
    };

    alterIfMissing('knowledge_sources', [
      { name: 'tenant_id', ddl: `tenant_id TEXT NOT NULL DEFAULT 'default'` },
      { name: 'registered_by', ddl: `registered_by TEXT NOT NULL DEFAULT 'default'` },
      { name: 'visibility', ddl: `visibility TEXT NOT NULL DEFAULT 'private'` },
      { name: 'network_json', ddl: `network_json TEXT` },
      { name: 'discover_json', ddl: `discover_json TEXT` },
      { name: 'auth_ref', ddl: `auth_ref TEXT` },
      { name: 'last_polled_at', ddl: `last_polled_at INTEGER` },
    ]);
    alterIfMissing('knowledge_projects', [
      { name: 'tenant_id', ddl: `tenant_id TEXT NOT NULL DEFAULT 'default'` },
      { name: 'registered_by', ddl: `registered_by TEXT NOT NULL DEFAULT 'default'` },
      { name: 'visibility', ddl: `visibility TEXT NOT NULL DEFAULT 'private'` },
    ]);
    alterIfMissing('knowledge_project_agents', [
      { name: 'tenant_id', ddl: `tenant_id TEXT NOT NULL DEFAULT 'default'` },
      { name: 'gateway_id', ddl: `gateway_id TEXT NOT NULL DEFAULT 'default'` },
      { name: 'local_agent_id', ddl: `local_agent_id TEXT NOT NULL DEFAULT ''` },
    ]);
    alterIfMissing('knowledge_agent_hidden', [
      { name: 'tenant_id', ddl: `tenant_id TEXT NOT NULL DEFAULT 'default'` },
      { name: 'gateway_id', ddl: `gateway_id TEXT NOT NULL DEFAULT 'default'` },
      { name: 'local_agent_id', ddl: `local_agent_id TEXT NOT NULL DEFAULT ''` },
    ]);
    alterIfMissing('knowledge_session_visibility', [
      { name: 'tenant_id', ddl: `tenant_id TEXT NOT NULL DEFAULT 'default'` },
      { name: 'gateway_id', ddl: `gateway_id TEXT NOT NULL DEFAULT 'default'` },
      { name: 'local_session_id', ddl: `local_session_id TEXT NOT NULL DEFAULT ''` },
    ]);
    alterIfMissing('knowledge_jobs', [
      { name: 'file_id', ddl: `file_id TEXT` },
      { name: 'tenant_id', ddl: `tenant_id TEXT NOT NULL DEFAULT 'default'` },
    ]);
    alterIfMissing('knowledge_hits', [
      { name: 'file_id', ddl: `file_id TEXT` },
      { name: 'tenant_id', ddl: `tenant_id TEXT NOT NULL DEFAULT 'default'` },
    ]);

    // 2) 旧 files/chunks（source_id,path）→ File identity 重建
    this.migrateLegacyFileIdentitySchema();
    // 2b) 旧 projects/project_agents 等主键 → 复合键重建
    this.rebuildLegacyProjectTables();
    // 3) 旧 project_agents/hidden/session：local_agent_id 空则从 agent_id 回填
    this.backfillLegacyAgentColumns();
    this.ensureEmbeddingSchema();
  }

  /**
   * 旧 projects PK(project_key) / project_agents PK(project_key,agent_id) → 复合键
   * （含 tenant/gateway），否则 ON CONFLICT(tenant_id, project_key) 会炸。
   */
  private rebuildLegacyProjectTables(): void {
    const tableSql = (name: string): string | null => {
      try {
        const row = this.db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
          .get(name) as { sql?: string } | undefined;
        return row?.sql ?? null;
      } catch {
        return null;
      }
    };

    // knowledge_projects：无 tenant_id 在 PK 中则重建
    const projSql = tableSql('knowledge_projects');
    if (projSql && !/PRIMARY KEY\s*\(\s*tenant_id/i.test(projSql)) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(`
          CREATE TABLE knowledge_projects_v2 (
            tenant_id     TEXT NOT NULL DEFAULT 'default',
            project_key   TEXT NOT NULL,
            display_name  TEXT,
            registered_by TEXT NOT NULL DEFAULT 'default',
            visibility    TEXT NOT NULL DEFAULT 'private',
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL,
            PRIMARY KEY (tenant_id, project_key)
          );
          INSERT INTO knowledge_projects_v2
            (tenant_id, project_key, display_name, registered_by, visibility, created_at, updated_at)
          SELECT COALESCE(tenant_id,'default'), project_key, display_name,
                 COALESCE(registered_by,'default'), COALESCE(visibility,'private'),
                 created_at, updated_at
          FROM knowledge_projects;
          DROP TABLE knowledge_projects;
          ALTER TABLE knowledge_projects_v2 RENAME TO knowledge_projects;
        `);
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    }

    // knowledge_project_agents
    const paSql = tableSql('knowledge_project_agents');
    if (paSql && !/PRIMARY KEY\s*\(\s*tenant_id/i.test(paSql)) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(`
          CREATE TABLE knowledge_project_agents_v2 (
            tenant_id      TEXT NOT NULL DEFAULT 'default',
            gateway_id     TEXT NOT NULL DEFAULT 'default',
            local_agent_id TEXT NOT NULL DEFAULT '',
            project_key    TEXT NOT NULL,
            created_at     INTEGER NOT NULL,
            PRIMARY KEY (tenant_id, gateway_id, local_agent_id, project_key)
          );
          INSERT OR IGNORE INTO knowledge_project_agents_v2
            (tenant_id, gateway_id, local_agent_id, project_key, created_at)
          SELECT COALESCE(tenant_id,'default'), COALESCE(gateway_id,'default'),
                 COALESCE(NULLIF(local_agent_id,''), COALESCE(agent_id,'')),
                 project_key, created_at
          FROM knowledge_project_agents;
          DROP TABLE knowledge_project_agents;
          ALTER TABLE knowledge_project_agents_v2 RENAME TO knowledge_project_agents;
        `);
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    }

    // knowledge_agent_hidden
    const ahSql = tableSql('knowledge_agent_hidden');
    if (ahSql && !/PRIMARY KEY\s*\(\s*tenant_id/i.test(ahSql)) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(`
          CREATE TABLE knowledge_agent_hidden_v2 (
            tenant_id      TEXT NOT NULL DEFAULT 'default',
            gateway_id     TEXT NOT NULL DEFAULT 'default',
            local_agent_id TEXT NOT NULL DEFAULT '',
            source_id      TEXT NOT NULL,
            created_at     INTEGER NOT NULL,
            PRIMARY KEY (tenant_id, gateway_id, local_agent_id, source_id)
          );
          INSERT OR IGNORE INTO knowledge_agent_hidden_v2
            (tenant_id, gateway_id, local_agent_id, source_id, created_at)
          SELECT COALESCE(tenant_id,'default'), COALESCE(gateway_id,'default'),
                 COALESCE(NULLIF(local_agent_id,''), COALESCE(agent_id,'')),
                 source_id, created_at
          FROM knowledge_agent_hidden;
          DROP TABLE knowledge_agent_hidden;
          ALTER TABLE knowledge_agent_hidden_v2 RENAME TO knowledge_agent_hidden;
        `);
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    }
  }

  /** 旧列 agent_id / session_id → local_* 回填（best-effort） */
  private backfillLegacyAgentColumns(): void {
    const hasCol = (table: string, col: string): boolean => {
      try {
        const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        return rows.some((r) => r.name === col);
      } catch {
        return false;
      }
    };
    try {
      if (hasCol('knowledge_project_agents', 'agent_id')) {
        this.db.exec(
          `UPDATE knowledge_project_agents SET local_agent_id = agent_id
           WHERE local_agent_id IS NULL OR local_agent_id = ''`,
        );
      }
      if (hasCol('knowledge_agent_hidden', 'agent_id')) {
        this.db.exec(
          `UPDATE knowledge_agent_hidden SET local_agent_id = agent_id
           WHERE local_agent_id IS NULL OR local_agent_id = ''`,
        );
      }
      if (hasCol('knowledge_session_visibility', 'session_id')) {
        this.db.exec(
          `UPDATE knowledge_session_visibility SET local_session_id = session_id
           WHERE local_session_id IS NULL OR local_session_id = ''`,
        );
      }
    } catch {
      // 旧列不存在则跳过
    }
  }

  /**
   * 保证 embeddings 表含 `bucket` 列并建索引。
   *
   * 必须在任何 `INSERT … bucket` / `WHERE bucket` **之前**调用；
   * 且不得与 `CREATE INDEX … (bucket)` 同批执行（旧表无该列时会先炸索引）。
   */
  ensureEmbeddingSchema(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(knowledge_chunk_embeddings)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('bucket')) {
      this.db.exec(
        `ALTER TABLE knowledge_chunk_embeddings ADD COLUMN bucket INTEGER NOT NULL DEFAULT -1`,
      );
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_embeddings_bucket
       ON knowledge_chunk_embeddings(bucket)`,
    );
  }

  /**
   * 幂等迁移：createTables 已跑 upgradeLegacySchema；此处仅兜底
   */
  private migrate(): void {
    this.ensureEmbeddingSchema();
    this.migrateLegacyFileIdentitySchema();
    this.ensureEmbeddingSchema();
  }

  /**
   * v2 旧库检测：knowledge_files 仍为 (source_id,path) 且无 identity_key / memberships。
   * Index 非权威 → 迁 membership + identity；失败则重建空索引（源登记保留）。
   */
  private migrateLegacyFileIdentitySchema(): void {
    const filesCols = this.db
      .prepare(`PRAGMA table_info(knowledge_files)`)
      .all() as Array<{ name: string }>;
    const fileNames = new Set(filesCols.map((c) => c.name));
    const hasMemberships = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_memberships'`,
      )
      .get();
    // 新库或已迁移
    if (fileNames.has('identity_key') && hasMemberships) return;

    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      // 保留 sources / projects / hidden / session_visibility
      // 重建索引投影表（identity 版）+ 清空残留 jobs（引用已删 file）
      this.db.exec(`
        DROP TABLE IF EXISTS knowledge_chunks_fts;
        DROP TABLE IF EXISTS knowledge_chunk_embeddings;
        DROP TABLE IF EXISTS knowledge_chunks;
        DROP TABLE IF EXISTS knowledge_files;
        DROP TABLE IF EXISTS knowledge_memberships;
      `);
      // jobs/hits 可能尚未建表（全新库）或已是新 schema
      try {
        this.db.exec('DELETE FROM knowledge_jobs');
        this.db.exec('DELETE FROM knowledge_hits');
      } catch {
        // 表不存在：createTables 随后会建
      }

      this.db.exec(`
        CREATE TABLE knowledge_files (
          id            TEXT PRIMARY KEY,
          tenant_id     TEXT NOT NULL DEFAULT 'default',
          identity_key  TEXT NOT NULL,
          size          INTEGER NOT NULL DEFAULT 0,
          mtime         INTEGER NOT NULL DEFAULT 0,
          content_hash  TEXT,
          adapter_id    TEXT,
          status        TEXT NOT NULL DEFAULT 'indexed',
          error         TEXT,
          chunk_count   INTEGER NOT NULL DEFAULT 0,
          indexed_at    INTEGER NOT NULL,
          external_url  TEXT,
          etag          TEXT,
          last_modified TEXT,
          UNIQUE (tenant_id, identity_key)
        );

        CREATE TABLE knowledge_memberships (
          source_id     TEXT NOT NULL,
          file_id       TEXT NOT NULL,
          logical_path  TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          PRIMARY KEY (source_id, logical_path)
        );
        CREATE INDEX idx_knowledge_memberships_file ON knowledge_memberships(file_id);

        CREATE TABLE knowledge_chunks (
          id          TEXT PRIMARY KEY,
          file_id     TEXT NOT NULL,
          ordinal     INTEGER NOT NULL,
          text        TEXT NOT NULL,
          start_line  INTEGER NOT NULL DEFAULT 1,
          end_line    INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX idx_knowledge_chunks_file ON knowledge_chunks(file_id);

        CREATE TABLE knowledge_chunk_embeddings (
          chunk_id      TEXT PRIMARY KEY,
          dimensions    INTEGER NOT NULL,
          embedding     BLOB NOT NULL,
          bucket        INTEGER NOT NULL DEFAULT -1,
          created_at    INTEGER NOT NULL
        );
      `);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 以原异常为准
      }
      throw err;
    }
    // 索引需重建：调用方 reconcile / reindex 补齐
    void now;
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
      memberships: 'SELECT COUNT(*) AS count FROM knowledge_memberships',
      files: 'SELECT COUNT(*) AS count FROM knowledge_files',
      projectAgents: 'SELECT COUNT(*) AS count FROM knowledge_project_agents',
      agentHidden: 'SELECT COUNT(*) AS count FROM knowledge_agent_hidden',
      sessionVisibility: 'SELECT COUNT(*) AS count FROM knowledge_session_visibility',
      chunks: 'SELECT COUNT(*) AS count FROM knowledge_chunks',
      ftsChunks: 'SELECT COUNT(*) AS count FROM knowledge_chunks_fts',
      embeddableChunks: `SELECT COUNT(*) AS count FROM knowledge_chunks c
         LEFT JOIN knowledge_files f ON f.id = c.file_id
         WHERE (f.adapter_id IS NULL OR f.adapter_id NOT IN ('code-tree'))`,
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
    // 0=无 ANN（仅桶/FTS）；1=sqlite-vec KNN —— 百万级部署必须为 1
    result.sqliteVec = this._sqliteVec ? 1 : 0;
    return result;
  }
}
