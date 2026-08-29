/**
 * Skill 系统测试（两阶段加载）
 *
 * 覆盖：discover、formatForPrompt、load、get、list
 * 边界：空目录、无效 frontmatter、缺失字段、disableModelInvocation、热重载
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { DefaultSkillManager } from '../src/harness/plugin-ecosystem/skills/manager.js';
import { resolve } from 'path';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';

const FIXTURES = resolve('./tests/fixtures/skills');

describe('DefaultSkillManager', () => {
  let manager: DefaultSkillManager;

  beforeEach(() => {
    manager = new DefaultSkillManager();
  });

  // ─────────────────────────────────────────────
  // discover
  // ─────────────────────────────────────────────
  describe('discover', () => {
    test('加载所有有效 Skill 元数据', async () => {
      await manager.discover(FIXTURES);

      const skills = manager.list();
      // valid-skill, disabled-model, custom-triggers 应该被加载
      // empty-description 和 missing-frontmatter 应该被跳过
      expect(skills.length).toBeGreaterThanOrEqual(3);
    });

    test('跳过没有 SKILL.md 的目录', async () => {
      await manager.discover(FIXTURES);

      // no-skill-file 目录没有 SKILL.md，不应出现
      expect(manager.get('no-skill-file')).toBeNull();
    });

    test('跳过 frontmatter 缺失 name 的 Skill', async () => {
      await manager.discover(FIXTURES);

      // missing-frontmatter 没有 frontmatter
      expect(manager.get('missing-frontmatter')).toBeNull();
    });

    test('跳过 description 为空的 Skill', async () => {
      await manager.discover(FIXTURES);

      // empty-description 的 description 为空
      expect(manager.get('empty-description')).toBeNull();
    });

    test('解析 disable-model-invocation: true', async () => {
      await manager.discover(FIXTURES);

      const disabled = manager.get('disabled-model');
      expect(disabled).not.toBeNull();
      expect(disabled!.disableModelInvocation).toBe(true);
    });

    test('解析 tools 字段', async () => {
      await manager.discover(FIXTURES);

      const custom = manager.get('custom-triggers');
      expect(custom).not.toBeNull();
      expect(custom!.requiredTools).toEqual(['web_search', 'browser']);
    });

    test('解析逗号分隔的 tools（中文逗号）', async () => {
      // valid-skill 的 tools: shell, browser
      await manager.discover(FIXTURES);

      const valid = manager.get('valid-skill');
      expect(valid).not.toBeNull();
      expect(valid!.requiredTools).toEqual(['shell', 'browser']);
    });

    test('source 字段设为 workspace', async () => {
      await manager.discover(FIXTURES);

      for (const skill of manager.list()) {
        expect(skill.source).toBe('workspace');
      }
    });

    test('不存在的目录不报错', async () => {
      await manager.discover('./nonexistent-dir');
      expect(manager.list()).toHaveLength(0);
    });

    test('空目录不报错', async () => {
      const emptyDir = resolve(FIXTURES, '../empty-skills-dir');
      mkdirSync(emptyDir, { recursive: true });
      try {
        await manager.discover(emptyDir);
        expect(manager.list()).toHaveLength(0);
      } finally {
        rmSync(emptyDir, { recursive: true });
      }
    });

    test('重复 discover 覆盖旧数据', async () => {
      await manager.discover(FIXTURES);
      const count1 = manager.list().length;

      await manager.discover(FIXTURES);
      const count2 = manager.list().length;

      expect(count2).toBe(count1);
    });
  });

  // ─────────────────────────────────────────────
  // formatForPrompt
  // ─────────────────────────────────────────────
  describe('formatForPrompt', () => {
    test('输出 XML 格式', async () => {
      await manager.discover(FIXTURES);

      const prompt = manager.formatForPrompt();
      expect(prompt).toContain('<available_skills>');
      expect(prompt).toContain('</available_skills>');
    });

    test('每个 Skill 有 name 和 description', async () => {
      await manager.discover(FIXTURES);

      const prompt = manager.formatForPrompt();
      expect(prompt).toContain('<name>valid-skill</name>');
      expect(prompt).toContain('<description>这是一个用于测试的有效 Skill</description>');
    });

    test('不包含 disableModelInvocation 的 Skill', async () => {
      await manager.discover(FIXTURES);

      const prompt = manager.formatForPrompt();
      expect(prompt).not.toContain('disabled-model');
      expect(prompt).not.toContain('隐藏 Skill');
    });

    test('末尾包含 read 工具提示', async () => {
      await manager.discover(FIXTURES);

      const prompt = manager.formatForPrompt();
      expect(prompt).toContain('read');
      expect(prompt).toContain('SKILL.md');
    });

    test('无 Skill 时返回空字符串', () => {
      expect(manager.formatForPrompt()).toBe('');
    });
  });

  // ─────────────────────────────────────────────
  // load
  // ─────────────────────────────────────────────
  describe('load', () => {
    test('返回剥离 frontmatter 的内容', async () => {
      await manager.discover(FIXTURES);

      const content = await manager.load('valid-skill');
      expect(content).not.toBeNull();
      expect(content).not.toContain('---');
      expect(content).toContain('测试 Skill');
      expect(content).toContain('步骤 1');
    });

    test('返回最新文件内容（热重载）', async () => {
      const testDir = resolve(FIXTURES, 'reload-test');
      const skillDir = resolve(testDir, 'reload-skill');
      mkdirSync(skillDir, { recursive: true });
      const skillFile = resolve(skillDir, 'SKILL.md');

      try {
        // 写入初始内容，discover 加载
        writeFileSync(
          skillFile,
          '---\nname: 重载测试\ndescription: 初始版本\n---\n# 版本 1',
        );
        const m1 = new DefaultSkillManager();
        await m1.discover(testDir);
        const v1 = await m1.load('reload-skill');
        expect(v1).not.toBeNull();
        expect(v1).toContain('版本 1');

        // 修改文件，重新 discover，应该拿到新内容
        writeFileSync(
          skillFile,
          '---\nname: 重载测试\ndescription: 更新版本\n---\n# 版本 2',
        );
        const m2 = new DefaultSkillManager();
        await m2.discover(testDir);
        const v2 = await m2.load('reload-skill');
        expect(v2).not.toBeNull();
        expect(v2).toContain('版本 2');
        expect(v2).not.toContain('版本 1');
      } finally {
        rmSync(testDir, { recursive: true });
      }
    });

    test('不存在的 Skill 返回 null', async () => {
      expect(await manager.load('nonexistent')).toBeNull();
    });

    test('load 前必须先 discover', async () => {
      // 没有 discover 就 load，应该返回 null
      expect(await manager.load('valid-skill')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  // get & list
  // ─────────────────────────────────────────────
  describe('get & list', () => {
    test('get 返回正确的 Skill 定义', async () => {
      await manager.discover(FIXTURES);

      const skill = manager.get('valid-skill');
      expect(skill).not.toBeNull();
      expect(skill!.id).toBe('valid-skill');
      expect(skill!.name).toBe('测试 Skill');
      expect(skill!.description).toBe('这是一个用于测试的有效 Skill');
      expect(skill!.source).toBe('workspace');
      expect(skill!.filePath).toContain('SKILL.md');
    });

    test('get 不存在的 Skill 返回 null', () => {
      expect(manager.get('nonexistent')).toBeNull();
    });

    test('list 返回所有已发现的 Skill', async () => {
      await manager.discover(FIXTURES);

      const skills = manager.list();
      const ids = skills.map((s) => s.id);

      expect(ids).toContain('valid-skill');
      expect(ids).toContain('disabled-model');
      expect(ids).toContain('custom-triggers');
      expect(ids).not.toContain('empty-description');
      expect(ids).not.toContain('missing-frontmatter');
    });

    test('list 返回空数组（未 discover）', () => {
      expect(manager.list()).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────
  // 与真实 skills/ 目录集成
  // ─────────────────────────────────────────────
  describe('集成测试（真实 skills 目录）', () => {
    test('加载项目 skills/ 目录', async () => {
      await manager.discover('./skills');

      const skills = manager.list();
      if (skills.length > 0) {
        // 如果项目有 skills，验证格式
        const prompt = manager.formatForPrompt();
        expect(prompt).toContain('<available_skills>');

        for (const skill of skills) {
          expect(skill.id).toBeTruthy();
          expect(skill.name).toBeTruthy();
          expect(skill.description).toBeTruthy();
          expect(skill.filePath).toContain('SKILL.md');
        }
      }
    });
  });
});
