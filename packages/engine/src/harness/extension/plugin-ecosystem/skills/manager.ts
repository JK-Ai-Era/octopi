/**
 * SkillManager — 两阶段加载实现（对齐 Agent Skills 标准）
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
import { dirname, join, resolve } from 'path';
import type { SkillDefinition, SkillManager } from './types.js';
import { parseSkillFile, type SkillFrontmatter } from './frontmatter.js';
import { renderSkillIndexEntries } from './index-render.js';
import { hashSkillDir } from './hash.js';
import type { SkillAdmissionGate } from './lifecycle.js';

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
    /** frontmatter.command（已规范化；非法则不透出） */
    command?: string;
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
 * 读取并解析 SKILL.md（frontmatter 解析单源在 frontmatter.ts）
 */
function parseSkillMdFile(filePath: string): {
  meta: SkillFrontmatter;
  content: string;
} | null {
  try {
    // parseSkillFile 内部统一换行，兼容 Windows CRLF
    return parseSkillFile(readFileSync(filePath, 'utf-8'));
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

      const parsed = parseSkillMdFile(skillFile);
      if (!parsed?.meta.name || !parsed.meta.description) continue;

      results.push({
        id: entry.name,
        filePath: skillFile,
        meta: {
          name: parsed.meta.name,
          description: parsed.meta.description,
          disableModelInvocation: parsed.meta.disableModelInvocation,
          requiredTools: parsed.meta.allowedTools,
          // frontmatter.ts 已规范化；非法 command 不透出
          command: parsed.meta.command,
        },
      });
    }

    return results;
  }

  async load(_skillId: string, filePath: string): Promise<string | null> {
    try {
      const raw = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
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
  /** 每个 skill 的发现来源（双层时 load 须回到各自 source，不跟最后一次 discover 漂移） */
  private sourceOf = new Map<string, SkillSource>();
  /** Skill id allowlist（`agents[].skills`）；undefined = 全部启用 */
  private readonly only?: ReadonlySet<string>;
  /** 准入闸门（lifecycle 实现）：仅多层装配的 agent 覆盖层应用；shared 层放盘信任不过闸 */
  private readonly gate?: SkillAdmissionGate;

  /**
   * @param sourceOrDirectory - SkillSource 实例或目录路径（向后兼容）
   * @param options.only - 启用的 Skill id allowlist（缺省全部）；discover 未列入的 Skill 不进索引、load 恒 null
   * @param options.gate - discover 准入闸门（arch/skill-creation-design.md §6）；缺省无闸门（嵌入式/测试自担）
   */
  constructor(
    sourceOrDirectory?: SkillSource | string,
    options?: { only?: string[]; gate?: SkillAdmissionGate },
  ) {
    if (typeof sourceOrDirectory === 'string') {
      this.source = new FileSystemSkillSource(sourceOrDirectory);
    } else {
      this.source = sourceOrDirectory ?? new FileSystemSkillSource('./skills');
    }
    this.only = options?.only ? new Set(options.only) : undefined;
    this.gate = options?.gate;
  }

  /**
   * 扫描目录发现所有 Skill（只读元数据）
   *
   * 期望目录结构：
   *   skills/
   *   ├── video-frames/SKILL.md
   *   ├── pdf-reader/SKILL.md
   *   └── web-scraper/SKILL.md
   *
   * 传入数组 = 双层发现：按序扫描并合并，**后层同 id 覆盖前层**
   * （约定调用序 `[共享层, agent 层]` → agent 层赢，实现 per-agent 覆盖）。
   * 同层内同 id 出现两次属目录异常：先到先得 + 告警，不静默后写赢。
   */
  async discover(directory: string | readonly string[]): Promise<void> {
    const dirs = typeof directory === 'string' ? [directory] : [...directory];
    // 重建语义：上一轮的技能不得残留（同实例二次 discover 时被闸门拒掉的
    // 技能若留在 map，load() 还会照常服务它——与「disabled 拒」矛盾）
    this.skills.clear();
    this.sourceOf.clear();
    // allowlist 未命中的 id 要对**合并后全集**判一次（跨层互补可凑齐 allowlist）
    const seenIds = new Set<string>();
    for (const [dirIdx, dir] of dirs.entries()) {
      // 单目录向后兼容：替换 source（历史语义）；多层时 source 只兜底 load
      const source = new FileSystemSkillSource(dir);
      if (dirs.length === 1) this.source = source;

      const discovered = await source.discover();
      for (const item of discovered) {
        // agents[].skills allowlist：未列入的 Skill 不进索引（load 经 skills map 天然拒绝）
        if (this.only && !this.only.has(item.id)) continue;
        // 准入闸门（agent 覆盖层；shared 层放盘信任不过闸）：
        // pending/rejected/disabled/哈希漂移(submitted) 不进索引——fail-loud 告警，不静默吞。
        // 唯一豁免 = 双层装配的首层（shared）；单层装配按 agent 层过闸（fail-closed：
        // shared 目录不存在时 filter 后只剩 agent 层，不能因数组长度退化而失闸）。
        let unreviewed = false;
        const isSharedLayer = dirs.length > 1 && dirIdx === 0;
        if (this.gate && !isSharedLayer) {
          // per-item 隔离：单个坏技能（非法目录名 / 哈希读失败 / db 忙）只损失自己，
          // 不得中止整个 discover（那会经 wire 降级成无闸门兜底 = fail-open）
          try {
            const admission = this.gate.admit({
              skillId: item.id,
              contentHash: hashSkillDir(dirname(item.filePath)),
            });
            if (!admission.admitted) {
              console.warn(
                `[Skills] "${item.id}" excluded by admission gate: ${admission.reason}`,
              );
              continue;
            }
            unreviewed = admission.unreviewed === true;
          } catch (err) {
            console.warn(
              `[Skills] "${item.id}" excluded by admission gate error (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
        }
        // 多层约定调用序 [共享层, agent 覆盖层…]：后写赢 = 覆盖语义（正常路径，不告警）
        const skill: SkillDefinition = {
          id: item.id,
          name: item.meta.name,
          description: item.meta.description,
          filePath: item.filePath,
          source: 'workspace',
          // 首层=共享层、其余=agent 覆盖层；单层部署不标注（不冒充分层事实）
          ...(dirs.length > 1 ? { layer: (dirIdx === 0 ? 'shared' : 'agent') as 'shared' | 'agent' } : {}),
          disableModelInvocation: item.meta.disableModelInvocation,
          requiredTools: item.meta.requiredTools,
          command: item.meta.command,
          ...(unreviewed ? { unreviewed: true } : {}),
        };
        this.skills.set(skill.id, skill);
        this.sourceOf.set(skill.id, source);
        seenIds.add(item.id);
      }
    }
    // allowlist 中未命中的 id（拼写错 / Skill 目录未落地）——fail-loud，防「静默全关」
    if (this.only) {
      for (const id of this.only) {
        if (!seenIds.has(id)) {
          console.warn(
            `[Skills] agents[].skills id "${id}" not found in skill directory (typo, or not landed yet)`,
          );
        }
      }
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
   *     <path>/abs/path/to/skills/video-frames/SKILL.md</path>
   *   </skill>
   * </available_skills>
   *
   * `path` 必须是 **绝对路径**：skill 目录通常在 agent home，不在 workspace。
   * 模型若按 `skills/<id>/SKILL.md` 相对路径去读，会解析到 workspace 下而 ENOENT。
   *
   * disableModelInvocation 的 Skill 不输出（只能显式调用）
   */
  formatForPrompt(): string {
    const visible = Array.from(this.skills.values()).filter(
      (s) => !s.disableModelInvocation,
    );
    // 渲染单源在 index-render.ts（与冻结快照/增量块共用，防格式漂移）
    return renderSkillIndexEntries(
      visible.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        filePath: s.filePath,
      })),
    );
  }

  /**
   * 加载 Skill 完整内容（LLM 按需调用）
   *
   * 通过 SkillSource 加载，支持热重载。
   */
  async load(skillId: string): Promise<string | null> {
    const skill = this.skills.get(skillId);
    if (!skill) return null;

    // 双层发现：各自 skill 回各自 source（agent 层覆盖后读到的必须是覆盖层文件）
    const source = this.sourceOf.get(skillId) ?? this.source;
    return source.load(skillId, skill.filePath);
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  get(skillId: string): SkillDefinition | null {
    return this.skills.get(skillId) ?? null;
  }
}
