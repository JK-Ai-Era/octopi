/**
 * 机械降级 — 零 LLM 的压缩执行（purpose 账本，单级）
 *
 * 定位（2026-11-04 拍板）：**应急通道**，只在摘要无法产出时接手——
 * provider 报错/超时、输出闸门二次判污染、摘要请求放不进窗口。它不是常态压缩
 * （常态走交接式摘要），因此不需要渐进、不需要分级，一次做到最大化压缩。
 *
 * 形态：整段 middle/messages 替换为 **一条 purpose 账本消息**——保留「调用过什么、
 * 为什么调用、哪条失败」，丢弃结果正文与参数载荷。依据：
 * - purpose 是工具调用的必填契约（`≤120 字符`，动词+宾语+目标），本身就是
 *   「任务执行情况」的最小可读摘要，实测 510/510 调用齐备；
 * - 生产实测压缩比 ~16x（475k → 29k 字符），远优于结果打码的 ~3.7x 地板
 *   （aging 指针约 557 字符/调用，账本约 58 字符/调用）；
 * - 省下的正是最不值钱的部分（长结果正文），留下的正是最值钱的（意图与失败）。
 *
 * **超预算不静默丢条目**：账本已是最小形态，若仍超预算说明该会话不宜继续——
 * 如实上报 `overBudget`，由上层决定告知用户开新会话。丢条目等于静默失忆。
 *
 * 单源：占位文案与判别见 ./messages.ts；错别话术禁止在本模块手写第二份。
 *
 * @module harness/context/capabilities/compact/mechanical
 */

import type { Message } from '@octopi-agent/core/types.js';
import { HeuristicTokenEstimator } from '../../token-estimator.js';
import { MECHANICAL_NOTICE_TRUNCATED, hasToolCall, isToolResultMessage } from './messages.js';

/**
 * 账本单条 purpose 的防御上限（字符）。
 * purpose 契约本身 ≤120；超长只可能来自历史数据或非本契约客户端，截断防单条撑爆账本。
 */
const LEDGER_PURPOSE_MAX = 160;

/** 账本单条 error 上限（字符）：错误文案优先保真，仅在异常长时截断 */
const LEDGER_ERROR_MAX = 200;

/** purpose 缺失时的诚实占位（正常不出现：purpose 是必填参数，缺失会在调用期直接报错） */
const MISSING_PURPOSE = '(purpose not recorded)';

/**
 * 工具调用账本（`name + purpose` 逐行）——降级时的「做过什么」无损索引。
 *
 * 输出形态：
 * ```
 * - file_edit: Add event-vocabulary disposition to P5 row
 * - shell: Stage explicit paths, commit, and tag v0.98.17
 *   ! project_run: test failed (exit 1)
 * ```
 * error 结果附在对应调用行下方（错误可追溯性优先，永不省略）。
 *
 * @param messages - 被降级丢弃的消息
 * @returns 账本文本（可为空串）
 */
export function buildToolCallLedger(messages: Message[]): string {
  const lines: string[] = [];
  // 调用行只从 toolCalls 产出（时间序）；错误行从 toolResults 追加到最近一次产出之后，
  // 保证「哪条调用失败」可定位——跨消息配对时以 toolCallId 归位。
  const lineIndexByCallId = new Map<string, number>();
  for (const msg of messages) {
    for (const tc of msg.toolCalls ?? []) {
      const raw = (tc.arguments as Record<string, unknown> | undefined)?.purpose;
      const purpose =
        typeof raw === 'string' && raw.trim()
          ? raw.trim().slice(0, LEDGER_PURPOSE_MAX)
          : MISSING_PURPOSE;
      lines.push(`- ${tc.name}: ${purpose}`);
      lineIndexByCallId.set(tc.id, lines.length - 1);
    }
    for (const tr of msg.toolResults ?? []) {
      if (lineIndexByCallId.get(tr.toolCallId) === undefined && tr.error === undefined) {
        // 孤儿 result（调用方消息不在本账本范围/未被砍）：结果被账本化也必须留痕——
        // name 不可失忆，否则「做过什么」无从追溯（只留 error 行不够）
        lines.push(`- ${tr.name ?? tr.toolCallId}: ${MISSING_PURPOSE}`);
        lineIndexByCallId.set(tr.toolCallId, lines.length - 1);
      }
      if (tr.error === undefined) continue;
      const err = tr.error.length > LEDGER_ERROR_MAX ? `${tr.error.slice(0, LEDGER_ERROR_MAX)}…` : tr.error;
      const errorLine = `  ! ${tr.name ?? tr.toolCallId}: ${err}`;
      const at = lineIndexByCallId.get(tr.toolCallId);
      if (at === undefined) {
        // 调用方消息已被丢弃（跨切片降级）：错误仍须保留，独立成行——宁可错位，不可丢失
        lines.push(errorLine);
        continue;
      }
      // 紧贴其调用行插入（倒序插入时下标不失效：同一条目只插一次）
      lines.splice(at + 1, 0, errorLine);
      for (const [id, idx] of lineIndexByCallId) {
        if (idx > at) lineIndexByCallId.set(id, idx + 1);
      }
    }
  }
  return lines.join('\n');
}

/**
 * 账本消息构造（user 角色——中段 system 会被部分网关拒绝）。
 *
 * @param ledger - 账本文本（可为空）
 * @param removedCount - 被替换的消息条数
 * @returns 账本视图消息
 */
export function asLedgerMessage(ledger: string, removedCount: number): Message {
  const head = `${MECHANICAL_NOTICE_TRUNCATED} ${removedCount} earlier entries replaced by a tool-call ledger to fit context window]`;
  const body = ledger
    ? `[Tool call ledger — do NOT redo these unless explicitly asked]\n${ledger}\n[Tool results and arguments were dropped; re-read files/sources if you need their content. Check session task list via task_* before continuing]`
    : '[No tool calls in the dropped range. Check session task list via task_* before continuing]';
  return {
    role: 'user',
    content: `${head}\n${body}`,
    timestamp: Date.now(),
    // 语义诚实：账本是机械降级产物，**不是**摘要——不得复用 contextSummary 标记，
    // 否则下游（持久化/回放/审计）会把它当交接摘要处理。
    metadata: { source: 'contextLedger' as const },
  };
}

/**
 * 账本截断（保留近尾 + 头部替换为账本）——**物理溢出兜底专用**。
 *
 * 与 `mechanicalDegrade` 的分工：本函数服务「消息必须放回窗口否则请求 400」的场景
 * （overflow 路径），所以在丢头部的同时**保住近尾原文**（最近的现场最值钱）；
 * `mechanicalDegrade` 服务「摘要失败」的场景，一次全量转账本。
 *
 * 形态（middle 替换体，外层 head/tail 由调用方拼接）：`[账本说明 + 近尾]`。
 * - 保留近尾：预算驱动从头丢弃，但**保底**不破（禁止只留 4 条）；
 * - 边界对齐：tool_call/tool_result 对同进同出，保留尾不得起于孤儿结果
 *  （孤儿时**回退**切点把调用一并纳入 kept——宁可胖不可拆对；向前跳会把连续
 *  tool 结果一路丢光、整段 middle 被吞）；
 * - 无可丢弃时原样返回（禁止「0 removed」假通知膨胀）。
 *
 * @param messages - 待降级消息
 * @param opts - targetTokens 预算、估算器、minKeep 保底
 *  - targetTokens 缺省不是「不压缩」，而是**只丢到保底**（最大压缩）；
 *  - minKeep 为**纯保底**（拍板常量，非可调参数）：显式传入即用该值（「压到目标」的
 *    机械压缩传 2 = 旧 TruncateCompressor「至少留 2」口径，不叠 15%——叠加会把保 2
 *    架空成 15%、粘滞增量撑胖后在复用轮挤出 overflow 补摘要）；缺省 = max(6, 15%)
 *    （旧 fallbackTruncate / conservativeTruncate 失败兜底口径）。
 * @returns 截断结果（result 含账本说明或原样 + droppedCount + ledgerKept）
 */
export function ledgerTruncate(
  messages: Message[],
  opts?: {
    targetTokens?: number;
    estimator?: { estimateMessages(ms: Message[]): number };
    minKeep?: number;
  },
): { result: Message[]; droppedCount: number; ledgerKept: boolean } {
  if (messages.length === 0) return { result: [], droppedCount: 0, ledgerKept: false };
  // 尺子内建兜底：给了 targetTokens 却无 estimator 时不得静默不截断
  const estimator = opts?.estimator ?? new HeuristicTokenEstimator();
  const floorKeep =
    opts?.minKeep != null
      ? Math.min(opts.minKeep, messages.length)
      : Math.min(Math.max(6, Math.ceil(messages.length * 0.15)), messages.length);
  // 切片求和逐轮 O(n²) 叠加：内置估算器对单条消息有 WeakMap 缓存（求和=缓存查找，
  // 实测可接受）；改为前缀和会改变自定义估算器的预算语义，不值得
  const tokensOf = (ms: Message[]): number => estimator.estimateMessages(ms);
  let cut = 0;
  while (
    messages.length - cut > floorKeep &&
    (opts?.targetTokens == null || tokensOf(messages.slice(cut)) > opts.targetTokens)
  ) {
    // 对齐：tool_call+tool_result 对同进同出
    const next = messages[cut + 1];
    cut += hasToolCall(messages[cut]!) && next !== undefined && isToolResultMessage(next) ? 2 : 1;
  }
  // 保留尾不得起于孤儿结果（其调用已被丢弃）：回退切点把调用一并纳入 kept（宁可胖，
  // 不可拆对、不可吞光——向前跳过会在「连续 tool 结果收尾」时把 kept 清空）
  while (cut > 0 && isToolResultMessage(messages[cut]!)) {
    cut -= 1;
  }
  const dropped = messages.slice(0, cut);
  const kept = messages.slice(cut);
  if (dropped.length === 0) {
    return { result: [...messages], droppedCount: 0, ledgerKept: false };
  }

  const ledger = buildToolCallLedger(dropped);
  const notice = asLedgerMessage(ledger, dropped.length);
  return { result: [notice, ...kept], droppedCount: dropped.length, ledgerKept: ledger.length > 0 };
}

/**
 * 机械降级：整段替换为 purpose 账本（零 LLM，单级，无可再降）。
 *
 * @param messages - 待降级消息
 * @param opts - targetTokens（用于判定是否仍需上报超预算）与估算器
 * @returns 降级结果
 *  - `result`：单条账本消息（入参为空时为空数组）
 *  - `tokensAfter`：账本 token 估算
 *  - `overBudget`：账本仍超 targetTokens —— 已无可降空间，调用方须如实上报，
 *    不得再丢条目（丢条目 = 静默失忆）
 *  - `droppedSummary`：产物描述
 */
export function mechanicalDegrade(
  messages: Message[],
  opts?: {
    targetTokens?: number;
    estimator?: { estimateMessages(ms: Message[]): number };
  },
): {
  result: Message[];
  tokensAfter: number;
  overBudget: boolean;
  droppedSummary?: string;
} {
  if (messages.length === 0) {
    return { result: [], tokensAfter: 0, overBudget: false };
  }
  const estimator = opts?.estimator ?? new HeuristicTokenEstimator();
  const ledger = buildToolCallLedger(messages);
  const ledgerMsg = asLedgerMessage(ledger, messages.length);
  const result = [ledgerMsg];
  const tokensAfter = estimator.estimateMessages(result);
  const overBudget = opts?.targetTokens != null && tokensAfter > opts.targetTokens;
  const callCount = messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
  return {
    result,
    tokensAfter,
    overBudget,
    droppedSummary: `Replaced ${messages.length} messages (${callCount} tool calls) with a purpose ledger`,
  };
}

/**
 * 工具执行账本化（收敛阶梯第 1–3 轮专用，arch/overflow-redesign.md §3）。
 *
 * 语义（丢弃次序原则：数据细节 → 执行记录 → 工作窗口 → 放弃，从最可再生到最不可再生）：
 * - **账本化对象 = 工具执行段**（assistant(toolCalls) + tool(result) 对，同进同出）——
 *   执行记录可再生（可重执行/磁盘找回），先于工作窗口丢弃；
 * - **跳过保留**：真 user 消息（最不可再生）、assistant 文本（非执行记录）、
 *   合成消息（contextLedger/contextSummary 占位——已是索引/交接形态，不可再降）；
 * - **tailKeep 近尾保护**（工作窗口）：近尾 tailKeep 条内的工具执行不账本化。
 *
 * 形态：被账本化 run 的原位移除，**第一个**被砍 run 的下标处放一个合并 notice
 * （buildToolCallLedger 汇总全部被砍执行的 name+purpose+errors）——与 fold 同构：
 * foldTransformView 对多 covers runs 渲染**一个**占位（firstIndex 处、区间内保护类原样），
 * 本函数的产物即 fold 后视图，守门量的与发送的是同一个产物。
 *
 * 每档独立调用（幂等）：无候选时原样返回——天然支持「每档对原视图重算」，不累积吞账本。
 *
 * @param messages - 原始视图（收敛循环对同一 view 每档独立调用）
 * @param opts - tailKeep 近尾保护档、估算器、targetTokens（缺省=砍掉全部候选）
 * @returns 产物视图 + 被账本化条数（0=砍不动/无候选）
 */
export function toolExecutionLedgerTrim(
  messages: Message[],
  opts: { tailKeep: number },
): { result: Message[]; droppedCount: number } {
  if (messages.length === 0) return { result: [], droppedCount: 0 };
  const isSynthetic = (m: Message): boolean =>
    m.metadata?.source === 'contextLedger' || m.metadata?.source === 'contextSummary';
  const isToolExec = (m: Message): boolean =>
    !isSynthetic(m) && (hasToolCall(m) || isToolResultMessage(m));

  // 档位即语义（B2 拍板 2026-11-08）：tailKeep 保护窗内的消息原样保留，
  // **窗外工具执行全部账本化**（砍满候选窗）——砍量由档位定义，不在档内提前停；
  // 「装得下吗」由外层 fits 判（校准+aging 同一把尺），砍量尺与验收尺不混。
  const tailFloor = Math.max(0, messages.length - Math.max(0, opts.tailKeep));
  // 候选 run：[0, tailFloor) 内的连续工具执行段（tool_call/result 对边界对齐——
  // 整 run 同进同出，宁可少砍不可拆对）
  interface ExecRun { start: number; end: number } // inclusive
  const runs: ExecRun[] = [];
  let i = 0;
  while (i < tailFloor) {
    if (!isToolExec(messages[i]!)) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < tailFloor && isToolExec(messages[i]!)) i += 1;
    let end = i - 1;
    // 边界对齐（评审 B1）：run 尾是 tool_call 而其 result 在 tail 窗内/窗后时整对不砍——
    // end 允许降到 start-1（单条 run 的 call 与 result 拆对正是孤儿 result 400 的来源）
    while (end >= start && hasToolCall(messages[end]!) && end + 1 < messages.length && isToolResultMessage(messages[end + 1]!)) {
      end -= 1;
    }
    if (end < start) continue; // 整对落在 tail 窗内 → 本 run 不砍（宁可少砍，不可拆对）
    runs.push({ start, end });
  }
  if (runs.length === 0) return { result: [...messages], droppedCount: 0 };

  // 砍满：全部候选 run 一次账本化（每档对原视图独立、幂等——累积截断会吞前轮账本）
  const droppedIdx = new Set<number>();
  for (const r of runs) for (let k = r.start; k <= r.end; k++) droppedIdx.add(k);
  const droppedMsgs = runs.flatMap((r) => messages.slice(r.start, r.end + 1));
  const ledger = buildToolCallLedger(droppedMsgs);
  const notice = asLedgerMessage(ledger, droppedMsgs.length);
  const result: Message[] = [];
  let noticePlaced = false;
  for (let idx = 0; idx < messages.length; idx++) {
    if (droppedIdx.has(idx)) {
      if (!noticePlaced) {
        result.push(notice);
        noticePlaced = true;
      }
      continue;
    }
    result.push(messages[idx]!);
  }
  return { result, droppedCount: droppedMsgs.length };
}
