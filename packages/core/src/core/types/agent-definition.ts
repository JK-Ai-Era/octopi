/**
 * 模型能力与工具策略（Kernel 词汇）
 *
 * @layer core — ModelProvider / ToolBus 消费；
 * 产品装配 DTO（AgentDefinition / Persona / ModelConfig）见 harness/shared/types/agent-definition.ts。
 */

/** 模型能力声明 */
export interface ModelInfo {
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 模型级采样温度：请求未显式指定时由 provider 采用；未配置则不发送该参数 */
  temperature?: number;
}

/** 工具策略 */
export interface ToolPolicy {
  allow: string[];
  deny?: string[];
  requireConfirmation?: string[];
}
