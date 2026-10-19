/**
 * HybridCompressor — 混合压缩器
 *
 * 三级压缩策略：
 * 1. 清除旧工具结果（>200 字符 → 占位符）- 无 LLM
 * 2. LLM 摘要（如果可用）
 * 3. 截断（兜底）
 *
 * 参考 OpenClaw 的智能路由 + Hermes 的四阶段压缩算法。
 */

import type { Message } from '@octopi-agent/core/types.js';
import { getTextContent } from '@octopi-agent/core/types.js';
import type {
  Compressor,
  CompressParams,
  CompressResult,
  TokenEstimator,
  SummarizeFunction,
} from './types.js';
import { HeuristicTokenEstimator } from './token-estimator.js';
import { LLMSummaryCompressor } from './llm-summarizer.js';
import { toolResultBody } from './tool-result-body.js';
import { TruncateCompressor } from './truncate-compressor.js';

/**
 * 工具结果截断阈值（字符数）
 */
const TOOL_RESULT_TRUNCATE_THRESHOLD = 200;

/**
 * 工具结果截断后的占位符（中性归档措辞——禁止诱导重跑）
 */
const TOOL_RESULT_PLACEHOLDER =
  '[Tool output archived in session log — do NOT re-run unless the output is needed again.]';

export class HybridCompressor implements Compressor {
  private llmCompressor: LLMSummaryCompressor;
  private truncateCompressor: TruncateCompressor;

  constructor() {
    this.llmCompressor = new LLMSummaryCompressor();
    this.truncateCompressor = new TruncateCompressor();
  }

  /**
   * 压缩消息
   *
   * 策略：
   * 1. 机械预处理（截断旧工具结果）——只作用于**丢弃体/机械路径**，不进 LLM 摘要输入
   * 2. 如果有摘要函数，对**原文**做 LLM 摘要（F-b：禁止先打码再摘要）
   * 3. 否则使用截断
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

    // 如果已经在预算内，不需要压缩。
    // requireSummary 除外：主动摘要路径的主交付是语义摘要，达标也必须继续到摘要级。
    if (currentTokens <= targetTokens && !params.requireSummary) {
      return {
        result: [...messages],
        estimatedTokens: currentTokens,
      };
    }

    // 机械预处理：仅给机械截断/残差用（F-b：不进摘要输入）
    const preprocessed = this.preprocessToolResults(messages);
    const preprocessedTokens = estimator.estimateMessages(preprocessed);

    // 如果预处理后已在预算内（requireSummary 时同样继续：机械截断不产出语义摘要）
    if (preprocessedTokens <= targetTokens && !params.requireSummary) {
      return {
        result: preprocessed,
        estimatedTokens: preprocessedTokens,
        droppedSummary: 'Old tool outputs truncated',
      };
    }

    // 第二级：LLM 摘要 —— 输入为原文（F-b）
    if (params.summarize) {
      try {
        const result = await this.llmCompressor.compress({
          ...params,
          messages,
        });
        return result;
      } catch (err) {
        // LLM 摘要失败，继续到截断
        console.warn('LLM summarization failed, falling back to truncation:', err);
      }
    }

    // 第三级：截断（兜底）——机械预处理后的丢弃体
    return this.truncateCompressor.compress({
      ...params,
      messages: preprocessed,
    });
  }

  /**
   * 预处理工具结果
   *
   * 清除旧的、冗长的工具输出：
   * - 超过阈值的工具结果 → 占位符
   * - 保留最近的工具结果（不截断）
   */
  private preprocessToolResults(messages: Message[]): Message[] {
    const result: Message[] = [];
    let lastToolCallIndex = -1;

    // 找到最后一个 tool_call 的位置
    for (let i = messages.length - 1; i >= 0; i--) {
      if (this.hasToolCall(messages[i])) {
        lastToolCallIndex = i;
        break;
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // 工具结果消息
      if (this.isToolResult(msg) && msg.toolResults) {
        // 最近的工具结果不截断
        const isRecent = i > lastToolCallIndex;

        if (isRecent) {
          result.push(msg);
          continue;
        }

        // 旧的工具结果：截断冗长的输出
        const truncatedResults = msg.toolResults.map(tr => {
          const body = toolResultBody(tr);
          if (body.length > TOOL_RESULT_TRUNCATE_THRESHOLD) {
            // error 永不打码（错误可追溯性优先，与 B2 同红线）；只截断成功结果
            if (tr.error !== undefined) {
              return tr;
            }
            return {
              ...tr,
              result: TOOL_RESULT_PLACEHOLDER,
            };
          }
          return tr;
        });

        result.push({
          ...msg,
          toolResults: truncatedResults,
        });
        continue;
      }

      result.push(msg);
    }

    return result;
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
