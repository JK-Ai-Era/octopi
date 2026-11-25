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

import { readFileSync, readdirSync, existsSync, statSync, realpathSync, lstatSync } from 'fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'path';
import type {
  SkillDefinition,
  SkillFileEntry,
  SkillFileLoadResult,
  SkillLoadResult,
  SkillManager,
} from './types.js';
import { parseSkillFile, type SkillFrontmatter } from './frontmatter.js';
import { renderSkillIndexEntries } from './index-render.js';
import { hashSkillDir, hashSkillFiles } from './hash.js';
import { globToPathRegex } from '../../../shared/paths/glob.js';
import type { SkillAdmissionGate, SkillLoadGuard, SkillLoadVerdict } from './lifecycle.js';

// ── 读取面常量（消费面；提交面阈值在 validate.ts 各管各层） ──

/** 附件单次返回行数上限（与 file_read 默认同口径）；export 供工具面同源复用（F16） */
export const DEFAULT_READ_LIMIT = 2000;
/** limit 参数硬顶（F4：模型可控参数不得绕过截断防线） */
export const MAX_READ_LIMIT = 5000;
/** 附件读取大小安全阀（超限拒读，防内存打爆；快照层整包 fail-closed） */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** 快照文件数上限（F27：vendored 大目录防 walk 无界） */
const SNAPSHOT_MAX_FILES = 20_000;
/** 清单条目数上限（超出「+N more」如实标注） */
const LIST_MAX = 200;
/** 清单条目「大文件」阈值（超此只标类型+大小，不读内容） */
const LARGE_ENTRY_BYTES = 1024 * 1024;
/** 首行提要长度上限 */
const EXCERPT_MAX = 120;
/** 提要探测读取量 */
const EXCERPT_READ_BYTES = 4096;

/**
 * 剥 frontmatter 取正文（消费面正文坐标单源；S2 评审 F2）。
 *
 * skill_read（load）、skill_search（SKILL.md 扫描）共用——保证「搜索到的行号」
 * 与「skill_read(file='SKILL.md', offset=…) 续读的行号」同一坐标系。
 *
 * @param text - SKILL.md 原始文本
 * @returns 剥 frontmatter 并 trim 后的正文
 */
export function stripFrontmatter(text: string): string {
  const fmMatch = text.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return (fmMatch ? fmMatch[1] : text).trim();
}

/** 二进制探测：前 8KB 含 NUL 即判二进制（与 file 嗅探同口径的轻量版）；skill_search 同源 */
export function isProbablyBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  return probe.includes(0);
}

/** 清单条目：从快照字节判类型；文本小文件带首行提要（不二次读盘，F14） */
function describeAttachment(rel: string, bytes: Buffer): SkillFileEntry {
  if (bytes.length > LARGE_ENTRY_BYTES) return { path: rel, bytes: bytes.length, kind: 'large' };
  if (isProbablyBinary(bytes)) return { path: rel, bytes: bytes.length, kind: 'binary' };
  const head = bytes.subarray(0, EXCERPT_READ_BYTES).toString('utf-8');
  const firstLine = head.split('\n', 1)[0] ?? '';
  return {
    path: rel,
    bytes: bytes.length,
    kind: 'text',
    excerpt: firstLine.trim().slice(0, EXCERPT_MAX),
  };
}

/**
 * 附件二次 containment：relPath 解析后必须落在技能目录内。
 *
 * 三重拒绝：绝对路径 / `..` 段（词法）/ symlink 逃逸（realpath 后仍在目录内）。
 * validate 拒绝 symlink，但 dropped-in 来源不过校验——消费面必须自防。
 * skill_read 附件与 skill_run 脚本共用（One source of truth）。
 *
 * @param skillDir - 技能目录绝对路径
 * @param relPath - 模型给出的相对路径
 * @returns 解析后的绝对路径，或拒绝原因
 */
export function resolveAttachmentPath(
  skillDir: string,
  relPath: string,
): { abs: string } | { forbidden: string; reason: string } {
  const cleaned = relPath.trim().replace(/\\/g, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) {
    return { forbidden: relPath, reason: 'absolute paths are not allowed; pass a path inside the skill' };
  }
  const segments = cleaned.split('/');
  if (segments.includes('..')) {
    return { forbidden: relPath, reason: 'path traversal ("..") is not allowed' };
  }
  const abs = resolve(skillDir, ...segments);
  // realpath 双查：symlink 指向目录外 = 逃逸（词法上无 `..` 也可能出去）
  const realDir = realpathSync(skillDir);
  let realTarget: string;
  try {
    realTarget = realpathSync(abs);
  } catch {
    // 不存在的文件交由调用方按 not_found 处理；只要词法已收口即不报 forbidden
    return { abs };
  }
  const prefix = realDir.endsWith(sep) ? realDir : realDir + sep;
  if (realTarget !== realDir && !realTarget.startsWith(prefix)) {
    return { forbidden: relPath, reason: 'symlink escapes the skill directory' };
  }
  return { abs: realTarget };
}

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
    /** metadata.interpreter（skill_run 解释器声明；S1 §12.4） */
    interpreter?: string;
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
      // F26：SKILL.md 本身是 symlink（可能指向目录外）不入索引——
      // discover 是消费面的第一道门，dropped-in 不过 validate 必须自防
      try {
        if (lstatSync(skillFile).isSymbolicLink()) continue;
      } catch {
        continue;
      }

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
          interpreter: parsed.meta.metadata?.interpreter,
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
  /** 上次 discover 的目录集（refresh/ensureFresh 重放用） */
  private lastDirs?: string[];
  /** 上次 discover 的文件面签名（**扫描前**探针；B1：扫描期变更不得被记成已新鲜） */
  private lastFileSig?: string;
  /** 上次成功读到的 registry 状态戳（戳读失败按「未知=未变」；M2 防换空连锁） */
  private lastRegistryStamp?: string;
  /** in-flight 重建（并发 ensureFresh/refresh 共享一次，防双份全量重扫） */
  private refreshing?: Promise<void>;
  /** Skill id allowlist（`agents[].skills`）；undefined = 全部启用 */
  private readonly only?: ReadonlySet<string>;
  /** 准入闸门（lifecycle 实现）：仅多层装配的 agent 覆盖层应用；shared 层放盘信任不过闸 */
  private readonly gate?: SkillAdmissionGate;
  /** 消费期加载守卫（lifecycle 实现）：load 时审查哈希锚定（设计 §12.3）；缺省不锚定（嵌入式/测试自担） */
  private readonly loadGuard?: SkillLoadGuard;

  /**
   * @param sourceOrDirectory - SkillSource 实例或目录路径（向后兼容）
   * @param options.only - 启用的 Skill id allowlist（缺省全部）；discover 未列入的 Skill 不进索引、load 恒 not_found
   * @param options.gate - discover 准入闸门（arch/skill-creation-design.md §6）；缺省无闸门（嵌入式/测试自担）
   * @param options.loadGuard - 消费期加载守卫（§12.3 漂移锚定）；缺省不锚定
   */
  constructor(
    sourceOrDirectory?: SkillSource | string,
    options?: { only?: string[]; gate?: SkillAdmissionGate; loadGuard?: SkillLoadGuard },
  ) {
    if (typeof sourceOrDirectory === 'string') {
      this.source = new FileSystemSkillSource(sourceOrDirectory);
    } else {
      this.source = sourceOrDirectory ?? new FileSystemSkillSource('./skills');
    }
    this.only = options?.only ? new Set(options.only) : undefined;
    this.gate = options?.gate;
    this.loadGuard = options?.loadGuard;
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
    // 技能若留在 map，load() 还会照常服务它——与「disabled 拒」矛盾）。
    // 原子 swap：全量建到局部 map 再整体替换——discover 的 await 让出点期间
    // 并发消费不得看到半空索引（中途刷新引入后此窗口每轮出现）
    const nextSkills = new Map<string, SkillDefinition>();
    const nextSourceOf = new Map<string, SkillSource>();
    // allowlist 未命中的 id 要对**合并后全集**判一次（跨层互补可凑齐 allowlist）
    const seenIds = new Set<string>();
    // 扫描前探针（B1 修）：签名采样必须先于任何扫描——扫描窗口内完成的
    // 批准/拷贝不得被记成「已新鲜」，否则该技能永不进索引且永不重扫
    const probe = this.probeState(dirs);
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
            // 闸门**报错** ≠ 明确拒绝（db 异常等）：已准入过的旧条目保留此前
            // 状态——一次 db 抖动不得把整张索引换成空（M2）；新面孔无旧条目
            // 仍 fail-closed 不放行。消费安全由 checkLoad 活查兜底，恢复后
            // registryStamp 变化会触发重扫收敛
            const prev = this.skills.get(item.id);
            if (prev) {
              nextSkills.set(prev.id, prev);
              nextSourceOf.set(item.id, source);
              seenIds.add(item.id);
              console.warn(
                `[Skills] "${item.id}" admission gate error — kept previous entry: ${err instanceof Error ? err.message : String(err)}`,
              );
            } else {
              console.warn(
                `[Skills] "${item.id}" excluded by admission gate error (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
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
          interpreter: item.meta.interpreter,
          ...(unreviewed ? { unreviewed: true } : {}),
        };
        nextSkills.set(skill.id, skill);
        nextSourceOf.set(skill.id, source);
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
    // 原子 swap：此刻起并发读方看到完整新索引（此前一刻仍是完整旧索引）。
    // lastFileSig/lastRegistryStamp 取**扫描前**探针（B1）：扫描期间完成的
    // 批准/拷贝会让下次探针不同 → 必然再对账，不会被记成「已新鲜」
    this.skills = nextSkills;
    this.sourceOf = nextSourceOf;
    this.lastDirs = dirs;
    this.lastFileSig = probe.fileSig;
    if (probe.registryStamp !== undefined) this.lastRegistryStamp = probe.registryStamp;
  }

  /**
   * 中途索引刷新（设计 §7「中途新增→增量块」的索引重建入口）。
   *
   * 实测修正（2026-11-26）：会话 run 在 run-serve-child 子进程、审查在 gateway
   * 进程——进程内事件到不了消费侧，故刷新触发 = 脏检（ensureFresh）+ 消费/装配
   * 入口必检，天然覆盖 CLI 直写、手拷 dropped-in 等一切变更来源。
   */
  async refresh(): Promise<void> {
    if (!this.lastDirs) return;
    // in-flight 去重：并发 ensureFresh/refresh 共享同一次重建
    this.refreshing ??= this.discover(this.lastDirs).finally(() => {
      this.refreshing = undefined;
    });
    try {
      await this.refreshing;
    } catch (err) {
      // 重建失败保留旧索引（swap 未发生）+ fail-loud 告警：不得让异常冒到
      // 装配层把整个技能层静默吞掉（M4）——陈旧索引好过没有索引
      console.warn(
        `[Skills] index refresh failed (kept previous index): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 脏检刷新：技能根目录面（条目 + 各 SKILL.md mtime/size）或 registry 戳
   * （gate.registryStamp：停用/批准/回 pending 等无文件面痕迹的状态迁移）
   * 任一变化才重扫重建。常态成本 = readdir + stat + 一次轻查询；
   * 变了才付 discover 全价（P1 遗留的 discover 成本不放大到每轮）。
   */
  async ensureFresh(): Promise<void> {
    if (!this.lastDirs) return;
    const probe = this.probeState(this.lastDirs);
    const fileChanged = probe.fileSig !== this.lastFileSig;
    // 戳读失败（undefined）= 「未知，按未变」：不触发重扫（M2——戳失败→重扫→
    // 闸门全抛→索引换空的连环就此切断）；文件面变化仍会触发重扫
    const stampChanged =
      probe.registryStamp !== undefined && probe.registryStamp !== this.lastRegistryStamp;
    if (!fileChanged && !stampChanged) return;
    await this.refresh();
  }

  /**
   * 新鲜度探针：文件面签名 + registry 状态戳。
   *
   * 文件面走**全量 stat 清单**（含 ctimeMs）：附件（非 SKILL.md）变更正是
   * hash_drift 的触发条件（M3）——只看 SKILL.md 会让漂移在会话内永不收敛；
   * ctimeMs 兜住「保留 mtime 的拷贝替换」（cp -p）类漏检。stat-only 成本远
   * 低于 discover 全价（读字节 + 解析 + 闸门哈希），可负担于每次消费/装配前。
   */
  private probeState(dirs: readonly string[]): { fileSig: string; registryStamp?: string } {
    const fileParts: string[] = [];
    for (const dir of dirs) {
      const entries: string[] = [];
      const walk = (abs: string, rel: string): void => {
        let list: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
        try {
          list = readdirSync(abs, { withFileTypes: true });
        } catch {
          // 目录消失/不可读也入签（之后恢复 = 签名变化）
          entries.push(`${rel || '.'}<?>`);
          return;
        }
        for (const e of list) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (e.isSymbolicLink()) {
            // symlink 形态也入签（消费面拒 symlink，形态翻转必须可见）
            entries.push(`${childRel}<lnk>`);
            continue;
          }
          if (e.isDirectory()) {
            entries.push(`${childRel}/`);
            walk(join(abs, e.name), childRel);
            continue;
          }
          try {
            const st = statSync(join(abs, e.name));
            entries.push(`${childRel}@${st.mtimeMs}:${st.ctimeMs}:${st.size}`);
          } catch {
            entries.push(`${childRel}@-`);
          }
        }
      };
      walk(resolve(dir), '');
      entries.sort();
      fileParts.push(`${dir}:${entries.join(',')}`);
    }
    let registryStamp: string | undefined;
    try {
      registryStamp = this.gate?.registryStamp?.() ?? '';
    } catch {
      // 戳读失败 = 未知（M2）：按「未变」处理，不触发重扫。消费安全不靠索引
      // 新旧（checkLoad 每次消费活查 registry，db 异常时它 fail-loud 抛错），
      // 但索引被换空会让消费直接 not_found——宁可暂陈旧，不做「戳失败→重扫→
      // 闸门全抛→索引换空」连锁
      registryStamp = undefined;
    }
    return { fileSig: fileParts.join('|'), registryStamp };
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
  formatForPrompt(opts?: { availableTools?: string[] }): string {
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
        requiredTools: s.requiredTools,
      })),
      opts,
    );
  }

  /**
   * 消费面快照（单 IO；S1 评审 F3 结构修）。
   *
   * 一次读取技能目录全部字节 → 从**本次读到的字节**算内容哈希 → 与登记锚点
   * 比对 → 从同一份字节服务消费。哈希与所服务字节同源，闭合「锚定算 A、
   * 消费读 B」的 TOCTOU（同尺寸替换窗口）。
   *
   * 全程 fail-closed：目录不可读/单文件超读取阀/文件数超上限 → 拒绝消费并
   * 报因（F2 不抛原始 fs 异常；F4 字节闸；F27 walk 上限）。
   *
   * @param skillId - 技能 id（调用方应先经 get() 确认在索引）
   * @returns 快照（rel → 字节）+ 锚定判定，或拒绝原因
   */
  consume(skillId: string):
    | { ok: true; files: Map<string, Buffer>; skippedSymlinks: Set<string>; unreviewed: boolean }
    | {
        ok: false;
        status: 'not_found' | 'refused';
        kind?: 'hash_drift' | 'disabled' | 'not_approved' | 'invalid_id' | 'unreadable';
        reason: string;
      } {
    const skill = this.skills.get(skillId);
    if (!skill) return { ok: false, status: 'not_found', reason: 'skill not found in the index' };
    const skillDir = dirname(skill.filePath);

    const files = new Map<string, Buffer>();
    const skippedSymlinks = new Set<string>();
    let count = 0;
    try {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const abs = join(dir, entry.name);
          // symlink 不消费（F26：SKILL.md 若是 symlink 指目录外，walk 跳过 =
          // 不入快照不入哈希 = 不被消费；validate 拒绝的形态 dropped-in 也自防）
          if (entry.isSymbolicLink()) {
            // 记名供消费面显式报「symlink 拒」而非含糊的 not_found（评审 5.1）
            skippedSymlinks.add(relative(skillDir, abs).split(sep).join('/'));
            continue;
          }
          if (entry.isDirectory()) {
            walk(abs);
            continue;
          }
          if (!entry.isFile()) continue;
          count += 1;
          if (count > SNAPSHOT_MAX_FILES) {
            throw new Error(`skill has more than ${SNAPSHOT_MAX_FILES} files`);
          }
          const rel = relative(skillDir, abs).split(sep).join('/');
          const bytes = readFileSync(abs);
          if (bytes.length > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file "${rel}" exceeds the ${MAX_ATTACHMENT_BYTES}-byte read cap`);
          }
          files.set(rel, bytes);
        }
      };
      walk(skillDir);
    } catch (err) {
      // 目录消失/权限/超限都归「不可读」：fail-closed 拒消费，报因不抛原始异常（F2）
      return {
        ok: false,
        status: 'refused',
        kind: 'unreadable',
        reason: `cannot read skill bundle: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 锚定：哈希来自本次读到的字节（hashSkillFiles 单源）——与消费内容同源
    const verdict = this.loadGuard
      ? this.loadGuard.checkLoad(
          skillId,
          hashSkillFiles([...files].map(([rel, bytes]) => ({ rel, bytes }))),
        )
      : { allow: true as const, unreviewed: skill.unreviewed === true };
    if (!verdict.allow) {
      return {
        ok: false,
        status: 'refused',
        kind: verdict.kind ?? 'hash_drift',
        reason: verdict.reason ?? 'content hash drift',
      };
    }
    return { ok: true, files, skippedSymlinks, unreviewed: verdict.unreviewed === true };
  }

  /**
   * 审查哈希锚定（消费面前置判定；设计 §12.3）。
   *
   * ⚠️ 轻量版（不读内容，仅复算目录哈希）——存在「算哈希与读内容不同源」的
   * TOCTOU 窗口，仅供诊断/预检用。**正文与附件消费一律走 {@link consume}**
   * （单 IO 快照，哈希与字节同源）。
   *
   * @param skillId - 技能 id（调用方应先经 get() 确认在索引）
   * @returns 判定（allow / unreviewed 标注 / 拒绝原因）；fs 异常 fail-closed（F2）
   */
  verifyAnchor(skillId: string): SkillLoadVerdict {
    const skill = this.skills.get(skillId);
    if (!skill) return { allow: false, kind: 'invalid_id', reason: 'skill not found in the enabled index' };
    if (!this.loadGuard) return { allow: true, unreviewed: skill.unreviewed === true };
    try {
      return this.loadGuard.checkLoad(skillId, hashSkillDir(dirname(skill.filePath)));
    } catch (err) {
      return {
        allow: false,
        kind: 'unreadable',
        reason: `anchor verification failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 加载 Skill 完整内容（消费面单源：skill_read 工具 + /name 命令展开共用）。
   *
   * 走 {@link consume} 单 IO 快照（审查哈希锚定与正文同源；§12.3）。
   */
  async load(skillId: string): Promise<SkillLoadResult> {
    await this.ensureFresh();
    const consumed = this.consume(skillId);
    if (!consumed.ok) {
      return consumed.status === 'not_found'
        ? { status: 'not_found' }
        : { status: 'refused', kind: consumed.kind ?? 'hash_drift', reason: consumed.reason };
    }
    const raw = consumed.files.get('SKILL.md');
    if (!raw) return { status: 'not_found' };
    // SKILL.md 超读取阀已在 consume fail-closed；正文坐标 = stripFrontmatter（与 skill_search 同源）
    const body = stripFrontmatter(raw.toString('utf-8').replace(/\r\n/g, '\n'));
    return {
      status: 'ok',
      body,
      totalLines: body.length === 0 ? 0 : body.split('\n').length,
      fileHash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      unreviewed: consumed.unreviewed,
    };
  }

  /**
   * 技能附件清单（skill_read/skill_list 清单面；设计 §12.3 清单上限防线）。
   *
   * 走 {@link consume} 快照（字节同源；F14：walk 失败如实带 error，不再谎报 0 附件）。
   * SKILL.md 不列（正文面已给）。文本小文件带首行提要（EXCERPT_MAX 字符），
   * 二进制/大文件只标类型+大小。条目按路径排序，截 LIST_MAX 条，total 供「+N more」。
   *
   * @param skillId - 技能 id
   * @param opts.subdir - 只列此前缀下的条目（如 `references/`）
   * @param opts.pattern - 路径 glob 过滤（`**`/`*`/`?`/`{a,b}`，匹配技能内相对路径）
   * @returns 清单 + 过滤后全量条目数（+可选 error）；id 不在索引时 null
   */
  async listFiles(
    skillId: string,
    opts?: { subdir?: string; pattern?: string },
  ): Promise<{ entries: SkillFileEntry[]; total: number; error?: string } | null> {
    await this.ensureFresh();
    const skill = this.skills.get(skillId);
    if (!skill) return null;
    const consumed = this.consume(skillId);
    if (!consumed.ok) {
      // F3（S2 评审）：拒绝语义透传 kind——drift/disabled/not_approved 由工具面
      // 升格为 throw（与 skill_read/skill_search 一致）；unreadable 柔性（walk 失败如实标注）
      return {
        entries: [],
        total: 0,
        error: consumed.reason,
        ...(consumed.status === 'refused' && consumed.kind ? { errorKind: consumed.kind } : {}),
      };
    }
    const prefix = opts?.subdir?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const globRe = opts?.pattern ? globToPathRegex(opts.pattern) : undefined;
    const rels = [...consumed.files.keys()]
      .filter((rel) => rel !== 'SKILL.md')
      .filter((rel) => (prefix ? rel.startsWith(prefix + '/') || rel === prefix : true))
      .filter((rel) => (globRe ? globRe.test(rel) : true))
      .sort();
    const total = rels.length;
    const entries: SkillFileEntry[] = [];
    for (const rel of rels.slice(0, LIST_MAX)) {
      entries.push(describeAttachment(rel, consumed.files.get(rel)!));
    }
    return { entries, total };
  }

  /**
   * 读取技能附件（skill_read file= 分支；设计 §12.3）。
   *
   * 走 {@link consume} 快照（审查锚定与字节同源）。二次 containment：
   * relPath 必须落在该技能目录内（拒绝对路径/`..`/symlink 逃逸）。
   *
   * @param skillId - 技能 id
   * @param relPath - 技能目录内相对路径（SKILL.md 由 {@link load} 服务，此处按附件读）
   * @param opts.offset - 起始行（1-indexed）
   * @param opts.limit - 返回行数上限（缺省 DEFAULT_READ_LIMIT，与 file_read 同口径；硬顶 MAX_READ_LIMIT）
   * @returns 附件内容（分段）或明确拒绝原因
   */
  async loadFile(
    skillId: string,
    relPath: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<SkillFileLoadResult> {
    await this.ensureFresh();
    const skill = this.skills.get(skillId);
    if (!skill) return { status: 'not_found' };
    const consumed = this.consume(skillId);
    if (!consumed.ok) {
      return consumed.status === 'not_found'
        ? { status: 'not_found' }
        : { status: 'refused', kind: consumed.kind ?? 'hash_drift', reason: consumed.reason };
    }

    // 二次 containment（快照 key 已归一 `/`；此处判逃逸——symlink 已在快照层跳过）
    const cleaned = relPath.trim().replace(/\\/g, '/');
    if (!cleaned || cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) {
      return {
        status: 'path_forbidden',
        reason: 'absolute paths are not allowed; pass a path inside the skill',
      };
    }
    if (cleaned.split('/').includes('..')) {
      return { status: 'path_forbidden', reason: 'path traversal ("..") is not allowed' };
    }
    const raw = consumed.files.get(cleaned);
    if (!raw) {
      // symlink 不入快照——显式报拒（symlink 形态是被拒不是缺失；评审 5.1）
      if (consumed.skippedSymlinks.has(cleaned)) {
        return {
          status: 'path_forbidden',
          reason: 'symbolic links are not consumed (path-containment risk)',
        };
      }
      return { status: 'not_found' };
    }
    if (isProbablyBinary(raw)) return { status: 'binary' };

    const text = raw.toString('utf-8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const totalLines = text.length === 0 ? 0 : lines.length;
    const offset = Math.max(1, Math.floor(opts?.offset ?? 1));
    // F4：limit 模型可控 → 硬顶 MAX_READ_LIMIT（截断防线不被超大参数绕过）
    const limit = Math.min(Math.max(1, Math.floor(opts?.limit ?? DEFAULT_READ_LIMIT)), MAX_READ_LIMIT);
    // F15：越界 offset 不静默钳制到末行——显式 outOfRange + 空内容
    if (offset > totalLines && totalLines > 0) {
      return {
        status: 'ok',
        content: '',
        totalLines,
        fromLine: offset,
        toLine: offset - 1,
        truncated: false,
        outOfRange: true,
        fileHash: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      };
    }
    const fromLine = Math.max(1, Math.min(offset, Math.max(totalLines, 1)));
    const toLine = Math.min(fromLine + limit - 1, totalLines);
    const content = lines.slice(fromLine - 1, toLine).join('\n');
    return {
      status: 'ok',
      content,
      totalLines,
      fromLine,
      toLine,
      truncated: toLine < totalLines,
      fileHash: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    };
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  get(skillId: string): SkillDefinition | null {
    return this.skills.get(skillId) ?? null;
  }
}
