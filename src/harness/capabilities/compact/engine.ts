/**
 * Compact 引擎 — 头尾保护 + 中间段摘要 + 截断兜底
 *
 * 会话 E4 状态与 Session 持久化不在此域。
 *
 * @module harness/capabilities/compact/engine
 */

import type { Message } from '../../../core/types.js';
import { getTextContent } from '../../../core/types.js';
import type { LLMMessage } from '../../../core/interfaces/model-provider.js';
import { HeuristicTokenEstimator } from '../../context/token-estimator.js';
import { buildPolicyRegistry } from '../summary/resolver.js';
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

function formatMessagesAsText(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
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

function toLlmMessages(messages: Message[]): LLMMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: getTextContent(m.content) || '',
  }));
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

    if (port) {
      const unit: ContentUnit = {
        text: middleText,
        structured: middleMessages,
        channel: 'pipeline',
        source: {},
        kind: 'conversation',
        policy: opts.summarizePolicy,
        task: 'Summarize conversation middle segment: goal, progress, decisions, blockers, next steps, key values.',
      };
      const r = await port.extract(unit, {
        signal: opts.signal,
        previousSummary: opts.previousSummary,
      });
      return { summary: r.text, coverage: r.coverage };
    }

    if (summarizeFn) {
      const llmMessages = middleMessages.length > 0 ? toLlmMessages(middleMessages) : [{ role: 'user', content: middleText }];
      const text = await summarizeFn(llmMessages, {
        previousSummary: opts.previousSummary,
        maxTokens: opts.maxSummaryTokens ?? maxTokens,
      });
      return { summary: text, coverage: 'full' };
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
            view,
            droppedSummary: 'middle dropped; summarizer unavailable',
          };
        }
        const view = text.slice(0, 500);
        return { ok: true, compacted: true, reason: 'summarize_failed_truncate', tokensBefore, view };
      }
      const summary = opts.previousSummary
        ? mergeSummaries(opts.previousSummary, summarized.summary)
        : summarized.summary;
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
          view,
        };
      }
      const summary = opts.previousSummary
        ? mergeSummaries(opts.previousSummary, summarized.summary)
        : summarized.summary;
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

    let summary = opts.previousSummary ?? '';
    if (summarized.summary) {
      summary = opts.previousSummary
        ? mergeSummaries(opts.previousSummary, summarized.summary)
        : summarized.summary;
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

function mergeSummaries(previous: string, next: string): string {
  const a = previous.trim();
  const b = next.trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\n${b}`;
}
