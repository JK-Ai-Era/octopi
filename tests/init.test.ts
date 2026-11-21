/**
 * Init 模块测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute, sep } from 'node:path';
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

      // 系统级子目录
      expect(existsSync(join(tempDir, 'plugins'))).toBe(true);
      expect(existsSync(join(tempDir, 'audit'))).toBe(true);

      // Agent home 子目录（persona / skills / sessions；memory 走 SQLite；ETL extract 不再创建）
      const home = join(tempDir, 'agents/default');
      expect(existsSync(join(tempDir, 'sessions'))).toBe(true);
      expect(existsSync(join(home, 'sessions'))).toBe(false);
      expect(existsSync(join(home, 'skills'))).toBe(true);
      expect(existsSync(join(home, 'extract/events'))).toBe(false);
      expect(existsSync(join(home, 'extract/bundles'))).toBe(false);
      expect(existsSync(join(home, 'extract/meta'))).toBe(false);
      // memory/wisdom 不再是文件目录
      expect(existsSync(join(home, 'memory'))).toBe(false);
      expect(existsSync(join(home, 'wisdom'))).toBe(false);

      // Agent workspace 目录（§4 规范布局：workspace/<tenantId>/<agentId>/）
      expect(existsSync(join(tempDir, 'workspace/default/default'))).toBe(true);

      // Persona 四件套：根目录 AGENTS.md + persona/{10-soul,20-identity,30-user}
      expect(existsSync(join(home, 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(home, 'persona/10-soul.md'))).toBe(true);
      expect(existsSync(join(home, 'persona/20-identity.md'))).toBe(true);
      expect(existsSync(join(home, 'persona/30-user.md'))).toBe(true);
      // 40-tools 不在四件套内，不再生成（旧文件迁移仍保留）
      expect(existsSync(join(home, 'persona/40-tools.md'))).toBe(false);
      // 旧版平铺文件不再生成
      expect(existsSync(join(home, 'SOUL.md'))).toBe(false);
      expect(existsSync(join(home, 'IDENTITY.md'))).toBe(false);
      expect(existsSync(join(home, 'USER.md'))).toBe(false);
      expect(existsSync(join(home, 'TOOLS.md'))).toBe(false);

      // 内容 = 通用助手模板（复用 renderAgentRole('general')）：
      // 无「Session Startup 读文件」指令（persona 自动加载；agent home 在围栏外）
      const agentsMd = readFileSync(join(home, 'AGENTS.md'), 'utf-8');
      expect(agentsMd).toContain('工作方式');
      expect(agentsMd).not.toContain('Session Startup');
      expect(agentsMd).not.toContain('读 persona');
      expect(readFileSync(join(home, 'persona/20-identity.md'), 'utf-8')).toContain('助手');

      // 配置文件
      expect(existsSync(join(tempDir, 'octopi.json'))).toBe(true);

      expect(result.isFresh).toBe(true);
      expect(result.created.length).toBeGreaterThan(0);
    });

    it('should not overwrite existing files', async () => {
      // 第一次初始化
      await initOctopi(tempDir);

      // 修改 soul
      const soulPath = join(tempDir, 'agents/default/persona/10-soul.md');
      const customContent = '# My Custom Soul\n\nCustom content.';
      writeFileSync(soulPath, customContent, 'utf-8');

      // 第二次初始化
      const result = await initOctopi(tempDir);

      // soul 不应被覆盖
      expect(readFileSync(soulPath, 'utf-8')).toBe(customContent);

      // 其他文件应标记为已存在
      expect(result.existed.length).toBeGreaterThan(0);
      expect(result.created.length).toBe(0);
    });

    it('should migrate legacy flat persona files into persona/', async () => {
      // 模拟旧布局：persona 文件平铺在 agent home 根目录
      const home = join(tempDir, 'agents/default');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'SOUL.md'), '# Legacy Soul', 'utf-8');
      writeFileSync(join(home, 'IDENTITY.md'), '# Legacy Identity', 'utf-8');
      writeFileSync(join(home, 'USER.md'), '# Legacy User', 'utf-8');
      writeFileSync(join(home, 'TOOLS.md'), '# Legacy Tools', 'utf-8');

      await initOctopi(tempDir);

      expect(existsSync(join(home, 'SOUL.md'))).toBe(false);
      expect(existsSync(join(home, 'IDENTITY.md'))).toBe(false);
      expect(existsSync(join(home, 'USER.md'))).toBe(false);
      expect(existsSync(join(home, 'TOOLS.md'))).toBe(false);

      expect(readFileSync(join(home, 'persona/10-soul.md'), 'utf-8')).toBe('# Legacy Soul');
      expect(readFileSync(join(home, 'persona/20-identity.md'), 'utf-8')).toBe('# Legacy Identity');
      expect(readFileSync(join(home, 'persona/30-user.md'), 'utf-8')).toBe('# Legacy User');
      expect(readFileSync(join(home, 'persona/40-tools.md'), 'utf-8')).toBe('# Legacy Tools');
    });

    it('should not migrate when persona target already exists', async () => {
      const home = join(tempDir, 'agents/default');
      mkdirSync(join(home, 'persona'), { recursive: true });
      writeFileSync(join(home, 'SOUL.md'), '# Legacy', 'utf-8');
      writeFileSync(join(home, 'persona/10-soul.md'), '# New', 'utf-8');

      await initOctopi(tempDir);

      expect(existsSync(join(home, 'SOUL.md'))).toBe(true);
      expect(readFileSync(join(home, 'persona/10-soul.md'), 'utf-8')).toBe('# New');
    });

    it('should create config with correct structure', async () => {
      await initOctopi(tempDir);

      const configPath = join(tempDir, 'octopi.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));

      expect(config.agents).toHaveLength(1);
      expect(config.agents[0].id).toBe('default');
      expect(config.agents[0].home).toContain(join('agents', 'default'));
      expect(config.agents[0].workspace).toContain(join('workspace', 'default'));
      expect(config.agents[0].skillDirectory).toContain(join('agents', 'default', 'skills'));
      expect(config.models).toBeDefined();
      expect(config.models.providers).toBeDefined();
      expect(config.session.dmScope).toBe('per-peer');
      expect(config.subsystems.auditDir).toContain(`${sep}audit`);
      // 产品语言随 persona 产物语言落盘（向导/WebUI 文案同源）
      expect(config.language).toBe('zh');
    });

    it('lang=en：persona 四件套与配置 language 产出英文', async () => {
      await initOctopi(tempDir, { lang: 'en' });

      const home = join(tempDir, 'agents/default');
      const agentsMd = readFileSync(join(home, 'AGENTS.md'), 'utf-8');
      expect(agentsMd).toContain('Operating Instructions');
      expect(agentsMd).not.toContain('工作方式');
      expect(readFileSync(join(home, 'persona/30-user.md'), 'utf-8')).toContain('you');

      const config = JSON.parse(readFileSync(join(tempDir, 'octopi.json'), 'utf-8'));
      expect(config.language).toBe('en');
    });

    it('init 重入：已有配置 language=en 时缺省四件套仍按 en 补齐', async () => {
      await initOctopi(tempDir, { lang: 'en' });
      // 模拟用户删掉 persona 后重跑 init（不带显式 lang）
      rmSync(join(tempDir, 'agents/default/persona/10-soul.md'));
      await initOctopi(tempDir);

      const soul = readFileSync(join(tempDir, 'agents/default/persona/10-soul.md'), 'utf-8');
      expect(soul).toContain('Agent Persona');
      expect(soul).not.toContain('人格定义');
    });

    it('should support custom agent ID', async () => {
      const result = await initOctopi(tempDir, { defaultAgentId: 'my-agent' });

      expect(existsSync(join(tempDir, 'agents/my-agent/AGENTS.md'))).toBe(true);
      expect(existsSync(join(tempDir, 'agents/my-agent/persona/10-soul.md'))).toBe(true);
      expect(existsSync(join(tempDir, 'workspace/default/my-agent'))).toBe(true);

      const config = JSON.parse(readFileSync(join(tempDir, 'octopi.json'), 'utf-8'));
      expect(config.agents[0].id).toBe('my-agent');
    });

    it('should skip config generation when generateConfig=false', async () => {
      await initOctopi(tempDir, { generateConfig: false });

      expect(existsSync(join(tempDir, 'octopi.json'))).toBe(false);
      expect(existsSync(join(tempDir, 'agents/default/persona/10-soul.md'))).toBe(true);
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
    it('should create agent home with persona and runtime dirs', async () => {
      // 先初始化基础目录
      await initOctopi(tempDir);

      // 添加新 agent
      const result = await ensureAgentDirs('new-agent', tempDir);

      const home = join(tempDir, 'agents/new-agent');
      expect(existsSync(join(home, 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(home, 'persona/10-soul.md'))).toBe(true);
      expect(existsSync(join(home, 'persona/20-identity.md'))).toBe(true);
      expect(existsSync(join(tempDir, 'sessions'))).toBe(true);
      expect(existsSync(join(home, 'sessions'))).toBe(false);
      expect(existsSync(join(home, 'skills'))).toBe(true);
      expect(existsSync(join(home, 'extract/events'))).toBe(false);
      expect(existsSync(join(home, 'memory'))).toBe(false);
      expect(existsSync(join(home, 'wisdom'))).toBe(false);
      expect(existsSync(join(tempDir, 'workspace/default/new-agent'))).toBe(true);
      expect(result.created.length).toBeGreaterThan(0);
    });

    it('should not overwrite existing persona files', async () => {
      await initOctopi(tempDir);

      const soulPath = join(tempDir, 'agents/default/persona/10-soul.md');
      const custom = '# Custom';
      writeFileSync(soulPath, custom, 'utf-8');

      const result = await ensureAgentDirs('default', tempDir);

      expect(readFileSync(soulPath, 'utf-8')).toBe(custom);
      expect(result.existed.length).toBeGreaterThan(0);
    });
  });

  describe('getOctopiHome', () => {
    it('should return default ~/.octopi when no env var', () => {
      const original = process.env.OCTOPI_HOME;
      delete process.env.OCTOPI_HOME;

      const home = getOctopiHome();
      expect(home).toContain('.octopi');
      expect(isAbsolute(home)).toBe(true);

      if (original) process.env.OCTOPI_HOME = original;
    });

    it('should respect OCTOPI_HOME env var', () => {
      const original = process.env.OCTOPI_HOME;
      process.env.OCTOPI_HOME = join(sep === '\\' ? 'C:\\' : '/', 'custom', 'octopi', 'path');

      const home = getOctopiHome();
      expect(home).toBe(resolve(process.env.OCTOPI_HOME!));

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
