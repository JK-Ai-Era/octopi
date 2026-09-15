/**
 * Skill 系统类型
 *
 * @layer harness/plugin-ecosystem — Skill 是 Harness 产品能力，
 * 不是 Kernel；discover/load 的 fs 实现在 manager.ts。
 */

/** Skill 定义 */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  filePath: string;
  source: 'bundled' | 'workspace' | 'plugin';
  disableModelInvocation?: boolean;
  requiredTools?: string[];
}

/** Skill 管理器接口 */
export interface SkillManager {
  discover(directory: string): Promise<void>;
  formatForPrompt(): string;
  load(skillId: string): Promise<string | null>;
  list(): SkillDefinition[];
  get(skillId: string): SkillDefinition | null;
}
