/**
 * AgentFileAdmin — agent 文件态管理（arch/config-hot-reload.md §5.2）
 *
 * 新增 agent = 目录脚手架（ensureAgentDirs，幂等）+ AGENTS.md 初始内容（角色
 * 模板渲染结果，给定则覆写）+ workspace 目录。persona 编辑 = 直接写 AGENTS.md
 * （builder 指纹缓存 mtime/size 自动重读，天然热生效）。
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ensureAgentDirs, getOctopiHome } from './init.js';

/** scaffold 选项 */
export interface ScaffoldAgentOptions {
  /** 初始 AGENTS.md 全文（角色模板渲染结果）；缺省用 ensureAgentDirs 默认模板 */
  agentsMd?: string;
  /** workspace 目录路径（`~` 由调用方展开为绝对路径）；缺省用脚手架默认 */
  workspace?: string;
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
   * agent 文件态标准路径（与 octopi init 布局同源）
   *
   * @param agentId - agent id
   * @returns home / workspace / skillDirectory 绝对路径
   */
  pathsOf(agentId: string): { home: string; workspace: string; skillDirectory: string } {
    const home = join(this.homeDir, 'agents', agentId);
    return {
      home,
      workspace: join(this.homeDir, 'workspace', agentId),
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
   * 建 agent 文件态（幂等）：home / workspace / skills + AGENTS.md
   *
   * @param agentId - agent id
   * @param opts - scaffold 选项
   * @throws id 为路径穿越形态 / workspace 为相对路径时抛错（纵深防御）
   */
  async scaffold(agentId: string, opts: ScaffoldAgentOptions = {}): Promise<void> {
    if (agentId === '.' || agentId === '..' || agentId.includes('/') || agentId.includes('\\')) {
      throw new Error(`invalid agent id: ${agentId}`);
    }
    await ensureAgentDirs(agentId, this.homeDir);
    if (opts.agentsMd !== undefined) {
      // 仅在 AGENTS.md 缺失时写：重建同 id agent 不覆盖既有 persona（用户数据）
      const agentsMdPath = join(this.homeOf(agentId), 'AGENTS.md');
      if (!existsSync(agentsMdPath)) {
        writeFileSync(agentsMdPath, opts.agentsMd, 'utf-8');
      }
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
