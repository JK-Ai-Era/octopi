/**
 * AgentFileAdmin — agent 文件态管理（arch/config-hot-reload.md §5.2）
 *
 * 新增 agent = 目录脚手架（ensureAgentDirs，幂等）+ 类型模板物化
 * （applyRolePresetFiles：AGENTS.md 覆写 + persona 四件套整体替换 + skills 落盘）。
 * persona 编辑 = 直接写 AGENTS.md（builder 指纹缓存 mtime/size 自动重读，天然热生效）。
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { agentHomeDir, agentWorkspaceDir } from '@octopi-agent/engine/paths.js';
import type { ProductLang } from '@octopi-agent/engine/config-admin/i18n.js';
import {
  assertSafeConfigName,
  assertSafePersonaFileName,
} from '@octopi-agent/engine/config-admin/name-guard.js';
import { ensureAgentDirs, getOctopiHome } from './init.js';

/** 类型模板 persona 补充件（文件名 + 正文） */
export interface RolePersonaFileToApply {
  file: string;
  content: string;
}

/** 类型模板技能套装条目（物化为 skills/<id>/SKILL.md） */
export interface RoleSkillToApply {
  id: string;
  name: string;
  description: string;
  content: string;
  tools?: string[];
}

/** 类型模板物化载荷（renderAgentRole 渲染结果的文件面） */
export interface RoleFilesToApply {
  /** AGENTS.md 全文（覆写） */
  agentsMd: string;
  /** persona/ 补充件；提供（含空数组）则整体替换四件套，undefined 则不动 */
  personaFiles?: RolePersonaFileToApply[];
  /** 技能套装；提供则物化 SKILL.md */
  skills?: RoleSkillToApply[];
}

/** scaffold 选项 */
export interface ScaffoldAgentOptions {
  /** 初始 AGENTS.md 全文（类型模板渲染结果）；缺省用 ensureAgentDirs 默认模板 */
  agentsMd?: string;
  /** 类型模板 persona 补充件（提供则整体替换四件套） */
  personaFiles?: RolePersonaFileToApply[];
  /** 类型模板技能套装（提供则物化 SKILL.md） */
  skills?: RoleSkillToApply[];
  /** workspace 目录路径（`~` 由调用方展开为绝对路径）；缺省用脚手架默认 */
  workspace?: string;
  /** 归属租户（脚手架布局用）；缺省 DEFAULT_TENANT_ID */
  tenantId?: string;
  /** 缺省 persona（general 四件套）产物语言；缺省 zh */
  lang?: ProductLang;
}

/**
 * 四件套默认文件名（应用类型模板时清理未被新模板提供的成员）。
 * 只含 init 真正生成的三件 persona；`40-tools.md` 不在四件套内——它可能是
 * 用户 TOOLS.md 迁移过来的数据（LEGACY_PERSONA_MOVES 刻意保留），按名清理会删用户数据。
 */
const PERSONA_SCAFFOLD_FILES = ['10-soul.md', '20-identity.md', '30-user.md'];

/**
 * 渲染技能套装为 SKILL.md 正文（frontmatter + 正文）
 *
 * @param skill - 技能条目
 * @returns SKILL.md 全文
 */
export function renderSkillMarkdown(skill: RoleSkillToApply): string {
  // n4：frontmatter 值用双引号包裹（description 常含 `: `，裸 YAML 非法）
  const esc = (s: string): string => s.replace(/"/g, '\\"');
  const toolsLine = skill.tools?.length ? `tools: ${skill.tools.join(', ')}\n` : '';
  return `---\nname: "${esc(skill.name)}"\ndescription: "${esc(skill.description)}"\n${toolsLine}---\n${skill.content}`;
}

/**
 * 应用类型模板到 agent home（创建时物化；CLI 向导与 Web scaffold 共用的单一实现）
 *
 * - AGENTS.md：覆写（创建者显式选择了该模板，与 CLI 向导语义一致）
 * - persona 四件套：personaFiles 提供时整体替换（写新件 + 清掉默认模板遗留的
 *   未提供成员）；undefined 时保持脚手架默认，不触碰
 * - skills：提供时物化 skills/<id>/SKILL.md
 *
 * @param home - agent home 绝对路径
 * @param role - 类型模板物化载荷
 * @throws home 不存在 / 载荷含空 AGENTS.md、非法 persona 文件名或 skill id 时抛错
 *   （fail-loud；**校验先于一切写盘与删除**——非法载荷不得留下半套 persona）
 */
export function applyRolePresetFiles(home: string, role: RoleFilesToApply): void {
  if (!existsSync(home)) {
    throw new Error(`agent home not found: ${home} (scaffold first)`);
  }
  // 预校验整包载荷（纯校验，未动盘）：任一非法即整体拒绝
  if (!role.agentsMd.trim()) {
    throw new Error('agentsMd must be a non-empty string');
  }
  for (const f of role.personaFiles ?? []) assertSafePersonaFileName(f.file);
  for (const s of role.skills ?? []) assertSafeConfigName(s.id);

  writeFileSync(join(home, 'AGENTS.md'), role.agentsMd, 'utf-8');

  if (role.personaFiles !== undefined) {
    const provided = new Set(role.personaFiles.map((f) => f.file));
    for (const name of PERSONA_SCAFFOLD_FILES) {
      if (provided.has(name)) continue;
      const stale = join(home, 'persona', name);
      if (existsSync(stale)) rmSync(stale);
    }
    for (const f of role.personaFiles) {
      const p = join(home, 'persona', f.file);
      mkdirSync(resolve(p, '..'), { recursive: true });
      writeFileSync(p, f.content, 'utf-8');
    }
  }

  if (role.skills !== undefined) {
    for (const s of role.skills) {
      const p = join(home, 'skills', s.id, 'SKILL.md');
      mkdirSync(resolve(p, '..'), { recursive: true });
      writeFileSync(p, renderSkillMarkdown(s), 'utf-8');
    }
  }
}

export class AgentFileAdmin {
  private readonly homeDir: string;

  /**
   * @param homeDir - OCTOPI_HOME（缺省 getOctopiHome()）
   */
  constructor(homeDir: string = getOctopiHome()) {
    this.homeDir = homeDir;
  }

  /**
   * agent 文件态标准路径（与 octopi init 布局同源；派生单一来源 = engine/paths）
   *
   * @param agentId - agent id
   * @param tenantId - 归属租户；缺省 DEFAULT_TENANT_ID
   * @returns home / workspace / skillDirectory 绝对路径
   */
  pathsOf(agentId: string, tenantId?: string): { home: string; workspace: string; skillDirectory: string } {
    const home = agentHomeDir(this.homeDir, agentId);
    return {
      home,
      workspace: agentWorkspaceDir(this.homeDir, tenantId, agentId),
      skillDirectory: join(home, 'skills'),
    };
  }

  /**
   * agent home 目录路径
   *
   * @param agentId - agent id
   * @returns `OCTOPI_HOME/agents/<id>`
   */
  homeOf(agentId: string): string {
    return this.pathsOf(agentId).home;
  }

  /**
   * 建 agent 文件态（幂等）：home / workspace / skills + 默认 persona 四件套；
   * 提供 agentsMd（类型模板渲染结果）时按创建语义物化模板文件
   *
   * @param agentId - agent id
   * @param opts - scaffold 选项
   * @throws id 为路径穿越形态 / workspace 为相对路径时抛错（纵深防御）
   */
  async scaffold(agentId: string, opts: ScaffoldAgentOptions = {}): Promise<void> {
    try {
      assertSafeConfigName(agentId);
    } catch {
      // 守卫是引擎单一实现（name-guard）；此处保持 agent id 语义的错误文案
      throw new Error(`invalid agent id: ${agentId}`);
    }
    await ensureAgentDirs(agentId, this.homeDir, opts.tenantId, opts.lang);
    if (opts.agentsMd !== undefined) {
      // 创建即应用类型模板：AGENTS.md 覆写 + 四件套按 personaFiles 整体替换
      // （与 CLI 新建向导同语义；重建同 id 且带模板 = 模板生效）
      applyRolePresetFiles(this.homeOf(agentId), {
        agentsMd: opts.agentsMd,
        personaFiles: opts.personaFiles,
        skills: opts.skills,
      });
    }
    if (opts.workspace) {
      if (!isAbsolute(opts.workspace)) {
        throw new Error(`workspace must be absolute or ~-form: ${opts.workspace}`);
      }
      mkdirSync(resolve(opts.workspace), { recursive: true });
    }
  }

  /**
   * 读 AGENTS.md（persona 全文）
   *
   * @param agentId - agent id
   * @param home - agent 配置的 home（缺省用标准布局路径）
   * @returns 文件内容；不存在返回 null
   */
  readPersona(agentId: string, home?: string): string | null {
    const path = join(home ?? this.homeOf(agentId), 'AGENTS.md');
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
  }

  /**
   * 读 persona/ 目录补充件（四件套等；另存为模板的 round-trip 用）
   *
   * @param agentId - agent id
   * @param home - agent 配置的 home（缺省用标准布局路径）
   * @returns `{file, content}` 列表（按文件名排序）；目录不存在返回空数组
   */
  readPersonaFiles(agentId: string, home?: string): RolePersonaFileToApply[] {
    const dir = join(home ?? this.homeOf(agentId), 'persona');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => ({ file: f, content: readFileSync(join(dir, f), 'utf-8') }));
  }

  /**
   * 写 AGENTS.md（persona 编辑；builder 指纹缓存自动重读）
   *
   * @param agentId - agent id
   * @param content - AGENTS.md 全文
   * @param home - agent 配置的 home（缺省用标准布局路径）
   * @throws home 不存在时抛错（fail-loud，防写到未 scaffold 的空洞路径）
   */
  writePersona(agentId: string, content: string, home?: string): void {
    const dir = home ?? this.homeOf(agentId);
    if (!existsSync(dir)) {
      throw new Error(`agent home not found: ${dir} (scaffold first)`);
    }
    writeFileSync(join(dir, 'AGENTS.md'), content, 'utf-8');
  }
}
