/**
 * Agent 产品装配 DTO
 *
 * @layer harness — 配置 / Gateway / Builder 使用。
 * 非 Kernel：Loop 与 Kernel ports 不消费 AgentDefinition。
 * Skill 相关见 plugin-ecosystem/skills/types.ts。
 */

import type { ModelInfo, ToolPolicy } from '../../core/types/agent-definition.js';
import type { SessionRights } from '../session-acl/types.js';

/** Agent 人设 */
export interface AgentPersona {
  name: string;
  description: string;
  systemPrompt: string;
  tags?: string[];
}

/** 模型配置（装配用；能力声明见 Core ModelInfo） */
export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  /** 回退模型列表（按优先级排序，由 resolveModelConfig 解析后的完整配置） */
  fallbackModels?: ModelConfig[];
}

/** Agent 定义（产品装配形状，非内核合同） */
export interface AgentDefinition {
  id: string;
  /** Agent home 目录：persona、skills、sessions、extract 的根目录 */
  home: string;
  /** 沙箱工作目录：agent 工具操作的 cwd */
  workspace?: string;
  persona: AgentPersona;
  tools: ToolPolicy;
  model: ModelConfig;
  skillDirectory?: string;
  skills?: string[];
  contextEngine?: string;
  channelBindings?: Record<string, string>;
  /**
   * Session ACL 天花板（L1 · E6）。
   * handle authorize 时与角色 max / 绑定取交集。
   */
  maxSessionRights?: SessionRights;
}

export type { ModelInfo, ToolPolicy };
