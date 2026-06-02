/**
 * Skill 系统测试
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { DefaultSkillManager } from '../src/skills/manager.js';
import type { SkillDefinition } from '../src/core/types.js';

describe('DefaultSkillManager', () => {
  let manager: DefaultSkillManager;

  const testSkill: SkillDefinition = {
    id: 'video-frames',
    name: '视频帧提取',
    description: '从视频中使用 ffmpeg 提取关键帧',
    triggers: ['视频', '抽帧', 'ffmpeg', '关键帧'],
    requiredTools: ['shell'],
    content: '# 从视频提取帧\n使用 ffmpeg ...',
  };

  const noToolSkill: SkillDefinition = {
    id: 'web-scrape',
    name: '网页抓取',
    description: '从网页抓取内容',
    triggers: ['抓取', '爬虫', 'scrape'],
    requiredTools: ['web_fetch', 'browser'],
    content: '# 网页抓取 ...',
  };

  beforeEach(() => {
    manager = new DefaultSkillManager();
  });

  test('注册和获取 Skill', () => {
    manager.register(testSkill);
    expect(manager.get('video-frames')).toBeDefined();
    expect(manager.get('video-frames')!.name).toBe('视频帧提取');
    expect(manager.list()).toHaveLength(1);
  });

  test('注销 Skill', () => {
    manager.register(testSkill);
    manager.unregister('video-frames');
    expect(manager.get('video-frames')).toBeNull();
    expect(manager.list()).toHaveLength(0);
  });

  test('触发词匹配', async () => {
    manager.register(testSkill);

    const match = await manager.match({
      message: '帮我从这个视频里抽帧',
      availableTools: ['shell', 'file_read'],
    });

    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('video-frames');
    expect(match!.matchType).toBe('trigger');
    expect(match!.score).toBeGreaterThan(0.5);
  });

  test('显式指定 Skill', async () => {
    manager.register(testSkill);

    const match = await manager.match({
      message: 'skill:video-frames 帮我提取视频帧',
      availableTools: ['shell'],
    });

    expect(match).not.toBeNull();
    expect(match!.matchType).toBe('explicit');
    expect(match!.score).toBe(1.0);
  });

  test('缺少必需工具时不匹配', async () => {
    manager.register(noToolSkill);

    const match = await manager.match({
      message: '帮我抓取网页内容',
      availableTools: ['shell'], // 缺少 web_fetch 和 browser
    });

    expect(match).toBeNull();
  });

  test('有必需工具时正常匹配', async () => {
    manager.register(noToolSkill);

    const match = await manager.match({
      message: '帮我抓取网页内容',
      availableTools: ['shell', 'web_fetch', 'browser'],
    });

    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('web-scrape');
  });

  test('无匹配时返回 null', async () => {
    manager.register(testSkill);

    const match = await manager.match({
      message: '今天天气怎么样？',
      availableTools: ['shell'],
    });

    expect(match).toBeNull();
  });

  test('描述关键词匹配（语义）', async () => {
    manager.register(testSkill);

    const match = await manager.match({
      message: '我想提取 ffmpeg 视频的关键帧',
      availableTools: ['shell'],
    });

    // 这应该匹配到 trigger 词 "ffmpeg" 和 "关键帧"
    expect(match).not.toBeNull();
    expect(match!.matchType).toBe('trigger');
  });

  test('多个 Skill 时选择最相关的', async () => {
    const anotherSkill: SkillDefinition = {
      id: 'pdf-read',
      name: 'PDF 阅读',
      description: '读取 PDF 文件并提取文本',
      triggers: ['PDF', 'pdf'],
      content: '# PDF 阅读 ...',
    };

    manager.register(testSkill);
    manager.register(anotherSkill);

    const match = await manager.match({
      message: '帮我读一下这个 PDF 文件',
    });

    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('pdf-read');
  });

  test('discover 从目录加载 Skill', async () => {
    // 使用项目自带的 skills 目录
    await manager.discover('./skills');

    const skills = manager.list();
    expect(skills.length).toBeGreaterThan(0);

    const videoFrames = manager.get('video-frames');
    expect(videoFrames).not.toBeNull();
    expect(videoFrames!.name).toBe('视频帧提取');
    expect(videoFrames!.triggers).toContain('视频');
  });

  test('load 返回剥离 frontmatter 的内容', async () => {
    manager.register({
      ...testSkill,
      filePath: './skills/video-frames/SKILL.md',
    });

    const content = await manager.load('video-frames');
    expect(content).not.toBeNull();
    expect(content).not.toContain('---');
    expect(content).toContain('ffmpeg');
  });
});
