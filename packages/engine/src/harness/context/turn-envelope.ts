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

/**
 * 是否 turn_start 正文（接受 string 或 Message.content）。
 *
 * 判形锚定到**正文开头**（允许前导空白）：真实信封由 formatTurnStartContent 定形、必然以开标签起头；
 * 正文中途引用标签字面量（讨论协议/贴日志/知识语料）不得命中——否则普通 user 发言会被
 * 写一次守卫误判「已定形」（arch/open-problems.md D7）。
 */
export function isTurnStartContent(content: string | Message['content'] | undefined | null): boolean {
  return /^\s*<turn_start[\s>]/.test(messageText(content));
}

/** 是否 turn_end 正文（同 isTurnStartContent：锚定正文开头，防止字面量误判） */
export function isTurnEndContent(content: string | Message['content'] | undefined | null): boolean {
  return /^\s*<turn_end[\s/>]/.test(messageText(content));
}

/** 从 turn_start / turn_end 正文解析 id */
export function parseTurnIdFromContent(
  content: string | Message['content'] | undefined | null,
): string | undefined {
  const m = /<turn_(?:start|end)\s[^>]*\bid="([^"]+)"/.exec(messageText(content));
  return m ? m[1] : undefined;
}

/** turn_context 内的槽位段（机器生成块，非用户发言） */
export interface TurnEnvelopeSlot {
  /** 槽位标签（runtime_snapshot / session_attachments / knowledge_grounding） */
  tag: string;
  /** 槽位正文（不含包裹标签，已 trim） */
  body: string;
}

/** turn_start 信封解析结果 */
export interface TurnEnvelopeParts {
  /** `<turn_start id>`；缺失时 undefined */
  turnId?: string;
  /** `<turn_start at>`；缺失时 undefined */
  at?: string;
  /** turn_context 内槽位（boilerplate 不计；白名单外标签跳过；按出现顺序） */
  slots: TurnEnvelopeSlot[];
  /** `<user_message>` 正文（已解转义）；块缺失时为 ''（坏信封不回退整段原文冒充用户发言） */
  userText: string;
  /** 是否含 `<user_message>` 块（false = 信封不完整，UI 应标注而非把整封当用户原文） */
  hasUserMessage: boolean;
}

/**
 * 槽位标签集（**转义清单的唯一真源**）：joinSlotXml 生产、escapeSlotBody 定向转义、
 * parseTurnEnvelope 白名单三处同源引用——新增槽位必须进此表，转义与白名单随之生效。
 * 白名单外的同形标签视为正文噪音 / 注入尝试。
 */
export const SLOT_TAGS = [
  'runtime_snapshot',
  'session_attachments',
  'knowledge_grounding',
] as const;
export type SlotTag = (typeof SLOT_TAGS)[number];

const SLOT_TAG_SET: ReadonlySet<string> = new Set(SLOT_TAGS);

/**
 * 槽位正文定向转义（D7 方案 A′）：把正文里的同名开/闭标签字面量转义为 XML 实体，
 * 防语料（知识 / grounding / 附件）伪造闭合提前截断槽位、或伪造新槽位条目。
 * 只动 `<tag>` / `</tag>` / `<tag ` 三种序列；其余内容（含其他合法 XML）原样保留。
 *
 * @param tag - 槽位标签（配合 SLOT_TAGS 使用）
 * @param body - 槽位正文
 * @returns 同名字面量已转义的正文
 */
export function escapeSlotBody(tag: string, body: string): string {
  return body
    .replaceAll(`</${tag}>`, `&lt;/${tag}&gt;`)
    .replaceAll(`<${tag}>`, `&lt;${tag}&gt;`)
    .replaceAll(`<${tag} `, `&lt;${tag} `);
}

/**
 * 解析 turn_start 信封（槽位 + 用户原文）。
 *
 * 入口判形锚定正文开头（同 isTurnStartContent）；turn_context 取**最后一块**
 * （与 extractUserMessageText 取最后一个 user_message 同口径）；槽位只认
 * SLOT_TAGS 白名单（防正文伪影伪造任意槽位条目）。
 *
 * @param content - 消息正文（string 或 Message.content）
 * @returns 信封解析结果；非 turn_start 正文返回 null
 */
export function parseTurnEnvelope(
  content: string | Message['content'] | undefined | null,
): TurnEnvelopeParts | null {
  const raw = messageText(content);
  if (!/^\s*<turn_start[\s>]/.test(raw)) return null;
  const at = /\sat="([^"]*)"/.exec(raw.slice(0, raw.indexOf('>') + 1))?.[1];
  const slots: TurnEnvelopeSlot[] = [];
  const ctxRe = /<turn_context[^>]*>([\s\S]*?)<\/turn_context>/g;
  let ctx = '';
  let cm: RegExpExecArray | null;
  while ((cm = ctxRe.exec(raw)) !== null) {
    ctx = cm[1] ?? '';
  }
  const slotRe = /<([a-z][a-z0-9_-]*)>\n?([\s\S]*?)\n?<\/\1>/g;
  let sm: RegExpExecArray | null;
  while ((sm = slotRe.exec(ctx)) !== null) {
    const tag = sm[1]!;
    if (tag === 'boilerplate') continue;
    if (!SLOT_TAG_SET.has(tag)) continue;
    slots.push({ tag, body: sm[2]!.trim() });
  }
  const hasUserMessage = /<user_message>/.test(raw);
  return {
    turnId: parseTurnIdFromContent(raw),
    at,
    slots,
    userText: hasUserMessage ? extractUserMessageText(raw) : '',
    hasUserMessage,
  };
}

/**
 * 拼 turn_context 内的槽位 XML（runner 注入）。
 * 正文经 escapeSlotBody 定向转义（D7 A′）：语料同名字面量不得产出解析器眼里的标签，
 * 防提前闭合 / 伪造槽位；tag 必须属于 SLOT_TAGS（转义清单唯一真源）。
 * @param parts - 非空槽位段；空段被跳过
 */
export function joinSlotXml(parts: Array<{ tag: string; body: string }>): string {
  return parts
    .filter((p) => p.body.trim().length > 0)
    .map((p) => `<${p.tag}>\n${escapeSlotBody(p.tag, p.body.trim())}\n</${p.tag}>`)
    .join('\n');
}

/** 任意 content 归一化后的用户正文（UI / 载体扫描共用） */
export function unwrapUserText(content: string | Message['content'] | undefined | null): string {
  return extractUserMessageText(content);
}
