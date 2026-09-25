/**
 * CredentialStore — 命名凭证登记与用时解析
 *
 * 密钥材料：env 引用优先；encrypted 需主密钥（U2）；file 引用可选。
 * 永不通过 list/get 返回明文密钥。
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CredentialDatabase, resolveCredentialPaths } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import {
  defaultCredentialHeaders,
  type CredentialConsumerRef,
  type CredentialKind,
  type CredentialMeta,
  type CredentialWrite,
  type ResolvedCredential,
  type SecretMode,
} from './types.js';

function rowToMeta(row: Record<string, unknown>): CredentialMeta {
  const mode = String(row.secret_mode) as SecretMode;
  const hasSecret =
    (mode === 'env' && Boolean(row.secret_env)) ||
    (mode === 'file' && Boolean(row.secret_file)) ||
    (mode === 'encrypted' && Boolean(row.secret_cipher));
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind) as CredentialKind,
    description: row.description == null ? undefined : String(row.description),
    username: row.username == null ? undefined : String(row.username),
    headerName: row.header_name == null ? undefined : String(row.header_name),
    headerPrefix: row.header_prefix == null ? undefined : String(row.header_prefix),
    secretMode: mode,
    secretEnv: row.secret_env == null ? undefined : String(row.secret_env),
    secretFile: row.secret_file == null ? undefined : String(row.secret_file),
    hasSecret,
    scope: {
      level: String(row.scope_level) as CredentialMeta['scope']['level'],
      key: String(row.scope_key),
    },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: row.last_used_at == null ? undefined : Number(row.last_used_at),
    expiresAt: row.expires_at == null ? undefined : Number(row.expires_at),
  };
}

export class CredentialStore {
  private db: CredentialDatabase;

  constructor(db: CredentialDatabase) {
    this.db = db;
  }

  static async open(options?: { dbPath?: string }): Promise<CredentialStore> {
    const db = await CredentialDatabase.create(options);
    return new CredentialStore(db);
  }

  /**
   * 按 OCTOPI_HOME 打开默认 credentials.db
   */
  static async openDefault(octopiHome: string): Promise<CredentialStore> {
    const paths = resolveCredentialPaths(octopiHome);
    return CredentialStore.open({ dbPath: paths.dbPath });
  }

  get database(): CredentialDatabase {
    return this.db;
  }

  /**
   * 登记/轮换凭证（元数据 + 密钥引用；不回传密文）
   *
   * @param write - 凭证写入载荷
   * @returns 无密文元数据
   */
  set(write: CredentialWrite): CredentialMeta {
    const now = Date.now();
    const mode: SecretMode =
      write.secretMode ??
      (write.secretEnv ? 'env' : write.secretFile ? 'file' : write.secretValue != null ? 'encrypted' : 'encrypted');
    if (mode === 'env' && !write.secretEnv?.trim()) {
      throw new Error('secretMode=env requires secretEnv');
    }
    if (mode === 'file' && !write.secretFile?.trim()) {
      throw new Error('secretMode=file requires secretFile');
    }

    let cipher: Buffer | null = null;
    let nonce: Buffer | null = null;
    if (mode === 'encrypted') {
      if (write.secretValue != null) {
        const enc = encryptSecret(write.secretValue);
        cipher = enc.cipher;
        nonce = enc.nonce;
      } else if (!this.hasCipher(write.name)) {
        throw new Error('secretMode=encrypted requires secretValue');
      }
    }

    const existing = this.get(write.name);
    const id = existing?.id ?? `cred_${randomUUID().slice(0, 12)}`;
    const scopeLevel = write.scope?.level ?? 'global';
    const scopeKey = scopeLevel === 'global' ? 'global' : (write.scope?.key ?? 'global');

    this.db.raw
      .prepare(
        `INSERT INTO credentials (
          id, name, kind, description, username, header_name, header_prefix,
          secret_mode, secret_env, secret_cipher, secret_nonce, secret_file,
          scope_level, scope_key, created_at, updated_at, last_used_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          kind=excluded.kind,
          description=excluded.description,
          username=excluded.username,
          header_name=excluded.header_name,
          header_prefix=excluded.header_prefix,
          secret_mode=excluded.secret_mode,
          secret_env=excluded.secret_env,
          secret_cipher=COALESCE(excluded.secret_cipher, credentials.secret_cipher),
          secret_nonce=COALESCE(excluded.secret_nonce, credentials.secret_nonce),
          secret_file=excluded.secret_file,
          scope_level=excluded.scope_level,
          scope_key=excluded.scope_key,
          updated_at=excluded.updated_at,
          expires_at=excluded.expires_at`,
      )
      .run(
        id,
        write.name,
        write.kind,
        write.description ?? null,
        write.username ?? null,
        write.headerName ?? null,
        write.headerPrefix ?? null,
        mode,
        write.secretEnv ?? null,
        cipher,
        nonce,
        write.secretFile ?? null,
        scopeLevel,
        scopeKey,
        existing?.createdAt ?? now,
        now,
        existing?.lastUsedAt ?? null,
        write.expiresAt ?? existing?.expiresAt ?? null,
      );

    return this.get(write.name)!;
  }

  private hasCipher(name: string): boolean {
    const row = this.db.raw
      .prepare(`SELECT secret_cipher FROM credentials WHERE name = ?`)
      .get(name) as { secret_cipher?: unknown } | undefined;
    return Boolean(row?.secret_cipher);
  }

  /**
   * 读元数据（无密文）
   */
  get(name: string): CredentialMeta | null {
    const row = this.db.raw
      .prepare(`SELECT * FROM credentials WHERE name = ?`)
      .get(name) as Record<string, unknown> | undefined;
    return row ? rowToMeta(row) : null;
  }

  list(): CredentialMeta[] {
    const rows = this.db.raw
      .prepare(`SELECT * FROM credentials ORDER BY name`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToMeta);
  }

  delete(name: string): boolean {
    const meta = this.get(name);
    if (!meta) return false;
    this.db.raw.prepare(`DELETE FROM credential_bindings WHERE credential_id = ?`).run(meta.id);
    const res = this.db.raw.prepare(`DELETE FROM credentials WHERE id = ?`).run(meta.id);
    return Number(res.changes ?? 0) > 0;
  }

  /**
   * 用时解析为请求头（短命；调用方禁止日志）
   *
   * @param name - 凭证名
   * @returns 解析结果；无档或无密钥材料时 null
   */
  async resolve(name: string): Promise<ResolvedCredential | null> {
    const row = this.db.raw
      .prepare(`SELECT * FROM credentials WHERE name = ?`)
      .get(name) as Record<string, unknown> | undefined;
    if (!row) return null;

    const meta = rowToMeta(row);
    if (meta.expiresAt != null && meta.expiresAt < Date.now()) {
      return null;
    }
    const kind = meta.kind;
    let secret: string | null = null;

    if (meta.secretMode === 'env' && meta.secretEnv) {
      const v = process.env[meta.secretEnv];
      secret = v != null && v !== '' ? v : null;
    } else if (meta.secretMode === 'file' && meta.secretFile) {
      try {
        secret = (await readFile(meta.secretFile, 'utf8')).trim();
      } catch {
        secret = null;
      }
    } else if (meta.secretMode === 'encrypted') {
      const cipherRow = this.db.raw
        .prepare(`SELECT secret_cipher, secret_nonce FROM credentials WHERE id = ?`)
        .get(meta.id) as { secret_cipher?: Uint8Array | null; secret_nonce?: Uint8Array | null } | undefined;
      const cipher = cipherRow?.secret_cipher;
      const nonce = cipherRow?.secret_nonce;
      if (cipher && nonce) {
        secret = decryptSecret(Buffer.from(cipher), Buffer.from(nonce));
      } else {
        secret = null;
      }
    }

    if (!secret) return null;

    this.db.raw
      .prepare(`UPDATE credentials SET last_used_at = ? WHERE id = ?`)
      .run(Date.now(), meta.id);

    return {
      name: meta.name,
      headers: defaultCredentialHeaders({
        kind,
        username: meta.username,
        headerName: meta.headerName,
        headerPrefix: meta.headerPrefix,
        secret,
      }),
    };
  }

  bind(consumer: CredentialConsumerRef, name: string): void {
    const meta = this.get(name);
    if (!meta) throw new Error(`credential not found: ${name}`);
    this.db.raw
      .prepare(
        `INSERT OR IGNORE INTO credential_bindings (credential_id, consumer_kind, consumer_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(meta.id, consumer.kind, consumer.id, Date.now());
  }

  unbind(consumer: CredentialConsumerRef, name: string): void {
    const meta = this.get(name);
    if (!meta) return;
    this.db.raw
      .prepare(
        `DELETE FROM credential_bindings WHERE credential_id = ? AND consumer_kind = ? AND consumer_id = ?`,
      )
      .run(meta.id, consumer.kind, consumer.id);
  }

  listBindings(name: string): Array<{ kind: string; id: string }> {
    const meta = this.get(name);
    if (!meta) return [];
    const rows = this.db.raw
      .prepare(
        `SELECT consumer_kind, consumer_id FROM credential_bindings WHERE credential_id = ?`,
      )
      .all(meta.id) as Array<{ consumer_kind: string; consumer_id: string }>;
    return rows.map((r) => ({ kind: r.consumer_kind, id: r.consumer_id }));
  }
}
