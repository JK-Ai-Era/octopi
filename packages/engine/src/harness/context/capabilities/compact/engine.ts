/**
 * Compact 引擎 — 头尾保护 + 中间段摘要 + 截断兜底
 *
 * 会话 E4 状态与 Session 持久化不在此域。
 *
 * @module harness/context/capabilities/compact/engine
 */

import type { Message } from '@octopi-agent/core/types.js';
import { getTextContent } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import { HeuristicTokenEstimator } from '../../token-estimator.js';
import { buildPolicyRegistry } from '../summary/resolver.js';
import { buildSystemPrompt } from '../summary/executor.js';
import type { ContentUnit, SummaryPolicy } from '../summary/types.js';
import type {
  CompactEngine,
  CompactMode,
  CompactOptions,
  CompactOutcome,
  CompactTokenEstimator,
  CreateCompactEngineOptions,
} from './types.js';

function defaultEstimator(): CompactTokenEstimator {
  const e = new HeuristicTokenEstimator();
  return {
    estimateMessages: (m) => e.estimateMessages(m),
    estimateText: (t) => e.estimateText(t),
  };
}

/** 中段摘要任务（summaryPort 与 summarizeFn 两路共用，保持指令对称） */
const MIDDLE_SEGMENT_TASK =
  'Summarize conversation middle segment: goal, progress, decisions, blockers, next steps, key values.';

function formatMessagesAsText(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    // 归因保留（模型 2）：多 agent 共线的摘要不得张冠李戴
    // （惯例出处 session/history/port.ts renderMessage 的 role(agentId)；此处大写+方括号仅排版差异）
    const role = msg.agentId ? `${msg.role.toUpperCase()}(${msg.agentId})` : msg.role.toUpperCase();
    const content = getTextContent(msg.content);
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const calls = msg.toolCalls
        .map((tc) => `  - ${tc.name}(${JSON.stringify(tc.arguments)})`)
        .join('\n');
      parts.push(`[${role}]\n${content}\nTool Calls:\n${calls}`);
    } else if (msg.role === 'tool' && msg.toolResults?.length) {
      const results = msg.toolResults
        .map((tr) => {
          const body =
            tr.error !== undefined
              ? JSON.stringify({ error: tr.error })
              : typeof tr.result === 'string'
                ? tr.result
                : JSON.stringify(tr.result ?? null);
          return `  - ${tr.name}: ${body}`;
        })
        .join('\n');
      parts.push(`[${role}]\nTool Results:\n${results}`);
    } else if (content) {
      parts.push(`[${role}]\n${content}`);
    }
  }
  return parts.join('\n\n---\n\n');
}

function asSummaryMessage(summary: string): Message {
  const body = summary.includes('[Conversation Summary]')
    ? summary
    : `[Conversation Summary]\n\n${summary}`;
  return {
    role: 'user',
    content: body,
    timestamp: Date.now(),
    metadata: { source: 'contextSummary' as const },
  };
}

/**
 * 创建 CompactEngine
 *
 * @param options - 缺省 protect / port / estimator
 * @returns CompactEngine
 */
export function createCompactEngine(options?: CreateCompactEngineOptions): CompactEngine {
  const defaults = {
    protectHead: options?.defaultProtectHead ?? 3,
    protectTail: options?.defaultProtectTail ?? 20,
    targetTokens: options?.defaultTargetTokens,
    mode: (options?.defaultMode ?? 'structure_only') as CompactMode,
  };

  async function summarizeMiddle(
    middleText: string,
    middleMessages: Message[],
    opts: CompactOptions,
    maxTokens: number,
  ): Promise<{ summary?: string; coverage?: CompactOutcome['coverage']; error?: string }> {
    const port = opts.summaryPort ?? options?.summaryPort;
    const summarizeFn = opts.summarizeFn;
    const registry = buildPolicyRegistry();
    let policy: SummaryPolicy = registry['conversation_default']!;
    if (typeof opts.summarizePolicy === 'string' && registry[opts.summarizePolicy]) {
      policy = registry[opts.summarizePolicy]!;
    } else if (opts.summarizePolicy && typeof opts.summarizePolicy === 'object') {
      policy = opts.summarizePolicy;
    }

    // 中段文本化为空（消息全无正文无工具）：不发空摘要请求——空 user / 空 New content
    // 过不了严格网关，且会让模型凭空产出；按摘要失败降级（onSummarizeFail 接管）
    if (!middleText.trim()) {
      return { error: 'empty_middle' };
    }

    if (port) {
      const unit: ContentUnit = {
        text: middleText,
        structured: middleMessages,
        channel: 'pipeline',
        source: {},
        kind: 'conversation',
        policy: opts.summarizePolicy,
        task: MIDDLE_SEGMENT_TASK,
      };
      try {
        const r = await port.extract(unit, {
          signal: opts.signal,
          previousSummary: opts.previousSummary,
        });
        return { summary: r.text, coverage: r.coverage };
      } catch (err) {
        // 只吞 port.extract 的抛错（摘要器契约外失败：provider 报错/超时）——转 error
        // 通道交给 onSummarizeFail 降级；try 内无其他可抛代码，无其他路径可至此
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (summarizeFn) {
      // 缓存优先：llmPrefix（会话同形 system+history）+ 尾部 user 指令。
      // 禁止把指令塞进 system 或重排历史——否则打穿前缀缓存。
      // 无 llmPrefix 时回退「policy system + 文本化中段」（旁路/旧调用）。
      let llmMessages: LLMMessage[];
      if (opts.llmPrefix && opts.llmPrefix.length > 0) {
        const tail = opts.previousSummary
          ? `${buildSystemPrompt(policy, MIDDLE_SEGMENT_TASK, maxTokens)}\n\nPrevious summary:\n${opts.previousSummary}`
          : buildSystemPrompt(policy, MIDDLE_SEGMENT_TASK, maxTokens);
        llmMessages = [
          ...opts.llmPrefix,
          { role: 'user', content: tail },
        ];
      } else {
        // 摘要请求 = policy 指令 + 文本化中段（单条 user），不把原始消息序列当对话发出：
        // tool_call-only assistant / 缺 tool_call_id 的 tool 消息会被严格网关 400。
        const system = buildSystemPrompt(policy, MIDDLE_SEGMENT_TASK, maxTokens);
        const userContent = opts.previousSummary
          ? `Previous summary:\n${opts.previousSummary}\n\n---\n\nNew content:\n${middleText}`
          : middleText;
        llmMessages = [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ];
      }
      try {
        const text = await summarizeFn(llmMessages, {
          previousSummary: opts.previousSummary,
          maxTokens: opts.maxSummaryTokens ?? maxTokens,
        });
        return { summary: text, coverage: 'full' };
      } catch (err) {
        // 只吞 summarizeFn 的抛错（provider 报错/超时）——转 error 通道交给 onSummarizeFail 降级
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    return { error: 'no_summarizer' };
  }

  async function compactCore(
    items: Message[] | string,
    opts: CompactOptions,
  ): Promise<CompactOutcome> {
    const isMessages = Array.isArray(items);
    const messages = isMessages ? items : [];
    const text = isMessages ? formatMessagesAsText(items) : items;
    const estimator = opts.estimator ?? options?.estimator ?? defaultEstimator();
    const tokensBefore = isMessages
      ? estimator.estimateMessages(messages)
      : estimator.estimateText(text);

    const protectHead = opts.protectHead ?? defaults.protectHead;
    const protectTail = opts.protectTail ?? defaults.protectTail;
    const mode = opts.mode ?? defaults.mode;
    const targetTokens = opts.targetTokens ?? defaults.targetTokens;
    const onFail = opts.onSummarizeFail ?? 'truncate';

    const unitCount = isMessages ? messages.length : 1;
    if (unitCount === 0 || (isMessages && messages.length === 0) || (!isMessages && !text.trim())) {
      return { ok: true, compacted: false, reason: 'empty', tokensBefore, view: items, summary: opts.previousSummary };
    }

    // 已在目标内且非 force 语义：mode auto 时跳过
    if (mode === 'auto' && targetTokens != null && tokensBefore <= targetTokens) {
      return { ok: true, compacted: false, reason: 'within_target', tokensBefore, view: items, summary: opts.previousSummary };
    }

    opts.emit?.({ type: 'compact.start', reason: mode });

    if (mode === 'head_tail_only') {
      if (!isMessages) {
        const headChars = Math.floor(text.length * 0.2);
        const tailChars = Math.floor(text.length * 0.2);
        const view = `${text.slice(0, headChars)}\n\n[middle removed]\n\n${text.slice(-tailChars)}`;
        return {
          ok: true,
          compacted: true,
          reason: 'head_tail_only',
          tokensBefore,
          tokensAfter: estimator.estimateText(view),
          view,
          droppedSummary: 'middle removed without LLM',
        };
      }
      if (messages.length <= protectHead + protectTail) {
        return { ok: true, compacted: false, reason: 'too_short', tokensBefore, view: messages };
      }
      const head = messages.slice(0, protectHead);
      const tail = messages.slice(-protectTail);
      const dropped = messages.length - head.length - tail.length;
      const placeholder = asSummaryMessage(`[Structural compact] dropped ${dropped} middle messages (head_tail_only)`);
      const view = [...head, placeholder, ...tail];
      return {
        ok: true,
        compacted: true,
        reason: 'head_tail_only',
        tokensBefore,
        tokensAfter: estimator.estimateMessages(view),
        summary: placeholder.content as string,
        view,
        droppedSummary: `${dropped} messages removed without LLM`,
      };
    }

    if (mode === 'summary_only') {
      const maxTokens = opts.maxSummaryTokens ?? Math.max(200, Math.floor(tokensBefore * 0.2));
      const summarized = await summarizeMiddle(text, messages, opts, maxTokens);
      if (!summarized.summary) {
        if (onFail === 'keep_partial' && opts.previousSummary && isMessages) {
          const view = [asSummaryMessage(opts.previousSummary), ...messages.slice(-protectTail)];
          return { ok: true, compacted: true, reason: 'partial', tokensBefore, summary: opts.previousSummary, view };
        }
        if (isMessages) {
          const view = messages.slice(-Math.max(protectTail, 4));
          return {
            ok: true,
            compacted: true,
            reason: 'summarize_failed_truncate',
            tokensBefore,
            tokensAfter: estimator.estimateMessages(view),
            // 摘要失败时旧摘要仍有效：summary 字段保留之（与 structure_only 失败兜底同款）
            summary: opts.previousSummary,
            view,
            droppedSummary: 'middle dropped; summarizer unavailable',
          };
        }
        const view = text.slice(0, 500);
        return {
          ok: true,
          compacted: true,
          reason: 'summarize_failed_truncate',
          tokensBefore,
          summary: opts.previousSummary,
          view,
        };
      }
      // 摘要即完整更新（previousSummary 已随 prompt 交给 summarizeFn 合并；
      // 与 LLMSummaryCompressor / summary executor 同一「迭代式更新」契约），不得再事后拼接
      const summary = summarized.summary;
      if (!isMessages) {
        return {
          ok: true,
          compacted: true,
          reason: 'summary_only',
          tokensBefore,
          tokensAfter: estimator.estimateText(summary),
          summary,
          coverage: summarized.coverage,
          view: summary,
        };
      }
      const view = [asSummaryMessage(summary)];
      return {
        ok: true,
        compacted: true,
        reason: 'summary_only',
        tokensBefore,
        tokensAfter: estimator.estimateMessages(view),
        summary,
        coverage: summarized.coverage,
        view,
        droppedSummary: `Conversation compressed from ${tokensBefore} tokens`,
      };
    }

    // structure_only（默认）
    if (!isMessages) {
      const maxTokens = opts.maxSummaryTokens ?? Math.max(200, Math.floor(tokensBefore * 0.25));
      const summarized = await summarizeMiddle(text, [], opts, maxTokens);
      if (!summarized.summary) {
        const head = text.slice(0, Math.max(200, Math.floor(text.length * 0.15)));
        const tail = text.slice(-Math.max(200, Math.floor(text.length * 0.15)));
        const view = `${head}\n\n[Structural compact]\n\n${tail}`;
        return {
          ok: true,
          compacted: true,
          reason: 'structure_truncate',
          tokensBefore,
          tokensAfter: estimator.estimateText(view),
          // 摘要失败时旧摘要仍有效：summary 字段保留之（与 messages 失败兜底同款）
          summary: opts.previousSummary,
          view,
        };
      }
      // 摘要即完整更新（同上：迭代式更新契约，不再事后拼接）
      const summary = summarized.summary;
      const view = `${text.slice(0, 200)}\n\n[Conversation Summary]\n${summary}\n\n${text.slice(-200)}`;
      return {
        ok: true,
        compacted: true,
        reason: 'structure_only',
        tokensBefore,
        tokensAfter: estimator.estimateText(view),
        summary,
        coverage: summarized.coverage,
        view,
      };
    }

    if (messages.length <= protectHead + protectTail) {
      return { ok: true, compacted: false, reason: 'too_short', tokensBefore, view: messages, summary: opts.previousSummary };
    }

    const head = messages.slice(0, protectHead);
    const middle = messages.slice(protectHead, Math.max(protectHead, messages.length - protectTail));
    const tail = messages.slice(-protectTail);

    const headTailTokens = estimator.estimateMessages(head) + estimator.estimateMessages(tail);
    const maxSummaryTokens =
      opts.maxSummaryTokens ??
      (targetTokens != null
        ? Math.max(200, Math.floor(targetTokens * 0.3))
        : Math.max(200, Math.floor(tokensBefore * 0.2)));

    const middleText = formatMessagesAsText(middle);
    const summarized = await summarizeMiddle(middleText, middle, opts, maxSummaryTokens);

    // 摘要即完整更新（previousSummary 已随 prompt 交给 summarizeFn 合并）；
    // 摘要失败时仍保留旧摘要兜底
    let summary = opts.previousSummary ?? '';
    if (summarized.summary) {
      summary = summarized.summary;
    } else if (!summary) {
      const placeholder = `[Structural compact] dropped ${middle.length} middle messages`;
      if (onFail === 'keep_partial') {
        summary = placeholder;
      } else {
        const view = [...head, asSummaryMessage(placeholder), ...tail];
        return {
          ok: true,
          compacted: true,
          reason: 'summarize_failed_truncate',
          tokensBefore,
          tokensAfter: estimator.estimateMessages(view),
          summary: placeholder,
          view,
          droppedSummary: `${middle.length} messages dropped; summarizer failed`,
        };
      }
    }

    const view = [...head, asSummaryMessage(summary), ...tail];
    const tokensAfter = estimator.estimateMessages(view);
    opts.emit?.({ type: 'compact.end', reason: mode, cached: false });

    return {
      ok: true,
      compacted: true,
      reason: 'structure_only',
      tokensBefore,
      tokensAfter,
      summary,
      coverage: summarized.coverage ?? (middle.length > 0 ? 'partial' : 'full'),
      view,
      droppedSummary: `Structural compact: head=${head.length} middle=${middle.length} tail=${tail.length}`,
    };
  }

  return {
    compactMessages: (messages, opts) => compactCore(messages, opts ?? {}),
    compactText: (text, opts) => compactCore(text, opts ?? {}),
  };
}
