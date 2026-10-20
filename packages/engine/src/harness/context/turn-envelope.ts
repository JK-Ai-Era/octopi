/**
 * Turn start/end 信封（全回放 · append-only）
 *
 * 语法（唯一合法形态，无 legacy 分支）：
 * - 开 turn：user 消息正文 = `<turn_start id at>…<user_message>…</user_message></turn_start>`
 * - 闭 turn：独立消息 `<turn_end id/>`，`metadata.source='turnEnd'`
 *
 * 不变式：每个 `turn_start.id` ⟺ 恰一条 `turn_end.id`；定形后字节冻结。
 * 正文经 XML 转义嵌入，用户原文不得截断信封。
 */

import { getTextContent } from '@octopi-agent/core/types.js';
import type { Message } from '@octopi-agent/core/types.js';

/** turn_start 元素的 id 形态（会话内单调 t1,t2,…） */
export function formatTurnId(seq: number): string {
  return `t${seq}`;
}

/** 归一化 Message.content → 纯文本（多模态取 text 块拼接；空 content → ''） */
export function messageText(content: Message['content'] | undefined | null): string {
  if (content == null) return '';
  return getTextContent(content);
}

/** user 原文嵌入 XML 前的最小转义（防伪影标签截断信封） */
export function escapeUserMessageText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 解转义（extractUserMessageText 出口） */
export function unescapeUserMessageText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 开 turn 信封：一次定形后的 user 消息正文 */
export function formatTurnStartContent(params: {
  turnId: string;
  /** ISO 或已格式化时间，写入一次 */
  at: string;
  /** `<turn_context>…</turn_context>` 整段（含 boilerplate） */
  turnContextXml: string;
  /** 用户原文（将被 XML 转义后放入 user_message） */
  userText: string;
}): string {
  return (
    `<turn_start id="${params.turnId}" at="${params.at}">\n` +
    `${params.turnContextXml.trim()}\n` +
    `<user_message>\n${escapeUserMessageText(params.userText)}\n</user_message>\n` +
    `</turn_start>`
  );
}

/** 闭 turn 消息正文（write-once） */
export function formatTurnEndContent(turnId: string): string {
  return `<turn_end id="${turnId}"/>`;
}

/**
 * 构造 turn_context 块（ephemeral 语义 + 各槽位）。
 * boilerplate **禁止**出现字面量 `<user_message>` / `</user_message>`（解析取最后一块）。
 */
export function formatTurnContextXml(params: {
  turnId: string;
  /** 已拼好的槽位正文（runtime_snapshot / grounding / attachments）；可空 */
  slotsXml: string;
}): string {
  const boilerplate =
    `[turn-scoped · ephemeral · ${params.turnId}]\n` +
    `Picks and snapshots below apply ONLY to the user text in this same turn.\n` +
    `They are not durable memory. Do not carry them forward as facts.\n` +
    `A later turn_context supersedes these picks for new work.\n` +
    `Transcript beats any stale pick.`;
  const slots = params.slotsXml.trim();
  return (
    `<turn_context authority="ephemeral" applies_to="this-turn-only" supersession="later-turn-wins">\n` +
    `<boilerplate>\n${boilerplate}\n</boilerplate>\n` +
    (slots ? `${slots}\n` : '') +
    `</turn_context>`
  );
}

/**
 * 从 turn_start 正文取出用户原文供检索 / UI / 摘要。
 * 非 turn_start 正文原样返回。
 * 取**最后一个** user_message 块（boilerplate 禁止再写该标签字面量）。
 */
export function extractUserMessageText(content: string | Message['content'] | undefined | null): string {
  const raw = messageText(content);
  const re = /<user_message>\n?([\s\S]*?)\n?<\/user_message>/g;
  let last: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    last = m[1];
  }
  return last !== undefined ? unescapeUserMessageText(last.trim()) : raw;
}

/**
 * 剥掉 `<turn_context>…</turn_context>`（摘要语义输入 / UI）。
 * 保留 `<user_message>` 与 turn_start/turn_end 骨架（或在 UI 场景配合 extractUserMessageText）。
 */
export function stripTurnContextXml(content: string | Message['content'] | undefined | null): string {
  return messageText(content)
    .replace(/<turn_context[\s\S]*?<\/turn_context>/g, '')
    .trim();
}

/** 是否 turn_start 正文（接受 string 或 Message.content） */
export function isTurnStartContent(content: string | Message['content'] | undefined | null): boolean {
  return /<turn_start[\s>]/.test(messageText(content));
}

/** 是否 turn_end 正文 */
export function isTurnEndContent(content: string | Message['content'] | undefined | null): boolean {
  return /<turn_end[\s/>]/.test(messageText(content));
}

/** 从 turn_start / turn_end 正文解析 id */
export function parseTurnIdFromContent(
  content: string | Message['content'] | undefined | null,
): string | undefined {
  const m = /<turn_(?:start|end)\s[^>]*\bid="([^"]+)"/.exec(messageText(content));
  return m ? m[1] : undefined;
}

/**
 * 拼 turn_context 内的槽位 XML（runner 注入）。
 * @param parts - 非空槽位段；空段被跳过
 */
export function joinSlotXml(parts: Array<{ tag: string; body: string }>): string {
  return parts
    .filter((p) => p.body.trim().length > 0)
    .map((p) => `<${p.tag}>\n${p.body.trim()}\n</${p.tag}>`)
    .join('\n');
}

/** 任意 content 归一化后的用户正文（UI / 载体扫描共用） */
export function unwrapUserText(content: string | Message['content'] | undefined | null): string {
  return extractUserMessageText(content);
}
