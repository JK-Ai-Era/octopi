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
import type { SkillDefinition, SkillManager } from '../core/types.js';

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
 * SkillManager 实现
 */
export class DefaultSkillManager implements SkillManager {
  private skills = new Map<string, SkillDefinition>();

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
    const absDir = resolve(directory);
    if (!existsSync(absDir)) return;

    const entries = readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillFile = join(absDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const parsed = parseFrontmatter(skillFile);
      if (!parsed?.meta.name || !parsed.meta.description) continue;

      const skill: SkillDefinition = {
        id: entry.name,
        name: parsed.meta.name,
        description: parsed.meta.description,
        filePath: skillFile,
        source: 'workspace',
        disableModelInvocation:
          parsed.meta['disable-model-invocation'] === 'true',
        requiredTools: parsed.meta.tools
          ? parsed.meta.tools.split(/[,，]/).map((s) => s.trim())
          : undefined,
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
      lines.push(`    <name>${skill.id}</name>`);
      lines.push(`    <description>${skill.description}</description>`);
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
   * 从文件重新读取，剥离 frontmatter，返回纯 Markdown 内容。
   * 支持热重载（每次从文件读取最新内容）。
   */
  async load(skillId: string): Promise<string | null> {
    const skill = this.skills.get(skillId);
    if (!skill) return null;

    try {
      const raw = readFileSync(skill.filePath, 'utf-8');
      const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
      return fmMatch ? fmMatch[1].trim() : raw.trim();
    } catch {
      return null;
    }
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  get(skillId: string): SkillDefinition | null {
    return this.skills.get(skillId) ?? null;
  }
}
