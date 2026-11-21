/**
 * 类型模板物化测试：applyRolePresetFiles（CLI/Web 共用）+ AgentFileAdmin.scaffold
 *
 * 覆盖拍板 2026-11-21：四件套整体替换、Web 创建路径模板生效（遮蔽修复）、双语缺省。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFileAdmin, applyRolePresetFiles } from '../src/agent-admin.js';
import { ensureAgentDirs } from '../src/init.js';

describe('applyRolePresetFiles', () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'octopi-agent-admin-'));
    home = join(dir, 'agents/x');
    await ensureAgentDirs('x', dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('应用类型模板：AGENTS.md 覆写 + 四件套整体替换 + skills 落盘', () => {
    // 40-tools 不在四件套清理集内（可能是用户 TOOLS.md 迁移数据，按名清理会删用户数据）
    writeFileSync(join(home, 'persona/40-tools.md'), '# legacy tools', 'utf-8');

    applyRolePresetFiles(home, {
      agentsMd: '# typed persona',
      personaFiles: [{ file: '10-soul.md', content: '# typed soul' }],
      skills: [{ id: 'sk1', name: 'SK', description: 'desc', content: 'skill body' }],
    });

    expect(readFileSync(join(home, 'AGENTS.md'), 'utf-8')).toBe('# typed persona');
    expect(readFileSync(join(home, 'persona/10-soul.md'), 'utf-8')).toBe('# typed soul');
    // 未被新模板提供的四件套成员清理（整体替换语义）
    expect(existsSync(join(home, 'persona/20-identity.md'))).toBe(false);
    expect(existsSync(join(home, 'persona/30-user.md'))).toBe(false);
    // 集合外文件不碰：40-tools（用户数据）与自定义笔记
    expect(readFileSync(join(home, 'persona/40-tools.md'), 'utf-8')).toBe('# legacy tools');
    writeFileSync(join(home, 'persona/99-notes.md'), '# mine', 'utf-8');
    applyRolePresetFiles(home, {
      agentsMd: '# again',
      personaFiles: [{ file: '10-soul.md', content: '# s' }],
    });
    expect(readFileSync(join(home, 'persona/99-notes.md'), 'utf-8')).toBe('# mine');
    expect(readFileSync(join(home, 'persona/40-tools.md'), 'utf-8')).toBe('# legacy tools');

    const skillMd = readFileSync(join(home, 'skills/sk1/SKILL.md'), 'utf-8');
    expect(skillMd).toContain('name: "SK"');
    expect(skillMd).toContain('skill body');
  });

  it('非法载荷整体拒绝且不碰盘（校验先于写盘/删除）', () => {
    const mdBefore = readFileSync(join(home, 'AGENTS.md'), 'utf-8');
    const soulBefore = readFileSync(join(home, 'persona/10-soul.md'), 'utf-8');

    // persona 文件名非法：不得先覆写 AGENTS.md / 删四件套再抛
    expect(() =>
      applyRolePresetFiles(home, {
        agentsMd: '# hijacked',
        personaFiles: [{ file: '../evil.md', content: 'x' }],
      }),
    ).toThrow(/invalid persona file name/);
    // skill id 非法：同理
    expect(() =>
      applyRolePresetFiles(home, {
        agentsMd: '# hijacked',
        skills: [{ id: '', name: 'n', description: 'd', content: 'c' }],
      }),
    ).toThrow(/invalid config name/);
    // 空 AGENTS.md 拒绝
    expect(() => applyRolePresetFiles(home, { agentsMd: '   ' })).toThrow(/non-empty/);

    expect(readFileSync(join(home, 'AGENTS.md'), 'utf-8')).toBe(mdBefore);
    expect(readFileSync(join(home, 'persona/10-soul.md'), 'utf-8')).toBe(soulBefore);
    expect(existsSync(join(home, 'persona/20-identity.md'))).toBe(true);
    expect(existsSync(join(home, 'skills'))).toBe(true);
  });

  it('personaFiles 未提供：只写 AGENTS.md，不触碰四件套', () => {
    applyRolePresetFiles(home, { agentsMd: '# only md' });
    expect(readFileSync(join(home, 'AGENTS.md'), 'utf-8')).toBe('# only md');
    expect(existsSync(join(home, 'persona/10-soul.md'))).toBe(true);
    expect(existsSync(join(home, 'persona/20-identity.md'))).toBe(true);
    expect(existsSync(join(home, 'persona/30-user.md'))).toBe(true);
  });

  it('路径穿越文件名 / skill id fail-loud', () => {
    expect(() =>
      applyRolePresetFiles(home, {
        agentsMd: '# x',
        personaFiles: [{ file: '../evil.md', content: 'x' }],
      }),
    ).toThrow(/invalid persona file name/);
    // skill id 走引擎单一守卫 assertSafeConfigName
    expect(() =>
      applyRolePresetFiles(home, {
        agentsMd: '# x',
        skills: [{ id: '../evil', name: 'n', description: 'd', content: 'c' }],
      }),
    ).toThrow(/invalid config name/);
    // 尾空格文件名拒绝（否则替换不命中 + loadPersona 过滤 → 身份静默消失）
    expect(() =>
      applyRolePresetFiles(home, {
        agentsMd: '# x',
        personaFiles: [{ file: '10-soul.md ', content: 'x' }],
      }),
    ).toThrow(/invalid persona file name/);
  });

  it('home 不存在 fail-loud', () => {
    expect(() => applyRolePresetFiles(join(dir, 'nope'), { agentsMd: '# x' })).toThrow(
      /agent home not found/,
    );
  });
});

describe('AgentFileAdmin.scaffold', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octopi-scaffold-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('带模板创建：模板生效（Web 创建路径遮蔽修复）', async () => {
    const admin = new AgentFileAdmin(dir);
    await admin.scaffold('a1', {
      agentsMd: '# type template md',
      personaFiles: [
        { file: '10-soul.md', content: '# type soul' },
        { file: '20-identity.md', content: '# type identity' },
        { file: '30-user.md', content: '# type user' },
      ],
      skills: [{ id: 'sk', name: 'N', description: 'D', content: 'C' }],
    });
    const home = join(dir, 'agents/a1');
    // ensureAgentDirs 先写 general 默认四件套，随后被模板覆写（不再被遮蔽）
    expect(readFileSync(join(home, 'AGENTS.md'), 'utf-8')).toBe('# type template md');
    expect(readFileSync(join(home, 'persona/10-soul.md'), 'utf-8')).toBe('# type soul');
    expect(readFileSync(join(home, 'persona/20-identity.md'), 'utf-8')).toBe('# type identity');
    expect(existsSync(join(home, 'skills/sk/SKILL.md'))).toBe(true);
  });

  it('无模板：general 缺省四件套（zh），无 Session Startup 指令', async () => {
    const admin = new AgentFileAdmin(dir);
    await admin.scaffold('a2', {});
    const home = join(dir, 'agents/a2');
    const agentsMd = readFileSync(join(home, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('工作方式');
    expect(agentsMd).not.toContain('Session Startup');
    expect(existsSync(join(home, 'persona/10-soul.md'))).toBe(true);
    expect(existsSync(join(home, 'persona/20-identity.md'))).toBe(true);
    expect(existsSync(join(home, 'persona/30-user.md'))).toBe(true);
  });

  it('lang=en：缺省四件套产出英文', async () => {
    const admin = new AgentFileAdmin(dir);
    await admin.scaffold('a3', { lang: 'en' });
    const home = join(dir, 'agents/a3');
    expect(readFileSync(join(home, 'AGENTS.md'), 'utf-8')).toContain('Operating Instructions');
    expect(readFileSync(join(home, 'persona/30-user.md'), 'utf-8')).toContain('you');
  });

  it('readPersonaFiles 读回四件套（另存为模板 round-trip 数据源）', async () => {
    const admin = new AgentFileAdmin(dir);
    await admin.scaffold('a4', {});
    const files = admin.readPersonaFiles('a4');
    expect(files.map((f) => f.file)).toEqual(['10-soul.md', '20-identity.md', '30-user.md']);
    expect(files[0]!.content).toContain('人格定义');
  });

  it('id 穿越形态拒绝（纵深防御）', async () => {
    const admin = new AgentFileAdmin(dir);
    await expect(admin.scaffold('../evil', {})).rejects.toThrow(/invalid agent id/);
  });
});
