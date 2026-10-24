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
 * 红线（§4 能力红线）：user / assistant **正文**永不降级；**error 结果永不降级**（错误可追溯性优先，
 * 字段保真）；不膨胀守卫——只有指针严格小于原文时才降级。
 *
 * tool_call 参数（`ageToolArgs`，默认开）：**只对「结果已被老化」的那条调用**同步降级为键值摘要
 * （长值换成长度标记，键名全保）。原因：参数是上下文中唯一无界增长的成分——结果老化成指针后
 * 参数仍留原文，实测其总量可达指针本体的 1.1 倍，且随 session 线性增长。
 * 降级不改变 tool_call ↔ tool_result 配对结构（`id`/`name` 不动，`arguments` 仍是合法 JSON）。
 *
 * @module harness/context/tool-result-aging
 */

import type { Message } from '@octopi-agent/core/types.js';
import { isTurnAnchor } from './layer-types.js';
import { toolResultBody } from './tool-result-body.js';

/** 老化配置（配置面输入；缺省见 {@link resolveToolResultAgingOptions}） */
export interface ToolResultAgingConfig {
  /** 总开关（默认 true） */
  enabled?: boolean;
  /** 跨轮原文保留条数（默认 40） */
  rawWindow?: number;
  /**
   * 批量冻结步长：老化边界只成批推进（默认 40；最小 1）。
   * ⚠️ 1 = 逐候选即降级（等同渐进老化、每轮烧前缀缓存，仅调试用）；
   * 生产取值应 ≥ 每轮工具结果数，使冻结事件隔数轮一次。
   * 默认 40 的实测依据：单轮工具结果数峰值 34、均值 15，批 20 会近乎每轮触发一次，
   * 而每次燃烧量是常数级（rawWindow + 半批 + 当轮），小批次摊不动 → 回本点被拉到 100 次调用。
   */
  freezeBatch?: number;
  /** 指针目标字符数（默认 400；是目标非硬顶——error/固定骨架可超出） */
  maxPointerChars?: number;
  /**
   * 是否随结果老化同步降级该次调用的参数（默认 true）
   *
   * 只作用于「结果已被老化」的调用；当前 run 与 rawWindow 内的参数保持原文。
   */
  ageToolArgs?: boolean;
  /**
   * 参数摘要的目标字符数（默认 320；**只约束内容值**，键名与定位字段不计入）
   *
   * 定位字段（path/file/glob/pattern/cwd）与 command 头部是「这条调用碰了哪里」的唯一锚点，
   * 恒定保留；预算过小只会让内容值更快退化，不会丢锚点。
   */
  maxAgedArgChars?: number;
}

/** 老化配置（已解析、全字段非空） */
export interface ToolResultAgingOptions {
  enabled: boolean;
  rawWindow: number;
  freezeBatch: number;
  maxPointerChars: number;
  ageToolArgs: boolean;
  maxAgedArgChars: number;
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
/**
 * 参数摘要中「原样保留」的单个值上限
 *
 * 只用来区分「标识性短值」（路径、命令、行号）与「载荷长值」（文件内容、diff 正文）。
 * 64 足以容纳常见路径，又远小于任何文件内容。
 */
const ARG_VALUE_KEEP_CHARS = 64;
const TRUNCATION_MARK = '…[truncated]';

/**
 * 解析老化配置（缺省 = 拍板参数起点：40 条原文 / 批 20 / 指针 400 字符）
 *
 * @param input - 配置面输入（可空）
 * @returns 全字段解析结果（非法值/0 步长回落缺省——0 或负步长等同禁用批量冻结）
 */
export function resolveToolResultAgingOptions(input?: ToolResultAgingConfig): ToolResultAgingOptions {
  const rawWindow = Number.isInteger(input?.rawWindow) && (input?.rawWindow ?? -1) >= 0 ? (input!.rawWindow as number) : 40;
  const freezeBatch = Number.isInteger(input?.freezeBatch) && (input?.freezeBatch ?? -1) >= 1 ? (input!.freezeBatch as number) : 40;
  const maxPointerChars =
    Number.isInteger(input?.maxPointerChars) && (input?.maxPointerChars ?? -1) > 0 ? (input!.maxPointerChars as number) : 400;
  const maxAgedArgChars =
    Number.isInteger(input?.maxAgedArgChars) && (input?.maxAgedArgChars ?? -1) > 0
      ? (input!.maxAgedArgChars as number)
      : 320;
  return {
    enabled: input?.enabled ?? true,
    rawWindow,
    freezeBatch,
    maxPointerChars,
    ageToolArgs: input?.ageToolArgs ?? true,
    maxAgedArgChars,
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
    if (isTurnAnchor(msg)) {
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
    let next = msg;

    // 参数与结果同步老化：只动「结果已老化」的那条调用，配对结构不变
    if (opts.ageToolArgs && msg.toolCalls?.length) {
      let callsChanged = false;
      const toolCalls = msg.toolCalls.map((tc) => {
        if (!plan.agedIds.has(tc.id)) return tc;
        callsChanged = true;
        return { ...tc, arguments: agedToolArgDigest(tc.name, tc.arguments, opts) as typeof tc.arguments };
      });
      if (callsChanged) next = { ...next, toolCalls };
    }

    if (!msg.toolResults?.length) return next;
    let changed = false;
    const results = msg.toolResults.map((tr) => {
      if (!plan.agedIds.has(tr.toolCallId)) return tr;
      changed = true;
      return {
        ...tr,
        result: agedToolResultPointer(tr, plan.argsById.get(tr.toolCallId), opts),
      };
    });
    return changed ? { ...next, toolResults: results } : next;
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
  // 结果轮廓只保留头部，若不给总量，读方会把「头部那几条」误当成全部（file_search 尤甚）
  const resultBody = toolResultOutline(tr);
  const errorOrResult =
    tr.error !== undefined
      ? `error: ${tr.error}` // 防御性保真：错误文案不截断、不改写
      : `result ${resultBody.length} chars: ${truncateOutline(resultBody, resultBudget)}`;
  const text =
    `[aged tool result · pointer] tool: ${tr.name ?? 'unknown'}; ` +
    `args: ${argsOutline}; ${errorOrResult}; ` +
    'full output kept in session log — do NOT re-run unless the output is needed again';

  pointerCache.set(tr as object, { fingerprint, text });
  return text;
}

/**
 * 参数摘要：把「结果已被老化」的工具调用参数降级为键值摘要
 *
 * 规则（机械、确定性、无 LLM）：
 * 1. **键名全保**——LLM 需要知道调用了哪个路径/命令才能在必要时重跑；
 * 2. 序列化长度超过 {@link ARG_VALUE_KEEP_CHARS} 的值替换为长度标记 `…[N chars]`；
 * 3. 若仍是超预算，按「值从大到小、同大小按键名」顺序继续替换，保证确定性；
 * 4. 兜底：键名太多装不下时退化为整体轮廓截断。
 *
 * 返回值仍是合法 JSON 值，调用方照常 `JSON.stringify`，因此 tool_call 结构不变。
 *
 * @param name - 工具名（兜底分支用于说明来源）
 * @param args - 原始调用参数（任意 JSON 值）
 * @param opts - 老化配置（已解析）
 * @returns 摘要值（`ageToolArgs=false` 时原样返回）
 */
export function agedToolArgDigest(name: string, args: unknown, opts: ToolResultAgingOptions): unknown {
  if (!opts.ageToolArgs || args == null) return args;
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { _aged: `${name} arguments elided`, outline: truncateOutline(safeJson(args), opts.maxAgedArgChars) };
  }

  const cached = argDigestCache.get(args as object);
  const fingerprint = `${opts.maxAgedArgChars}`;
  if (cached && cached.fingerprint === fingerprint) return cached.value;

  const entries = Object.entries(args as Record<string, unknown>).map(([k, v]) => ({
    k,
    v,
    size: safeJson(v).length,
  }));
  const out: Record<string, unknown> = {};
  for (const e of entries) {
    out[e.k] = digestArgValue(e.k, e.v, e.size);
  }

  // 预算只约束「内容值」，定位字段不计入：
  // 否则一条绝对路径就能吃掉整个预算，反而先把唯一锚点挤掉（实测 path 均长 79，
  // 若计入预算，file_edit 这类调用会退化成「看不到改了哪个文件」）。
  const contentChars = (): number =>
    safeJson(
      Object.fromEntries(Object.entries(out).filter(([k]) => !ANCHOR_FIELDS.has(k))),
    ).length;

  const contentEntries = entries
    .filter((e) => !ANCHOR_FIELDS.has(e.k))
    .sort((a, b) => b.size - a.size || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  for (const e of contentEntries) {
    if (contentChars() <= opts.maxAgedArgChars) break;
    out[e.k] = elidedMarker(e.size);
  }

  const value: unknown =
    contentChars() > opts.maxAgedArgChars
      ? { _aged: `${name} arguments elided`, outline: truncateOutline(safeJson(args), opts.maxAgedArgChars) }
      : out;

  argDigestCache.set(args as object, { fingerprint, value });
  return value;
}

/** 值被省略时的长度标记 */
function elidedMarker(chars: number): string {
  return `…[${chars} chars]`;
}

/**
 * 定位字段：它们短、且是「这条调用到底碰了哪里」的唯一锚点，优先全保
 *
 * 实测：`path` 均长 79 字符（全保仅 +1.5% 请求体），而 `command` 均长 414
 * （全保 +8.6%）。因此路径类全保、命令类只留头部。
 */
const LOCATOR_FIELDS = new Set(['path', 'file', 'glob', 'pattern', 'cwd']);

/**
 * 锚点字段：不占用内容预算（否则定位信息会被内容载荷挤出）
 *
 * 定位字段与命令字段都属锚点——`command` 头部回答「跑了什么」，
 * 若让它和 `old_text` 之类抢同一个预算，多条命令一累加就会把头部整体省略掉。
 */
const ANCHOR_FIELDS = new Set([...LOCATOR_FIELDS, 'command', 'cmd']);

/** 定位字段全保上限（超长的罕见路径才会退化为标记） */
const LOCATOR_KEEP_CHARS = 200;

/** 命令类字段保留的头部长度（其余用长度标记收尾） */
const COMMAND_HEAD_CHARS = 100;

/** 命令类字段名 */
const COMMAND_FIELDS = new Set(['command', 'cmd']);

function isLocatorField(key: string): boolean {
  return LOCATOR_FIELDS.has(key);
}

/**
 * 单个参数值的降级策略（确定性、与顺序无关）
 *
 * @param key - 字段名
 * @param value - 字段值
 * @param size - 值的 JSON 序列化长度
 * @returns 保留原值、头部摘录或长度标记
 */
function digestArgValue(key: string, value: unknown, size: number): unknown {
  if (size <= ARG_VALUE_KEEP_CHARS) return value;
  if (isLocatorField(key) && size <= LOCATOR_KEEP_CHARS) return value;
  if (COMMAND_FIELDS.has(key) && typeof value === 'string') {
    // 短命令原样保留；长命令保留头部（头部才是「跑了什么」的判据）
    if (value.length <= COMMAND_HEAD_CHARS) return value;
    return `${value.slice(0, COMMAND_HEAD_CHARS)}…[+${value.length - COMMAND_HEAD_CHARS} chars]`;
  }
  return elidedMarker(size);
}

// 参数摘要 write-once 缓存：同 args 对象 + 同配置 → 同值（与 pointerCache 同理）
const argDigestCache = new WeakMap<object, { fingerprint: string; value: unknown }>();

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
