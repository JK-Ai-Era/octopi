/**
 * doctor registry 播种检查：配置文件存在 ≠ 部署可用。
 *
 * 锚（防复发）：`isInitialized()` 只看 octopi.json，播种在 onboarding 末尾才发生。
 * 落在"有配置、无用户"的中间态时，`octopi agent new` 会报 create_agent_no_owner，
 * 而此前没有任何命令会提示这件事。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectRegistrySeeding, seedRegistryIfPossible } from '../src/cli/doctor/data.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'octopi-doctor-registry-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function seedRegistryJustTables(): Promise<void> {
  const { RegistryDatabase } = await import(
    '../packages/engine/src/harness/governance/registry/db.js'
  );
  const db = await RegistryDatabase.create({ dbPath: join(home, 'registry.db') });
  db.close();
}

async function seedRegistryWithUser(): Promise<void> {
  const { RegistryService } = await import(
    '../packages/engine/src/harness/governance/registry/service.js'
  );
  const svc = await RegistryService.create({ dbPath: join(home, 'registry.db') });
  try {
    const tenant = svc.ensureTenant('default', 'default');
    await svc.createUserInTenant({
      tenantId: tenant.tenantId,
      name: 'default',
      isPlatformAdmin: true,
    });
  } finally {
    svc.close();
  }
}

describe('detectRegistrySeeding', () => {
  it('reports info when registry.db does not exist (not a defect)', async () => {
    const findings = await detectRegistrySeeding(home);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe('REG001');
    expect(findings[0]!.severity).toBe('info');
    // 不得建库：只读检查不能有副作用
    expect(existsSync(join(home, 'registry.db'))).toBe(false);
  });

  it('warns when registry has tables but zero users (half-initialized)', async () => {
    await seedRegistryJustTables();
    // 模拟老部署：octopi.json 在，但 registry 从未播种
    writeFileSync(join(home, 'octopi.json'), '{}\n', 'utf-8');

    const findings = await detectRegistrySeeding(home);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe('REG004');
    expect(findings[0]!.severity).toBe('warn');
    expect(findings[0]!.message).toContain('0 users');
    // 出路必须可执行
    expect(findings[0]!.hint).toContain('octopi init');
    expect(findings[0]!.hint).toContain('create_agent_no_owner');
  });

  it('reports ok when a user is seeded', async () => {
    await seedRegistryWithUser();
    const findings = await detectRegistrySeeding(home);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe('REG005');
    expect(findings[0]!.severity).toBe('ok');
    expect(findings[0]!.message).toContain('1 user');
  });

  it('never writes: seeding check leaves an unseeded registry untouched', async () => {
    await seedRegistryJustTables();
    const before = existsSync(join(home, 'registry.db'));
    await detectRegistrySeeding(home);
    expect(existsSync(join(home, 'registry.db'))).toBe(before);
  });

  it('marks REG004 fixable when deploymentMode is absent (treated as personal)', async () => {
    await seedRegistryJustTables();
    writeFileSync(join(home, 'octopi.json'), '{}\n', 'utf-8');

    const findings = await detectRegistrySeeding(home);
    expect(findings[0]!.id).toBe('REG004');
    expect(findings[0]!.fixable).toBe(true);
    expect(findings[0]!.hint).toContain('doctor --fix');
  });

  it('marks REG004 fixable for explicit personal mode', async () => {
    await seedRegistryJustTables();
    writeFileSync(
      join(home, 'octopi.json'),
      JSON.stringify({ deploymentMode: 'personal' }),
      'utf-8',
    );

    const findings = await detectRegistrySeeding(home);
    expect(findings[0]!.id).toBe('REG004');
    expect(findings[0]!.fixable).toBe(true);
  });

  it('does NOT mark REG004 fixable for organization modes (password required)', async () => {
    await seedRegistryJustTables();
    writeFileSync(
      join(home, 'octopi.json'),
      JSON.stringify({ deploymentMode: 'organization' }),
      'utf-8',
    );

    const findings = await detectRegistrySeeding(home);
    expect(findings[0]!.id).toBe('REG004');
    expect(findings[0]!.fixable).toBe(false);
    expect(findings[0]!.group).toBeUndefined();
    // 必须点名"需要密码"，并给出可执行出路
    expect(findings[0]!.hint).toContain('admin password');
    expect(findings[0]!.hint).toContain('octopi init');
  });
});

describe('seedRegistryIfPossible', () => {
  it('seeds a personal deployment end-to-end (agent new can then find an owner)', async () => {
    await seedRegistryJustTables();
    writeFileSync(
      join(home, 'octopi.json'),
      JSON.stringify({ deploymentMode: 'personal' }),
      'utf-8',
    );

    const note = await seedRegistryIfPossible(home);
    expect(note).toContain('personal');

    // 断言真实效果：播种后 REG004 消失，owner 可解析
    const after = await detectRegistrySeeding(home);
    expect(after[0]!.id).toBe('REG005');

    const { RegistryService } = await import(
      '../packages/engine/src/harness/governance/registry/service.js'
    );
    const svc = await RegistryService.create({ dbPath: join(home, 'registry.db') });
    try {
      const owner = svc.getUserByName('default') ?? svc.getUserByName('admin');
      expect(owner).not.toBeNull();
      expect(owner!.name).toBe('default');
    } finally {
      svc.close();
    }
  });

  it('refuses organization modes rather than guessing an admin password', async () => {
    await seedRegistryJustTables();
    writeFileSync(
      join(home, 'octopi.json'),
      JSON.stringify({ deploymentMode: 'organization' }),
      'utf-8',
    );

    await expect(seedRegistryIfPossible(home)).rejects.toThrow(
      /registry_seed_needs_password/,
    );

    // 拒绝后不得留下半截用户
    const after = await detectRegistrySeeding(home);
    expect(after[0]!.id).toBe('REG004');
  });
});
