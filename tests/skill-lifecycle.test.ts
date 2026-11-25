/**
 * SkillLifecycle 测试（arch/skill-creation-design.md §4–§6 拍板语义）
 *
 * 覆盖：submit 校验闸 / review 批准物化与驳回 / setEnabled 正交开关 /
 *      admit 准入语义（dropped-in 自动登记、submitted 哈希漂移审查作废、disabled 拒）/
 *      DefaultSkillManager 双层集成（agent 层过闸、shared 层放盘信任）
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SkillStateDatabase } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/registry.js';
import { SkillLifecycle } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/lifecycle.js';
import { DefaultSkillManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/manager.js';
import { hashSkillDir } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/hash.js';

describe('SkillLifecycle', () => {
  let home: string;
  let workspace: string;
  let db: SkillStateDatabase;
  let lifecycle: SkillLifecycle;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'skill-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'skill-ws-'));
    db = await SkillStateDatabase.create({ dbPath: ':memory:' });
    lifecycle = new SkillLifecycle({ db, octopiHome: home, agentId: 'agent-1' });
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  /** 起草一个技能目录 */
  function draft(id: string, body = '# How to do the thing'): string {
    const dir = join(workspace, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: Does the thing. Use when thing needed.\n---\n${body}\n`);
    return dir;
  }

  test('submit：校验失败不建单，返回逐项 issues', async () => {
    const dir = join(workspace, 'broken');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), '# no frontmatter');
    const r = await lifecycle.submit({ sourceDir: dir });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.code === 'frontmatter_missing')).toBe(true);
    }
    expect(lifecycle.list()).toEqual([]);
  });

  test('submit → approve：staging 物化到 agent skills 目录并默认启用', async () => {
    const r = await lifecycle.submit({ sourceDir: draft('my-skill'), summary: 'does things' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.submission.status).toBe('pending_review');
    const pending = lifecycle.list();
    expect(pending[0].reviewStatus).toBe('pending');
    expect(pending[0].enabled).toBe(false);

    const verdict = await lifecycle.review({ skillId: 'my-skill', verdict: 'approved', by: 'human:tester' });
    expect(verdict.ok).toBe(true);
    const installed = join(home, 'agents', 'agent-1', 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, 'utf-8')).toContain('name: my-skill');

    const record = lifecycle.list()[0];
    expect(record.reviewStatus).toBe('approved');
    expect(record.enabled).toBe(true);
    expect(record.unreviewed).toBe(false);
    expect(record.review?.by).toBe('human:tester');
    expect(record.review?.contentHash).toBe(record.contentHash);
  });

  test('submit → reject：不物化，findings 落审查记录', async () => {
    await lifecycle.submit({ sourceDir: draft('bad-skill') });
    const verdict = await lifecycle.review({
      skillId: 'bad-skill',
      verdict: 'rejected',
      by: 'human:tester',
      findings: 'exfiltrates data',
    });
    expect(verdict.ok).toBe(true);
    expect(existsSync(join(home, 'agents', 'agent-1', 'skills', 'bad-skill'))).toBe(false);
    const record = lifecycle.list()[0];
    expect(record.reviewStatus).toBe('rejected');
    expect(record.enabled).toBe(false);
    expect(record.review?.findings).toBe('exfiltrates data');
  });

  test('setEnabled：未批准不能启用；disable 一键下线', async () => {
    await lifecycle.submit({ sourceDir: draft('toggle-skill') });
    expect(() => lifecycle.setEnabled('toggle-skill', true)).toThrow(/not approved/);

    await lifecycle.review({ skillId: 'toggle-skill', verdict: 'approved', by: 'human:tester' });
    expect(lifecycle.setEnabled('toggle-skill', false).enabled).toBe(false);
    expect(lifecycle.setEnabled('toggle-skill', true).enabled).toBe(true);
  });

  test('admit：未登记自动登记 dropped-in（放盘即信任，unreviewed 标注）', () => {
    const a = lifecycle.admit({ skillId: 'dropped-skill', contentHash: 'sha256:aaa' });
    expect(a.admitted).toBe(true);
    expect(a.unreviewed).toBe(true);
    const record = lifecycle.list()[0];
    expect(record.source).toBe('dropped-in');
    expect(record.unreviewed).toBe(true);
    expect(record.reviewStatus).toBe('approved');
  });

  test('admit：submitted 哈希漂移 = 审查作废回 pending（fail-closed）', async () => {
    await lifecycle.submit({ sourceDir: draft('drift-skill') });
    await lifecycle.review({ skillId: 'drift-skill', verdict: 'approved', by: 'human:tester' });

    const a = lifecycle.admit({ skillId: 'drift-skill', contentHash: 'sha256:CHANGED' });
    expect(a.admitted).toBe(false);
    expect(a.reason).toBe('stale_hash_resubmit_required');
    const record = lifecycle.list()[0];
    expect(record.reviewStatus).toBe('pending');
    expect(record.enabled).toBe(false);
  });

  test('admit：dropped-in 哈希漂移 = 刷新哈希仍准入（放盘信任延续）', () => {
    lifecycle.admit({ skillId: 'free-skill', contentHash: 'sha256:one' });
    const a = lifecycle.admit({ skillId: 'free-skill', contentHash: 'sha256:two' });
    expect(a.admitted).toBe(true);
    expect(lifecycle.list()[0].contentHash).toBe('sha256:two');
  });

  test('admit：disabled / rejected / pending 拒绝', async () => {
    // disabled
    await lifecycle.submit({ sourceDir: draft('off-skill') });
    await lifecycle.review({ skillId: 'off-skill', verdict: 'approved', by: 'human:tester' });
    const hash = lifecycle.list()[0].contentHash;
    lifecycle.setEnabled('off-skill', false);
    expect(lifecycle.admit({ skillId: 'off-skill', contentHash: hash }).admitted).toBe(false);

    // rejected
    await lifecycle.submit({ sourceDir: draft('no-skill') });
    await lifecycle.review({ skillId: 'no-skill', verdict: 'rejected', by: 'human:tester' });
    expect(lifecycle.admit({ skillId: 'no-skill', contentHash: hash }).admitted).toBe(false);

    // pending
    await lifecycle.submit({ sourceDir: draft('wait-skill') });
    expect(lifecycle.admit({ skillId: 'wait-skill', contentHash: hash }).admitted).toBe(false);
  });

  test('DefaultSkillManager 双层：agent 层过闸，shared 层放盘信任', async () => {
    const sharedDir = join(home, 'skills');
    const agentDir = join(home, 'agents', 'agent-1', 'skills');
    for (const [root, id] of [
      [sharedDir, 'shared-skill'],
      [agentDir, 'agent-skill'],
    ] as const) {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(
        join(root, id, 'SKILL.md'),
        `---\nname: ${id}\ndescription: A skill. Use when needed.\n---\nbody\n`,
      );
    }

    const manager = new DefaultSkillManager(undefined, { gate: lifecycle });
    await manager.discover([sharedDir, agentDir]);

    // shared 层不过闸：直接可见
    expect(manager.get('shared-skill')).not.toBeNull();
    // agent 层 dropped-in 自动登记后准入，unreviewed 标注
    const agentSkill = manager.get('agent-skill');
    expect(agentSkill).not.toBeNull();
    expect(agentSkill!.unreviewed).toBe(true);

    // 停用 agent 层技能 → 不进索引
    const hash = hashSkillDir(join(agentDir, 'agent-skill'));
    lifecycle.setEnabled('agent-skill', true); // normalize to approved state
    lifecycle.setEnabled('agent-skill', false);
    const manager2 = new DefaultSkillManager(undefined, { gate: lifecycle });
    await manager2.discover([sharedDir, agentDir]);
    expect(manager2.get('agent-skill')).toBeNull();
    expect(manager2.get('shared-skill')).not.toBeNull();
    expect(hash).toMatch(/^sha256:/);
  });
});

describe('评审修复回归（2026-11-25 独立评审 P0/P1）', () => {
  let home: string;
  let workspace: string;
  let db: SkillStateDatabase;
  let lifecycle: SkillLifecycle;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'skill-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'skill-ws-'));
    db = await SkillStateDatabase.create({ dbPath: ':memory:' });
    lifecycle = new SkillLifecycle({ db, octopiHome: home, agentId: 'agent-1' });
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  function draft(id: string, body = '# how'): string {
    const dir = join(workspace, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: Does the thing. Use when thing needed.\n---\n${body}\n`);
    return dir;
  }

  test('P0-1：非法目录名（下划线/大写）不中止 discover、不失闸', async () => {
    const sharedDir = join(home, 'skills');
    const agentDir = join(home, 'agents', 'agent-1', 'skills');
    // 坏目录（目录名非法，放盘来源不可控）+ 一个好目录 + 一个应被拒目录
    for (const [root, id] of [
      [agentDir, 'my_skill'],
      [agentDir, 'good-skill'],
    ] as const) {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(
        join(root, id, 'SKILL.md'),
        `---\nname: ${id}\ndescription: A skill. Use when needed.\n---\nbody\n`,
      );
    }
    // 应被拒：已提交未审
    await lifecycle.submit({ sourceDir: draft('wait-skill') });

    const manager = new DefaultSkillManager(undefined, { gate: lifecycle });
    await manager.discover([sharedDir, agentDir]); // 不得抛错

    expect(manager.get('my_skill')).toBeNull(); // 非法 id 被拒
    expect(manager.get('good-skill')).not.toBeNull(); // 好技能不被连坐
    expect(manager.get('wait-skill')).toBeNull(); // 闸门未失效
  });

  test('P0-1：gate 抛错时 fail-closed（单技能损失，不失闸）', async () => {
    const agentDir = join(home, 'agents', 'agent-1', 'skills');
    for (const id of ['boom-skill', 'good-skill']) {
      mkdirSync(join(agentDir, id), { recursive: true });
      writeFileSync(
        join(agentDir, id, 'SKILL.md'),
        `---\nname: ${id}\ndescription: A skill. Use when needed.\n---\nbody\n`,
      );
    }
    const throwingGate = {
      admit(): { admitted: boolean } {
        throw new Error('db busy');
      },
    };
    const manager = new DefaultSkillManager(undefined, { gate: throwingGate });
    await manager.discover([join(home, 'skills'), agentDir]);
    expect(manager.get('boom-skill')).toBeNull();
    expect(manager.get('good-skill')).toBeNull(); // gate 全挂时全拒（fail-closed，非 fail-open）
  });

  test('P1-1：同名提交不顶下线已批准技能、不抹审查记录', async () => {
    await lifecycle.submit({ sourceDir: draft('keeper') });
    await lifecycle.review({ skillId: 'keeper', verdict: 'approved', by: 'human:t', findings: 'good' });

    const again = await lifecycle.submit({ sourceDir: draft('keeper', '# v2') });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.issues.some((i) => i.code === 'skill_already_active')).toBe(true);
    }
    const record = lifecycle.list()[0];
    expect(record.enabled).toBe(true);
    expect(record.reviewStatus).toBe('approved');
    expect(record.review?.findings).toBe('good'); // 历史可追溯
  });

  test('P1-2：staging 被偷改 → 批准拒绝（staging_changed_since_submit）', async () => {
    await lifecycle.submit({ sourceDir: draft('tamper') });
    const sub = lifecycle.listSubmissions()[0];
    // 模拟 staging 副本被改动（哈希锚点漂移）
    writeFileSync(join(sub.stagingPath, 'tamper', 'SKILL.md'), '---\nname: tamper\ndescription: x\n---\nEVIL\n');

    const verdict = await lifecycle.review({ skillId: 'tamper', verdict: 'approved', by: 'human:t' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error).toContain('staging_changed_since_submit');
    }
    expect(existsSync(join(home, 'agents', 'agent-1', 'skills', 'tamper'))).toBe(false);
  });

  test('P1-2：漂移后旧 submission 作废 → 批准要求重提，不物化旧内容', async () => {
    await lifecycle.submit({ sourceDir: draft('drift'), });
    await lifecycle.review({ skillId: 'drift', verdict: 'approved', by: 'human:t' });

    // 磁盘内容被改（host 直写）→ discover 发现漂移
    const installDir = join(home, 'agents', 'agent-1', 'skills', 'drift');
    writeFileSync(join(installDir, 'SKILL.md'), `---\nname: drift\ndescription: new\n---\nNEW\n`);
    const hash = hashSkillDir(installDir);
    const a = lifecycle.admit({ skillId: 'drift', contentHash: hash });
    expect(a.reason).toBe('stale_hash_resubmit_required');

    // 旧 submission 已作废：批准被拒（不得拿旧 staging 覆盖磁盘新版本）
    const verdict = await lifecycle.review({ skillId: 'drift', verdict: 'approved', by: 'human:t' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain('resubmit');
    expect(readFileSync(join(installDir, 'SKILL.md'), 'utf-8')).toContain('NEW'); // 磁盘版本未被覆盖

    // 重提 → 批准 → 收敛（可再次准入）
    const resubmit = await lifecycle.submit({ sourceDir: draft('drift', '# v3') });
    expect(resubmit.ok).toBe(true);
    const verdict2 = await lifecycle.review({ skillId: 'drift', verdict: 'approved', by: 'human:t' });
    expect(verdict2.ok).toBe(true);
    const admitted = lifecycle.admit({ skillId: 'drift', contentHash: hashSkillDir(installDir) });
    expect(admitted.admitted).toBe(true);
  });

  test('P1-1 回归：漂移重审路径不受提交保护阻塞（漂移后状态 pending 可重提）', async () => {
    await lifecycle.submit({ sourceDir: draft('renew') });
    await lifecycle.review({ skillId: 'renew', verdict: 'approved', by: 'human:t' });
    const installDir = join(home, 'agents', 'agent-1', 'skills', 'renew');
    writeFileSync(join(installDir, 'SKILL.md'), `---\nname: renew\ndescription: x\n---\nCHANGED\n`);
    lifecycle.admit({ skillId: 'renew', contentHash: hashSkillDir(installDir) }); // → pending

    const again = await lifecycle.submit({ sourceDir: draft('renew', '# fixed') });
    expect(again.ok).toBe(true); // pending 状态允许重提
  });

  test('P1-6：previewSubmission 给出内容面且不泄漏 stagingPath', async () => {
    await lifecycle.submit({ sourceDir: draft('viewme', '# Detailed steps'), summary: 'demo' });
    const sub = lifecycle.listSubmissions()[0];
    const preview = await lifecycle.previewSubmission(sub.submissionId);
    expect(preview).not.toBeNull();
    expect(preview!.skillMd).toContain('Detailed steps');
    expect(preview!.files.map((f) => f.path)).toContain('SKILL.md');
    expect(preview!.summary).toBe('demo');
    expect(JSON.stringify(preview)).not.toContain(sub.stagingPath); // 内部路径不出 DTO
  });
});

// ─────────────────────────────────────────────
// checkLoad — 消费期加载判定（S1 §12.3 load 单源升级）
// ─────────────────────────────────────────────

describe('SkillLifecycle.checkLoad（消费期漂移锚定）', () => {
  let home: string;
  let db: SkillStateDatabase;
  let lifecycle: SkillLifecycle;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'skill-home-'));
    db = await SkillStateDatabase.create({ dbPath: ':memory:' });
    lifecycle = new SkillLifecycle({ db, octopiHome: home, agentId: 'agent-1' });
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  test('未登记（shared 放盘未登记）→ 放行 + unreviewed', () => {
    const v = lifecycle.checkLoad('any-skill', 'sha256:aaa');
    expect(v.allow).toBe(true);
    expect(v.unreviewed).toBe(true);
  });

  test('submitted 漂移 → 拒（审查的是内容不是名字）', () => {
    db.upsertSkill({
      agentId: 'agent-1',
      skillId: 'sub-skill',
      source: 'submitted',
      reviewStatus: 'approved',
      enabled: true,
      contentHash: 'sha256:old',
      unreviewed: false,
    });
    const v = lifecycle.checkLoad('sub-skill', 'sha256:new');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('resubmit');
  });

  test('dropped-in 漂移 → 放行 + unreviewed（放盘信任延续）', () => {
    db.upsertSkill({
      agentId: 'agent-1',
      skillId: 'drop-skill',
      source: 'dropped-in',
      reviewStatus: 'approved',
      enabled: true,
      contentHash: 'sha256:old',
      unreviewed: true,
    });
    const v = lifecycle.checkLoad('drop-skill', 'sha256:new');
    expect(v.allow).toBe(true);
    expect(v.unreviewed).toBe(true);
  });

  test('哈希一致 + approved + enabled → 放行', () => {
    db.upsertSkill({
      agentId: 'agent-1',
      skillId: 'ok-skill',
      source: 'submitted',
      reviewStatus: 'approved',
      enabled: true,
      contentHash: 'sha256:same',
      unreviewed: false,
    });
    expect(lifecycle.checkLoad('ok-skill', 'sha256:same')).toEqual({
      allow: true,
      unreviewed: false,
    });
  });

  test('哈希一致但 disabled → 拒（未启用报因）', () => {
    db.upsertSkill({
      agentId: 'agent-1',
      skillId: 'off-skill',
      source: 'submitted',
      reviewStatus: 'approved',
      enabled: false,
      contentHash: 'sha256:same',
      unreviewed: false,
    });
    const v = lifecycle.checkLoad('off-skill', 'sha256:same');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('disabled');
  });

  test('哈希一致但 pending → 拒（未过审不得消费）', () => {
    db.upsertSkill({
      agentId: 'agent-1',
      skillId: 'pend-skill',
      source: 'submitted',
      reviewStatus: 'pending',
      enabled: true,
      contentHash: 'sha256:same',
      unreviewed: false,
    });
    const v = lifecycle.checkLoad('pend-skill', 'sha256:same');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('not approved');
  });

  test('非法 id → 拒而不抛（与 admit 同规）', () => {
    const v = lifecycle.checkLoad('bad_id!', 'sha256:x');
    expect(v.allow).toBe(false);
    expect(v.reason).toBe('invalid_skill_id');
  });
});
