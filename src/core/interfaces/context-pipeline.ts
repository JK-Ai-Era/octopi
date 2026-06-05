/**
 * ContextPipeline — 上下文组装管道接口
 *
 * 职责：将消息历史组装成发给 LLM 的上下文。
 * 采用管道模型，支持多阶段处理：enrich → assemble → compact → filter
 *
 * Core 层只定义接口，不预设管道实现。
 * Harness 层实现 DefaultContextPipeline，包含可插拔的阶段。
 */

import type { Message, TokenUsage } from '../types.js';
import type { LLMMessage, ToolDefinition } from './model-provider.js';

// ── 管道输入 ──

/** 管道输入 */
export interface PipelineInput {
  /** 系统提示词（由 Harness 层传入，Core 不关心来源） */
  systemPrompt: string;
  /** 可用工具描述 */
  tools: ToolDefinition[];
  /** 最大 token 数 */
  maxTokens?: number;
  /** 中止信号 */
  signal?: AbortSignal;
  /** 扩展配置（Harness 层自定义） */
  extra?: Record<string, unknown>;
}

// ── 管道输出 ──

/** 不可信内容范围 */
export interface UntrustedRange {
  start: number;
  end: number;
  source: string;
}

/** 管道输出 */
export interface PipelineOutput {
  /** 组装后的 LLM 消息 */
  messages: LLMMessage[];
  /** token 使用估算 */
  estimatedTokens: number;
  /** 标记的不可信内容范围（用于 injection 防护） */
  untrustedRanges?: UntrustedRange[];
  /** 系统提示词（可能被管道阶段修改） */
  systemPrompt: string;
}

// ── 接口定义 ──

/**
 * ContextPipeline 接口
 *
 * Core 层在每次模型调用前调用此接口组装上下文。
 */
export interface ContextPipeline {
  /**
   * 处理上下文
   *
   * @param messages - 当前消息历史
   * @param input - 管道输入（工具定义、系统提示等）
   * @returns 组装后的管道输出
   */
  process(messages: Message[], input: PipelineInput): Promise<PipelineOutput>;
}
