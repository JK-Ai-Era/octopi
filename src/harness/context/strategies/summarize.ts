/**
 * Context 压缩策略 — 摘要压缩
 *
 * 用 LLM 总结历史消息，保留关键信息。
 * 适用于长对话场景。
 */

import type { Message } from '../../../core/types.js';
import type { ModelProvider, LLMRequest } from '../../../core/interfaces/model-provider.js';

/** 摘要策略配置 */
export interface SummarizeConfig {
  /** 保留最近的消息数量 */
  preserveRecent: number;
  /** 最大 token 数 */
  maxTokens?: number;
  /** 摘要提示词 */
  summaryPrompt?: string;
}

/**
 * 摘要压缩策略
 *
 * 用 LLM 总结历史消息，保留最近的消息。
 */
export async function summarize(
  messages: Message[],
  provider: ModelProvider,
  config: SummarizeConfig
): Promise<Message[]> {
  const { preserveRecent, summaryPrompt } = config;

  if (messages.length <= preserveRecent) {
    return messages;
  }

  // 分离系统消息和普通消息
  const systemMessages = messages.filter(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');

  // 分离需要总结的和需要保留的
  const toSummarize = otherMessages.slice(0, -preserveRecent);
  const toKeep = otherMessages.slice(-preserveRecent);

  if (toSummarize.length === 0) {
    return messages;
  }

  // 构建摘要请求
  const prompt = summaryPrompt ?? '请用简洁的语言总结以下对话历史，保留关键信息。输出纯文本摘要，不要添加任何格式。';

  const request: LLMRequest = {
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: formatMessagesForSummary(toSummarize) },
    ],
    maxTokens: 500,
  };

  try {
    const response = await provider.chat(request);
    const summary = response.content;

    // 组合：系统消息 + 摘要 + 最近消息
    return [
      ...systemMessages,
      { role: 'system', content: `[对话历史摘要]\n${summary}`, timestamp: Date.now() },
      ...toKeep,
    ];
  } catch (error) {
    // 摘要失败时回退到滑动窗口
    console.warn('[SummarizeStrategy] Summary failed, falling back to keeping recent messages:', error);
    return [...systemMessages, ...toKeep];
  }
}

/**
 * 格式化消息用于摘要
 */
function formatMessagesForSummary(messages: Message[]): string {
  return messages
    .map(m => {
      const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role;
      return `${role}: ${m.content}`;
    })
    .join('\n');
}

/**
 * 创建摘要压缩器
 */
export function createSummarizeCompressor(provider: ModelProvider, config: SummarizeConfig) {
  return (messages: Message[]) => summarize(messages, provider, config);
}
