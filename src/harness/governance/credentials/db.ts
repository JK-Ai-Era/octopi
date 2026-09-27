/**
 * CredentialDatabase — OCTOPI_HOME/credentials/credentials.db
 *
 * 与 knowledge.db / octopi.json 分离：资源级访问凭证，规模可随集成增长。
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export interface CredentialDatabaseOptions {
  dbPath?: string;
  wal?: boolean;
  busyTimeoutMs?: number;
}

export interface CredentialPaths {
  root: string;
  dbPath: string;
}

/**
 * 解析 Credential 数据面路径
 *
 * @param octopiHome - OCTOPI_HOME 绝对路径
 */
export function resolveCredentialPaths(octopiHome: string): CredentialPaths {
  const root = join(octopiHome, 'credentials');
  return { root, dbPath: join(root, 'credentials.db') };
}

export class CredentialDatabase {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * 打开/创建 credentials.db（Node >= 24 node:sqlite）
   */
  static async create(options?: CredentialDatabaseOptions): Promise<CredentialDatabase> {
    let DatabaseSyncCtor: typeof DatabaseSync;
    try {
      const mod = await import('node:sqlite');
      DatabaseSyncCtor = mod.DatabaseSync;
    } catch {
      throw new Error(
        `CredentialDatabase requires Node.js >= 24 built-in "node:sqlite". process.version=${process.version}`,
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

    const cdb = new CredentialDatabase(db);
    cdb.createTables();
    return cdb;
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL UNIQUE,
        kind           TEXT NOT NULL,
        description    TEXT,
        username       TEXT,
        header_name    TEXT,
        header_prefix  TEXT,
        secret_mode    TEXT NOT NULL,
        secret_env     TEXT,
        secret_cipher  BLOB,
        secret_nonce   BLOB,
        secret_file    TEXT,
        scope_level    TEXT NOT NULL DEFAULT 'global',
        scope_key      TEXT NOT NULL DEFAULT 'global',
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        last_used_at   INTEGER,
        expires_at     INTEGER
      );

      CREATE TABLE IF NOT EXISTS credential_bindings (
        credential_id  TEXT NOT NULL,
        consumer_kind  TEXT NOT NULL,
        consumer_id    TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (credential_id, consumer_kind, consumer_id)
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
