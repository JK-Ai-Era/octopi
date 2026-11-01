/**
 * agents[].skills allowlist — DefaultSkillManager 按 skill id 过滤发现结果。
 *
 * 防回归背景：该键自声明以来无消费方（skills 一律目录全量发现）；
 * v0.98.12 接线为 allowlist（undefined = 全部启用），discover 未列入的
 * Skill 不进索引、load 恒 null。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultSkillManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/manager.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'octopi-skills-allowlist-'));
  for (const id of ['alpha', 'beta']) {
    mkdirSync(join(dir, id));
    writeFileSync(
      join(dir, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${id} skill\n---\n\nbody\n`,
    );
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DefaultSkillManager only allowlist', () => {
  it('without allowlist: all discovered skills are enabled', async () => {
    const mgr = new DefaultSkillManager();
    await mgr.discover(dir);
    expect(mgr.list().map((s) => s.id).sort()).toEqual(['alpha', 'beta']);
  });

  it('with allowlist: only listed ids are indexed, others load as null', async () => {
    const mgr = new DefaultSkillManager(undefined, { only: ['alpha'] });
    await mgr.discover(dir);
    expect(mgr.list().map((s) => s.id)).toEqual(['alpha']);
    expect(mgr.get('beta')).toBeNull();
    await expect(mgr.load('beta')).resolves.toBeNull();
    await expect(mgr.load('alpha')).resolves.toContain('body');
    expect(mgr.formatForPrompt()).not.toContain('beta');
  });

  it('allowlist 未命中的 id 打 warn（防静默全关）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mgr = new DefaultSkillManager(undefined, { only: ['alpha', 'ghost'] });
      await mgr.discover(dir);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"ghost"'));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('"alpha"'));
    } finally {
      warn.mockRestore();
    }
  });
});
