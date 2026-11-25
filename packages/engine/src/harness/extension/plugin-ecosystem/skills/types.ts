/**
 * Skill 系统类型
 *
 * @layer harness/extension/plugin-ecosystem — Skill 是 Harness 产品能力，
 * 不是 Kernel；discover/load 的 fs 实现在 manager.ts。
 */

/** Skill 定义 */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  filePath: string;
  source: 'bundled' | 'workspace' | 'plugin';
  /** 双层发现的来源层：共享层（skillSharedDirectory）或 agent 覆盖层；单层部署不标注 */
  layer?: 'shared' | 'agent';
  disableModelInvocation?: boolean;
  requiredTools?: string[];
  /**
   * 注册斜杠命令（不含 `/`）。缺省不注册。
   * 校验 `^[a-z][a-z0-9_-]*$`（可写 `/pdf`，规范化后存储）。
   */
  command?: string;
  /** metadata.interpreter：skill_run 解释器声明（shebang/扩展名映射之前的优先级；§12.4） */
  interpreter?: string;
  /** 放盘即信任来源（dropped-in）的「未经审查」标注（审计面；不进 prompt 索引） */
  unreviewed?: boolean;
}

/** Skill 管理器接口 */
export interface SkillManager {
  /**
   * 扫描技能目录。传入数组 = 双层发现：**按序合并，后层同 id 覆盖前层**
   * （约定调用序 = [共享层, agent 层]，agent 层赢）。
   */
  discover(directory: string | readonly string[]): Promise<void>;
  formatForPrompt(): string;
  /**
   * 加载 Skill 正文（消费面单源：skill_read 工具与 /name 命令展开共用）。
   * 注入 loadGuard 时随文做审查哈希锚定（漂移即拒，见 SkillLoadGuard）。
   */
  load(skillId: string): Promise<SkillLoadResult>;
  /**
   * 消费面快照（单 IO：读到的字节与内容哈希同源，闭合 TOCTOU）。
   * skill_run 取脚本原始字节用；正文/附件消费经 load/loadFile（内部同走此快照）。
   */
  consume(skillId: string):
    | { ok: true; files: Map<string, Buffer>; skippedSymlinks: Set<string>; unreviewed: boolean }
    | {
        ok: false;
        status: 'not_found' | 'refused';
        kind?: 'hash_drift' | 'disabled' | 'not_approved' | 'invalid_id' | 'unreadable';
        reason: string;
      };
  /**
   * 审查哈希锚定（轻量预检：不读内容、仅复算目录哈希——有 TOCTOU 窗口，
   * 仅供诊断；正文/附件/脚本消费一律走 consume）。
   */
  verifyAnchor(skillId: string): import('./lifecycle.js').SkillLoadVerdict;
  /**
   * 技能附件清单（SKILL.md 之外；截 LIST_MAX 条 + total 如实标注）。
   * id 不在索引时 null；快照失败时 entries 空 + error 如实标注（F14）。
   */
  listFiles(
    skillId: string,
    opts?: { subdir?: string; pattern?: string },
  ): Promise<{
    entries: SkillFileEntry[];
    total: number;
    error?: string;
    errorKind?: 'hash_drift' | 'disabled' | 'not_approved' | 'invalid_id' | 'unreadable';
  } | null>;
  /**
   * 读取技能附件（二次 containment + 审查哈希锚定，见 manager 实现）。
   */
  loadFile(
    skillId: string,
    relPath: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<SkillFileLoadResult>;
  list(): SkillDefinition[];
  get(skillId: string): SkillDefinition | null;
}

/**
 * Skill 正文加载结果（S1 消费面升级：元信息 + 漂移判定）。
 *
 * - `ok`：正文可用；`fileHash` = 正文（body）sha256，供分段续读一致性比对；
 *   `totalLines` 供截断标注；`unreviewed` = 放盘即信任来源（未经审查）。
 * - `not_found`：未发现该 id（或文件已消失）。
 * - `refused`：内容不得消费——`kind` 分类（漂移≠停用≠未过审，文案分派用），
 *   `reason` 供消费面展示（skill_read 报因 / skill-bridge 展开警示）。
 */
export type SkillLoadResult =
  | { status: 'ok'; body: string; totalLines: number; fileHash: string; unreviewed: boolean }
  | { status: 'not_found' }
  | {
      status: 'refused';
      kind: 'hash_drift' | 'disabled' | 'not_approved' | 'invalid_id' | 'unreadable';
      reason: string;
    };

/** 技能附件清单条目（skill_read 附件清单；设计 §12.3） */
export interface SkillFileEntry {
  /** 技能目录内相对路径（`/` 分隔） */
  path: string;
  bytes: number;
  /** text=文本小文件（带提要）；binary=二进制；large=大文件（不读内容） */
  kind: 'text' | 'binary' | 'large';
  /** 首行提要（kind=text；≤120 字符） */
  excerpt?: string;
}

/** 技能附件读取结果（skill_read file= 分支） */
export type SkillFileLoadResult =
  | {
      status: 'ok';
      content: string;
      totalLines: number;
      fromLine: number;
      toLine: number;
      truncated: boolean;
      /** 起始行超出文件范围（content 为空；越界不静默钳制——F15） */
      outOfRange?: boolean;
      /** 全文件字节 sha256（分段续读一致性比对） */
      fileHash: string;
    }
  | { status: 'not_found' }
  | {
      status: 'refused';
      kind: 'hash_drift' | 'disabled' | 'not_approved' | 'invalid_id' | 'unreadable';
      reason: string;
    }
  /** 路径逃逸 / symlink 逃逸 / 非常规文件（二次 containment） */
  | { status: 'path_forbidden'; reason: string }
  | { status: 'binary' };
