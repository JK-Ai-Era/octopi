/**
 * HeuristicTokenEstimator — 启发式 Token 估算器
 *
 * 三层策略（参考 OpenClaw）：
 * 1. 优先使用 LLM 返回的实际 token 数（usage.promptTokens）- 外部回写
 * 2. 次选：专用 tokenizer（如 tiktoken）- 未来扩展
 * 3. 兜底：启发式估算，按内容类型使用不同比率
 *
 * 关键改进（v0.6.5+）：
 * - 完整 CJK 范围（扩展A/B + 平假名 + 片假名 + 韩文 + 全角符号）
 * - 按内容类型区分比率（文本4/工具结果2/JSON3）
 * - 消息结构开销 12 token（参考 OpenClaw）
 * - 图片估算 1200 token（参考 OpenClaw 的 4800 chars）
 * - 安全余量 1.2x（参考 OpenClaw 的 SAFETY_MARGIN）
 */

import type { Message } from '../../core/types.js';
import { getTextContent } from '../../core/types.js';
import type { TokenEstimator } from '../../core/interfaces/context-engine.js';
import type { LLMMessage, ToolDefinition } from '../../core/interfaces/model-provider.js';
import {
  estimateTextTokens,
  estimateAdjustedChars,
} from './core-token-estimator.js';
import {
  CHARS_PER_TOKEN,
  TOOL_RESULT_CHARS_PER_TOKEN,
  JSON_CHARS_PER_TOKEN,
  MESSAGE_OVERHEAD_TOKENS,
  IMAGE_TOKEN_ESTIMATE,
  AUDIO_TOKEN_ESTIMATE,
  VIDEO_TOKEN_ESTIMATE,
  SAFETY_MARGIN,
} from './token-constants.js';

// Re-export for backward compatibility
export { estimateTextTokens } from './core-token-estimator.js';

/**
 * 启发式 Token 估算器实现
 */
export class HeuristicTokenEstimator implements TokenEstimator {
  /**
   * 估算单条消息的 token 数
   *
   * 支持 string 和 ContentBlock[] 两种 content 格式。
   * 包含消息结构开销（role、分隔符等）。
   */
  estimateMessage(message: Message): number {
    let tokens = MESSAGE_OVERHEAD_TOKENS;

    // 内容
    if (typeof message.content === 'string') {
      tokens += estimateTextTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          tokens += estimateTextTokens(block.text);
        } else if (block.type === 'image') {
          tokens += IMAGE_TOKEN_ESTIMATE;
        } else if (block.type === 'audio') {
          tokens += AUDIO_TOKEN_ESTIMATE;
        } else if (block.type === 'video') {
          tokens += VIDEO_TOKEN_ESTIMATE;
        } else {
          tokens += 10;
        }
      }
    }

    // 工具调用（用 JSON 比率）
    if (message.toolCalls) {
      for (const tc of message.toolCalls) {
        tokens += estimateTextTokens(tc.name ?? '');
        const argsStr = JSON.stringify(tc.arguments ?? {});
        tokens += Math.ceil(argsStr.length / JSON_CHARS_PER_TOKEN);
      }
    }

    // 工具结果（用更密集的比率 chars/2）
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
   */
  estimateText(text: string): number {
    return estimateTextTokens(text);
  }

  /**
   * 估算工具定义的 token 数
   *
   * 工具定义包含：名称、描述、参数 schema。
   * JSON schema 结构符号多，token 密度高。
   */
  estimateTools(tools: ToolDefinition[]): number {
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
 * 估算 LLM 消息列表的 token 数（兼容函数）
 */
export function estimateLLMMessages(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;

    if (typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          total += estimateTextTokens(block.text);
        } else if (block.type === 'image') {
          total += IMAGE_TOKEN_ESTIMATE;
        } else if (block.type === 'input_audio') {
          total += AUDIO_TOKEN_ESTIMATE;
        } else {
          total += 10;
        }
      }
    }

    // 工具调用
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTextTokens(tc.function?.name ?? '');
        total += Math.ceil((tc.function?.arguments ?? '').length / JSON_CHARS_PER_TOKEN);
      }
    }
  }
  return total;
}
