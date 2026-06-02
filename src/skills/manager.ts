/**
 * SkillManager — Skill 系统的核心实现
 *
 * Skill 是 Tool 之上的结构化经验层：
 * - Tool = 原子能力（file_read, shell）
 * - Skill = "怎么用工具做好一件事"
 *
 * Skill 文件格式（SKILL.md）：
 * ---
 * name: 视频帧提取
 * description: 从视频中提取关键帧
 * triggers: 视频, 抽帧, ffmpeg, 关键帧
 * tools: shell
 * ---
 * # 从视频提取帧
 * 使用 ffmpeg 从视频中提取关键帧...
 *
 * 设计原则：
 * 1. 每次任务最多激活一个 Skill（避免上下文污染）
 * 2. Skill 内容注入 system prompt，不是替换
 * 3. 文件变更自动热重载（下次匹配时读取最新内容）
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type {
  SkillDefinition,
  SkillMatch,
  SkillManager,
} from '../core/types.js';

/**
 * SKILL.md 文件 frontmatter 解析
 */
interface SkillFrontmatter {
  name: string;
  description: string;
  triggers?: string;
  tools?: string;
}

/**
 * 解析 SKILL.md 文件的 frontmatter 和内容
 */
function parseSkillFile(filePath: string): SkillDefinition | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    // 匹配 YAML frontmatter（--- ... ---）
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) {
      // 没有 frontmatter，跳过
      return null;
    }

    const fmLines = fmMatch[1].split('\n');
    const content = fmMatch[2].trim();

    // 简单 YAML 解析（只支持 key: value）
    const meta: Record<string, string> = {};
    for (const line of fmLines) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) {
        meta[m[1]] = m[2].trim();
      }
    }

    if (!meta.name || !meta.description) {
      return null; // 缺少必填字段
    }

    // 从文件路径推断 id
    // skills/<id>/SKILL.md → id
    const dirName = filePath.split('/').at(-2) ?? 'unknown';

    return {
      id: dirName,
      name: meta.name,
      description: meta.description,
      triggers: meta.triggers
        ? meta.triggers.split(/[,，]/).map((s) => s.trim())
        : [],
      requiredTools: meta.tools
        ? meta.tools.split(/[,，]/).map((s) => s.trim())
        : [],
      content,
      filePath,
    };
  } catch {
    return null;
  }
}

/**
 * SkillManager 默认实现
 */
export class DefaultSkillManager implements SkillManager {
  private skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.id, skill);
  }

  unregister(skillId: string): void {
    this.skills.delete(skillId);
  }

  /**
   * 扫描目录发现所有 Skill
   *
   * 期望目录结构：
   *   directory/
   *   ├── skill-a/SKILL.md
   *   ├── skill-b/SKILL.md
   *   └── skill-c/SKILL.md
   */
  async discover(directory: string): Promise<void> {
    const absDir = resolve(directory);
    if (!existsSync(absDir)) {
      return;
    }

    const entries = readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillFile = join(absDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const skill = parseSkillFile(skillFile);
      if (skill) {
        this.skills.set(skill.id, skill);
      }
    }
  }

  /**
   * 根据用户消息匹配最相关的 Skill
   *
   * 匹配策略（优先级从高到低）：
   * 1. 显式指定 — 用户消息中包含 skill:<id> 标记
   * 2. 触发词匹配 — 消息包含 Skill 的 trigger 关键词
   * 3. 描述匹配 — 简单关键词重叠（未来可升级为语义匹配）
   *
   * 每次最多返回 1 个 Skill，避免上下文污染。
   */
  async match(params: {
    message: string;
    agentId?: string;
    availableTools?: string[];
  }): Promise<SkillMatch | null> {
    const { message, availableTools } = params;
    const lower = message.toLowerCase();

    // 策略 1：显式指定（skill:<id>）
    const explicitMatch = lower.match(/skill[:\s]+(\w[\w-]*)/);
    if (explicitMatch) {
      const skillId = explicitMatch[1];
      const skill = this.skills.get(skillId);
      if (skill && this.isUsable(skill, availableTools)) {
        return { skill, score: 1.0, matchType: 'explicit' };
      }
    }

    let bestMatch: SkillMatch | null = null;

    for (const skill of this.skills.values()) {
      // 跳过缺少必需工具的 Skill
      if (!this.isUsable(skill, availableTools)) continue;

      // 策略 2：触发词匹配
      if (skill.triggers && skill.triggers.length > 0) {
        for (const trigger of skill.triggers) {
          if (lower.includes(trigger.toLowerCase())) {
            const score = 0.8;
            if (!bestMatch || score > bestMatch.score) {
              bestMatch = { skill, score, matchType: 'trigger' };
            }
            break; // 一个 trigger 匹配就够了
          }
        }
      }

      // 策略 3：描述关键词重叠
      // 把描述拆成词，看有多少在消息中出现
      if (skill.description) {
        const descWords = skill.description
          .toLowerCase()
          .split(/[\s,，。、；;：:]+/)
          .filter((w) => w.length >= 2); // 至少 2 个字符
        const matchCount = descWords.filter((w) => lower.includes(w)).length;
        if (matchCount > 0) {
          const score = Math.min(0.5 + matchCount * 0.1, 0.7);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { skill, score, matchType: 'semantic' };
          }
        }
      }
    }

    return bestMatch;
  }

  /**
   * 加载 Skill 内容
   *
   * 从文件重新读取（支持热重载），返回 Markdown 内容。
   * 没有 frontmatter 的原始 Markdown（已剥离）。
   */
  async load(skillId: string): Promise<string | null> {
    const skill = this.skills.get(skillId);
    if (!skill?.filePath) return null;

    try {
      const raw = readFileSync(skill.filePath, 'utf-8');
      // 剥离 frontmatter
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

  /**
   * 检查 Skill 的必需工具是否可用
   */
  private isUsable(
    skill: SkillDefinition,
    availableTools?: string[],
  ): boolean {
    if (!skill.requiredTools || skill.requiredTools.length === 0) {
      return true; // 没有工具依赖
    }
    if (!availableTools || availableTools.length === 0) {
      return false; // 有依赖但没有可用工具
    }
    return skill.requiredTools.every((t) => availableTools.includes(t));
  }
}
