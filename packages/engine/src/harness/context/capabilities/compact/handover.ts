/**
 * 交接式摘要契约（2026-10-28 拍板）——所有摘要路径的**单一指令源**。
 *
 * F8 模板统一：手动压缩（compactCore.summarizeMiddle）与 proactive/overflow
 * （LLMSummaryCompressor）共用本模板、指令构造与预算语义，保证 previousSummary
 * 只有一种格式在迭代合并——两套模板轮流并入是压缩行为不可控的根源。
 *
 * 模板结构是拍板物（四段式）；规则行只约束行为，不改结构。F-d 硬约束
 * （完成项可核验 + 交接防重做 + 不虚构）以散文形式并入，不另立结构。
 */

import { buildSystemPrompt } from '../summary/executor.js';
import { buildPolicyRegistry } from '../summary/resolver.js';
import type { SummaryPolicy } from '../summary/types.js';

/** 交接书四段式任务（summaryPort / summarizeFn / LLMSummaryCompressor 共用，保持指令对齐）。
 * 反回声纪律（评审 F15）：指令里不出现任何工具调用/角色标记字面量——负面示例本身会教坏模型
 * 且引发闸门自命中；证据允许单行短引用（F4：引用≠污染）。 */
export const HANDOVER_SUMMARY_TASK = [
  'Write a handoff summary that lets a fresh agent continue this work seamlessly.',
  'Structure (use exactly these four sections):',
  '1. Goal & status - what the work is trying to accomplish and where it stands now.',
  '2. Open items & commitments - unfinished tasks, promised follow-ups, what is waiting on whom.',
  '3. Conclusions & decisions - settled outcomes and rulings, each with its rationale.',
  '4. Evidence pointers - for the above: file paths, commit ids, test names, numbers to look up.',
  'Write in the same language as the conversation.',
  'Completed work must be verifiable: pair every finished item with its artifact (file path,',
  'commit id, test name) so the next turn can check it - and make explicit that finished work is',
  'finished, so the next turn does not redo it.',
  'Output ONLY the handoff summary as new prose - no dialogue transcript, no role-marker lines,',
  'and no raw tool-call syntax of any kind (describe calls in words instead of replaying their',
  'payloads). Do not quote or replay passages of the input; quoting a single evidence line',
  '(a decision, an error string) verbatim is acceptable.',
].join('\n');

/** 迭代合并提示（两路共用同一字面量，评审 F10）。
 * 含旧格式重写提示（评审 F7：升级前落盘的 Done/ToDo 存量摘要并入时重构为四段式，防跨格式漂移）。 */
const MERGE_HINT =
  '\n\nUpdate the previous summary into one fresh handoff: merge the new work in, keep still-relevant content, and do not drop still-open items. If the previous summary is not in this four-section structure, restructure it into it.';

/** 折叠区间（评审 F7/F3）：交接书替换范围与原样保留尾部——计数语义（两路都能精确供给，不编造索引） */
export interface HandoverFoldRange {
  /** 交接书替换的旧消息条数 */
  replacedCount: number;
  /** 会话消息总数 */
  total: number;
  /** 原样保留的尾部条数（勿总结它们） */
  preservedTail: number;
}

export interface HandoverPromptOptions {
  /** 摘要软目标预算（P1c：写进指令当「尽量控制在 N tokens」，禁止作 provider 硬顶） */
  maxTokens: number;
  /** 覆盖策略（缺省 conversation_default） */
  summarizePolicy?: string | SummaryPolicy;
  /** 上一份交接书（迭代合并输入） */
  previousSummary?: string;
  /** 折叠区间 */
  foldRange?: HandoverFoldRange;
  /** task 快照（B0：易变块走 content 尾部，不进 system） */
  taskSnapshot?: string;
}

export interface HandoverPrompt {
  /** 指令主体（任务+规则+软目标行+折叠边界）：textify 分支作 system */
  instruction: string;
  /** 尾部 user 全文（llmPrefix 分支：前缀之后的唯一 user 消息） */
  tailUser: string;
}

function resolvePolicy(summarizePolicy?: string | SummaryPolicy): SummaryPolicy {
  const registry = buildPolicyRegistry();
  if (typeof summarizePolicy === 'string' && registry[summarizePolicy]) {
    return registry[summarizePolicy]!;
  }
  if (summarizePolicy && typeof summarizePolicy === 'object') {
    return summarizePolicy;
  }
  return registry['conversation_default']!;
}

/**
 * 构造交接式摘要指令（所有摘要路径共用的唯一实现）。
 *
 * 布局契约：llmPrefix 分支把 tailUser 作为前缀之后的**唯一 user 消息**（缓存纪律：
 * 指令只挂尾部，禁改 system/历史字节）；textify 分支用 instruction 作 system、
 * buildHandoverUserContent 作 user。
 *
 * @param options - 见 HandoverPromptOptions
 * @returns instruction + tailUser 两段文本
 */
export function buildHandoverPrompt(options: HandoverPromptOptions): HandoverPrompt {
  const policy = resolvePolicy(options.summarizePolicy);
  const instruction = buildSystemPrompt(policy, HANDOVER_SUMMARY_TASK, options.maxTokens);
  const preservedHead = options.foldRange
    ? Math.max(
        0,
        options.foldRange.total - options.foldRange.replacedCount - options.foldRange.preservedTail,
      )
    : 0;
  const foldBlock = options.foldRange
    ? `\n\nFold boundary: the handoff summarizes ${options.foldRange.replacedCount} older messages of ${options.foldRange.total}; ${preservedHead} earlier and ${options.foldRange.preservedTail} newer messages are preserved verbatim - cover the replaced part in depth and keep the summary off the preserved ones.`
    : '';
  const mergeHint = options.previousSummary ? MERGE_HINT : '';
  const previousBlock = options.previousSummary
    ? `\n\nPrevious summary:\n${options.previousSummary}`
    : '';
  const taskBlock = options.taskSnapshot?.trim()
    ? `\n\nCurrent session task list snapshot (live task store):\n${options.taskSnapshot.trim()}`
    : '';
  return {
    instruction: `${instruction}${foldBlock}`,
    tailUser: `${instruction}${foldBlock}${mergeHint}${previousBlock}${taskBlock}`,
  };
}

/**
 * 摘要 provider 硬顶钳制（F8 单一预算语义，所有摘要路径共用）。
 *
 * 硬顶 = 软目标 ×4 保险丝（P1c 禁硬截断/静默半截），再按窗口钳制（评审 F5）：
 * provider 多按 input+max_tokens ≤ window 校验，压缩恰在会话最满时触发。
 *
 * @param options - hardCap（4× 软目标）、输入估算 token 数、可选窗口/输出上限
 * @returns 钳制后的 provider max_tokens（≥0；调用方以 256 为可用下限自行降级）
 */
export function clampSummaryProviderCap(options: {
  hardCap: number;
  /** 输入估算 token 数（用 estimateLLMMessages 算——含 tool_calls/content block/消息开销，
   *  勿用 String(content) 拼接或 chars/4：前者漏 tool_calls，后者 CJK 低估 4×） */
  inputTokens: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}): number {
  if (!options.contextWindow || options.contextWindow <= 0) {
    return options.hardCap;
  }
  const byWindow = Math.min(
    options.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    Math.floor(options.contextWindow * 0.1),
    options.contextWindow - options.inputTokens - 256,
  );
  return Math.min(options.hardCap, Math.max(byWindow, 0));
}

/**
 * textify 旁路的 user 正文（所有摘要路径共用的唯一实现）。
 *
 * @param options - previousSummary / taskSnapshot（与 buildHandoverPrompt 同源）
 * @param content - 文本化会话正文
 * @returns user 消息正文（previousSummary 前置合并输入，task 快照尾随）
 */
export function buildHandoverUserContent(
  options: Pick<HandoverPromptOptions, 'previousSummary' | 'taskSnapshot'>,
  content: string,
): string {
  const taskBlock = options.taskSnapshot?.trim()
    ? `\n\nCurrent session task list snapshot (live task store):\n${options.taskSnapshot.trim()}`
    : '';
  if (!options.previousSummary) {
    return `${content}${taskBlock}`;
  }
  return `Previous summary:\n${options.previousSummary}\n\n---\n\n${MERGE_HINT.trim()}\n\nNew content:\n${content}${taskBlock}`;
}
