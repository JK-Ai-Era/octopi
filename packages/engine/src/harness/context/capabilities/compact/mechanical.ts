/**
 * 机械降级阶梯 — 零 LLM 的压缩执行（打码 → 账本截断）
 *
 * B′（2026-11-03 拍板）：工具输出打码**降为机械降级阶梯第一级**——零 LLM、
 * 不丢轮次、error 永不打码；「先打码、不够再账本截断」。语义收敛为
 * 「有 summarize 就出真摘要；无 summarize / 摘要失败才走机械」。
 *
 * 截断兜底三→一（债务 #5）：原 `LLMSummaryCompressor.fallbackTruncate` /
 * `TruncateCompressor` / `DefaultContextEngine.conservativeTruncate` 三套收敛为
 * `ledgerTruncate` 一份（账本单源；占位文案单源见 ./messages.ts）。
 *
 * @module harness/context/capabilities/compact/mechanical
 */

import type { Message } from '@octopi-agent/core/types.js';
import { toolResultBody } from '../../tool-result-body.js';
import { HeuristicTokenEstimator } from '../../token-estimator.js';
import {
  MECHANICAL_NOTICE_TRUNCATED,
  hasToolCall,
  isToolResultMessage,
} from './messages.js';

/**
 * 打码占位（中性归档措辞——禁止诱导重跑）。
 * 成功结果被降级时替换正文；error 载荷永不打码（错误可追溯性优先，与 B2 同红线）。
 */
export const TOOL_RESULT_PLACEHOLDER =
  '[Tool output archived in session log — do NOT re-run unless the output is needed again.]';

/**
 * 打码阈值（字符）：旧工具输出正文超过此长度才降级。
 * 拍板常量（B′ 自 HybridCompressor 继承），**不是**可调参数——Q2 已删的 2000/200
 * 两魔数是 SmartRouter 路由阈值，与此处无关；如需调整须走拍板，不走配置。
 */
export const TOOL_RESULT_MASK_THRESHOLD = 200;

/**
 * 工具调用账本（name+args 紧凑清单）——降级时的「做过什么」无损索引。
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
 * 机械降级第一级：旧工具输出打码（B′）——零 LLM、**不丢轮次**、error 永不打码。
 *
 * 语义（自 HybridCompressor.preprocessToolResults 迁入，行为保持）：
 * - 最后一个 tool_call 之后的工具结果是「最近工作现场」，不打码；
 * - 更旧的成功结果正文 > `maxChars` → 占位符；error 结果原样保留。
 *
 * @param messages - 待降级消息（视图级处理，不写回持久层）
 * @param opts - maxChars 阈值（缺省 200）
 * @returns 打码结果（result + maskedCount 被打码的结果数）
 */
export function maskFatToolResults(
  messages: Message[],
  opts?: { maxChars?: number },
): { result: Message[]; maskedCount: number } {
  const maxChars = opts?.maxChars ?? TOOL_RESULT_MASK_THRESHOLD;
  const result: Message[] = [];
  let maskedCount = 0;
  let lastToolCallIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasToolCall(messages[i]!)) {
      lastToolCallIndex = i;
      break;
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (isToolResultMessage(msg) && msg.toolResults?.length) {
      if (i > lastToolCallIndex) {
        result.push(msg);
        continue;
      }
      let touched = false;
      const masked = msg.toolResults.map((tr) => {
        if (tr.error !== undefined) return tr;
        if (toolResultBody(tr).length <= maxChars) return tr;
        touched = true;
        return { ...tr, result: TOOL_RESULT_PLACEHOLDER };
      });
      if (touched) maskedCount += 1;
      result.push(touched ? { ...msg, toolResults: masked } : msg);
      continue;
    }
    result.push(msg);
  }
  return { result, maskedCount };
}

/**
 * 机械降级第二级：账本截断（唯一截断兜底，三→一）。
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
  const notice: Message = {
    role: 'user',
    content: ledger
      ? `${MECHANICAL_NOTICE_TRUNCATED} ${dropped.length} earlier messages removed to fit context window]\n[Tool call ledger — do NOT redo these unless explicitly asked]\n${ledger}\n[Check session task list via task_* before continuing]`
      : `${MECHANICAL_NOTICE_TRUNCATED} ${dropped.length} earlier messages removed to fit context window]\n[Check session task list via task_* before continuing]`,
    timestamp: Date.now(),
    metadata: { source: 'contextSummary' as const },
  };
  return { result: [notice, ...kept], droppedCount: dropped.length, ledgerKept: ledger.length > 0 };
}

/**
 * 机械降级阶梯：先打码（不丢轮次），不够再账本截断（B′）。
 *
 * @param messages - 待降级消息
 * @param opts - targetTokens（打码后达标即止；缺省直接进账本截断）与估算器
 * @returns 降级结果（result + droppedSummary 描述；完全无操作时不带 droppedSummary）
 */
export function mechanicalDegrade(
  messages: Message[],
  opts?: {
    targetTokens?: number;
    estimator?: { estimateMessages(ms: Message[]): number };
    minKeep?: number;
  },
): { result: Message[]; droppedSummary?: string } {
  const { result: masked, maskedCount } = maskFatToolResults(messages);
  const estimator = opts?.estimator ?? new HeuristicTokenEstimator();
  const maskedTokens = estimator.estimateMessages(masked);
  const withinTarget = opts?.targetTokens != null && maskedTokens <= opts.targetTokens;
  if (withinTarget && maskedCount > 0) {
    return { result: masked, droppedSummary: 'Old tool outputs masked' };
  }
  const {
    result: truncated,
    droppedCount,
    ledgerKept,
  } = ledgerTruncate(masked, { ...opts, estimator });
  // 诚实上报：打码与截断都发生时两级都要报；账本为空不得写 "ledger kept"
  const parts: string[] = [];
  if (maskedCount > 0) parts.push(`${maskedCount} tool results masked`);
  if (droppedCount > 0) {
    parts.push(`${droppedCount} messages truncated${ledgerKept ? ' (tool call ledger kept)' : ''}`);
  }
  return { result: truncated, droppedSummary: parts.length > 0 ? parts.join('; ') : undefined };
}
