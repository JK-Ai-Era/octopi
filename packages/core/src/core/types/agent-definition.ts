/**
 * 模型能力与工具策略（Kernel 词汇）
 *
 * @layer core — ModelProvider / ToolBus 消费；
 * 产品装配 DTO（AgentDefinition / Persona / ModelConfig）见 harness/shared/types/agent-definition.ts。
 */

/** 输入模态声明 */
export type ModelInputType = 'text' | 'image' | 'audio' | 'video';

/**
 * 模型输入模态判据（唯一出口）：模型是否接受某输入模态
 *
 * 语义与 {@link ModelInfo.input} 一致：**未声明 = 纯文本**（`['text']`）。
 * 消费方（convertMessage 图像降级、file_read 图像返回）一律经此判断，
 * 禁止散点 `input?.includes(...)`——判据语义只此一处（arch/file-read-image-view.md §2.3）。
 *
 * @param input - 输入模态声明（`ModelInfo.input` / `ResolvedModel.input` 透传），可缺省
 * @param kind - 待判模态
 * @returns 接受该模态返回 true
 */
export function modelAcceptsInput(
  input: ModelInputType[] | undefined | null,
  kind: ModelInputType,
): boolean {
  return (input ?? ['text']).includes(kind);
}

/** 模型能力声明 */
export interface ModelInfo {
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 模型级采样温度：请求未显式指定时由 provider 采用；未配置则不发送该参数 */
  temperature?: number;
  /** 是否支持 reasoning/thinking 输出（目录展示 / WebUI gating） */
  reasoning?: boolean;
  /** 输入模态声明（缺省视为纯文本） */
  input?: ModelInputType[];
}

/** 工具策略 */
export interface ToolPolicy {
  allow: string[];
  deny?: string[];
  /** 能力标签黑名单（exec / egress / send / dynamic-code / …）；与 session toolRights.denyCapabilities 同语义。
   * 注意 fail-closed：配置本字段后，能力标签解析不出的工具（未知=保守拒绝）也会被拒。 */
  denyCapabilities?: string[];
  requireConfirmation?: string[];
}
