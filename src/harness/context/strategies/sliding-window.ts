/**
 * Context 压缩策略 — 滑动窗口
 *
 * 最简单的压缩策略：只保留最近的 N 条消息。
 * 适用于大多数短对话场景。
 */

import type { Message } from '../../../core/types.js';

/** 压缩策略配置 */
export interface CompressionConfig {
  /** 保留最近的消息数量 */
  preserveRecent: number;
  /** 是否保留系统消息 */
  preserveSystem: boolean;
  /** 是否保留工具调用结果 */
  preserveTools: boolean;
}

/** 压缩结果 */
export interface CompressionResult {
  /** 原始消息数量 */
  originalCount: number;
  /** 压缩后消息数量 */
  compressedCount: number;
  /** 被移除的消息数量 */
  removedCount: number;
}

/**
 * 滑动窗口压缩策略
 *
 * 保留最近的 N 条消息，丢弃更早的消息。
 * 系统消息和工具消息可以根据配置保留。
 */
export function slidingWindow(
  messages: Message[],
  config: CompressionConfig
): { messages: Message[]; result: CompressionResult } {
  const { preserveRecent, preserveSystem, preserveTools } = config;

  if (messages.length <= preserveRecent) {
    return {
      messages,
      result: {
        originalCount: messages.length,
        compressedCount: messages.length,
        removedCount: 0,
      },
    };
  }

  // 分离需要特殊处理的消息
  const systemMessages: Message[] = [];
  const toolMessages: Message[] = [];
  const normalMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'system' && preserveSystem) {
      systemMessages.push(msg);
    } else if (msg.role === 'tool' && preserveTools) {
      toolMessages.push(msg);
    } else if (msg.role !== 'system' && msg.role !== 'tool') {
      normalMessages.push(msg);
    }
  }

  // 保留最近的普通消息
  const recentMessages = normalMessages.slice(-preserveRecent);

  // 合并：系统消息 + 工具消息 + 最近消息
  const compressed = [...systemMessages, ...toolMessages, ...recentMessages];

  return {
    messages: compressed,
    result: {
      originalCount: messages.length,
      compressedCount: compressed.length,
      removedCount: messages.length - compressed.length,
    },
  };
}

/**
 * 创建滑动窗口压缩器
 *
 * 返回一个函数，可以直接用于 ContextPipeline。
 */
export function createSlidingWindowCompressor(config: CompressionConfig) {
  return (messages: Message[]) => slidingWindow(messages, config).messages;
}
