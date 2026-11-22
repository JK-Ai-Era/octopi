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
}

/** Skill 管理器接口 */
export interface SkillManager {
  /**
   * 扫描技能目录。传入数组 = 双层发现：**按序合并，后层同 id 覆盖前层**
   * （约定调用序 = [共享层, agent 层]，agent 层赢）。
   */
  discover(directory: string | readonly string[]): Promise<void>;
  formatForPrompt(): string;
  load(skillId: string): Promise<string | null>;
  list(): SkillDefinition[];
  get(skillId: string): SkillDefinition | null;
}
