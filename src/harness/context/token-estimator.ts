/**
 * HeuristicTokenEstimator — 启发式 Token 估算器
 *
 * 实现 Core 的 `TokenEstimator` 接口；估算原语在 `token-estimate-fns.ts`。
 *
 * 三层策略（参考 OpenClaw）：
 * 1. 优先使用 LLM 返回的实际 token 数（usage.promptTokens）- 外部回写
 * 2. 次选：专用 tokenizer（如 tiktoken）- 未来扩展
 * 3. 兜底：启发式估算，按内容类型使用不同比率
 */

import type { Message } from '../../core/types.js';
import type { TokenEstimator } from './types.js';
import type { LLMMessage, LLMToolDefinition } from '../../core/interfaces/model-provider.js';
import {
  estimateTextTokens,
  estimateAdjustedChars,
  estimateContentBlock,
  estimateToolCallTokens,
} from './token-estimate-fns.js';
import {
  TOOL_RESULT_CHARS_PER_TOKEN,
  JSON_CHARS_PER_TOKEN,
  MESSAGE_OVERHEAD_TOKENS,
} from './token-constants.js';

// Re-export for callers that only need text estimation
export { estimateTextTokens } from './token-estimate-fns.js';

/**
 * 启发式 Token 估算器实现
 */
export class HeuristicTokenEstimator implements TokenEstimator {
  /**
   * 估算单条消息的 token 数
   *
   * 支持 string 和 ContentBlock[] 两种 content 格式。
   * 包含消息结构开销（role、分隔符等）。
   *
   * @param message 领域消息
   * @returns 估算 token 数
   */
  estimateMessage(message: Message): number {
    let tokens = MESSAGE_OVERHEAD_TOKENS;

    if (typeof message.content === 'string') {
      tokens += estimateTextTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        tokens += estimateContentBlock(block);
      }
    }

    if (message.toolCalls) {
      tokens += estimateToolCallTokens(message.toolCalls);
    }

    // 工具结果用更密集的比率（chars/2）
    if (message.toolResults) {
      for (const tr of message.toolResults) {
        const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
        tokens += Math.ceil(estimateAdjustedChars(resultStr) / TOOL_RESULT_CHARS_PER_TOKEN);
      }
    }

    return tokens;
  }

  /**
   * 估算多条消息的总 token 数
   *
   * @param messages 领域消息列表
   * @returns 估算 token 数
   */
  estimateMessages(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateMessage(msg);
    }
    return total;
  }

  /**
   * 估算文本的 token 数
   *
   * @param text 原始文本
   * @returns 估算 token 数
   */
  estimateText(text: string): number {
    return estimateTextTokens(text);
  }

  /**
   * 估算工具定义的 token 数
   *
   * 工具定义包含：名称、描述、参数 schema。
   * JSON schema 结构符号多，token 密度高。
   *
   * @param tools 工具定义列表
   * @returns 估算 token 数
   */
  estimateTools(tools: LLMToolDefinition[]): number {
    let total = 0;
    for (const tool of tools) {
      const fn = tool.function;
      total += estimateTextTokens(fn.name);
      total += estimateTextTokens(fn.description);
      const paramsStr = JSON.stringify(fn.parameters ?? {});
      total += Math.ceil(paramsStr.length / JSON_CHARS_PER_TOKEN);
    }
    return total;
  }
}

/**
 * 估算 LLM 消息列表的 token 数
 *
 * 适配 provider 侧 `LLMMessage`（OpenAI 风格 `tool_calls` / `input_audio`）。
 *
 * @param messages LLM 消息列表
 * @returns 估算 token 数
 */
export function estimateLLMMessages(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;

    if (typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        total += estimateContentBlock(block as { type?: string; text?: string });
      }
    }

    if (msg.tool_calls) {
      total += estimateToolCallTokens(
        msg.tool_calls.map((tc) => ({
          name: tc.function?.name,
          arguments: tc.function?.arguments ?? '',
        })),
      );
    }
  }
  return total;
}
