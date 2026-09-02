/**
 * Agent 定义类型
 *
 * 描述 Agent 的人设、模型配置、工具策略等静态定义。
 */

/** Agent 人设 */
export interface AgentPersona {
  name: string;
  description: string;
  systemPrompt: string;
  tags?: string[];
}

/** 模型能力声明 */
export interface ModelInfo {
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** 模型配置 */
export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  /** 回退模型列表（按优先级排序，由 resolveModelConfig 解析后的完整配置） */
  fallbackModels?: ModelConfig[];
}

/** 工具策略 */
export interface ToolPolicy {
  allow: string[];
  deny?: string[];
  requireConfirmation?: string[];
}

/** Agent 定义 */
export interface AgentDefinition {
  id: string;
  /** Agent home 目录：persona、memory、wisdom、skills、sessions 的根目录 */
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
}
