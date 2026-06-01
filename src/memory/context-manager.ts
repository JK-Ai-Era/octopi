import type { ContextWindow, Message } from '../core/types.js';

/**
 * 上下文管理器
 *
 * 职责：
 * - 将 session 上下文转换为 LLM 消息格式
 * - 管理 token 预算，动态裁剪对话历史
 * - 注入记忆上下文
 */
export class ContextManager {
  /**
   * 构建发送给 LLM 的消息数组
   */
  buildMessages(context: ContextWindow): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    // 1. 系统 prompt
    if (context.systemPrompt) {
      messages.push({ role: 'system', content: context.systemPrompt });
    }

    // 2. 注入记忆上下文（如果有的话，拼接到 system prompt 之后）
    if (context.memoryContext) {
      messages.push({
        role: 'system',
        content: `[记忆上下文]\n${context.memoryContext}`,
      });
    }

    // 3. 对话历史（可能需要裁剪）
    const historyMessages = this.trimMessages(
      context.messages,
      context.maxTokens,
    );

    for (const msg of historyMessages) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    return messages;
  }

  /**
   * 裁剪消息以适配 token 预算
   *
   * 策略：保留最近的消息，丢弃最早的
   * TODO: 后续可以实现摘要压缩
   */
  private trimMessages(messages: Message[], maxTokens: number): Message[] {
    const estimatedTokensPerChar = 0.3; // 粗略估算
    let totalTokens = 0;
    const result: Message[] = [];

    // 从后往前遍历，保留最近的消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgTokens = msg.content.length * estimatedTokensPerChar;
      if (totalTokens + msgTokens > maxTokens * 0.8) {
        // 留 20% 给响应
        break;
      }
      totalTokens += msgTokens;
      result.unshift(msg);
    }

    return result;
  }

  /**
   * 估算文本的 token 数（粗略）
   */
  estimateTokens(text: string): number {
    // 中文约 1.5 token/字，英文约 0.75 token/word
    // 粗略取 1 token/字符
    return Math.ceil(text.length * 1);
  }
}
