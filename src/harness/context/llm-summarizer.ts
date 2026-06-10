/**
 * LLMSummaryCompressor — LLM 摘要压缩器
 *
 * 使用 LLM 生成结构化摘要，保留关键信息。
 * 支持迭代式更新：传入上次摘要，LLM 更新而非重建。
 *
 * 摘要策略：
 * 1. 将消息格式化为上下文
 * 2. 调用 LLM 生成结构化摘要
 * 3. 摘要 token 预算：contentTokens × 0.20（上下限：2000 - 12000）
 */

import type { Message } from '../../core/types.js';
import { getTextContent } from '../../core/types.js';
import type { LLMMessage } from '../../core/interfaces/model-provider.js';
import type {
  Compressor,
  CompressParams,
  CompressResult,
  TokenEstimator,
  SummarizeFunction,
} from '../../core/interfaces/context-engine.js';
import { HeuristicTokenEstimator } from './token-estimator.js';

/**
 * 结构化摘要模板
 */
const SUMMARY_TEMPLATE = `## Conversation Summary

### Goal
[What the user is trying to accomplish]

### Progress
#### Completed
[What has been completed]

#### In Progress
[What is currently being worked on]

#### Blocked
[Any issues or blockers]

### Key Decisions
[Important technical decisions and reasons]

### Relevant Files
[Files read, modified, or created]

### Next Steps
[What needs to be done next]

### Key Context
[Specific values, error messages, configuration details]`;

/**
 * 摘要指令
 */
const SUMMARIZE_INSTRUCTION = `You are a conversation summarizer. Your task is to create a concise, structured summary of the conversation history.

Rules:
1. Focus on factual information, not pleasantries
2. Preserve specific details (file paths, error messages, code snippets)
3. Use the exact structure provided in the template
4. If updating a previous summary, merge new information rather than replacing everything
5. Keep the summary under {maxTokens} tokens

Template:
${SUMMARY_TEMPLATE}`;

const UPDATE_INSTRUCTION = `You are updating an existing conversation summary. The previous summary is provided below, along with new conversation messages.

Rules:
1. Merge new information into the existing summary
2. Remove outdated information
3. Preserve the structure
4. Keep the summary under {maxTokens} tokens

Previous Summary:
{previousSummary}`;

export class LLMSummaryCompressor implements Compressor {
  /**
   * 压缩消息
   *
   * 策略：
   * 1. 将消息格式化为 LLM 可读的上下文
   * 2. 调用 LLM 生成摘要
   * 3. 返回摘要作为压缩结果
   */
  async compress(params: CompressParams): Promise<CompressResult> {
    const { messages, targetTokens, previousSummary, summarize, tokenEstimator } = params;
    const estimator = tokenEstimator ?? new HeuristicTokenEstimator();

    // 如果没有摘要函数，返回截断结果
    if (!summarize) {
      return this.fallbackTruncate(messages, targetTokens, estimator);
    }

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

    // 计算摘要 token 预算
    const summaryTokens = this.calculateSummaryBudget(currentTokens);

    // 格式化消息为 LLM 可读的上下文
    const formattedContext = this.formatMessagesForSummary(messages);

    // 构建 LLM 消息
    const llmMessages: LLMMessage[] = [];

    // 系统指令
    if (previousSummary) {
      llmMessages.push({
        role: 'system',
        content: UPDATE_INSTRUCTION
          .replace('{previousSummary}', previousSummary)
          .replace('{maxTokens}', String(summaryTokens)),
      });
    } else {
      llmMessages.push({
        role: 'system',
        content: SUMMARIZE_INSTRUCTION.replace('{maxTokens}', String(summaryTokens)),
      });
    }

    // 用户消息（要摘要的内容）
    llmMessages.push({
      role: 'user',
      content: formattedContext,
    });

    try {
      // 调用 LLM 生成摘要
      const summary = await summarize(llmMessages, {
        previousSummary,
        maxTokens: summaryTokens,
      });

      // 创建摘要消息
      const summaryMessage: Message = {
        role: 'system',
        content: `[Conversation Summary]\n\n${summary}`,
        timestamp: Date.now(),
      };

      // 估算摘要 token 数
      const summaryMessageTokens = estimator.estimateMessage(summaryMessage);

      return {
        result: [summaryMessage],
        estimatedTokens: summaryMessageTokens,
        droppedSummary: `Conversation compressed from ${currentTokens} to ~${summaryMessageTokens} tokens`,
      };
    } catch (err) {
      // LLM 摘要失败，回退到截断
      console.warn('LLM summarization failed, falling back to truncation:', err);
      return this.fallbackTruncate(messages, targetTokens, estimator);
    }
  }

  /**
   * 计算摘要 token 预算
   *
   * 公式：contentTokens × 0.20
   * 上下限：2000 - 12000
   */
  private calculateSummaryBudget(contentTokens: number): number {
    const budget = Math.floor(contentTokens * 0.20);
    return Math.max(2000, Math.min(12000, budget));
  }

  /**
   * 格式化消息为 LLM 可读的上下文
   */
  private formatMessagesForSummary(messages: Message[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      const content = getTextContent(msg.content);

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // 带工具调用的 assistant 消息
        const toolCallsStr = msg.toolCalls
          .map(tc => `  - ${tc.name}(${JSON.stringify(tc.arguments)})`)
          .join('\n');
        parts.push(`[${role}]\n${content}\nTool Calls:\n${toolCallsStr}`);
      } else if (msg.role === 'tool' && msg.toolResults?.length) {
        // 工具结果消息
        const resultsStr = msg.toolResults
          .map(tr => `  - ${tr.name}: ${typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result)}`)
          .join('\n');
        parts.push(`[${role}]\nTool Results:\n${resultsStr}`);
      } else if (content) {
        parts.push(`[${role}]\n${content}`);
      }
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * 回退截断（当 LLM 摘要不可用时）
   */
  private fallbackTruncate(
    messages: Message[],
    targetTokens: number,
    estimator: TokenEstimator,
  ): CompressResult {
    // 简单截断：保留最后几条消息
    const keepCount = Math.min(4, messages.length);
    const kept = messages.slice(-keepCount);
    const keptTokens = estimator.estimateMessages(kept);

    // 插入截断说明
    const summaryMessage: Message = {
      role: 'system',
      content: `[Context truncated: ${messages.length - keepCount} earlier messages removed to fit context window]`,
      timestamp: Date.now(),
    };

    const result = [summaryMessage, ...kept];
    const estimatedTokens = estimator.estimateMessages(result);

    return {
      result,
      estimatedTokens,
      droppedSummary: `${messages.length - keepCount} messages truncated`,
    };
  }
}
