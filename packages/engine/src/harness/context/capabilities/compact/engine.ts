/**
 * Compact 引擎 — 头尾保护 + 中间段摘要 + 截断兜底
 *
 * 会话 E4 状态与 Session 持久化不在此域。
 *
 * @module harness/context/capabilities/compact/engine
 */

import type { Message } from '@octopi-agent/core/types.js';
import { getTextContent } from '@octopi-agent/core/types.js';
import { isCannedRefusalText } from '@octopi-agent/core/loop/canned-refusal.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import { HeuristicTokenEstimator } from '../../token-estimator.js';
import { buildPolicyRegistry } from '../summary/resolver.js';
import type { ContentUnit, SummaryPolicy } from '../summary/types.js';
import {
  HANDOVER_SUMMARY_TASK,
  buildHandoverPrompt,
  buildHandoverUserContent,
  clampSummaryProviderCap,
} from './handover.js';
import { estimateLLMMessages } from '../../token-estimator.js';
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

/** 摘要任务/指令/合并语义已单源化到 ./handover.ts（F8 模板统一）——此处仅保留算法与闸门。 */

/** 重试仍污染时附加的加严指令（输出闸门二次机会用） */
const STRICT_RETRY_SUFFIX =
  '\n\nIMPORTANT: your previous attempt replayed input passages. Write fresh prose only. ' +
  'Do not copy input lines. No dialogue transcript, no role-marker lines, no tool-call syntax.';

/** 输出闸门形状词表（评审 F3 扩表）：对话体/工具调用语法。
 * 角色行用行首语义（防正文误伤）；工具调用语法 anywhere 判定——指令已不含这些
 * 字面量（F15），输出里出现即高概率是续写污染。 */
const TRANSCRIPT_SHAPE =
  /<function[=_]|<\/?tool_call|<invoke[ \t]|<\/?tool_use|<parameter[ >]|antml:|Tool Calls:|\[(ASSISTANT|USER|TOOL|SYSTEM)\]|^\s*(Assistant|Human|User|System):/im;

/** 输出闸门：摘要落盘前的污染检测（回声/对话体续写）。
 *
 * 失效模式（2026-10-28 实测）：模型把对话样本当语料续写，产出「assistant 半句 + 逐字
 * tool-call」的原文复读，使折叠掉的中段信息全丢。本闸门兜底校验：命中即判污染，交由
 * 调用方重试或按 onSummarizeFail 降级（不得静默存坏摘要）。
 *
 * 回声判据是结构性的（评审 F2/F3/F4）：单条证据引用合法，成段复读非法——
 * 命中输入行 ≥3 条，或命中字符占输出 ≥60%（输出基本就是复读），才判污染。
 *
 * @param text - 模型输出
 * @param sourceText - 「模型实际看到的会话文本」投影（回声比对源；不得含指令本身——
 *   指令的四段式标题会合法出现在输出里）
 * @returns 命中原因；干净返回 null
 */
export function detectSummaryContamination(text: string, sourceText?: string): string | null {
  // 内容过滤罐头拒答：网关 200 内联拒答（正文被替换成固定英文罐头）不是摘要，
  // 一律判污染——交由既有的「一次加严重试 → 二次抛错降级」链路处理
  if (isCannedRefusalText(text)) {
    return 'canned_refusal';
  }
  if (TRANSCRIPT_SHAPE.test(text)) {
    return 'transcript_shape';
  }
  if (sourceText) {
    let hits = 0;
    let hitChars = 0;
    for (const line of sourceText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length >= 40 && text.includes(trimmed)) {
        hits += 1;
        hitChars += trimmed.length;
      }
    }
    if (hits >= 3 || (hitChars >= 40 && hitChars >= text.length * 0.6)) {
      return 'verbatim_echo';
    }
  }
  return null;
}

/** 带输出闸门的摘要执行：首次污染给一次加严重试，二次污染抛错交 onSummarizeFail 降级。
 *
 * @param invoke - 摘要调用（strict=true 时需附加加严指令）
 * @param sourceText - 回声比对源（喂给模型的输入文本）
 * @returns 干净摘要文本
 * @throws provider 错误，或 `contaminated_output:*`（二次污染）
 */
async function invokeGuardedSummarize(
  invoke: (strict: boolean) => Promise<string>,
  sourceText: string,
): Promise<string> {
  let text = await invoke(false);
  if (detectSummaryContamination(text, sourceText)) {
    text = await invoke(true);
    const again = detectSummaryContamination(text, sourceText);
    if (again) {
      throw new Error(`contaminated_output:${again}`);
    }
  }
  return text;
}

/** 摘要软目标预算（P1c 拍板缺省 clamp(2%, 2k, 8k)）。
 *
 * 软目标语义：只写进指令当「尽量控制在 N tokens」，禁止作为 provider max_tokens 硬顶
 * （硬截断产生静默半截摘要，业务完整性优先）。公式即拍板三参数 clamp(2%, 2k, 8k)，
 * 不附加「不超过输入」等未记录规则（评审 F13：规格外规则会与模型互相算计）。
 *
 * @param tokensBefore - 输入 token 估算
 * @param budget - 可配置 ratioPct/minTokens/maxTokens
 * @returns 软目标 token 数
 */
export function summarySoftTargetTokens(
  tokensBefore: number,
  budget?: { ratioPct?: number; minTokens?: number; maxTokens?: number },
): number {
  const ratioPct = budget?.ratioPct ?? 2;
  const minTokens = budget?.minTokens ?? 2000;
  const maxTokens = budget?.maxTokens ?? 8000;
  const target = Math.floor((tokensBefore * ratioPct) / 100);
  return Math.min(Math.max(target, minTokens), maxTokens);
}

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
    // 能力层缺省与 DefaultContextEngine protectFirstN 同源（5，2026-10-28 拍板交接快照头 5）
    protectHead: options?.defaultProtectHead ?? 5,
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
        task: HANDOVER_SUMMARY_TASK,
      };
      try {
        // 输出闸门与 summarizeFn 路径对齐：污染给一次加严重试，仍污染按失败降级（不静默存坏摘要）
        let r = await port.extract(unit, {
          signal: opts.signal,
          previousSummary: opts.previousSummary,
        });
        if (detectSummaryContamination(r.text, middleText)) {
          r = await port.extract(
            { ...unit, task: `${HANDOVER_SUMMARY_TASK}${STRICT_RETRY_SUFFIX}` },
            { signal: opts.signal, previousSummary: opts.previousSummary },
          );
          const again = detectSummaryContamination(r.text, middleText);
          if (again) {
            return { error: `contaminated_output:${again}` };
          }
        }
        return { summary: r.text, coverage: r.coverage };
      } catch (err) {
        // 只吞 port.extract 的抛错（摘要器契约外失败：provider 报错/超时）——转 error
        // 通道交给 onSummarizeFail 降级；try 内无其他可抛代码，无其他路径可至此
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (summarizeFn) {
      // 交接式契约单源（F8 模板统一）：模板/指令/合并语义全走 handover.ts——
      // 与 LLMSummaryCompressor 逐字同构，previousSummary 只有一种格式在迭代合并
      const prompt = buildHandoverPrompt({
        maxTokens,
        summarizePolicy: policy,
        previousSummary: opts.previousSummary,
        foldRange: opts.foldRange,
        taskSnapshot: opts.taskSnapshot,
      });
      // 缓存优先：llmPrefix（会话同形 system+history）+ 尾部 user 指令。
      // 禁止把指令塞进 system 或重排历史——否则打穿前缀缓存。
      const buildPrefixed = (): LLMMessage[] => [
        ...opts.llmPrefix!,
        { role: 'user', content: prompt.tailUser },
      ];
      // 无 llmPrefix 回退「policy system + 文本化中段」（旁路/旧调用）：
      // tool_call-only assistant / 缺 tool_call_id 的 tool 消息会被严格网关 400。
      const buildTextify = (): LLMMessage[] => [
        { role: 'system', content: prompt.instruction },
        { role: 'user', content: buildHandoverUserContent(opts, middleText) },
      ];
      // 回声比对源 = 模型实际看到的会话文本投影（评审 F2）：llmPrefix 分支含 head/middle/tail
      // 全量历史，只比 middleText 会漏掉 head/tail 区回声；指令本身不得进比对源（四段式标题
      // 会合法出现在输出里）。
      const prefixEchoSource = (): string =>
        (opts.llmPrefix ?? []).map((m) => String(m.content ?? '')).join('\n');

      let usePrefix = Boolean(opts.llmPrefix?.length);
      let llmMessages = usePrefix ? buildPrefixed() : buildTextify();
      let echoSource = usePrefix ? prefixEchoSource() : middleText;

      // 硬顶 = 软目标 4 倍保险丝（P1c 禁硬截断/静默半截），再按窗口钳制（评审 F5）：
      // provider 多按 input+max_tokens ≤ window 校验，压缩恰在会话最满时触发，保险丝可能把
      // 请求顶出窗口——放不下就改走文本化中段旁路（cache-miss 如实降级），仍放不下则如实失败。
      const hardCap = (opts.maxSummaryTokens ?? maxTokens) * 4;
      const windowCapOf = (msgs: LLMMessage[]): number =>
        clampSummaryProviderCap({
          hardCap,
          // estimateLLMMessages 口径含 tool_calls/content block/消息开销（同 llm-summarizer）
          inputTokens: estimateLLMMessages(msgs),
          contextWindow: opts.contextWindow,
          maxOutputTokens: opts.maxOutputTokens,
        });
      let providerMaxTokens = windowCapOf(llmMessages);
      // F22 可观测：无前缀/被迫旁路 = cache-miss，如实上报，不静默换请求形状
      if (!usePrefix) {
        opts.emit?.({ type: 'compact.summarize_fallback', reason: 'no_prefix', cached: false });
      }
      if (providerMaxTokens < 256 && usePrefix) {
        usePrefix = false;
        llmMessages = buildTextify();
        echoSource = middleText;
        providerMaxTokens = windowCapOf(llmMessages);
        opts.emit?.({ type: 'compact.summarize_fallback', reason: 'window_guard', cached: false });
      }
      if (providerMaxTokens < 256) {
        // F8R-06 可观测：最终失败也是 cache-miss 旁路结果，与 compressor 侧对称上报
        opts.emit?.({ type: 'compact.summarize_fallback', reason: 'window_exhausted', cached: false });
        return { error: 'window_exhausted:summary request cannot fit the model window' };
      }

      try {
        const invoke = (strict: boolean): Promise<string> => {
          const msgs = strict
            ? [
                ...llmMessages.slice(0, -1),
                {
                  ...llmMessages[llmMessages.length - 1]!,
                  content: `${String(llmMessages[llmMessages.length - 1]!.content)}${STRICT_RETRY_SUFFIX}`,
                },
              ]
            : llmMessages;
          return summarizeFn(msgs, {
            previousSummary: opts.previousSummary,
            maxTokens: providerMaxTokens,
          });
        };
        const text = await invokeGuardedSummarize(invoke, echoSource);
        return { summary: text, coverage: 'full' };
      } catch (err) {
        // 吞两类抛错并转 error 通道交 onSummarizeFail 降级：① provider 报错/超时；
        // ② 闸门二次污染（contaminated_output:*）。try 内无其他可抛代码，无其他路径可至此
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

    // 边界归一：负数无契约语义，按 0 处理（slice 对负数是另一套语义，会切出意外视图）
    const protectHead = Math.max(0, opts.protectHead ?? defaults.protectHead);
    const protectTail = Math.max(0, opts.protectTail ?? defaults.protectTail);
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
        // 太短无可拆中段（len<5 时 20%×2 皆为 0）：原样返回不丢正文（与消息路径 too_short 同语义）
        if (headChars === 0 && tailChars === 0) {
          return { ok: true, compacted: false, reason: 'too_short', tokensBefore, view: text };
        }
        // slice(-0) === slice(0) 返回全量：tailChars=0 时尾段必须显式取空
        const view = `${text.slice(0, headChars)}\n\n[middle removed]\n\n${tailChars > 0 ? text.slice(-tailChars) : ''}`;
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
      // slice(-0) === slice(0) 返回全量：protectTail=0 时 tail 必须显式为空
      const tail = protectTail > 0 ? messages.slice(-protectTail) : [];
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
      const maxTokens = opts.maxSummaryTokens ?? summarySoftTargetTokens(tokensBefore, opts.summaryBudget);
      const summarized = await summarizeMiddle(text, messages, opts, maxTokens);
      if (!summarized.summary) {
        if (onFail === 'keep_partial' && opts.previousSummary && isMessages) {
          // slice(-0) === slice(0) 返回全量：protectTail=0 时 tail 必须显式为空
          const view = [asSummaryMessage(opts.previousSummary), ...(protectTail > 0 ? messages.slice(-protectTail) : [])];
          return { ok: true, compacted: true, reason: 'partial', tokensBefore, tokensAfter: estimator.estimateMessages(view), summary: opts.previousSummary, fresh: false, view };
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
            fresh: false,
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
          fresh: false,
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
          fresh: true,
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
        fresh: true,
        coverage: summarized.coverage,
        view,
        droppedSummary: `Conversation compressed from ${tokensBefore} tokens`,
      };
    }

    // structure_only（默认）
    if (!isMessages) {
      const maxTokens = opts.maxSummaryTokens ?? summarySoftTargetTokens(tokensBefore, opts.summaryBudget);
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
          fresh: false,
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
        fresh: true,
        coverage: summarized.coverage,
        view,
      };
    }

    if (messages.length <= protectHead + protectTail) {
      return { ok: true, compacted: false, reason: 'too_short', tokensBefore, view: messages, summary: opts.previousSummary };
    }

    const head = messages.slice(0, protectHead);
    const middle = messages.slice(protectHead, Math.max(protectHead, messages.length - protectTail));
    // slice(-0) === slice(0) 返回全量：protectTail=0 时 tail 必须显式为空
    const tail = protectTail > 0 ? messages.slice(-protectTail) : [];

    const headTailTokens = estimator.estimateMessages(head) + estimator.estimateMessages(tail);
    const maxSummaryTokens =
      opts.maxSummaryTokens ?? summarySoftTargetTokens(tokensBefore, opts.summaryBudget);

    const middleText = formatMessagesAsText(middle);
    const summarized = await summarizeMiddle(middleText, middle, opts, maxSummaryTokens);

    // 摘要即完整更新（previousSummary 已随 prompt 交给 summarizeFn 合并）；
    // 摘要失败时仍保留旧摘要兜底
    let summary = opts.previousSummary ?? '';
    let fresh = false;
    if (summarized.summary) {
      summary = summarized.summary;
      fresh = true;
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
          fresh: false,
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
      // fresh=false（摘要失败仅旧摘要兜底）不得报 'structure_only'——调用方据此不推进覆盖
      reason: fresh ? 'structure_only' : `summarize_failed:${summarized.error ?? 'no_output'}`,
      tokensBefore,
      tokensAfter,
      summary,
      fresh,
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
