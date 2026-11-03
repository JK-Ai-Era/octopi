/**
 * 切片手术 — 视图边界对齐与语义过滤的唯一实现
 *
 * P3（2026-11-03）自 DefaultContextEngine 迁入：引擎瘦身为触发/状态层，
 * 「怎么切」属执行手术归本模块。**修 #10**：compact 引擎自身的 head/tail 切片
 * 从此也走 `alignViewSplit`（此前裸 slice 会把 tool_call/tool_result 对劈开：
 * head 停在带 toolCalls 的 assistant 上 → 悬空调用；tail 起于 tool 结果 →
 * 孤儿结果，两者都会被严格网关 400）。
 *
 * @module harness/context/capabilities/compact/view-split
 */

import type { Message } from '@octopi-agent/core/types.js';
import {
  extractUserMessageText,
  isTurnStartContent,
} from '../../turn-envelope.js';
import { isToolResultMessage } from './messages.js';

/**
 * 视图切分边界对齐（不拆 tool_call/tool_result 对）。
 *
 * head 不得停在带 toolCalls 的 assistant 上（其结果落入中间段，视图里会成悬空调用）；
 * tail 不得起于 tool 结果（其调用在中间段，会成孤儿结果）。
 *
 * @param messages - 全量消息
 * @param headCount - 期望头部条数
 * @param tailCount - 期望尾部条数
 * @returns 对齐后的 head 终点（不含）与 tail 起点（含）；对齐后实际条数可能与期望不同
 */
export function alignViewSplit(
  messages: Message[],
  headCount: number,
  tailCount: number,
): { headEnd: number; tailStart: number } {
  let headEnd = Math.max(0, Math.min(headCount, messages.length));
  while (headEnd > 0 && (messages[headEnd - 1]?.toolCalls?.length ?? 0) > 0) {
    headEnd--;
  }
  let tailStart = Math.max(0, messages.length - tailCount);
  // tailCount=0 时 tailStart === messages.length（空尾）：不得越界读 messages[len]
  while (
    tailStart > headEnd &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]!)
  ) {
    tailStart--;
  }
  // protectN 总和 > messages.length 时裸值可畸形（headEnd > tailStart）：夹回合法切点，
  // 禁止 head/tail 重叠重复出消息（调用方多有过短早退，这里是 API 直调用户的护栏）
  if (tailStart < headEnd) {
    tailStart = headEnd;
  }
  return { headEnd, tailStart };
}

/**
 * 压缩/摘要的语义输入：丢掉托管 system 与 turn 信封元数据
 * （turn_context picks 不进 previousSummary——防陈旧择取固化进摘要）；
 * turn_start 只保留 <user_message> 正文。
 *
 * @param messages - 待过滤消息
 * @returns 语义历史（过滤后的消息列表）
 */
export function semanticHistory(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === 'system' && m.metadata?.source === 'systemPrompt') continue;
    if (m.metadata?.source === 'turnEnd') continue;
    if (m.metadata?.source === 'knowledgeGrounding') continue;
    if (m.metadata?.source === 'runtimeSnapshot') continue;
    if (m.metadata?.source === 'sessionAttachment') continue;
    if (isTurnStartContent(m.content)) {
      out.push({ ...m, content: extractUserMessageText(m.content) });
      continue;
    }
    out.push(m);
  }
  return out;
}
