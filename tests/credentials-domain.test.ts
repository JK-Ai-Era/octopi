/**
 * 凭证域分离（arch/multi-tenancy.md §4 credentials 行）：
 * 平台域（scope != tenant）与租户私有域（scope=tenant, key=tenantId）分离；
 * 租户解析域 = 平台 ∪ 本域；他租户私有对本域不存在；同名分域各存各的（不互覆）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CredentialStore } from '@octopi-agent/engine/harness/governance/credentials/store.js';
import { CredentialDatabase } from '@octopi-agent/engine/harness/governance/credentials/db.js';
import type { CredentialScopeRef } from '@octopi-agent/engine/harness/governance/credentials/types.js';

const ENV_A = 'TEST_CRED_DOMAIN_A';
const ENV_B = 'TEST_CRED_DOMAIN_B';
const ENV_P = 'TEST_CRED_DOMAIN_P';

describe('credentials domain separation', () => {
  let store: CredentialStore;

  beforeEach(async () => {
    process.env[ENV_A] = 'secret-a';
    process.env[ENV_B] = 'secret-b';
    process.env[ENV_P] = 'secret-p';
    store = await CredentialStore.open();
  });

  afterEach(async () => {
    delete process.env[ENV_A];
    delete process.env[ENV_B];
    delete process.env[ENV_P];
    store.database.close();
  });

  it('租户解析域 = 平台 ∪ 本域', async () => {
    store.set({ name: 'shared', kind: 'bearer', secretMode: 'env', secretEnv: ENV_P });
    store.set({
      name: 'private',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: ENV_A,
      scope: { level: 'tenant', key: 't-a' },
    });

    const shared = await store.resolve('shared', null, { tenantId: 't-a' });
    const own = await store.resolve('private', null, { tenantId: 't-a' });
    expect(shared?.headers.Authorization).toContain('secret-p');
    expect(own?.headers.Authorization).toContain('secret-a');
  });

  it('他租户私有对本域不存在（不泄露存在性）；无归属解析仅平台域（MAJ-10 旁路闭）', async () => {
    store.set({
      name: 'private',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: ENV_A,
      scope: { level: 'tenant', key: 't-a' },
    });

    expect(await store.resolve('private', null, { tenantId: 't-b' })).toBeNull();
    expect(await store.reveal('private', null, { tenantId: 't-b' })).toBeNull();
    // 无归属解析 = 平台域：租户私有不出现在 unattributed 解析域（租户密文只经归属解析）
    expect(await store.reveal('private', null)).toBeNull();
    // 归属解析（含管理面按 tenantId 代查）：本域可见
    expect(await store.reveal('private', null, { tenantId: 't-a' })).toBe('secret-a');
  });

  it('同名遮蔽：本域私有优先于平台同名；他租户取平台同名', async () => {
    store.set({ name: 'tok', kind: 'bearer', secretMode: 'env', secretEnv: ENV_P });
    store.set({
      name: 'tok',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: ENV_A,
      scope: { level: 'tenant', key: 't-a' },
    });

    expect(await store.reveal('tok', null, { tenantId: 't-a' })).toBe('secret-a');
    expect(await store.reveal('tok', null, { tenantId: 't-b' })).toBe('secret-p');
    expect(await store.reveal('tok', null)).toBe('secret-p'); // 无归属解析 = 平台域取最早登记
  });

  it('非 global 域缺 key fail-loud（MAJ-3：{level:\'tenant\'} 无 key 不得写孤儿行）', () => {
    // 类型已要求 key；此处铸型模拟 JS/JSON 边界（运行时守卫的受众）
    const noKey = (level: 'tenant' | 'agent') => ({ level }) as unknown as CredentialScopeRef;
    expect(() =>
      store.set({ name: 'x', kind: 'bearer', secretMode: 'env', secretEnv: ENV_A, scope: noKey('tenant') }),
    ).toThrow(/scope\.key/);
    expect(() =>
      store.set({ name: 'x', kind: 'bearer', secretMode: 'env', secretEnv: ENV_A, scope: noKey('agent') }),
    ).toThrow(/scope\.key/);
    // global 不得携带异域 key
    expect(() =>
      store.set({ name: 'x', kind: 'bearer', secretMode: 'env', secretEnv: ENV_A, scope: { level: 'global', key: 't-a' } }),
    ).toThrow(/global/);
  });

  it('管理面域语义（MAJ-1）：同名跨域 delete 歧义 fail-loud；带 scope 精删', () => {
    store.set({ name: 'tok', kind: 'bearer', secretMode: 'env', secretEnv: ENV_P });
    store.set({
      name: 'tok',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: ENV_A,
      scope: { level: 'tenant', key: 't-a' },
    });

    expect(() => store.delete('tok')).toThrow(/multiple domains/);
    expect(store.delete('tok', { level: 'tenant', key: 't-a' })).toBe(true);
    // 只删了 t-a 行，平台行还在
    expect(store.get('tok', { level: 'global', key: 'global' })?.scope.level).toBe('global');
    expect(store.get('tok', { level: 'tenant', key: 't-a' })).toBeNull();
  });

  it('bind/listBindings 按域定位（MAJ-1/MAJ-9）', () => {
    store.set({ name: 'tok', kind: 'bearer', secretMode: 'env', secretEnv: ENV_P });
    store.set({
      name: 'tok',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: ENV_A,
      scope: { level: 'tenant', key: 't-a' },
    });

    expect(() => store.bind({ kind: 'agent', id: 'a1' }, 'tok')).toThrow(/multiple domains/);
    store.bind({ kind: 'agent', id: 'a1' }, 'tok', { level: 'tenant', key: 't-a' });
    expect(store.listBindings('tok', { level: 'tenant', key: 't-a' })).toEqual([{ kind: 'agent', id: 'a1' }]);
    expect(store.listBindings('tok', { level: 'global', key: 'global' })).toEqual([]);
  });

  it('同路径二次打开幂等（MIN-14：迁移判定不重跑）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-reopen-'));
    const dbPath = join(dir, 'credentials.db');
    try {
      const first = await CredentialStore.open({ dbPath });
      first.set({ name: 'tok', kind: 'bearer', secretMode: 'env', secretEnv: ENV_P });
      first.database.close();

      const second = await CredentialStore.open({ dbPath });
      try {
        expect(await second.reveal('tok', null)).toBe('secret-p');
        const idx = second.database.raw
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'credentials_domain_name'`)
          .get() as { name?: string } | undefined;
        expect(idx?.name).toBe('credentials_domain_name');
      } finally {
        second.database.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同名分域各存各的：写他域同名不互覆（v1 UNIQUE(name) 的写穿洞已闭）', async () => {
    store.set({
      name: 'tok',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: ENV_A,
      scope: { level: 'tenant', key: 't-a' },
    });
    store.set({
      name: 'tok',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: ENV_B,
      scope: { level: 'tenant', key: 't-b' },
    });

    expect(await store.reveal('tok', null, { tenantId: 't-a' })).toBe('secret-a');
    expect(await store.reveal('tok', null, { tenantId: 't-b' })).toBe('secret-b');
  });

  it('scope.level=tenant 缺 key → fail-loud', () => {
    expect(() =>
      store.set({ name: 'x', kind: 'bearer', secretMode: 'env', secretEnv: ENV_A, scope: { level: 'tenant', key: '' } }),
    ).toThrow(/tenantId/);
  });

  it('v1→v2 迁移：存量数据保留 + 域唯一生效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-mig-'));
    const dbPath = join(dir, 'credentials.db');
    try {
      // 造 v1 库（旧 schema：name 全局唯一）
      const raw = new DatabaseSync(dbPath);
      raw.exec(`
        CREATE TABLE credentials (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
          description TEXT, username TEXT, header_name TEXT, header_prefix TEXT,
          secret_mode TEXT NOT NULL, secret_env TEXT, secret_cipher BLOB, secret_nonce BLOB,
          secret_file TEXT, scope_level TEXT NOT NULL DEFAULT 'global',
          scope_key TEXT NOT NULL DEFAULT 'global', created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER
        );
      `);
      raw
        .prepare(
          `INSERT INTO credentials (id, name, kind, secret_mode, secret_env, scope_level, scope_key, created_at, updated_at)
           VALUES ('c1', 'legacy', 'bearer', 'env', ?, 'global', 'global', 1, 1)`,
        )
        .run(ENV_P);
      raw.close();

      const migrated = await CredentialStore.open({ dbPath });
      try {
        expect(await migrated.reveal('legacy', null)).toBe('secret-p');
        // v2 域唯一：同名不同域可共存
        migrated.set({
          name: 'legacy',
          kind: 'bearer',
          secretMode: 'env',
          secretEnv: ENV_A,
          scope: { level: 'tenant', key: 't-a' },
        });
        expect(await migrated.reveal('legacy', null, { tenantId: 't-a' })).toBe('secret-a');
        expect(await migrated.reveal('legacy', null, { tenantId: 't-b' })).toBe('secret-p');
      } finally {
        migrated.database.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CredentialDatabase 幂等打开不重复迁移', async () => {
    const db = await CredentialDatabase.create();
    try {
      const raw = db.raw;
      const idx = raw
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'credentials_domain_name'`)
        .get() as { name?: string } | undefined;
      expect(idx?.name).toBe('credentials_domain_name');
    } finally {
      db.close();
    }
  });
});
