import type { ContextEngine, ContextEngineInfo, Message, AssembleResult, CompactResult, Turn } from '../core/types.js';

/**
 * Legacy Context Engine — 默认的上下文引擎
 *
 * 参考 OpenClaw 的 legacy 引擎设计：
 * - Ingest: no-op（session manager 直接处理）
 * - Assemble: 透传（消息按 token budget 裁剪）
 * - Compact: 委托给内置压缩
 * - AfterTurn: no-op
 */
export class LegacyContextEngine implements ContextEngine {
  info: ContextEngineInfo = {
    id: 'legacy',
    name: 'Legacy Context Engine',
    ownsCompaction: false,
  };

  async ingest(_params: { sessionId: string; message: Message }): Promise<void> {
    // no-op — session manager 直接处理消息持久化
  }

  async assemble(params: {
    sessionId: string;
    messages: Message[];
    tokenBudget: number;
    availableTools: string[];
  }): Promise<AssembleResult> {
    const { messages, tokenBudget } = params;

    // 裁剪消息以适配 token 预算
    const trimmed = this.trimMessages(messages, tokenBudget);

    return {
      messages: trimmed.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls && { tool_calls: m.toolCalls }),
      })),
      estimatedTokens: this.estimateTokens(trimmed),
    };
  }

  async compact(params: { sessionId: string; force: boolean }): Promise<CompactResult> {
    // Legacy 引擎不自己压缩，委托给运行时
    return { ok: true, compacted: false };
  }

  async afterTurn(_params: { sessionId: string; turn: Turn }): Promise<void> {
    // no-op
  }

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

  private estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length * 1), 0);
  }
}
