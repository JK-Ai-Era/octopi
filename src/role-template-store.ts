/**
 * 自定义角色模板存取（「另存为模板」，P3）— `OCTOPI_HOME/templates/agent-roles.json`
 *
 * 生成器原则同内置模板：只做创建时渲染，不进运行时。与内置清单合并后经
 * `/config/presets/agent-roles` 暴露。
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRolePreset } from '@octopi-agent/engine/config-admin/agent-presets.js';
import { assertSafeConfigName } from '@octopi-agent/engine/config-admin/name-guard.js';
import { getOctopiHome } from './init.js';

/** 自定义角色模板存取端口 */
export interface RoleTemplateStore {
  /** 列出自定义模板 */
  list(): AgentRolePreset[];
  /** 保存自定义模板（同 id 覆盖） */
  save(preset: AgentRolePreset): void;
}

export class FileRoleTemplateStore implements RoleTemplateStore {
  private readonly filePath: string;

  /**
   * @param filePath - 模板文件路径（缺省 `OCTOPI_HOME/templates/agent-roles.json`）
   */
  constructor(filePath?: string) {
    this.filePath = filePath ?? join(getOctopiHome(), 'templates', 'agent-roles.json');
  }

  /**
   * 列出自定义模板
   *
   * @returns 模板清单；文件不存在返回空数组
   */
  list(): AgentRolePreset[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as { presets?: AgentRolePreset[] };
      return Array.isArray(parsed.presets) ? parsed.presets : [];
    } catch {
      // 损坏的模板文件不拖垮配置面：视为空（fail-safe 于读侧）
      console.warn(`[templates] failed to parse ${this.filePath}, ignoring`);
      return [];
    }
  }

  /**
   * 保存自定义模板（同 id 覆盖；文件不存在自动建）
   *
   * @param preset - 角色模板
   * @throws id 非法时抛错
   */
  save(preset: AgentRolePreset): void {
    assertSafeConfigName(preset.id);
    const existing = this.list().filter((p) => p.id !== preset.id);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      `${JSON.stringify({ presets: [...existing, preset] }, null, 2)}\n`,
      'utf-8',
    );
  }
}
