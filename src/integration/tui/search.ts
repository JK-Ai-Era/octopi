/**
 * TUI 消息历史搜索（/find）— 纯函数
 *
 * 在会话消息文本里做大小写不敏感的子串搜索，产出可展示的命中行。
 * 无 IO：消息获取由 app.ts 走 REST，此处只管检索与片段生成。
 */

import { contentToText } from './history.js';

/** 可搜索消息（getSessionMessages 口径的最小面） */
export interface SearchableMessage {
  index?: number;
  role: string;
  content: unknown;
}

export interface SearchHit {
  /** 消息序号（index 缺省时用列表下标） */
  index: number;
  role: string;
  /** 命中所在行（已按窗口截取片段） */
  snippet: string;
}

/** 片段窗口：命中词前后各保留的字符数 */
const SNIPPET_PAD = 40;

/**
 * 单条消息文本 → 命中片段行（第一条命中的行；无命中返回 null）。
 *
 * @param text - 消息纯文本
 * @param needle - 已小写化的查询词（非空）
 * @returns 片段（命中词两侧带窗口，长行截断）
 */
function firstMatchingLine(text: string, needle: string): string | null {
  for (const line of text.split('\n')) {
    const at = line.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    const start = Math.max(0, at - SNIPPET_PAD);
    const end = Math.min(line.length, at + needle.length + SNIPPET_PAD);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < line.length ? '…' : '';
    return `${prefix}${line.slice(start, end).trim()}${suffix}`;
  }
  return null;
}

/**
 * 消息历史 → 命中列表。
 *
 * @param messages - 会话消息（顺序即历史顺序）
 * @param query - 查询词（空/空白返回空列表）
 * @param options - maxHits 上限（缺省 20）；每条消息只记首个命中行
 * @returns 命中列表（按历史顺序）
 */
export function searchMessages(
  messages: SearchableMessage[],
  query: string,
  options: { maxHits?: number } = {},
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const maxHits = options.maxHits ?? 20;
  const hits: SearchHit[] = [];
  for (let i = 0; i < messages.length && hits.length < maxHits; i++) {
    const msg = messages[i];
    const text = contentToText(msg.content as string | Parameters<typeof contentToText>[0]);
    const snippet = firstMatchingLine(text, needle);
    if (snippet !== null) {
      hits.push({ index: msg.index ?? i, role: msg.role, snippet });
    }
  }
  return hits;
}
