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

import type { Message } from '@octopi-agent/core/types.js';
import type {
  MessageSelector,
  SelectResult,
  SelectOptions,
  TokenEstimator,
} from './types.js';
import { HeuristicTokenEstimator } from './token-estimator.js';
import { hasToolCall, isToolResultMessage } from './capabilities/compact/messages.js';

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

    // 度量视图（可选）：与 messages 等长同序，仅用于估算；切分仍按原文。
    // 不传时退化为原行为（量原文）。
    const measure = options.measureMessages ?? messages;

    /**
     * 估算字节区间 [start, end) 的 token 数（按度量视图的同下标取值）
     */
    const estimateRange = (start: number, end: number): number => {
      let tokens = 0;
      for (let i = start; i < end; i++) {
        tokens += estimator.estimateMessage(measure[i] ?? messages[i]!);
      }
      return tokens;
    };

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
    const headCount = Math.max(0, Math.min(protectFirstN, messages.length));
    const headMessages = messages.slice(0, headCount);

    // 2. 划分尾部保护区域（排除头部已保护的）
    const remainingAfterHead = messages.slice(headCount);
    const tailCount = Math.min(protectLastN, remainingAfterHead.length);
    // slice(-0)===slice(0) 返回全量、slice(0,-0) 返回空：tailCount=0 时必须显式取空/全量
    const tailMessages = tailCount > 0 ? remainingAfterHead.slice(-tailCount) : [];

    // 3. 中间区域（可压缩/丢弃）
    const middleMessages = tailCount > 0 ? remainingAfterHead.slice(0, -tailCount) : remainingAfterHead;

    // 4. 计算各区域 token 数（按度量视图；区域下标以原文为准）
    const headTokens = estimateRange(0, headCount);
    const tailStartIdx = messages.length - tailMessages.length;
    const tailTokens = estimateRange(tailStartIdx, messages.length);
    const middleTokens = estimateRange(headCount, tailStartIdx);

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
      const selectedTail = this.selectByTokenBudget(
        tailMessages,
        availableForTail,
        estimator,
        measure.slice(tailStartIdx),
      );

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
    const selectedMiddle = this.selectByTokenBudgetFromEnd(
      middleMessages,
      middleBudget,
      estimator,
      measure.slice(headCount, tailStartIdx),
    );
    // 选中段可能因配对对齐而不连续（跳过孤立 tool_call/result），
    // 所以按成员精确累加，不能用「长度差」推算起点。
    const selectedMiddleSet = new Set(selectedMiddle);
    let selectedMiddleTokens = 0;
    for (let i = headCount; i < tailStartIdx; i++) {
      const m = messages[i];
      if (selectedMiddleSet.has(m)) {
        selectedMiddleTokens += estimator.estimateMessage(measure[i] ?? m);
      }
    }

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
   *
   * @param messages - 候选消息（原文）
   * @param budget - token 预算
   * @param estimator - 估算器
   * @param measure - 与 messages 等长同序的度量视图（省略时量原文）
   */
  private selectByTokenBudget(
    messages: Message[],
    budget: number,
    estimator: TokenEstimator,
    measure?: Message[],
  ): Message[] {
    const selected: Message[] = [];
    const selectedSet = new Set<Message>();
    let usedTokens = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgTokens = estimator.estimateMessage(measure?.[i] ?? msg);

      // 检查是否需要边界对齐
      if (isToolResultMessage(msg) && i > 0) {
        // tool_result 消息必须和前面的 tool_call 消息一起保留
        const prevMsg = messages[i - 1];
        if (hasToolCall(prevMsg)) {
          // 确保 tool_call 已被选中
          const prevInSelected = selectedSet.has(prevMsg);
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
      selectedSet.add(msg);
      usedTokens += msgTokens;
    }

    return selected;
  }

  /**
   * 从尾部开始选择消息，直到达到 token 预算
   *
   * 边界对齐：不拆分 tool_call/tool_result 对。
   *
   * @param messages - 候选消息（原文）
   * @param budget - token 预算
   * @param estimator - 估算器
   * @param measure - 与 messages 等长同序的度量视图（省略时量原文）
   */
  private selectByTokenBudgetFromEnd(
    messages: Message[],
    budget: number,
    estimator: TokenEstimator,
    measure?: Message[],
  ): Message[] {
    const selected: Message[] = [];
    const selectedSet = new Set<Message>();
    let usedTokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgTokens = estimator.estimateMessage(measure?.[i] ?? msg);

      // 边界对齐：如果这是 tool_call 消息，检查后面的 tool_result
      if (hasToolCall(msg) && i < messages.length - 1) {
        const nextMsg = messages[i + 1];
        if (isToolResultMessage(nextMsg)) {
          // 确保 tool_result 已被选中
          const nextInSelected = selectedSet.has(nextMsg);
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
      selectedSet.add(msg);
      usedTokens += msgTokens;
    }

    return selected;
  }

}
