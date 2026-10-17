/**
 * Agent 产品装配 DTO
 *
 * @layer harness — 配置 / Gateway / Builder 使用。
 * 非 Kernel：Loop 与 Kernel ports 不消费 AgentDefinition。
 * Skill 相关见 plugin-ecosystem/skills/types.ts。
 */

import type { ModelInfo, ToolPolicy } from '@octopi-agent/core/types/agent-definition.js';
import type { SessionRights } from '../../governance/session-acl/types.js';

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
  /** ToolEffectPolicy 运行模式（P3）；agents[].effectPolicy 覆盖顶层 */
  effectPolicy?: import('../../extension/execution-environment/effect-policy.js').EffectPolicyConfig;
  /** Knowledge 召回姿态（覆盖全局 knowledge.recall） */
  knowledge?: {
    recall?: 'off' | 'hint' | 'hybrid' | 'inject';
  };
  /** 特质标签（arch/delegation.md §9.2：供父 agent 按特质发现委派目标）；无权限语义 */
  traits?: string[];
  /** 委派策略（arch/delegation.md §9.2）；整段可省略 = 用 DEFAULT_DELEGATION_POLICY（委派默认开启） */
  delegation?: {
    /** 能否被委派（默认 true；显式 false = 只能被用户直接对话） */
    callable: boolean;
    /** 允许哪些 agentId 调我（缺省 = 任意） */
    callableBy?: string[];
    /** 我能不能再委派、获得 delegate_* 工具（默认 true） */
    canDelegate: boolean;
    /** 递归上限（默认 1 = 我能派子，子不能再派；runaway 兜底） */
    maxDepth?: number;
    /** 被委派时的权利天花板（只能收紧不能放宽，D3） */
    rightsCeiling?: SessionRights;
    /** 委派预算上限（请求预算与此取交集） */
    budget?: {
      maxTurns?: number;
      maxTokens?: number;
      timeoutMs?: number;
    };
  };
}

export type { ModelInfo, ToolPolicy };
