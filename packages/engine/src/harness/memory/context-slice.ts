/**
 * ContextSlice 提取 — session 消息 + evidence 锚定 → 证据周边语境（±N 条消息）
 *
 * 概念化输入包要求 contextSlice（arch/cognition-graph-formation.md D1）。
 * evidence 多为缩略引文（「…」截断、句读改写），整串精确匹配常失败，
 * 因此按省略号/句读拆片段、以最长命中片段定位锚点消息，再截两侧窗口。
 * 找不到锚点返回空串，由调用方显式失败——禁止用无关窗口冒充语境。
 *
 * 锚定域：user / assistant / tool 的文本消息（evidence 可能引用工具输出，
 * 如文件路径与命令结果）。引擎载体插槽经 `isEngineCarrierSource` 单源过滤。
 *
 * @module harness/memory/context-slice
 */

import { elidedCharsMarker } from '@octopi-agent/core/elision.js';
import { getTextContent } from '@octopi-agent/core/types.js';
import { isEngineCarrierSource } from '../context/layer-types.js';

/** evidence 片段最小长度；短于它的命中易误锚（误锚比无锚更糟），宁可不锚定 */
const MIN_FRAGMENT_LEN = 8;

/** 缺省窗口：锚点两侧各取的实质消息条数 */
export const DEFAULT_CONTEXT_WINDOW_MESSAGES = 2;

/** 缺省切片字符预算（软上限；elision 标记会略超，见 {@link extractContextSlice}） */
export const DEFAULT_CONTEXT_SLICE_MAX_CHARS = 4000;

/** 引号类字符：匹配前剥除（evidence 引文与消息原文的引号使用不一致） */
const QUOTE_CHARS_RE = /[「」『』“”"'‘’（）()【】[\]]/g;

export interface ContextSliceOptions {
  /** 会话消息序列（SessionData.messages 结构；容忍未知形状） */
  messages: readonly unknown[];
  /** 记忆证据原文（可含缩略） */
  evidence: string;
  /** 锚点两侧各取的实质消息条数；缺省 {@link DEFAULT_CONTEXT_WINDOW_MESSAGES} */
  windowMessages?: number;
  /** 切片字符预算（软上限）；缺省 {@link DEFAULT_CONTEXT_SLICE_MAX_CHARS} */
  maxChars?: number;
}

/**
 * 匹配键归一：剥引号 + 空白折叠 + 拉丁小写（CJK 不受影响）。
 *
 * @param text - 原文
 * @returns 用于包含匹配的归一化文本
 */
function matchKey(text: string): string {
  return text.replace(QUOTE_CHARS_RE, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * evidence → 候选片段：按省略号/句读/换行拆开，归一后保留 ≥ MIN_FRAGMENT_LEN 的片段。
 *
 * @param evidence - 记忆证据原文
 * @returns 归一化候选片段（保持出现顺序）
 */
function evidenceFragments(evidence: string): string[] {
  const rough = evidence.split(/[…⋯]|\.{3,}|[。！？!?\n；;，,：:]/);
  const out: string[] = [];
  for (const piece of rough) {
    const cleaned = matchKey(piece);
    if (cleaned.length >= MIN_FRAGMENT_LEN) out.push(cleaned);
  }
  return out;
}

/**
 * 消息是否是可作语境的实质消息。
 *
 * 过滤口径：引擎载体插槽（快照/grounding/附件/摘要/hint/turn 闭标/停止说明）
 * 一律不算语境——快照含记忆原文回显，入语境即自我复制；turnEnd 以 user 角色
 * 落盘但不是发言。角色限 user/assistant/tool：evidence 可能引用工具输出
 * （文件路径、命令结果），故 tool 文本也是合法锚点。
 *
 * @param message - 会话消息（未知形状）
 * @returns 实质消息的文本与角色，否则 null
 */
function asSubstantive(message: unknown): { text: string; role: string } | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as {
    role?: unknown;
    content?: unknown;
    metadata?: { source?: unknown };
  };
  if (isEngineCarrierSource(m.metadata?.source)) return null;
  if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') return null;
  const raw = m.content;
  // 只取文本块：ContentBlock[] 整体 stringify 会把 tool_use 参数/图片塞进语境
  const text = (
    typeof raw === 'string' ? raw : Array.isArray(raw) ? getTextContent(raw as never) : ''
  ).trim();
  if (!text) return null;
  return { text, role: String(m.role) };
}

/**
 * 从会话消息中提取 evidence 周边语境切片。
 *
 * 定位策略：evidence 拆片段后取「能命中某条实质消息的最长片段」（等长片段取
 * evidence 中先出现者），同一片段取最后一次出现的消息（贴近记忆产生时的活跃
 * 语境），锚点 ±windowMessages 条实质消息。
 *
 * 截断：锚点行优先保留，两侧邻居按余量裁剪并以 elision 标记标注。
 * maxChars 为软上限（标记文本会略超）。锚点行自身超预算时保头尾两段，
 * 行内中段（含命中片段本身）可能被裁。
 *
 * @param options - 消息序列 + evidence + 窗口/预算
 * @returns `[role] text` 行拼接的语境切片；无锚点或无实质消息时返回空串
 */
export function extractContextSlice(options: ContextSliceOptions): string {
  const { messages, evidence } = options;
  const windowMessages = Math.max(0, options.windowMessages ?? DEFAULT_CONTEXT_WINDOW_MESSAGES);
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_CONTEXT_SLICE_MAX_CHARS);

  const substantive: Array<{ text: string; role: string }> = [];
  for (const message of messages) {
    const item = asSubstantive(message);
    if (item) substantive.push(item);
  }
  const fragments = evidenceFragments(evidence);
  if (substantive.length === 0 || fragments.length === 0) return '';

  const keys = substantive.map((item) => matchKey(item.text));
  let bestLen = 0;
  let anchorIndex = -1;
  for (const fragment of fragments) {
    let lastHit = -1;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].includes(fragment)) lastHit = i;
    }
    if (lastHit >= 0 && fragment.length > bestLen) {
      bestLen = fragment.length;
      anchorIndex = lastHit;
    }
  }
  if (anchorIndex < 0) return '';

  const from = Math.max(0, anchorIndex - windowMessages);
  const to = Math.min(substantive.length, anchorIndex + windowMessages + 1);
  const anchorPos = anchorIndex - from;
  const lines = substantive
    .slice(from, to)
    .map((item) => `[${item.role}] ${item.text}`);
  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;

  // 锚点行在 joined 内的字符区间
  let anchorStart = 0;
  for (let i = 0; i < anchorPos; i++) anchorStart += lines[i].length + 1;
  const anchorEnd = anchorStart + lines[anchorPos].length;

  if (anchorEnd - anchorStart >= maxChars) {
    const line = lines[anchorPos];
    const headBudget = Math.floor(maxChars * 0.4);
    const tailBudget = Math.max(0, maxChars - headBudget - 20);
    const tail = tailBudget > 0 ? line.slice(-tailBudget) : '';
    return `${line.slice(0, headBudget)}\n${elidedCharsMarker(line.length - headBudget - tailBudget)}\n${tail}`;
  }

  const room = maxChars - (anchorEnd - anchorStart);
  let left = Math.min(anchorStart, Math.floor(room / 2));
  const right = Math.min(joined.length - anchorEnd, room - left);
  left = Math.min(anchorStart, room - right);
  const start = anchorStart - left;
  const end = anchorEnd + right;

  const parts: string[] = [];
  if (start > 0) parts.push(elidedCharsMarker(start));
  if (left > 0) parts.push(joined.slice(start, anchorStart));
  parts.push(lines[anchorPos]);
  if (right > 0) parts.push(joined.slice(anchorEnd, end));
  if (end < joined.length) parts.push(elidedCharsMarker(joined.length - end));
  return parts.join('\n');
}
