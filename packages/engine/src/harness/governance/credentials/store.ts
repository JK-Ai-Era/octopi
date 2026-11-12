/**
 * CredentialStore — 命名凭证登记与用时解析
 *
 * 密钥材料：env 引用（默认）/ file 引用 / encrypted（AES-GCM + OCTOPI_CREDENTIALS_KEY）。
 * 永不通过 list/get 返回明文密钥；resolve 时校验 expiresAt，过期返回 null。
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
  type CredentialScopeRef,
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
  /** true 时无绑定的凭证不可 resolve（部署拧紧 / untrusted） */
  private readonly requireBindings: boolean;

  constructor(db: CredentialDatabase, options?: { requireBindings?: boolean }) {
    this.db = db;
    this.requireBindings = options?.requireBindings === true;
  }

  static async open(options?: {
    dbPath?: string;
    requireBindings?: boolean;
  }): Promise<CredentialStore> {
    const db = await CredentialDatabase.create(options);
    return new CredentialStore(db, { requireBindings: options?.requireBindings });
  }

  /**
   * 按 OCTOPI_HOME 打开默认 credentials.db
   */
  static async openDefault(
    octopiHome: string,
    options?: { requireBindings?: boolean },
  ): Promise<CredentialStore> {
    const paths = resolveCredentialPaths(octopiHome);
    return CredentialStore.open({
      dbPath: paths.dbPath,
      requireBindings: options?.requireBindings,
    });
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

    // 域（§4）：唯一键 (name, scope_level, scope_key)——同名分域各存各的，不互覆。
    // 先校验后归一化（评审 MAJ-3）：非 global 域必须显式 key；global 不得携带异域 key
    const scopeLevel = write.scope?.level ?? 'global';
    let scopeKey: string;
    if (scopeLevel === 'global') {
      const key = write.scope?.key?.trim();
      if (key && key !== 'global') {
        throw new Error('scope.level=global must not carry a tenant/agent key');
      }
      scopeKey = 'global';
    } else {
      scopeKey = write.scope?.key?.trim() ?? '';
      if (!scopeKey) {
        throw new Error(`scope.level=${scopeLevel} requires scope.key (e.g. tenantId for level=tenant)`);
      }
    }

    let cipher: Buffer | null = null;
    let nonce: Buffer | null = null;
    if (mode === 'encrypted') {
      if (write.secretValue != null) {
        const enc = encryptSecret(write.secretValue);
        cipher = enc.cipher;
        nonce = enc.nonce;
      } else if (!this.hasCipher(write.name, scopeLevel, scopeKey)) {
        throw new Error('secretMode=encrypted requires secretValue');
      }
    }

    const existingRow = this.findByScope(write.name, scopeLevel, scopeKey);
    const existing = existingRow ? rowToMeta(existingRow) : null;
    const id = existing?.id ?? `cred_${randomUUID().slice(0, 12)}`;

    this.db.raw
      .prepare(
        `INSERT INTO credentials (
          id, name, kind, description, username, header_name, header_prefix,
          secret_mode, secret_env, secret_cipher, secret_nonce, secret_file,
          scope_level, scope_key, created_at, updated_at, last_used_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name, scope_level, scope_key) DO UPDATE SET
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

    return rowToMeta(this.findByScope(write.name, scopeLevel, scopeKey)!);
  }

  /** 按域精确定位（唯一键 (name, scope_level, scope_key)） */  private findByScope(
    name: string,
    scopeLevel: string,
    scopeKey: string,
  ): Record<string, unknown> | undefined {
    return this.db.raw
      .prepare('SELECT * FROM credentials WHERE name = ? AND scope_level = ? AND scope_key = ?')
      .get(name, scopeLevel, scopeKey) as Record<string, unknown> | undefined;
  }

  /**
   * 域内按名定位（§4 域分离）：
   * - 有归属租户：本租户私有（level=tenant, key=tenantId）优先——同名遮蔽平台同名；
   *   平台域兜底；他租户私有对本域不存在（不泄露存在性）。
   * - 无归属：**平台域**（level != tenant，含管理域 project/agent/plugin），不含任何
   *   租户私有行——租户密文只经归属租户解析（MAJ-10/评审 MIN-18：unattributed 解析
   *   不得成为读他租户密文的旁路）。管理面（get/list/delete）仍可不带域查看全量元数据。
   */
  private findRow(name: string, tenantId?: string): Record<string, unknown> | undefined {
    if (tenantId) {
      return (
        this.findByScope(name, 'tenant', tenantId) ??
        (this.db.raw
          .prepare(
            `SELECT * FROM credentials WHERE name = ? AND scope_level != 'tenant' ORDER BY created_at, rowid LIMIT 1`,
          )
          .get(name) as Record<string, unknown> | undefined)
      );
    }
    return this.db.raw
      .prepare(
        `SELECT * FROM credentials WHERE name = ? AND scope_level != 'tenant' ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(name) as Record<string, unknown> | undefined;
  }

  private hasCipher(name: string, scopeLevel: string, scopeKey: string): boolean {
    const row = this.findByScope(name, scopeLevel, scopeKey);
    return Boolean(row?.secret_cipher);
  }

  /**
   * 读元数据（无密文）。
   * 同名跨域（遮蔽）时：给 scope 精确定位；不给取最早登记（宿主面确定性视图）。
   *
   * @param name - 凭证名
   * @param scope - 域（level/key）；缺省不限域
   */
  get(name: string, scope?: CredentialScopeRef): CredentialMeta | null {
    const row = scope ? this.findByScope(name, scope.level, scope.key) : this.findRow(name);
    return row ? rowToMeta(row) : null;
  }

  list(): CredentialMeta[] {
    const rows = this.db.raw
      .prepare(`SELECT * FROM credentials ORDER BY name`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToMeta);
  }

  /**
   * 删除凭证（含绑定）。同名跨域且未给 scope = 歧义 fail-loud——域唯一后
   * name 不再是唯一身份，静默删错行等于数据事故。
   *
   * @param name - 凭证名
   * @param scope - 域（level/key）；缺省不限域
   * @returns 是否删除了记录
   */
  delete(name: string, scope?: CredentialScopeRef): boolean {
    const metas = this.findAll(name, scope);
    if (metas.length === 0) return false;
    if (metas.length > 1 && !scope) {
      throw new Error(`credential "${name}" matches multiple domains; pass scope to delete`);
    }
    let deleted = false;
    for (const meta of metas) {
      this.db.raw.prepare(`DELETE FROM credential_bindings WHERE credential_id = ?`).run(meta.id);
      const res = this.db.raw.prepare(`DELETE FROM credentials WHERE id = ?`).run(meta.id);
      deleted = deleted || Number(res.changes ?? 0) > 0;
    }
    return deleted;
  }

  /** 按名（可选域）取全部匹配行 */
  private findAll(name: string, scope?: CredentialScopeRef): CredentialMeta[] {
    const rows = scope
      ? [this.findByScope(name, scope.level, scope.key)].filter(Boolean)
      : (this.db.raw
          .prepare('SELECT * FROM credentials WHERE name = ? ORDER BY created_at, rowid')
          .all(name) as Record<string, unknown>[]);
    return rows.map((r) => rowToMeta(r as Record<string, unknown>));
  }

  /** 按名（可选域）定位唯一行；歧义 fail-loud（写路径专用） */
  private requireNamed(name: string, scope?: CredentialScopeRef): CredentialMeta {
    const metas = this.findAll(name, scope);
    if (metas.length === 0) throw new Error(`credential not found: ${name}`);
    if (metas.length > 1 && !scope) {
      throw new Error(`credential "${name}" matches multiple domains; pass scope`);
    }
    return metas[0];
  }

  /**
   * 用时解析为明文 secret（短命；调用方禁止日志/持久化）。
   * 消费约束与 {@link resolve} 相同（SEC-3c 绑定检查、过期返回 null）。
   * 供插件 secret 原语（api.secrets）等非 header 形态的消费者使用。
   *
   * @param name - 凭证名
   * @param consumer - 消费方；绑定非空时必填
   * @param options - requireBindings 覆盖
   * @returns 明文 secret；无档、无密钥材料或过期时 null
   * @throws 绑定策略拒绝时抛错（勿静默降级）
   */
  async reveal(
    name: string,
    consumer?: import('./types.js').CredentialConsumerRef | null,
    options?: import('./types.js').ResolveCredentialOptions,
  ): Promise<string | null> {
    return this.revealSecret(name, consumer, options);
  }

  /**
   * 用时解析为请求头（短命；调用方禁止日志）。
   * 消费侧强制 `credential_bindings`（SEC-3c）：绑定非空须命中 consumer；
   * 绑定为空且 requireBindings 时拒绝。
   *
   * @param name - 凭证名
   * @param consumer - 消费方；绑定非空时必填
   * @param options - requireBindings 覆盖
   * @returns 解析结果；无档或无密钥材料时 null
   * @throws 绑定策略拒绝时抛错（勿静默降级）
   */
  async resolve(
    name: string,
    consumer?: import('./types.js').CredentialConsumerRef | null,
    options?: import('./types.js').ResolveCredentialOptions,
  ): Promise<ResolvedCredential | null> {
    const row = this.findRow(name, options?.tenantId);
    if (!row) return null;

    const meta = rowToMeta(row);
    const secret = await this.revealSecret(name, consumer, options, meta, row);
    if (!secret) return null;

    return {
      name: meta.name,
      headers: defaultCredentialHeaders({
        kind: meta.kind,
        username: meta.username,
        headerName: meta.headerName,
        headerPrefix: meta.headerPrefix,
        secret,
      }),
    };
  }

  /** 明文解析单一实现点（reveal/resolve 共用）：材料解析 + 绑定检查 + last_used_at。 */
  private async revealSecret(
    name: string,
    consumer?: import('./types.js').CredentialConsumerRef | null,
    options?: import('./types.js').ResolveCredentialOptions,
    knownMeta?: CredentialMeta,
    knownRow?: Record<string, unknown>,
  ): Promise<string | null> {
    const row = knownRow ?? this.findRow(name, options?.tenantId);
    if (!row) return null;

    const meta = knownMeta ?? rowToMeta(row);
    if (meta.expiresAt != null && meta.expiresAt < Date.now()) {
      return null;
    }

    // 只紧不松：显式 true 可收紧；false/undefined 不得覆盖 store 级 requireBindings
    const require =
      options?.requireBindings === true || this.requireBindings === true;
    // 绑定检查按命中行的域定位（遮蔽场景不得串查平台同名行的绑定表）
    const bindings = this.listBindings(name, meta.scope);
    if (require && bindings.length === 0) {
      throw new Error(
        `credential "${name}" has no bindings and requireBindings is enabled`,
      );
    }
    if (bindings.length > 0) {
      const ref = consumer ?? options?.consumer ?? null;
      if (!ref) {
        throw new Error(
          `credential "${name}" is bound; consumer required to resolve`,
        );
      }
      const hit = bindings.some((b) => b.kind === ref.kind && b.id === ref.id);
      if (!hit) {
        throw new Error(
          `credential "${name}" is not bound to consumer ${ref.kind}:${ref.id}`,
        );
      }
    }
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

    return secret;
  }

  /**
   * 绑定消费方。同名跨域且未给 scope = 歧义 fail-loud。
   *
   * @param consumer - 消费方
   * @param name - 凭证名
   * @param scope - 域（level/key）；缺省不限域
   */
  bind(consumer: CredentialConsumerRef, name: string, scope?: CredentialScopeRef): void {
    const meta = this.requireNamed(name, scope);
    this.db.raw
      .prepare(
        `INSERT OR IGNORE INTO credential_bindings (credential_id, consumer_kind, consumer_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(meta.id, consumer.kind, consumer.id, Date.now());
  }

  /**
   * 解绑消费方。同名跨域且未给 scope = 歧义 fail-loud。
   *
   * @param consumer - 消费方
   * @param name - 凭证名
   * @param scope - 域（level/key）；缺省不限域
   */
  unbind(consumer: CredentialConsumerRef, name: string, scope?: CredentialScopeRef): void {
    const meta = this.requireNamed(name, scope);
    this.db.raw
      .prepare(
        `DELETE FROM credential_bindings WHERE credential_id = ? AND consumer_kind = ? AND consumer_id = ?`,
      )
      .run(meta.id, consumer.kind, consumer.id);
  }

  /**
   * 列绑定（按命中行 id；同名跨域给 scope 定位）。
   *
   * @param name - 凭证名
   * @param scope - 域（level/key）；缺省不限域（取最早登记）
   */
  listBindings(name: string, scope?: CredentialScopeRef): Array<{ kind: string; id: string }> {
    const meta = this.get(name, scope);
    if (!meta) return [];
    const rows = this.db.raw
      .prepare(
        `SELECT consumer_kind, consumer_id FROM credential_bindings WHERE credential_id = ?`,
      )
      .all(meta.id) as Array<{ consumer_kind: string; consumer_id: string }>;
    return rows.map((r) => ({ kind: r.consumer_kind, id: r.consumer_id }));
  }
}
