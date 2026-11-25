/**
 * skill_read 消费面 — SkillManager.listFiles/loadFile + skill_read 工具渲染
 * （arch/skill-creation-design.md §12.3 按需读取 + 大小三层防线）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultSkillManager } from '../packages/engine/src/harness/extension/plugin-ecosystem/skills/manager.js';
import { createSkillTools } from '../packages/engine/src/harness/extension/plugin-ecosystem/tools/skill-tools.js';
import type { SkillLifecycle } from '../packages/engine/src/harness/extension/plugin-ecosystem/skills/lifecycle.js';

let dir: string;

function writeSkill(id: string, body: string, extra?: Record<string, string>): void {
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${id}\ndescription: Test skill ${id}\n---\n${body}`);
  for (const [rel, content] of Object.entries(extra ?? {})) {
    const abs = join(d, ...rel.split('/'));
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-read-'));
  writeSkill('alpha', 'Alpha body line 1\nAlpha body line 2', {
    'references/spec.md': '# Spec\nDetailed spec here',
    'scripts/run.sh': '#!/bin/bash\necho hi',
    'assets/logo.bin': Buffer.from([0x89, 0x50, 0x00, 0x01]).toString('binary'),
    'assets/big.txt': Array.from({ length: 100 }, (_, i) => `big line ${i}`).join('\n') +
      '\n' +
      'x'.repeat(2 * 1024 * 1024),
  });
  writeSkill('drift', 'Body that will drift');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SkillManager.listFiles（附件清单）', () => {
  it('列附件不列 SKILL.md，文本带首行提要', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const listing = await mgr.listFiles('alpha');
    expect(listing).not.toBeNull();
    const paths = listing!.entries.map((e) => e.path);
    expect(paths).not.toContain('SKILL.md');
    expect(paths).toContain('references/spec.md');
    const spec = listing!.entries.find((e) => e.path === 'references/spec.md')!;
    expect(spec.kind).toBe('text');
    expect(spec.excerpt).toBe('# Spec');
  });

  it('二进制/大文件只标类型不读提要', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const listing = await mgr.listFiles('alpha');
    const bin = listing!.entries.find((e) => e.path === 'assets/logo.bin')!;
    expect(bin.kind).toBe('binary');
    expect(bin.excerpt).toBeUndefined();
    const big = listing!.entries.find((e) => e.path === 'assets/big.txt')!;
    expect(big.kind).toBe('large');
    expect(big.excerpt).toBeUndefined();
  });

  it('不在索引的 id 返回 null', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    expect(await mgr.listFiles('ghost')).toBeNull();
  });
});

describe('SkillManager.loadFile（附件读取 + 二次 containment）', () => {
  it('正常读取带行数与 fileHash', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const r = await mgr.loadFile('alpha', 'references/spec.md');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.content).toContain('Detailed spec here');
    expect(r.totalLines).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.fileHash).toMatch(/^sha256:/);
  });

  it('offset/limit 分段截断带续读信息', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const r = await mgr.loadFile('alpha', 'assets/big.txt', { offset: 2, limit: 1 });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.truncated).toBe(true);
    expect(r.fromLine).toBe(2);
    expect(r.toLine).toBe(2);
  });

  it('拒绝 .. 路径逃逸', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const r = await mgr.loadFile('alpha', '../drift/SKILL.md');
    expect(r).toEqual({
      status: 'path_forbidden',
      reason: 'path traversal ("..") is not allowed',
    });
  });

  it('拒绝绝对路径', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const r = await mgr.loadFile('alpha', '/etc/passwd');
    expect(r.status).toBe('path_forbidden');
  });

  it('拒绝 symlink 逃逸', async () => {
    const escape = join(dir, 'alpha', 'escape.md');
    try {
      symlinkSync(join(dir, 'drift', 'SKILL.md'), escape);
    } catch {
      return; // 平台不支持 symlink 时跳过
    }
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const r = await mgr.loadFile('alpha', 'escape.md');
    expect(r.status).toBe('path_forbidden');
  });

  it('二进制附件拒读', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    expect(await mgr.loadFile('alpha', 'assets/logo.bin')).toEqual({ status: 'binary' });
  });

  it('不存在的附件 not_found', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    expect(await mgr.loadFile('alpha', 'references/ghost.md')).toEqual({ status: 'not_found' });
  });

  it('loadGuard 漂移锚定同样约束附件（目录级锚）', async () => {
    const mgr = new DefaultSkillManager(dir, {
      loadGuard: {
        checkLoad: () => ({ allow: false, reason: 'content changed since review (hash drift)' }),
      },
    });
    await mgr.discover(dir);
    const r = await mgr.loadFile('alpha', 'references/spec.md');
    expect(r.status).toBe('refused');
    if (r.status === 'refused') expect(r.kind).toBe('hash_drift');
  });
});

describe('skill_read 工具渲染', () => {
  const fakeLifecycle = {} as SkillLifecycle;

  it('默认分支：正文 + 附件清单一次给出', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const [readTool] = createSkillTools({ lifecycle: fakeLifecycle, skills: mgr }).filter(
      (t) => t.definition.name === 'skill_read',
    );
    const result = (await readTool.handler!({ id: 'alpha' }, undefined as never)) as Record<string, unknown>;
    expect(result.body).toContain('Alpha body line 1');
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.filesTotal).toBe(4);
    expect(result.truncated).toBe(false);
  });

  it('正文超限截断带续读提示', async () => {
    const big = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    writeSkill('longbody', big);
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const [readTool] = createSkillTools({ lifecycle: fakeLifecycle, skills: mgr }).filter(
      (t) => t.definition.name === 'skill_read',
    );
    const result = (await readTool.handler!(
      { id: 'longbody', limit: 10 },
      undefined as never,
    )) as Record<string, unknown>;
    expect(result.truncated).toBe(true);
    expect(String(result.hint)).toContain('offset=11');
  });

  it('file 分支：附件内容 + 续读提示', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const [readTool] = createSkillTools({ lifecycle: fakeLifecycle, skills: mgr }).filter(
      (t) => t.definition.name === 'skill_read',
    );
    const result = (await readTool.handler!(
      { id: 'alpha', file: 'references/spec.md' },
      undefined as never,
    )) as Record<string, unknown>;
    expect(result.content).toContain('Detailed spec here');
    expect(result.truncated).toBe(false);
  });

  it('hash_drift 报因（审查锚定）', async () => {
    const mgr = new DefaultSkillManager(dir, {
      loadGuard: {
        checkLoad: () => ({
          allow: false,
          reason: 'content changed since review (hash drift) — resubmit via skill_submit for review',
        }),
      },
    });
    await mgr.discover(dir);
    const [readTool] = createSkillTools({ lifecycle: fakeLifecycle, skills: mgr }).filter(
      (t) => t.definition.name === 'skill_read',
    );
    await expect(
      readTool.handler!({ id: 'alpha' }, undefined as never),
    ).rejects.toThrow('hash drift');
  });

  it('limit 参数硬顶（超大 limit 不绕过截断防线）', async () => {
    const big = Array.from({ length: 8000 }, (_, i) => `line ${i}`).join('\n');
    writeSkill('capped', big);
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const [readTool] = createSkillTools({ lifecycle: fakeLifecycle, skills: mgr }).filter(
      (t) => t.definition.name === 'skill_read',
    );
    const result = (await readTool.handler!(
      { id: 'capped', limit: 999999 },
      undefined as never,
    )) as Record<string, unknown>;
    // 硬顶 MAX_READ_LIMIT=5000 行：正文必须被截断而非全量返回
    expect(result.truncated).toBe(true);
    expect(String(result.body).split('\n').length).toBeLessThanOrEqual(5000);
  });

  it('越界 offset 显式 outOfRange（不静默钳到末行）', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const [readTool] = createSkillTools({ lifecycle: fakeLifecycle, skills: mgr }).filter(
      (t) => t.definition.name === 'skill_read',
    );
    const result = (await readTool.handler!(
      { id: 'alpha', file: 'references/spec.md', offset: 9999 },
      undefined as never,
    )) as Record<string, unknown>;
    expect(result.outOfRange).toBe(true);
    expect(result.content).toBe('');
    expect(result.truncated).toBe(false);
  });

  it('不存在的技能报明确因', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const [readTool] = createSkillTools({ lifecycle: fakeLifecycle, skills: mgr }).filter(
      (t) => t.definition.name === 'skill_read',
    );
    await expect(readTool.handler!({ id: 'ghost' }, undefined as never)).rejects.toThrow('not found');
  });

  it('manager 未就绪 fail-loud（provider 时序解耦）', async () => {
    const [readTool] = createSkillTools({
      lifecycle: fakeLifecycle,
      skills: () => undefined,
    }).filter((t) => t.definition.name === 'skill_read');
    await expect(readTool.handler!({ id: 'alpha' }, undefined as never)).rejects.toThrow('not ready');
  });
});
