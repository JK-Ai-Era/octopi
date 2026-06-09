/**
 * ModelProvider — LLM 调用接口
 *
 * 职责：与 LLM 服务通信，支持同步和流式调用。
 * 实现方：OpenAI、Anthropic、本地模型等。
 *
 * 设计要点：
 * - 返回统一的 LLMResponse 格式
 * - 流式调用返回 AsyncGenerator<LLMStreamChunk>
 * - 不关心 Session、Tool 等上层概念
 */

import type { TokenUsage, ToolCall, ModelInfo } from '../types.js';

// ── 请求/响应类型 ──

/**
 * LLM 消息格式（provider 边界格式）
 *
 * 支持多模态：content 可以是字符串或内容块数组（OpenAI vision/audio 格式）。
 */
export interface LLMMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }> | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/** 工具定义（OpenAI function calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** LLM 请求 */
export interface LLMRequest {
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
}

/** LLM 响应 */
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

/** LLM 流式 chunk */
export interface LLMStreamChunk {
  type: 'content' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: {
    id?: string;
    name?: string;
    arguments?: string;
    /** 工具调用索引（支持多个并行 tool call） */
    index?: number;
  };
  usage?: TokenUsage;
  error?: string;
}

// ── 接口定义 ──

/**
 * ModelProvider 接口
 *
 * 实现方必须提供：
 * - chat(): 同步调用
 * - stream(): 流式调用
 * - isAvailable(): 健康检查
 * - getModelInfo(): 查询模型能力（可选，返回 null 表示未知）
 */
export interface ModelProvider {
  /** Provider 名称（如 'openai', 'anthropic'） */
  readonly name: string;

  /**
   * 默认模型名称
   *
   * 当 RunConfig.model 未指定时，Engine 使用此值。
   * 可选——未设置时 Engine 不做 fallback。
   */
  readonly defaultModel?: string;

  /** 同步调用 */
  chat(request: LLMRequest): Promise<LLMResponse>;

  /** 流式调用 */
  stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk>;

  /** 检查 provider 是否可用 */
  isAvailable(): Promise<boolean>;

  /**
   * 查询模型能力声明
   *
   * 返回 ModelInfo（contextWindow, maxOutputTokens）或 null（未知）。
   * Context Pipeline 用此信息做 token 预算规划。
   */
  getModelInfo(modelName: string): ModelInfo | null;

  /**
   * 获取所有已配置的 ModelInfo
   *
   * 用于模型选择 UI、能力发现等场景。
   */
  getModelInfos(): ModelInfo[];
}
