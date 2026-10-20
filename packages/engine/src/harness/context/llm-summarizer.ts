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

import type { Message } from '@octopi-agent/core/types.js';
import { getTextContent } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import type {
  Compressor,
  CompressParams,
  CompressResult,
  TokenEstimator,
  SummarizeFunction,
} from './types.js';
import { HeuristicTokenEstimator } from './token-estimator.js';
import { toolResultBody } from './tool-result-body.js';

/**
 * 工具调用账本（name+args 紧凑清单）——降级时的「做过什么」无损索引
 *
 * @param messages - 被降级丢弃的消息
 * @returns 账本文本（可为空串）
 */
export function buildToolCallLedger(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    for (const tc of msg.toolCalls ?? []) {
      let args: string;
      try {
        args = JSON.stringify(tc.arguments ?? {});
      } catch {
        args = '[unserializable]';
      }
      if (args.length > 160) args = `${args.slice(0, 160)}…`;
      lines.push(`- ${tc.name}(${args})`);
    }
    for (const tr of msg.toolResults ?? []) {
      if (tr.error !== undefined) {
        const err = tr.error.length > 120 ? `${tr.error.slice(0, 120)}…` : tr.error;
        lines.push(`  ! ${tr.name ?? tr.toolCallId}: ${err}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * 结构化摘要模板（F-d 硬约束：Done 逐条可核验 + 交接语防重做）
 */
const SUMMARY_TEMPLATE = `## Conversation Summary

> HANDOFF: Your working memory was compacted. First check Done/ToDo and the session task list (task_*). DO NOT redo work listed under Done.

### Goal
[What the user is trying to accomplish]

### Progress
#### Done
- [each item MUST be] what was done + artifact path(s) / exact identifiers
- ...

#### In Progress
[What is currently being worked on]

#### Blocked
[Any issues or blockers]

### Key Decisions
[Important technical decisions and reasons]

### Relevant Files
[Files read, modified, or created — absolute or workspace-relative paths]

### Next Steps
[What needs to be done next; align with task_* list when present]

### Key Context
[Specific values, error messages, configuration details]`;

/**
 * 摘要指令（缓存友好：只作 **user 尾部** 追加，绝不改写 system/历史）。
 * 规则与旧 SUMMARIZE_INSTRUCTION 对齐；模板不变。
 */
function buildSummarizeTailInstruction(params: {
  previousSummary?: string;
  maxTokens: number;
}): string {
  const header = params.previousSummary
    ? `You are updating an existing conversation summary. Merge the conversation above into the summary below.\n\nPrevious Summary:\n${params.previousSummary}`
    : `You are a conversation summarizer. Create a concise, structured summary of the conversation above.`;
  return `${header}

Rules:
1. Focus on factual information, not pleasantries
2. Preserve specific details (file paths, error messages, code snippets)
3. Use the exact structure provided in the template
4. If updating a previous summary, merge new information rather than replacing everything
5. Keep the summary under ${params.maxTokens} tokens
6. HARD: Every Done item must state what was completed AND the artifact path or exact identifier
7. HARD: Keep the HANDOFF line at the top unchanged in meaning — it prevents redoing finished work
8. HARD: Do not invent paths or claim work that is not evidenced in the history

Template:
${SUMMARY_TEMPLATE}`;
}

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

    // 如果已经在预算内，不需要压缩。
    // requireSummary 除外：调用方要求语义摘要，不能以机械返回冒充已摘要。
    if (currentTokens <= targetTokens && !params.requireSummary) {
      return {
        result: [...messages],
        estimatedTokens: currentTokens,
      };
    }

    // 计算摘要 token 预算
    const summaryTokens = this.calculateSummaryBudget(currentTokens);

    // 格式化消息为 LLM 可读的上下文（仅无 llmPrefix 时的旁路）
    const formattedContext = this.formatMessagesForSummary(messages);

    // 构建 LLM 消息
    // 缓存优先：llmPrefix（会话 system+history 同形）+ 尾部 user 指令。
    // 禁止改写 system / 重排历史——否则打穿 provider 前缀缓存。
    let llmMessages: LLMMessage[];
    if (params.llmPrefix && params.llmPrefix.length > 0) {
      llmMessages = [
        ...params.llmPrefix,
        {
          role: 'user',
          content: buildSummarizeTailInstruction({
            previousSummary,
            maxTokens: summaryTokens,
          }),
        },
      ];
    } else {
      llmMessages = [
        {
          role: 'system',
          content: buildSummarizeTailInstruction({ previousSummary, maxTokens: summaryTokens }),
        },
        { role: 'user', content: formattedContext },
      ];
    }

    try {
      // 调用 LLM 生成摘要
      const summary = await summarize(llmMessages, {
        previousSummary,
        maxTokens: summaryTokens,
      });

      // 空摘要（拒答/内容过滤）按失败处理：不得用空正文替换中间段、更不得冒充语义摘要
      if (!summary || !summary.trim()) {
        return this.fallbackTruncate(messages, targetTokens, estimator);
      }

      // 摘要用 user 角色：中段 system 会被部分网关拒绝
      const summaryMessage: Message = {
        role: 'user',
        content: `[Conversation Summary]\n\n${summary}`,
        timestamp: Date.now(),
        metadata: { source: 'contextSummary' as const },
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
   *
   * 归因保留（模型 2）：多 agent 共线的摘要不得张冠李戴
   * （惯例出处 session/history/port.ts renderMessage 的 role(agentId)；此处大写仅排版差异）。
   */
  private formatMessagesForSummary(messages: Message[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      const role = msg.agentId ? `${msg.role.toUpperCase()}(${msg.agentId})` : msg.role.toUpperCase();
      const content = getTextContent(msg.content ?? '');

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // 带工具调用的 assistant 消息
        const toolCallsStr = msg.toolCalls
          .map(tc => `  - ${tc.name}(${JSON.stringify(tc.arguments)})`)
          .join('\n');
        parts.push(`[${role}]\n${content}\nTool Calls:\n${toolCallsStr}`);
      } else if (msg.role === 'tool' && msg.toolResults?.length) {
        // 工具结果消息（含 error，避免摘要丢失失败信息）
        const resultsStr = msg.toolResults
          .map(tr => `  - ${tr.name}: ${toolResultBody(tr)}`)
          .join('\n');
        parts.push(`[${role}]\nTool Results:\n${resultsStr}`);
      } else if (content) {
        parts.push(`[${role}]\n${content}`);
      }
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * 回退截断（当 LLM 摘要不可用时）——保守降级
   *
   * 作为 **middle 替换体**：账本说明 + 近尾若干条。
   * 外层 head/tail 由调用方（applyProactiveCompact）拼接，此处不得重复携带。
   */
  private fallbackTruncate(
    messages: Message[],
    _targetTokens: number,
    estimator: TokenEstimator,
  ): CompressResult {
    // 近尾保留工具步上下文；更早的换成「账本」——禁止只留 4 条且无索引
    const keepCount = Math.min(Math.max(6, Math.ceil(messages.length * 0.15)), messages.length);
    const kept = messages.slice(-keepCount);
    const dropped = messages.slice(0, messages.length - keepCount);

    // 无可丢弃：原样返回（禁止用「0 removed」假通知撑长视图）
    if (dropped.length === 0) {
      return {
        result: [...messages],
        estimatedTokens: estimator.estimateMessages(messages),
      };
    }

    const ledger = buildToolCallLedger(dropped);
    const notice = ledger
      ? `[Context truncated: ${dropped.length} earlier messages removed to fit context window]\n[Tool call ledger — do NOT redo these unless explicitly asked]\n${ledger}\n[Check session task list via task_* before continuing]`
      : `[Context truncated: ${dropped.length} earlier messages removed to fit context window]\n[Check session task list via task_* before continuing]`;

    // 插入截断说明（user 角色，避免中段 system）
    const summaryMessage: Message = {
      role: 'user',
      content: notice,
      timestamp: Date.now(),
      metadata: { source: 'contextSummary' as const },
    };

    const result = [summaryMessage, ...kept];
    const estimatedTokens = estimator.estimateMessages(result);

    return {
      result,
      estimatedTokens,
      droppedSummary: `${dropped.length} messages truncated`,
    };
  }
}
