/**
 * Skill 双层发现（共享层 + agent 覆盖层）
 *
 * C 方案契约（2026-11-23 拍板）：
 * - discover([共享层, agent 层])：按序合并，后层同 id 覆盖前层（agent 层赢）
 * - load() 回各自 source——覆盖后必须读到覆盖层文件，不跟最后一次 discover 漂移
 * - allowlist（agents[].skills）对合并后全集生效；跨层互补可凑齐
 * - 单目录 discover 向后兼容（layer 不标注）
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { DefaultSkillManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/manager.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let sharedDir: string;
let agentDir: string;

function writeSkill(dir: string, id: string, name: string, body: string): void {
  const skillDir = join(dir, id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill ${id}\n---\n\n${body}\n`,
    'utf8',
  );
}

beforeEach(() => {
  sharedDir = mkdtempSync(join(tmpdir(), 'skills-shared-'));
  agentDir = mkdtempSync(join(tmpdir(), 'skills-agent-'));
});

afterEach(() => {
  rmSync(sharedDir, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

describe('skill two-layer discovery', () => {
  test('双层各自独有 skill 都被发现', async () => {
    writeSkill(sharedDir, 'alpha', 'Alpha', 'shared alpha body');
    writeSkill(agentDir, 'beta', 'Beta', 'agent beta body');

    const mgr = new DefaultSkillManager();
    await mgr.discover([sharedDir, agentDir]);

    expect(mgr.get('alpha')).not.toBeNull();
    expect(mgr.get('beta')).not.toBeNull();
    expect(mgr.list()).toHaveLength(2);
  });

  test('同名 skill：agent 层赢（覆盖语义）', async () => {
    writeSkill(sharedDir, 'alpha', 'AlphaShared', 'SHARED BODY');
    writeSkill(agentDir, 'alpha', 'AlphaAgent', 'AGENT OVERRIDE BODY');

    const mgr = new DefaultSkillManager();
    await mgr.discover([sharedDir, agentDir]);

    const got = mgr.get('alpha');
    expect(got).not.toBeNull();
    expect(got!.name).toBe('AlphaAgent');
    // filePath 必须指向覆盖层文件
    expect(got!.filePath).toContain(agentDir);
  });

  test('load() 读到覆盖层内容（回源不漂移）', async () => {
    writeSkill(sharedDir, 'alpha', 'AlphaShared', 'SHARED BODY');
    writeSkill(agentDir, 'alpha', 'AlphaAgent', 'AGENT OVERRIDE BODY');

    const mgr = new DefaultSkillManager();
    await mgr.discover([sharedDir, agentDir]);

    const content = await mgr.load('alpha');
    expect(content).toContain('AGENT OVERRIDE BODY');
    expect(content).not.toContain('SHARED BODY');
  });

  test('无覆盖时 load() 读共享层内容（sourceOf 各自回源）', async () => {
    writeSkill(sharedDir, 'alpha', 'AlphaShared', 'SHARED BODY');

    const mgr = new DefaultSkillManager();
    await mgr.discover([sharedDir, agentDir]);

    const content = await mgr.load('alpha');
    expect(content).toContain('SHARED BODY');
  });

  test('layer 标注：首层 shared、其余 agent', async () => {
    writeSkill(sharedDir, 'alpha', 'AlphaShared', 'body');
    writeSkill(agentDir, 'beta', 'Beta', 'body');

    const mgr = new DefaultSkillManager();
    await mgr.discover([sharedDir, agentDir]);

    expect(mgr.get('alpha')!.layer).toBe('shared');
    expect(mgr.get('beta')!.layer).toBe('agent');
  });

  test('单目录 discover 向后兼容：不标注 layer', async () => {
    writeSkill(sharedDir, 'alpha', 'Alpha', 'body');

    const mgr = new DefaultSkillManager();
    await mgr.discover(sharedDir);

    expect(mgr.get('alpha')!.layer).toBeUndefined();
  });

  test('allowlist 对合并全集生效：跨层互补可凑齐', async () => {
    writeSkill(sharedDir, 'alpha', 'Alpha', 'body');
    writeSkill(agentDir, 'beta', 'Beta', 'body');

    const mgr = new DefaultSkillManager(undefined, { only: ['alpha', 'beta'] });
    await mgr.discover([sharedDir, agentDir]);

    expect(mgr.get('alpha')).not.toBeNull();
    expect(mgr.get('beta')).not.toBeNull();
  });

  test('allowlist 挡住未列出的覆盖层 skill', async () => {
    writeSkill(sharedDir, 'alpha', 'AlphaShared', 'body');
    writeSkill(agentDir, 'alpha', 'AlphaAgent', 'body');

    const mgr = new DefaultSkillManager(undefined, { only: ['beta'] });
    await mgr.discover([sharedDir, agentDir]);

    expect(mgr.get('alpha')).toBeNull();
    expect(mgr.get('beta')).toBeNull();
  });

  test('缺失目录不炸：其余层照常发现', async () => {
    writeSkill(agentDir, 'beta', 'Beta', 'body');

    const mgr = new DefaultSkillManager();
    await mgr.discover([join(sharedDir, 'no-such-dir'), agentDir]);

    expect(mgr.get('beta')).not.toBeNull();
    expect(mgr.list()).toHaveLength(1);
  });

  test('formatForPrompt 输出覆盖层的绝对路径', async () => {
    writeSkill(sharedDir, 'alpha', 'AlphaShared', 'body');
    writeSkill(agentDir, 'alpha', 'AlphaAgent', 'body');

    const mgr = new DefaultSkillManager();
    await mgr.discover([sharedDir, agentDir]);

    const prompt = mgr.formatForPrompt();
    expect(prompt).toContain(join(agentDir, 'alpha', 'SKILL.md'));
  });
});
