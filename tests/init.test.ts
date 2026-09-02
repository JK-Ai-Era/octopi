/**
 * Init 模块测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initOctopi,
  isInitialized,
  ensureAgentDirs,
  getOctopiHome,
  formatInitReport,
} from '../src/init.js';

describe('init', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'octopi-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('initOctopi', () => {
    it('should create full directory structure on fresh init', async () => {
      const result = await initOctopi(tempDir);

      // 根目录
      expect(existsSync(tempDir)).toBe(true);

      // 子目录
      // data/sessions 已移至 agent home 下
      expect(existsSync(join(tempDir, 'plugins'))).toBe(true);

      // Agent workspace 目录
      expect(existsSync(join(tempDir, 'workspace/default'))).toBe(true);

      // Persona 文件（在 workspace 下）
      expect(existsSync(join(tempDir, 'agents/default/SOUL.md'))).toBe(true);
      expect(existsSync(join(tempDir, 'agents/default/IDENTITY.md'))).toBe(true);
      expect(existsSync(join(tempDir, 'agents/default/USER.md'))).toBe(true);
      expect(existsSync(join(tempDir, 'agents/default/AGENTS.md'))).toBe(true);
      expect(existsSync(join(tempDir, 'agents/default/TOOLS.md'))).toBe(true);

      // 配置文件
      expect(existsSync(join(tempDir, 'octopi.json'))).toBe(true);

      expect(result.isFresh).toBe(true);
      expect(result.created.length).toBeGreaterThan(0);
    });

    it('should not overwrite existing files', async () => {
      // 第一次初始化
      await initOctopi(tempDir);

      // 修改 SOUL.md
      const soulPath = join(tempDir, 'agents/default/SOUL.md');
      const customContent = '# My Custom Soul\n\nCustom content.';
      const { writeFileSync } = await import('node:fs');
      writeFileSync(soulPath, customContent, 'utf-8');

      // 第二次初始化
      const result = await initOctopi(tempDir);

      // SOUL.md 不应被覆盖
      expect(readFileSync(soulPath, 'utf-8')).toBe(customContent);

      // 其他文件应标记为已存在
      expect(result.existed.length).toBeGreaterThan(0);
      expect(result.created.length).toBe(0);
    });

    it('should create config with correct structure', async () => {
      await initOctopi(tempDir);

      const configPath = join(tempDir, 'octopi.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));

      expect(config.agents).toHaveLength(1);
      expect(config.agents[0].id).toBe('default');
      expect(config.agents[0].home).toContain('agents/default');
      expect(config.agents[0].workspace).toContain('workspace/default');
      expect(config.models).toBeDefined();
      expect(config.models.providers).toBeDefined();
      expect(config.session.store.type).toBe('jsonl');
      expect(config.session.store.dataDir).toContain('agents');
    });

    it('should support custom agent ID', async () => {
      const result = await initOctopi(tempDir, { defaultAgentId: 'my-agent' });

      expect(existsSync(join(tempDir, 'agents/my-agent/SOUL.md'))).toBe(true);
      expect(existsSync(join(tempDir, 'workspace/my-agent'))).toBe(true);

      const config = JSON.parse(readFileSync(join(tempDir, 'octopi.json'), 'utf-8'));
      expect(config.agents[0].id).toBe('my-agent');
    });

    it('should skip config generation when generateConfig=false', async () => {
      await initOctopi(tempDir, { generateConfig: false });

      expect(existsSync(join(tempDir, 'octopi.json'))).toBe(false);
      expect(existsSync(join(tempDir, 'agents/default/SOUL.md'))).toBe(true);
    });
  });

  describe('isInitialized', () => {
    it('should return false for non-existent directory', () => {
      expect(isInitialized(join(tempDir, 'nonexistent'))).toBe(false);
    });

    it('should return false when directory exists but no config', () => {
      expect(isInitialized(tempDir)).toBe(false);
    });

    it('should return true after init', async () => {
      await initOctopi(tempDir);
      expect(isInitialized(tempDir)).toBe(true);
    });
  });

  describe('ensureAgentDirs', () => {
    it('should create agent workspace with persona files', async () => {
      // 先初始化基础目录
      await initOctopi(tempDir);

      // 添加新 agent
      const result = await ensureAgentDirs('new-agent', tempDir);

      expect(existsSync(join(tempDir, 'agents/new-agent/SOUL.md'))).toBe(true);
      expect(existsSync(join(tempDir, 'agents/new-agent/IDENTITY.md'))).toBe(true);
      expect(existsSync(join(tempDir, 'workspace/new-agent'))).toBe(true);
      expect(result.created.length).toBeGreaterThan(0);
    });

    it('should not overwrite existing persona files', async () => {
      await initOctopi(tempDir);

      const { writeFileSync } = await import('node:fs');
      const soulPath = join(tempDir, 'agents/default/SOUL.md');
      const custom = '# Custom';
      writeFileSync(soulPath, custom, 'utf-8');

      const result = await ensureAgentDirs('default', tempDir);

      expect(readFileSync(soulPath, 'utf-8')).toBe(custom);
      expect(result.existed.length).toBeGreaterThan(0);
    });
  });

  describe('getOctopiHome', () => {
    it('should return default ~/octopi when no env var', () => {
      const original = process.env.OCTOPI_HOME;
      delete process.env.OCTOPI_HOME;

      const home = getOctopiHome();
      expect(home).toContain('.octopi');
      expect(home.startsWith('/')).toBe(true);

      if (original) process.env.OCTOPI_HOME = original;
    });

    it('should respect OCTOPI_HOME env var', () => {
      const original = process.env.OCTOPI_HOME;
      process.env.OCTOPI_HOME = '/custom/octopi/path';

      const home = getOctopiHome();
      expect(home).toBe('/custom/octopi/path');

      if (original) {
        process.env.OCTOPI_HOME = original;
      } else {
        delete process.env.OCTOPI_HOME;
      }
    });
  });

  describe('formatInitReport', () => {
    it('should produce human-readable report', async () => {
      const result = await initOctopi(tempDir);
      const report = formatInitReport(result);

      expect(report).toContain('Octopi');
      expect(report).toContain(tempDir);
      expect(report).toContain('octopi.json');
      expect(report).toContain('Created');
      expect(report).toContain('Next steps');
    });
  });
});
