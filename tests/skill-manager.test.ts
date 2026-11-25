/**
 * Skill 系统测试（两阶段加载）
 *
 * 覆盖：discover、formatForPrompt、load、get、list
 * 边界：空目录、无效 frontmatter、缺失字段、disableModelInvocation、热重载
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { DefaultSkillManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/manager.js';
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

    test('每个 Skill 有 name、description 与绝对 path', async () => {
      await manager.discover(FIXTURES);

      const prompt = manager.formatForPrompt();
      expect(prompt).toContain('<name>valid-skill</name>');
      expect(prompt).toContain('<description>这是一个用于测试的有效 Skill</description>');
      expect(prompt).toMatch(/<path>[^<]*valid-skill[\\/]SKILL\.md<\/path>/);
    });

    test('不包含 disableModelInvocation 的 Skill', async () => {
      await manager.discover(FIXTURES);

      const prompt = manager.formatForPrompt();
      expect(prompt).not.toContain('disabled-model');
      expect(prompt).not.toContain('隐藏 Skill');
    });

    test('末尾提示用 skill_read 激活/查阅，且声明 skill_* 为唯一入口', async () => {
      await manager.discover(FIXTURES);

      const prompt = manager.formatForPrompt();
      expect(prompt).toContain('skill_read(id=<name>)');
      expect(prompt).toContain('SKILL.md');
      expect(prompt).toContain('skill_* namespace is the only way');
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
      expect(content.status).toBe('ok');
      if (content.status !== 'ok') return;
      expect(content.body).not.toContain('---');
      expect(content.body).toContain('测试 Skill');
      expect(content.body).toContain('步骤 1');
      expect(content.totalLines).toBeGreaterThan(0);
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
        expect(v1.status).toBe('ok');
        if (v1.status === 'ok') expect(v1.body).toContain('版本 1');

        // 修改文件，重新 discover，应该拿到新内容
        writeFileSync(
          skillFile,
          '---\nname: 重载测试\ndescription: 更新版本\n---\n# 版本 2',
        );
        const m2 = new DefaultSkillManager();
        await m2.discover(testDir);
        const v2 = await m2.load('reload-skill');
        expect(v2.status).toBe('ok');
        if (v2.status === 'ok') {
          expect(v2.body).toContain('版本 2');
          expect(v2.body).not.toContain('版本 1');
        }
      } finally {
        rmSync(testDir, { recursive: true });
      }
    });

    test('不存在的 Skill 返回 not_found', async () => {
      expect((await manager.load('nonexistent')).status).toBe('not_found');
    });

    test('loadGuard 漂移锚定：hash_drift 时拒正文（§12.3 load 单源）', async () => {
      const guarded = new DefaultSkillManager(undefined, {
        loadGuard: {
          checkLoad: () => ({ allow: false, reason: 'content changed since review' }),
        },
      });
      await guarded.discover(FIXTURES);
      expect(await guarded.load('valid-skill')).toEqual({
        status: 'refused',
        kind: 'hash_drift',
        reason: 'content changed since review',
      });
    });

    test('loadGuard 放行透传 unreviewed 标注', async () => {
      const guarded = new DefaultSkillManager(undefined, {
        loadGuard: { checkLoad: () => ({ allow: true, unreviewed: true }) },
      });
      await guarded.discover(FIXTURES);
      const r = await guarded.load('valid-skill');
      expect(r.status).toBe('ok');
      if (r.status === 'ok') {
        expect(r.unreviewed).toBe(true);
        expect(r.fileHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    });

    test('load 前必须先 discover', async () => {
      // 没有 discover 就 load，应该返回 not_found
      expect((await manager.load('valid-skill')).status).toBe('not_found');
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
  // frontmatter 引号标量（m1 回归）
  // ─────────────────────────────────────────────
  describe('frontmatter 引号标量', () => {
    test('成对双引号被剥离、转义还原', async () => {
      const testDir = resolve(FIXTURES, 'quoted-frontmatter');
      const skillDir = resolve(testDir, 'quoted-skill');
      mkdirSync(skillDir, { recursive: true });

      try {
        writeFileSync(
          resolve(skillDir, 'SKILL.md'),
          ['---', 'name: "quoted \\"skill\\""', 'description: "A \\"quoted\\" description"', '---', '', 'Body.'].join('\n'),
          'utf-8',
        );
        await manager.discover(testDir);
        const skill = manager.get('quoted-skill');
        expect(skill).not.toBeNull();
        expect(skill!.name).toBe('quoted "skill"');
        expect(skill!.description).toBe('A "quoted" description');
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  // ─────────────────────────────────────────────
  // 与真实 skills/ 目录集成
  // ─────────────────────────────────────────────
  describe('集成测试（真实 skills 目录）', () => {
    test('加载项目 skills/ 的五个内置技能，且引号不泄漏进索引', async () => {
      await manager.discover('./skills');

      const skills = manager.list();
      const ids = skills.map((s) => s.id);
      for (const id of ['document-authoring', 'docx', 'pdf', 'pptx', 'xlsx']) {
        expect(ids).toContain(id);
      }

      const prompt = manager.formatForPrompt();
      expect(prompt).toContain('<available_skills>');
      // m1 回归：带引号 frontmatter 的转义引号不得出现在技能索引
      expect(prompt).not.toContain('\\"');
      for (const skill of skills) {
        expect(skill.id).toBeTruthy();
        expect(skill.name).toBeTruthy();
        expect(skill.name).not.toContain('"');
        expect(skill.description).toBeTruthy();
        expect(skill.filePath).toContain('SKILL.md');
      }
    });
  });
});
