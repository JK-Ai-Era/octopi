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
    // v2（arch/multi-tenancy.md §4 域分离）：唯一键 name → (name, scope_level, scope_key)。
    // v1 的 UNIQUE(name) 是跨租户同名互覆的洞（同名 upsert 会写穿他租户）；存量库重建迁移。
    const CREATE_CREDENTIALS_V2 = `
      CREATE TABLE IF NOT EXISTS credentials (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
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
    `;
    const CREATE_BINDINGS = `
      CREATE TABLE IF NOT EXISTS credential_bindings (
        credential_id  TEXT NOT NULL,
        consumer_kind  TEXT NOT NULL,
        consumer_id    TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (credential_id, consumer_kind, consumer_id)
      );
    `;
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credentials'")
      .get() as { name?: string } | undefined;
    const domainIndexExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'credentials_domain_name'")
      .get() as { name?: string } | undefined;

    if (tableExists && !domainIndexExists) {
      // v1 → v2 迁移：整表重建（SQLite 改不了列级 UNIQUE；拷贝后原地换表）。
      // 原子性（评审 MAJ-4）：单事务内完成 + 失败 ROLLBACK 并抛出（fail-loud，半迁移库
      // 不得继续使用）；残留 v1 残表先清（MIN-1 前置）；唯一索引并入同事务（MIN-1）。
      this.db.exec('DROP TABLE IF EXISTS credentials_v1_legacy;');
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.exec(`
        ALTER TABLE credentials RENAME TO credentials_v1_legacy;
        ${CREATE_CREDENTIALS_V2}
        INSERT INTO credentials (
          id, name, kind, description, username, header_name, header_prefix,
          secret_mode, secret_env, secret_cipher, secret_nonce, secret_file,
          scope_level, scope_key, created_at, updated_at, last_used_at, expires_at
        )
        SELECT
          id, name, kind, description, username, header_name, header_prefix,
          secret_mode, secret_env, secret_cipher, secret_nonce, secret_file,
          scope_level, scope_key, created_at, updated_at, last_used_at, expires_at
        FROM credentials_v1_legacy;
        DROP TABLE credentials_v1_legacy;
        CREATE UNIQUE INDEX credentials_domain_name ON credentials(name, scope_level, scope_key);
        `);
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }
    } else {
      this.db.exec(CREATE_CREDENTIALS_V2);
      this.db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS credentials_domain_name ON credentials(name, scope_level, scope_key);',
      );
    }
    this.db.exec(CREATE_BINDINGS);
  }

  get raw(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
