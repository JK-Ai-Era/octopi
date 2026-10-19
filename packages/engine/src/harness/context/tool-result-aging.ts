/**
 * 历史工具结果批量冻结老化（F1-B2）— 视图级、零 LLM、write-once
 *
 * 语义（arch/long-session-latency.md §5 B2 + arch/b0-cache-stable-context.md §4）：
 * - **当前 run 永不老化**：最近一条真实 user 消息（排除引擎载体插槽）以来的工具结果全原文；
 * - **近 `rawWindow` 条跨轮工具结果**保留原文；
 * - 更旧的候选按 **`freezeBatch` 批量**降级为结构化指针（工具名 + 参数要点 + 结果轮廓 + re-run 提示）；
 * - **批量冻结（禁渐进老化）**：老化边界只以 `freezeBatch` 为步长成批推进，段间轮次视图
 *   逐字节稳定——每轮在 recency 边界改写 1 条 = 把边界→尾部整段烧前缀缓存（B0 稿 §4）；
 * - **write-once**：指针按工具结果对象记忆化 + 纯函数定形，永不二次改写；
 *   ⚠️ 计划必须基于**完整历史**（append-only 的 session 消息序）计算，不能按被裁剪的
 *   装配视图重算——视图收缩会让已降级条目回原文、批量边界来回翻转（评审 F1）；
 * - **视图级**：只影响发给 LLM 的消息视图（`buildLlmMessages`）；session 持久层保原文。
 *
 * 红线（§4 能力红线）：user / assistant 正文永不降级；tool_call 参数默认保留；
 * **error 结果永不降级**（错误可追溯性优先，字段保真）；不膨胀守卫——
 * 只有指针严格小于原文时才降级。
 *
 * @module harness/context/tool-result-aging
 */

import type { Message } from '@octopi-agent/core/types.js';
import { isEngineCarrierSource } from './layer-types.js';
import { toolResultBody } from './tool-result-body.js';

/** 老化配置（配置面输入；缺省见 {@link resolveToolResultAgingOptions}） */
export interface ToolResultAgingConfig {
  /** 总开关（默认 true） */
  enabled?: boolean;
  /** 跨轮原文保留条数（默认 40） */
  rawWindow?: number;
  /**
   * 批量冻结步长：老化边界只成批推进（默认 20；最小 1）。
   * ⚠️ 1 = 逐候选即降级（等同渐进老化、每轮烧前缀缓存，仅调试用）；
   * 生产取值应 ≥ 每轮工具结果数，使冻结事件隔数轮一次。
   */
  freezeBatch?: number;
  /** 指针目标字符数（默认 400；是目标非硬顶——error/固定骨架可超出） */
  maxPointerChars?: number;
}

/** 老化配置（已解析、全字段非空） */
export interface ToolResultAgingOptions {
  enabled: boolean;
  rawWindow: number;
  freezeBatch: number;
  maxPointerChars: number;
}

/** 老化计划：一次装配内的降级判定（基于完整历史的纯函数结果，跨轮稳定） */
export interface ToolResultAgingPlan {
  /** 要降级为指针的 toolCallId 集合 */
  agedIds: ReadonlySet<string>;
  /** toolCallId → 工具调用参数（指针的「参数要点」来源；取自完整历史，裁剪视图中的孤儿也有参数） */
  argsById: ReadonlyMap<string, unknown>;
}

/** args / result 轮廓占 maxPointerChars 的比例（合计 ~0.65，加固定骨架 ≈ 目标） */
const ARGS_OUTLINE_RATIO = 0.2;
const RESULT_OUTLINE_RATIO = 0.45;
/** 轮廓下限（小旋钮下仍可读） */
const MIN_ARGS_OUTLINE_CHARS = 24;
const MIN_RESULT_OUTLINE_CHARS = 48;
const TRUNCATION_MARK = '…[truncated]';

/**
 * 解析老化配置（缺省 = 拍板参数起点：40 条原文 / 批 20 / 指针 400 字符）
 *
 * @param input - 配置面输入（可空）
 * @returns 全字段解析结果（非法值/0 步长回落缺省——0 或负步长等同禁用批量冻结）
 */
export function resolveToolResultAgingOptions(input?: ToolResultAgingConfig): ToolResultAgingOptions {
  const rawWindow = Number.isInteger(input?.rawWindow) && (input?.rawWindow ?? -1) >= 0 ? (input!.rawWindow as number) : 40;
  const freezeBatch = Number.isInteger(input?.freezeBatch) && (input?.freezeBatch ?? -1) >= 1 ? (input!.freezeBatch as number) : 20;
  const maxPointerChars =
    Number.isInteger(input?.maxPointerChars) && (input?.maxPointerChars ?? -1) > 0 ? (input!.maxPointerChars as number) : 400;
  return {
    enabled: input?.enabled ?? true,
    rawWindow,
    freezeBatch,
    maxPointerChars,
  };
}

interface CandidateEntry {
  toolCallId: string;
  msgIndex: number;
  bodyLength: number;
  isError: boolean;
  tr: { toolCallId: string; name?: string; error?: string; result?: unknown };
}

/**
 * 计算老化计划：批量冻结边界 + 工具调用参数索引
 *
 * 边界语义：跨轮工具结果（位于最近一条真实 user 消息之前）中，最旧的
 * `crossTurn - rawWindow` 条为候选；候选前 `freezeBatch` 整批部分「过冻结线」。
 * 过线条目再过三道守卫才降级：error 永不降级；正文 ≤ 指针目标不降级；
 * 实际指针不比原文短不降级（不膨胀）。历史只增不减时边界单调推进、
 * 已降级条目永不回原文——满足 write-once（须以完整历史为输入，见模块头注）。
 *
 * @param messages - **完整**历史消息（按时间序；勿传裁剪后的装配视图）
 * @param opts - 老化配置（已解析）
 * @returns 老化计划（enabled=false 或无候选时 agedIds 为空）
 */
export function computeToolResultAgingPlan(
  messages: Message[],
  opts: ToolResultAgingOptions,
): ToolResultAgingPlan {
  const argsById = new Map<string, unknown>();
  const ordered: CandidateEntry[] = [];

  let lastGenuineUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && !isEngineCarrierSource(msg.metadata?.source)) {
      lastGenuineUserIdx = i;
    }
    for (const tc of msg.toolCalls ?? []) {
      argsById.set(tc.id, tc.arguments);
    }
    for (const tr of msg.toolResults ?? []) {
      ordered.push({
        toolCallId: tr.toolCallId,
        msgIndex: i,
        bodyLength: toolResultBody(tr).length,
        isError: tr.error !== undefined,
        tr,
      });
    }
  }

  const agedIds = new Set<string>();
  if (!opts.enabled) return { agedIds, argsById };

  // 边界 = 完整历史最后一个真实 user（两遍判定：旧轮结果在遇到后续 user 前不可下结论）
  const crossTurn = ordered.filter((e) => e.msgIndex < lastGenuineUserIdx);
  const candidates = crossTurn.slice(0, Math.max(0, crossTurn.length - opts.rawWindow));
  const covered = candidates.length - (candidates.length % opts.freezeBatch);
  for (let i = 0; i < covered; i++) {
    const cand = candidates[i];
    if (cand.isError) continue; // 红线：error 结果永不降级（错误可追溯性优先）
    if (cand.bodyLength <= opts.maxPointerChars) continue; // 预筛：小于指针目标不值得
    const pointer = agedToolResultPointer(cand.tr, argsById.get(cand.toolCallId), opts);
    if (pointer.length < cand.bodyLength) {
      agedIds.add(cand.toolCallId);
    }
  }
  return { agedIds, argsById };
}

// 指针 write-once 缓存：同 `tr` 对象 + 同配置指纹 → 同字节（toolResultBody 同款 WeakMap 先例；
// 消息内容写入后不可变，对象身份稳定；即便对象重建，纯函数定形也保证字节一致）。
const pointerCache = new WeakMap<object, { fingerprint: string; text: string }>();

/**
 * 把老化计划物化为消息视图副本（新建对象，不改原消息）
 *
 * 供「量实际请求」的估算路径使用（F1-B3：主动压缩触发线必须量老化后的视图，
 * 否则 B2 稳态的 raw 估算会每 turn 误触发 compact = 双机制打架）。
 * 压缩/摘要输入仍用原消息（摘要质量需要原文）。
 *
 * @param messages - 完整历史消息
 * @param plan - 老化计划
 * @param opts - 老化配置（已解析）
 * @returns 消息副本（老化条目的正文替换为指针；无老化条目时原样返回同一数组）
 */
export function applyAgingToMessages(
  messages: Message[],
  plan: ToolResultAgingPlan,
  opts: ToolResultAgingOptions,
): Message[] {
  if (plan.agedIds.size === 0) return messages;
  return messages.map((msg) => {
    if (!msg.toolResults?.length) return msg;
    let changed = false;
    const results = msg.toolResults.map((tr) => {
      if (!plan.agedIds.has(tr.toolCallId)) return tr;
      changed = true;
      return {
        ...tr,
        result: agedToolResultPointer(tr, plan.argsById.get(tr.toolCallId), opts),
      };
    });
    return changed ? { ...msg, toolResults: results } : msg;
  });
}

/**
 * 生成结构化摘要指针（机械、零 LLM、确定性）
 *
 * 布局：工具名 + args 轮廓（截断）+ result 轮廓（截断）+ re-run 提示；
 * 轮廓预算按 `maxPointerChars` 比例派生（旋钮真实生效）。
 * error 分支为防御性保真（计划永不选中 error 结果）。
 *
 * @param tr - 工具结果（error / result 至少其一）
 * @param args - 对应工具调用参数（可空）
 * @param opts - 老化配置（已解析）
 * @returns 指针文本（write-once：同输入恒同字节）
 */
export function agedToolResultPointer(
  tr: { toolCallId: string; name?: string; error?: string; result?: unknown },
  args: unknown,
  opts: ToolResultAgingOptions,
): string {
  const fingerprint = `${opts.maxPointerChars}|${args === undefined ? '' : JSON.stringify(args)}|${
    tr.error !== undefined ? 'e' : 'r'
  }`;
  const cached = pointerCache.get(tr as object);
  if (cached && cached.fingerprint === fingerprint) return cached.text;

  const argsBudget = Math.max(MIN_ARGS_OUTLINE_CHARS, Math.floor(opts.maxPointerChars * ARGS_OUTLINE_RATIO));
  const resultBudget = Math.max(MIN_RESULT_OUTLINE_CHARS, Math.floor(opts.maxPointerChars * RESULT_OUTLINE_RATIO));
  const argsOutline = truncateOutline(safeJson(args ?? {}), argsBudget);
  const errorOrResult =
    tr.error !== undefined
      ? `error: ${tr.error}` // 防御性保真：错误文案不截断、不改写
      : `result: ${truncateOutline(toolResultOutline(tr), resultBudget)}`;
  const text =
    `[aged tool result · pointer] tool: ${tr.name ?? 'unknown'}; ` +
    `args: ${argsOutline}; ${errorOrResult}; ` +
    'full output kept in session log — re-run this tool call to fetch it';

  pointerCache.set(tr as object, { fingerprint, text });
  return text;
}

/**
 * 结果轮廓：结果正文序列化的头部（机械截断，非摘要改写）
 *
 * @param tr - 工具结果
 * @returns 序列化正文（string result 原文；否则 JSON）
 */
function toolResultOutline(tr: { error?: string; result?: unknown }): string {
  return typeof tr.result === 'string' ? tr.result : safeJson(tr.result ?? null);
}

/**
 * JSON 序列化（异常时降级为 String()，不抛错）
 *
 * @param value - 任意值
 * @returns JSON 字符串
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 机械截断轮廓（超长加显式标记；机械截断 ≠ 摘要改写）
 *
 * @param text - 原文
 * @param maxChars - 轮廓字符上限
 * @returns 轮廓文本
 */
function truncateOutline(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}${TRUNCATION_MARK}`;
}
