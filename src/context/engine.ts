/**
 * Legacy Context Engine — 默认的上下文引擎
 *
 * 这是框架内置的简单上下文引擎，实现基本的消息裁剪和 token 估算。
 * 生产环境应替换为更智能的引擎（如基于向量检索的 RAG 引擎）。
 *
 * 4 阶段生命周期：
 * - ingest: no-op（session manager 直接处理消息持久化）
 * - assemble: 按 token budget 从尾部裁剪消息
 * - compact: no-op（不自己压缩，委托给运行时）
 * - afterTurn: no-op
 *
 * TODO: 未来可以扩展为支持：
 * - 消息摘要（compact 时将旧消息压缩为摘要）
 * - 重要性排序（不是简单从尾部裁剪，而是保留重要消息）
 * - 系统提示词动态注入（根据对话阶段调整 system prompt）
 */

import type { ContextEngine, ContextEngineInfo, Message, AssembleResult, CompactResult, Turn } from '../core/types.js';

/**
 * Legacy Context Engine
 *
 * 最简单的上下文引擎实现。消息按时间顺序从尾部裁剪，
 * 保证最新的消息优先保留。
 */
export class LegacyContextEngine implements ContextEngine {
  info: ContextEngineInfo = {
    id: 'legacy',
    name: 'Legacy Context Engine',
    ownsCompaction: false, // 不自己管理压缩
  };

  /**
   * 阶段 1：新消息到达
   *
   * Legacy 引擎不做额外处理，消息持久化由 SessionManager 负责。
   */
  async ingest(_params: { sessionId: string; message: Message }): Promise<void> {
    // no-op — session manager 直接处理消息持久化
  }

  /**
   * 阶段 2：组装上下文
   *
   * 将消息列表转换为 LLM 可理解的格式，并按 token budget 裁剪。
   * 裁剪策略：从最新消息向前保留，直到达到 budget 的 80%。
   *
   * @param sessionId - session ID
   * @param messages - 完整消息列表
   * @param tokenBudget - token 预算
   * @param availableTools - 可用工具列表（暂未使用）
   * @returns 裁剪后的消息列表和 token 估算
   */
  async assemble(params: {
    sessionId: string;
    messages: Message[];
    tokenBudget: number;
    availableTools: string[];
  }): Promise<AssembleResult> {
    const { messages, tokenBudget } = params;

    // 裁剪消息以适配 token 预算
    const trimmed = this.trimMessages(messages, tokenBudget);

    // 转换为 LLM 消息格式
    return {
      messages: trimmed.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls && { tool_calls: m.toolCalls }),
      })),
      estimatedTokens: this.estimateTokens(trimmed),
    };
  }

  /**
   * 阶段 3：压缩上下文
   *
   * Legacy 引擎不自己压缩，返回 compacted: false。
   * 运行时可以根据返回值决定是否触发外部压缩逻辑。
   */
  async compact(params: { sessionId: string; force: boolean }): Promise<CompactResult> {
    return { ok: true, compacted: false };
  }

  /**
   * 阶段 4：一轮完成
   *
   * Legacy 引擎不做额外处理。
   */
  async afterTurn(_params: { sessionId: string; turn: Turn }): Promise<void> {
    // no-op
  }

  // ================================================================
  // 内部方法
  // ================================================================

  /**
   * 裁剪消息列表
   *
   * 策略：从最新消息向前保留，直到达到 token budget 的 80%。
   * 这保证了最新的对话上下文优先保留。
   *
   * TODO: 改进裁剪策略：
   * - 保留 system 消息（永远不裁剪）
   * - 保留第一条 user 消息（提供对话起点）
   * - 对 tool 消息进行摘要
   */
  private trimMessages(messages: Message[], maxTokens: number): Message[] {
    let totalTokens = 0;
    const result: Message[] = [];

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgTokens = this.estimateTokens([msg]);
      if (totalTokens + msgTokens > maxTokens * 0.8) break;
      totalTokens += msgTokens;
      result.unshift(msg);
    }

    return result;
  }

  /**
   * 估算消息的 token 数
   *
   * 简单估算：1 个中文字符 ≈ 1 token，1 个英文单词 ≈ 1 token。
   * 生产环境应使用 tiktoken 等精确计算库。
   */
  private estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length * 1), 0);
  }
}
