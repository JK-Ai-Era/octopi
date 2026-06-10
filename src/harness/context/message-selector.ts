/**
 * DefaultMessageSelector — 默认消息选择器
 *
 * 四区域划分策略：
 * 1. 头部保护（protectFirstN）：永远保留的最早消息
 * 2. 尾部保护（protectLastN）：永远保留的最新消息
 * 3. 中间区域：可压缩/丢弃的消息
 * 4. 溢出区域：超出预算需要压缩的消息
 *
 * 边界对齐：不拆分 tool_call/tool_result 对。
 */

import type { Message } from '../../core/types.js';
import type {
  MessageSelector,
  SelectResult,
  SelectOptions,
  TokenEstimator,
} from '../../core/interfaces/context-engine.js';
import { HeuristicTokenEstimator } from './token-estimator.js';

export class DefaultMessageSelector implements MessageSelector {
  /**
   * 选择要保留的消息
   *
   * @param messages - 完整消息历史
   * @param options - 选择选项
   * @param tokenEstimator - Token 估算器（可选）
   * @returns 选择结果
   */
  select(
    messages: Message[],
    options: SelectOptions,
    tokenEstimator?: TokenEstimator,
  ): SelectResult {
    const estimator = tokenEstimator ?? new HeuristicTokenEstimator();
    const { maxTokens, protectFirstN, protectLastN } = options;

    // 空消息列表
    if (messages.length === 0) {
      return {
        kept: [],
        overflow: [],
        tail: [],
        tailTokens: 0,
        estimatedTokens: 0,
        overflowTokens: 0,
      };
    }

    // 1. 划分头部保护区域
    const headCount = Math.min(protectFirstN, messages.length);
    const headMessages = messages.slice(0, headCount);

    // 2. 划分尾部保护区域（排除头部已保护的）
    const remainingAfterHead = messages.slice(headCount);
    const tailCount = Math.min(protectLastN, remainingAfterHead.length);
    const tailMessages = remainingAfterHead.slice(-tailCount);

    // 3. 中间区域（可压缩/丢弃）
    const middleMessages = remainingAfterHead.slice(0, -tailCount);

    // 4. 计算各区域 token 数
    const headTokens = estimator.estimateMessages(headMessages);
    const tailTokens = estimator.estimateMessages(tailMessages);
    const middleTokens = estimator.estimateMessages(middleMessages);

    // 5. 计算可用预算
    const fixedTokens = headTokens + tailTokens;

    // 如果固定区域已超预算，需要截断尾部
    if (fixedTokens >= maxTokens) {
      // 尝试只保留头部
      if (headTokens >= maxTokens) {
        // 头部也超预算，返回空（理论上不应发生）
        return {
          kept: [],
          overflow: messages,
          tail: [],
          tailTokens: 0,
          estimatedTokens: headTokens + tailTokens + middleTokens,
          overflowTokens: headTokens + tailTokens + middleTokens,
        };
      }

      // 保留头部 + 部分尾部
      const availableForTail = maxTokens - headTokens;
      const selectedTail = this.selectByTokenBudget(tailMessages, availableForTail, estimator);

      return {
        kept: [...headMessages, ...selectedTail],
        overflow: middleMessages,
        tail: selectedTail,
        tailTokens: estimator.estimateMessages(selectedTail),
        estimatedTokens: headTokens + estimator.estimateMessages(selectedTail),
        overflowTokens: middleTokens + tailTokens - estimator.estimateMessages(selectedTail),
      };
    }

    // 6. 计算中间区域可用预算
    const middleBudget = maxTokens - fixedTokens;

    // 如果中间区域不需要压缩
    if (middleTokens <= middleBudget) {
      const kept = [...headMessages, ...middleMessages, ...tailMessages];
      return {
        kept,
        overflow: [],
        tail: tailMessages,
        tailTokens,
        estimatedTokens: headTokens + middleTokens + tailTokens,
        overflowTokens: 0,
      };
    }

    // 7. 中间区域需要压缩：从尾部开始保留（越新的越重要）
    const selectedMiddle = this.selectByTokenBudgetFromEnd(middleMessages, middleBudget, estimator);
    const selectedMiddleTokens = estimator.estimateMessages(selectedMiddle);

    const kept = [...headMessages, ...selectedMiddle, ...tailMessages];
    const overflow = middleMessages.slice(0, middleMessages.length - selectedMiddle.length);

    return {
      kept,
      overflow,
      tail: tailMessages,
      tailTokens,
      estimatedTokens: headTokens + selectedMiddleTokens + tailTokens,
      overflowTokens: middleTokens - selectedMiddleTokens,
    };
  }

  /**
   * 从头部开始选择消息，直到达到 token 预算
   *
   * 边界对齐：不拆分 tool_call/tool_result 对。
   */
  private selectByTokenBudget(
    messages: Message[],
    budget: number,
    estimator: TokenEstimator,
  ): Message[] {
    const selected: Message[] = [];
    let usedTokens = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgTokens = estimator.estimateMessage(msg);

      // 检查是否需要边界对齐
      if (this.isToolResult(msg) && i > 0) {
        // tool_result 消息必须和前面的 tool_call 消息一起保留
        const prevMsg = messages[i - 1];
        if (this.hasToolCall(prevMsg)) {
          // 确保 tool_call 已被选中
          const prevInSelected = selected.includes(prevMsg);
          if (!prevInSelected) {
            // tool_call 未被选中，跳过 tool_result
            continue;
          }
        }
      }

      if (usedTokens + msgTokens > budget && selected.length > 0) {
        break;
      }

      selected.push(msg);
      usedTokens += msgTokens;
    }

    return selected;
  }

  /**
   * 从尾部开始选择消息，直到达到 token 预算
   *
   * 边界对齐：不拆分 tool_call/tool_result 对。
   */
  private selectByTokenBudgetFromEnd(
    messages: Message[],
    budget: number,
    estimator: TokenEstimator,
  ): Message[] {
    const selected: Message[] = [];
    let usedTokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgTokens = estimator.estimateMessage(msg);

      // 边界对齐：如果这是 tool_call 消息，检查后面的 tool_result
      if (this.hasToolCall(msg) && i < messages.length - 1) {
        const nextMsg = messages[i + 1];
        if (this.isToolResult(nextMsg)) {
          // 确保 tool_result 已被选中
          const nextInSelected = selected.includes(nextMsg);
          if (!nextInSelected) {
            // tool_result 未被选中，跳过 tool_call
            continue;
          }
        }
      }

      if (usedTokens + msgTokens > budget && selected.length > 0) {
        break;
      }

      selected.unshift(msg);
      usedTokens += msgTokens;
    }

    return selected;
  }

  /**
   * 检查消息是否是工具结果
   */
  private isToolResult(msg: Message): boolean {
    return msg.role === 'tool' || (msg.toolResults !== undefined && msg.toolResults.length > 0);
  }

  /**
   * 检查消息是否包含工具调用
   */
  private hasToolCall(msg: Message): boolean {
    return msg.role === 'assistant' && msg.toolCalls !== undefined && msg.toolCalls.length > 0;
  }
}
