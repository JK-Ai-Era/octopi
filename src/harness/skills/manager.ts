/**
 * SkillManager — 两阶段加载实现（对齐 OpenClaw / Agent Skills 标准）
 *
 * 阶段 1（启动时）：
 *   discover() 扫描 skills/ 目录，只读 SKILL.md 的 frontmatter（name/description）
 *   formatForPrompt() 输出 XML 格式，始终注入 system prompt
 *   → 100 个 Skill 只占几百 token
 *
 * 阶段 2（LLM 按需）：
 *   LLM 判断需要某个 Skill 后，用 read 工具读取 SKILL.md 获得完整指令
 *   load(skillId) 从文件重新读取（支持热重载）
 *
 * 对齐标准：https://agentskills.io/integrate-skills
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type { SkillDefinition, SkillManager } from '../../core/types.js';

// ── SkillSource 接口 ──

/**
 * 发现的 Skill 条目（SkillSource 返回的中间格式）
 */
export interface DiscoveredSkill {
  /** Skill ID（通常是目录名） */
  id: string;
  /** SKILL.md 文件路径（用于后续 load） */
  filePath: string;
  /** Skill 元数据 */
  meta: {
    name: string;
    description: string;
    disableModelInvocation?: boolean;
    requiredTools?: string[];
  };
}

/**
 * SkillSource — 抽象 Skill 来源
 *
 * 抽象 Skill 的发现和加载机制，支持多种后端：
 * - 文件系统（默认）
 * - 远程仓库
 * - 数据库
 * - 内存（测试用）
 */
export interface SkillSource {
  /** 来源名称（用于日志和诊断） */
  readonly name: string;

  /**
   * 发现所有可用 Skill
n   * 返回 Skill 元数据列表（不包含完整内容）
   */
  discover(): Promise<DiscoveredSkill[]>;

  /**
   * 加载 Skill 完整内容
n   * @param skillId - Skill ID
n   * @param filePath - SKILL.md 文件路径（由 discover 返回）
   * @returns Skill 完整 Markdown 内容（不含 frontmatter）
   */
  load(skillId: string, filePath: string): Promise<string | null>;
}

// ── 文件系统实现 ──

/**
 * SKILL.md 文件 frontmatter 解析
 */
interface SkillFrontmatter {
  name?: string;
  description?: string;
  'disable-model-invocation'?: string;
  tools?: string;
  [key: string]: string | undefined;
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（只读元数据，不读正文）
 */
function parseFrontmatter(filePath: string): {
  meta: SkillFrontmatter;
  content: string;
} | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) return null;

    const fmLines = fmMatch[1].split('\n');
    const content = fmMatch[2].trim();

    // 简单 YAML 解析（只支持 key: value）
    const meta: SkillFrontmatter = {};
    for (const line of fmLines) {
      const m = line.match(/^([\w-]+):\s*(.+)$/);
      if (m) {
        meta[m[1]] = m[2].trim();
      }
    }

    return { meta, content };
  } catch {
    return null;
  }
}

/**
 * FileSystemSkillSource — 文件系统 Skill 来源
 *
 * 从本地目录扫描 SKILL.md 文件。
 */
export class FileSystemSkillSource implements SkillSource {
  readonly name = 'filesystem';
  private directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async discover(): Promise<DiscoveredSkill[]> {
    const absDir = resolve(this.directory);
    if (!existsSync(absDir)) return [];

    const results: DiscoveredSkill[] = [];
    const entries = readdirSync(absDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillFile = join(absDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const parsed = parseFrontmatter(skillFile);
      if (!parsed?.meta.name || !parsed.meta.description) continue;

      results.push({
        id: entry.name,
        filePath: skillFile,
        meta: {
          name: parsed.meta.name,
          description: parsed.meta.description,
          disableModelInvocation:
            parsed.meta['disable-model-invocation'] === 'true',
          requiredTools: parsed.meta.tools
            ? parsed.meta.tools.split(/[,，]/).map((s) => s.trim())
            : undefined,
        },
      });
    }

    return results;
  }

  async load(_skillId: string, filePath: string): Promise<string | null> {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
      return fmMatch ? fmMatch[1].trim() : raw.trim();
    } catch {
      return null;
    }
  }
}

// ── 默认 SkillManager ──

/**
 * SkillManager 实现
 *
 * 通过 SkillSource 抽象支持多种后端。默认使用 FileSystemSkillSource。
 */
export class DefaultSkillManager implements SkillManager {
  private skills = new Map<string, SkillDefinition>();
  private source: SkillSource;

  /**
   * @param sourceOrDirectory - SkillSource 实例或目录路径（向后兼容）
   */
  constructor(sourceOrDirectory?: SkillSource | string) {
    if (typeof sourceOrDirectory === 'string') {
      this.source = new FileSystemSkillSource(sourceOrDirectory);
    } else {
      this.source = sourceOrDirectory ?? new FileSystemSkillSource('./skills');
    }
  }

  /**
   * 扫描目录发现所有 Skill（只读元数据）
   *
   * 期望目录结构：
   *   skills/
   *   ├── video-frames/SKILL.md
   *   ├── pdf-reader/SKILL.md
   *   └── web-scraper/SKILL.md
   */
  async discover(directory: string): Promise<void> {
    // 如果传入了目录路径，创建新的 FileSystemSkillSource
    if (directory) {
      this.source = new FileSystemSkillSource(directory);
    }

    const discovered = await this.source.discover();
    for (const item of discovered) {
      const skill: SkillDefinition = {
        id: item.id,
        name: item.meta.name,
        description: item.meta.description,
        filePath: item.filePath,
        source: 'workspace',
        disableModelInvocation: item.meta.disableModelInvocation,
        requiredTools: item.meta.requiredTools,
      };
      this.skills.set(skill.id, skill);
    }
  }

  /**
   * 格式化所有 Skill 描述为 system prompt 片段
   *
   * 输出 XML 格式（对齐 Agent Skills 标准）：
   * <available_skills>
   *   <skill>
   *     <name>video-frames</name>
   *     <description>Extract frames from videos using ffmpeg</description>
   *   </skill>
   * </available_skills>
   *
   * disableModelInvocation 的 Skill 不输出（只能显式调用）
   */
  formatForPrompt(): string {
    const visible = Array.from(this.skills.values()).filter(
      (s) => !s.disableModelInvocation,
    );

    if (visible.length === 0) return '';

    const lines: string[] = ['<available_skills>'];
    for (const skill of visible) {
      lines.push('  <skill>');
      lines.push(`    <name>${this.xmlEscape(skill.id)}</name>`);
      lines.push(`    <description>${this.xmlEscape(skill.description)}</description>`);
      lines.push('  </skill>');
    }
    lines.push('</available_skills>');
    lines.push('');
    lines.push(
      'Use the read tool to load a skill file when needed. ' +
        'Example: read("skills/video-frames/SKILL.md")',
    );

    return lines.join('\n');
  }

  /**
   * 加载 Skill 完整内容（LLM 按需调用）
   *
   * 通过 SkillSource 加载，支持热重载。
   */
  async load(skillId: string): Promise<string | null> {
    const skill = this.skills.get(skillId);
    if (!skill) return null;

    return this.source.load(skillId, skill.filePath);
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  get(skillId: string): SkillDefinition | null {
    return this.skills.get(skillId) ?? null;
  }

  /**
   * XML 转义：防止 skill 名称或描述中的特殊字符破坏 XML 格式
   */
  private xmlEscape(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
