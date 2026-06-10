/**
 * HeuristicTokenEstimator — 启发式 Token 估算器
 *
 * 三层策略：
 * 1. 优先使用 LLM 返回的实际 token 数（usage.promptTokens）- 外部回写
 * 2. 次选：专用 tokenizer（如 tiktoken）- 未来扩展
 * 3. 兜底：启发式估算
 *    - 英文：字符数 / 4
 *    - 中文：1 汉字 ≈ 1.5 token
 *    - 多模态：图片按固定 token 计
 *
 * 基于 tiktoken cl100k_base 经验值。
 */

import type { Message } from '../../core/types.js';
import { getTextContent } from '../../core/types.js';
import type { TokenEstimator } from '../../core/interfaces/context-engine.js';
import type { LLMMessage, ToolDefinition } from '../../core/interfaces/model-provider.js';

/**
 * 估算单段文本的 token 数
 *
 * 使用采样策略：超长文本采样前 2000 字符估算，避免 O(n) 扫描。
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;

  // 超长文本采样
  const sample = text.length > 2000 ? text.slice(0, 2000) : text;
  const sampleRatio = text.length / sample.length;

  // 分类统计
  let chineseChars = 0;
  let asciiChars = 0;
  let otherChars = 0;

  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      // CJK 统一汉字
      chineseChars++;
    } else if (code < 0x80) {
      // ASCII
      asciiChars++;
    } else {
      otherChars++;
    }
  }

  // 估算：
  // - 中文：~1.5 token/字
  // - 英文：~0.25 token/char（即 4 chars/token）
  // - 其他：~0.5 token/char
  const tokens = chineseChars * 1.5 + asciiChars * 0.25 + otherChars * 0.5;

  // 加上采样比例
  return Math.ceil(tokens * sampleRatio);
}

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
    let tokens = 0;

    // 消息结构开销（role + 分隔符）
    tokens += 4;

    // 内容
    if (typeof message.content === 'string') {
      tokens += estimateTextTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          tokens += estimateTextTokens(block.text);
        } else if (block.type === 'image') {
          // 图片 token 估算（参考 OpenAI vision 定价）
          // 典型图片：85-170 token per tile，假设 1-2 tiles
          tokens += 170;
        } else if (block.type === 'audio') {
          // 音频：~1 token/秒，假设 30 秒
          tokens += 30;
        } else if (block.type === 'video') {
          // 视频：抽帧处理，假设 10 帧
          tokens += 850;
        } else {
          tokens += 10;
        }
      }
    }

    // 工具调用
    if (message.toolCalls) {
      for (const tc of message.toolCalls) {
        tokens += 1; // 函数名
        const argsStr = JSON.stringify(tc.arguments ?? {});
        tokens += Math.ceil(argsStr.length / 3); // JSON 结构符号密集
      }
    }

    // 工具结果
    if (message.toolResults) {
      for (const tr of message.toolResults) {
        const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
        tokens += estimateTextTokens(resultStr);
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
      // ToolDefinition 格式: { type: 'function', function: { name, description, parameters } }
      const fn = tool.function;
      total += estimateTextTokens(fn.name);
      total += estimateTextTokens(fn.description);
      const paramsStr = JSON.stringify(fn.parameters ?? {});
      total += Math.ceil(paramsStr.length / 3);
    }
    return total;
  }
}

/**
 * 估算 LLM 消息列表的 token 数（兼容函数）
 *
 * 用于向后兼容旧的 estimateTokens 函数。
 */
export function estimateLLMMessages(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // 消息结构开销
    total += 4;

    // 内容
    if (typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          total += estimateTextTokens(block.text);
        } else if (block.type === 'image') {
          total += 170;
        } else if (block.type === 'input_audio') {
          total += 30;
        } else {
          total += 10;
        }
      }
    }

    // 工具调用
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += 1;
        total += Math.ceil((tc.function?.arguments ?? '').length / 3);
      }
    }
  }
  return total;
}
