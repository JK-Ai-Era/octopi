/**
 * 密码认证面回归（批 1-7）：scrypt 设置/校验、防枚举、(tenant,name) 二元组、
 * 成员创建、租户幂等播种、token 过期语义。全走真实 RegistryService（tmp sqlite）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegistryService } from '../packages/engine/src/harness/governance/registry/service.js';
import type { UserId } from '../packages/engine/src/harness/governance/registry/types.js';

let home: string;
let registry: RegistryService;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'octopi-auth-'));
  registry = await RegistryService.create({ dbPath: join(home, 'registry.db') });
});
afterEach(() => {
  registry.close();
  rmSync(home, { recursive: true, force: true });
});

describe('setUserPassword / authenticate', () => {
  it('设置密码后可凭密码登录（个人面：无 tenant 二元组）', async () => {
    const { user } = registry.registerUser({ name: 'alice' });
    await registry.setUserPassword(user.userId, 'pw-正确');
    expect(registry.hasPassword(user.userId)).toBe(true);
    const ok = await registry.authenticate({ name: 'alice', password: 'pw-正确' });
    expect(ok?.userId).toBe(user.userId);
  });

  it('错密码 / 无此用户一律 null（不区分原因，防枚举）', async () => {
    const { user } = registry.registerUser({ name: 'alice' });
    await registry.setUserPassword(user.userId, 'pw');
    expect(await registry.authenticate({ name: 'alice', password: 'wrong' })).toBeNull();
    expect(await registry.authenticate({ name: 'ghost', password: 'pw' })).toBeNull();
  });

  it('无密码用户不走密码登录（免密仅 personal 名登录兼容）', async () => {
    registry.registerUser({ name: 'bob' });
    expect(await registry.authenticate({ name: 'bob', password: 'anything' })).toBeNull();
    expect(registry.hasPassword(registry.getUserByName('bob')!.userId)).toBe(false);
  });

  it('(tenant, name) 二元组定位：跨租户同名消歧', async () => {
    const t1 = registry.ensureTenant('org-a');
    const t2 = registry.ensureTenant('org-b');
    const u1 = await registry.createUserInTenant({ tenantId: t1.tenantId, name: 'admin', password: 'pw-a' });
    await registry.createUserInTenant({ tenantId: t2.tenantId, name: 'adminX', password: 'pw-b' });
    // 二元组只认 org-a 的 admin
    expect((await registry.authenticate({ tenant: 'org-a', name: 'admin', password: 'pw-a' }))?.userId).toBe(u1.userId);
    expect(await registry.authenticate({ tenant: 'org-b', name: 'admin', password: 'pw-a' })).toBeNull();
  });

  it('setUserPassword：空密码拒绝、未知用户 fail-loud', async () => {
    const { user } = registry.registerUser({ name: 'alice' });
    await expect(registry.setUserPassword(user.userId, '')).rejects.toThrow(/password_required/);
    await expect(registry.setUserPassword('ghost' as UserId, 'pw')).rejects.toThrow(/registry_user_not_found/);
  });
});

describe('createUserInTenant / ensureTenant', () => {
  it('成员创建带密码即刻可登录；缺租户 fail-loud', async () => {
    const t = registry.ensureTenant('org');
    const u = await registry.createUserInTenant({ tenantId: t.tenantId, name: 'carol', password: 'pw' });
    expect((await registry.authenticate({ name: 'carol', password: 'pw' }))?.userId).toBe(u.userId);
    await expect(
      registry.createUserInTenant({ tenantId: 'ghost-tenant' as never, name: 'x' }),
    ).rejects.toThrow(/registry_tenant_not_found/);
  });

  it('ensureTenant 幂等：同名返回既有，不重建', () => {
    const a = registry.ensureTenant('org');
    const b = registry.ensureTenant('org');
    expect(b.tenantId).toBe(a.tenantId);
  });

  it('同名用户全局唯一：撞名 fail-loud（createUserInTenant）', async () => {
    const t1 = registry.ensureTenant('org-a');
    const t2 = registry.ensureTenant('org-b');
    await registry.createUserInTenant({ tenantId: t1.tenantId, name: 'admin' });
    await expect(registry.createUserInTenant({ tenantId: t2.tenantId, name: 'admin' })).rejects.toThrow(/UNIQUE/);
  });
});

describe('token 过期语义', () => {
  it('issueToken(ttl) 过期后 resolveToken 拒绝并清除条目', () => {
    const { user } = registry.registerUser({ name: 'alice' });
    const live = registry.issueToken(user.userId, 3600_000);
    expect(registry.resolveToken(live)?.userId).toBe(user.userId);

    const expired = registry.issueToken(user.userId, -1000);
    expect(registry.resolveToken(expired)).toBeNull();
    // 过期条目已清（再解析仍 null，且 revoke 幂等）
    expect(registry.resolveToken(expired)).toBeNull();
    expect(registry.revokeToken(expired)).toBe(false);
  });

  it('缺省 issueToken 不过期（兼容存量语义）', () => {
    const { user } = registry.registerUser({ name: 'alice' });
    const token = registry.issueToken(user.userId);
    expect(registry.resolveToken(token)?.userId).toBe(user.userId);
  });

  it('revokeToken 后 resolveToken 拒绝', () => {
    const { user } = registry.registerUser({ name: 'alice' });
    const token = registry.issueToken(user.userId);
    expect(registry.revokeToken(token)).toBe(true);
    expect(registry.resolveToken(token)).toBeNull();
  });
});
