/**
 * RegistryDatabase — OCTOPI_HOME/registry.db
 *
 * 租户与定义面的权威数据（arch/multi-tenancy.md §3）。单机起步落在 gateway 进程内
 * （Q12），API 按服务化契约设计——分布式时迁 C 机服务、调用面不变。
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export interface RegistryDatabaseOptions {
  dbPath?: string;
  wal?: boolean;
  busyTimeoutMs?: number;
}

export interface RegistryPaths {
  dbPath: string;
}

/**
 * 解析 registry 数据面路径
 *
 * @param octopiHome - OCTOPI_HOME 绝对路径
 */
export function resolveRegistryPaths(octopiHome: string): RegistryPaths {
  return { dbPath: join(octopiHome, 'registry.db') };
}

export class RegistryDatabase {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * 打开/创建 registry.db（Node >= 24 node:sqlite）
   */
  static async create(options?: RegistryDatabaseOptions): Promise<RegistryDatabase> {
    let DatabaseSyncCtor: typeof DatabaseSync;
    try {
      const mod = await import('node:sqlite');
      DatabaseSyncCtor = mod.DatabaseSync;
    } catch {
      throw new Error(
        `RegistryDatabase requires Node.js >= 24 built-in "node:sqlite". process.version=${process.version}`,
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

    const rdb = new RegistryDatabase(db);
    rdb.createTables();
    return rdb;
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id   TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        user_id           TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        name              TEXT NOT NULL UNIQUE,
        is_platform_admin INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        agent_id       TEXT PRIMARY KEY,
        tenant_id      TEXT NOT NULL,
        owner_user_id  TEXT NOT NULL,
        visibility     TEXT NOT NULL DEFAULT 'private',
        name           TEXT NOT NULL,
        definition     TEXT NOT NULL DEFAULT '{}',
        home_ref       TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_tenant_name
        ON agents(tenant_id, name);

      CREATE TABLE IF NOT EXISTS bindings (
        binding_id     TEXT PRIMARY KEY,
        tenant_id      TEXT NOT NULL,
        platform       TEXT NOT NULL,
        identity       TEXT NOT NULL,
        agent_id       TEXT NOT NULL,
        session_policy TEXT NOT NULL DEFAULT 'per-user',
        created_at     INTEGER NOT NULL,
        UNIQUE (tenant_id, platform, identity)
      );

      CREATE TABLE IF NOT EXISTS mounts (
        mount_id      TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL,
        consumer_type TEXT NOT NULL,
        consumer_id   TEXT NOT NULL,
        source_type   TEXT NOT NULL,
        source_id     TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        UNIQUE (tenant_id, consumer_type, consumer_id, source_type, source_id)
      );

      CREATE TABLE IF NOT EXISTS knowledge_sources (
        source_id  TEXT PRIMARY KEY,
        scope      TEXT NOT NULL,
        tenant_id  TEXT,
        name       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_tokens (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  get raw(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
