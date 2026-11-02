/**
 * 视图消息构造 — 摘要包装与机械占位的唯一实现
 *
 * 摘要包装（`[Conversation Summary]`）与机械占位说明（`[Context truncated:` 等）
 * 此前散落在 llm-summarizer / truncate-compressor / default-context-engine 等 ~6 处
 * （债务 #4）。收敛后：文案、包装、识别全部单源于本模块——**生产者与识别串同源**，
 * 新增占位类型时不得绕过这里手写字面量。
 *
 * @module harness/context/capabilities/compact/messages
 */

import type { Message } from '@octopi-agent/core/types.js';

// ── 摘要包装（族 A 交接摘要的视图载体） ──

/** 摘要标记（extract / 调试 / 幂等包装判别共用） */
export const SUMMARY_MARKER = '[Conversation Summary]';

/**
 * 摘要正文包装：确保带 `[Conversation Summary]` 标记（幂等）。
 *
 * @param text - 摘要正文
 * @returns 带标记的摘要正文
 */
export function wrapSummaryText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes(SUMMARY_MARKER)) return trimmed;
  return `${SUMMARY_MARKER}\n\n${trimmed}`;
}

/**
 * 摘要消息构造（user 角色——中段 system 会被部分网关拒绝）。
 *
 * 覆盖边界行（评审 F11）按覆盖点动态渲染，**不写进摘要正文**：
 * 写进正文会把过期数字烘死、随失败累积、还会被当 Previous summary 回喂模型。
 *
 * @param summary - 摘要正文
 * @param coveredEnd - 摘要覆盖终点（下标，不含）；>0 时附 [Coverage] 行
 * @returns 摘要视图消息
 */
export function asSummaryMessage(summary: string, coveredEnd?: number): Message {
  const coverage =
    coveredEnd && coveredEnd > 0
      ? `\n\n[Coverage] This handoff covers the conversation up to message ${coveredEnd}; later messages appear verbatim and take precedence.`
      : '';
  return {
    role: 'user',
    content: wrapSummaryText(`${summary}${coverage}`),
    timestamp: Date.now(),
    metadata: { source: 'contextSummary' as const },
  };
}

// ── 机械占位（非摘要，永不进 previousSummary） ──

/** 账本截断占位（生产者：mechanical.ts ledgerTruncate） */
export const MECHANICAL_NOTICE_TRUNCATED = '[Context truncated:';
/** 头切截断占位（生产者已随 TruncateCompressor 退休；识别保留兜旧持久化状态） */
export const MECHANICAL_NOTICE_COMPRESSED = '[Context compressed:';
/** 结构压缩占位（生产者：compact 引擎 head_tail_only / 文本结构路径） */
export const MECHANICAL_NOTICE_STRUCTURAL = '[Structural compact]';

/**
 * 机械降级占位说明判别（非语义摘要）：首条实质行以占位标记开头即认定。
 * 只看首行而非全文 includes——真实摘要引用这些字符串（如记录「曾发生截断」）不得被误杀。
 *
 * @param text - 候选摘要正文
 * @returns 是否为机械占位说明
 */
export function isMechanicalNotice(text: string): boolean {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line === SUMMARY_MARKER) continue;
    return (
      line.startsWith(MECHANICAL_NOTICE_TRUNCATED) ||
      line.startsWith(MECHANICAL_NOTICE_COMPRESSED) ||
      line.startsWith(MECHANICAL_NOTICE_STRUCTURAL)
    );
  }
  return false;
}
