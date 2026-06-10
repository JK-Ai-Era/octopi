/**
 * TruncateCompressor — 截断压缩器
 *
 * 最简单的压缩策略：直接截断早期消息，保留最近消息。
 * 不需要 LLM，零成本，但信息损失最大。
 *
 * 作为兜底方案，当 LLM 摘要不可用时使用。
 */

import type { Message } from '../../core/types.js';
import { getTextContent } from '../../core/types.js';
import type {
  Compressor,
  CompressParams,
  CompressResult,
  TokenEstimator,
} from '../../core/interfaces/context-engine.js';
import { HeuristicTokenEstimator } from './token-estimator.js';

export class TruncateCompressor implements Compressor {
  /**
   * 压缩消息
   *
   * 策略：
   * 1. 从头部开始移除消息，直到达到目标 token 数
   * 2. 插入一条摘要消息说明被移除的内容
   * 3. 保持边界对齐（不拆分 tool_call/tool_result 对）
   */
  async compress(params: CompressParams): Promise<CompressResult> {
    const { messages, targetTokens, tokenEstimator } = params;
    const estimator = tokenEstimator ?? new HeuristicTokenEstimator();

    // 如果没有消息需要压缩
    if (messages.length === 0) {
      return {
        result: [],
        estimatedTokens: 0,
      };
    }

    // 计算当前 token 数
    const currentTokens = estimator.estimateMessages(messages);

    // 如果已经在预算内，不需要压缩
    if (currentTokens <= targetTokens) {
      return {
        result: [...messages],
        estimatedTokens: currentTokens,
      };
    }

    // 需要压缩的 token 数
    const excessTokens = currentTokens - targetTokens;

    // 从头部开始移除消息
    const remaining = [...messages];
    let removedCount = 0;
    let removedTokens = 0;

    while (remaining.length > 0 && removedTokens < excessTokens) {
      const msg = remaining[0];
      const msgTokens = estimator.estimateMessage(msg);

      // 边界对齐：如果下一条是 tool_result，一起移除
      if (this.hasToolCall(msg) && remaining.length > 1 && this.isToolResult(remaining[1])) {
        const nextTokens = estimator.estimateMessage(remaining[1]);
        remaining.splice(0, 2);
        removedTokens += msgTokens + nextTokens;
        removedCount += 2;
      } else {
        remaining.shift();
        removedTokens += msgTokens;
        removedCount++;
      }

      // 至少保留最后 2 条消息
      if (remaining.length <= 2) {
        break;
      }
    }

    // 如果没有移除任何消息，强制移除最早的一条
    if (removedCount === 0 && remaining.length > 2) {
      const removed = remaining.shift()!;
      removedCount = 1;
      removedTokens = estimator.estimateMessage(removed);
    }

    // 生成摘要消息
    const summaryMessage: Message = {
      role: 'system',
      content: `[Context compressed: ${removedCount} earlier messages removed to fit context window. ` +
        `Approximately ${removedTokens} tokens saved. ` +
        `The conversation continues from here.]`,
      timestamp: Date.now(),
    };

    // 组装结果
    const result = [summaryMessage, ...remaining];
    const estimatedTokens = estimator.estimateMessages(result);

    return {
      result,
      estimatedTokens,
      droppedSummary: `${removedCount} messages removed (~${removedTokens} tokens)`,
    };
  }

  /**
   * 检查消息是否包含工具调用
   */
  private hasToolCall(msg: Message): boolean {
    return msg.role === 'assistant' && msg.toolCalls !== undefined && msg.toolCalls.length > 0;
  }

  /**
   * 检查消息是否是工具结果
   */
  private isToolResult(msg: Message): boolean {
    return msg.role === 'tool' || (msg.toolResults !== undefined && msg.toolResults.length > 0);
  }
}
