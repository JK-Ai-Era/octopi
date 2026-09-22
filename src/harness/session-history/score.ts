/**
 * 从 Message 抽取可搜字段并打分（可解释、无向量）。
 */

import type { Message } from '../../core/types.js';
import type {
  SessionHistoryMatchField,
  SessionHistoryQueryMode,
} from './types.js';
import { messageText } from './types.js';

export interface SearchableField {
  field: SessionHistoryMatchField;
  text: string;
  weight: number;
}

export interface FieldMatch {
  field: SessionHistoryMatchField;
  text: string;
  score: number;
  matchStart: number;
  matchEnd: number;
}

const FIELD_WEIGHTS: Record<SessionHistoryMatchField, number> = {
  content: 1,
  source: 0.85,
  tool_call: 0.55,
  tool_result: 0.35,
};

/**
 * 抽取可搜字段；默认不含 tool IO 全文。
 *
 * @param message - 消息
 * @param includeToolIo - 是否包含 tool args/result 文本
 * @returns 可搜字段列表
 */
export function extractSearchableFields(
  message: Message,
  includeToolIo: boolean,
): SearchableField[] {
  const fields: SearchableField[] = [];
  const body = messageText(message).trim();
  if (body) {
    fields.push({ field: 'content', text: body, weight: FIELD_WEIGHTS.content });
  }

  const sender = message.source?.senderName ?? message.source?.senderId;
  if (sender) {
    fields.push({
      field: 'source',
      text: sender,
      weight: FIELD_WEIGHTS.source,
    });
  }

  const callNames = (message.toolCalls ?? []).map((c) => c.name).filter(Boolean);
  if (callNames.length) {
    fields.push({
      field: 'tool_call',
      text: callNames.join(' '),
      weight: FIELD_WEIGHTS.tool_call,
    });
  }

  if (includeToolIo) {
    for (const call of message.toolCalls ?? []) {
      const args = safeJson(call.arguments);
      if (args) {
        fields.push({ field: 'tool_call', text: args, weight: FIELD_WEIGHTS.tool_call });
      }
    }
    for (const result of message.toolResults ?? []) {
      const text = safeResultText(result.result);
      if (text) {
        fields.push({ field: 'tool_result', text, weight: FIELD_WEIGHTS.tool_result });
      }
    }
  }

  return fields;
}

/**
 * 在字段上匹配 query。
 * - `keyword`：分词 AND（子串，CJK 友好）
 * - `phrase`：连续子串
 * - `regex`：显式正则
 *
 * @param fields - 可搜字段
 * @param query - 用户查询
 * @param mode - 匹配模式
 * @returns 按得分排序的命中（每字段至多 1 条主命中）
 */
export function matchFields(
  fields: SearchableField[],
  query: string,
  mode: SessionHistoryQueryMode = 'keyword',
): FieldMatch[] {
  const q = query.trim();
  if (!q) return [];

  const hits: FieldMatch[] = [];

  for (const f of fields) {
    const lower = f.text.toLowerCase();
    let score = f.weight;
    let matchStart = -1;
    let matchEnd = -1;
    let matched = false;

    if (mode === 'regex') {
      let re: RegExp;
      try {
        re = new RegExp(q, 'i');
      } catch {
        return [];
      }
      const m = re.exec(f.text);
      if (!m) continue;
      matched = true;
      matchStart = m.index;
      matchEnd = m.index + m[0].length;
      score += 0.15 * Math.min(1, m[0].length / Math.max(f.text.length, 1));
    } else if (mode === 'phrase') {
      const idx = lower.indexOf(q.toLowerCase());
      if (idx < 0) continue;
      matched = true;
      matchStart = idx;
      matchEnd = idx + q.length;
      score += 0.2 + 0.15 * Math.min(1, q.length / Math.max(f.text.length, 1));
    } else {
      // keyword：全部词 AND
      const terms = q.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
      if (!terms.length) continue;
      let firstAt = -1;
      let lastEnd = -1;
      let hitCount = 0;
      for (const t of terms) {
        const at = lower.indexOf(t);
        if (at < 0) continue;
        hitCount++;
        if (firstAt < 0 || at < firstAt) firstAt = at;
        const end = at + t.length;
        if (end > lastEnd) lastEnd = end;
      }
      if (hitCount < terms.length) continue;
      matched = true;
      matchStart = firstAt;
      matchEnd = lastEnd;
      score += 0.2 + 0.1 * hitCount;
      score += 0.15 * Math.min(1, q.length / Math.max(f.text.length, 1));
    }

    if (!matched) continue;
    hits.push({
      field: f.field,
      text: f.text,
      score,
      matchStart,
      matchEnd,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * 角色加权（user 略高，便于定位意图原话）。
 *
 * @param role - 消息角色
 * @param base - 字段分
 * @returns 调整后得分
 */
export function applyRoleWeight(role: Message['role'], base: number): number {
  if (role === 'user') return base * 1.1;
  if (role === 'assistant') return base;
  return base * 0.85;
}

/**
 * 作者过滤（非安全边界）。
 *
 * @param messageAgentId - 消息 agentId
 * @param selfAgentId - 当前 agent
 * @param filter - 过滤器
 * @returns 是否保留
 */
export function authorAllows(
  messageAgentId: string | undefined,
  selfAgentId: string,
  filter: 'any' | 'self' | 'others' = 'any',
): boolean {
  if (filter === 'any') return true;
  const isSelf = messageAgentId === selfAgentId;
  return filter === 'self' ? isSelf : !isSelf;
}

/**
 * 生成 snippet：截取命中附近并用【】标出匹配。
 *
 * @param text - 原文
 * @param matchStart - 起点
 * @param matchEnd - 终点
 * @param maxChars - 上限
 * @returns 带标记的片段
 */
export function makeSnippet(
  text: string,
  matchStart: number,
  matchEnd: number,
  maxChars = 200,
): string {
  const window = Math.max(20, Math.floor(maxChars / 2));
  const start = Math.max(0, matchStart - Math.floor(window / 2));
  const end = Math.min(text.length, start + maxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const body = text.slice(start, end);
  const s = Math.max(0, matchStart - start);
  const e = Math.min(body.length, matchEnd - start);
  if (s >= e || s < 0) return `${prefix}${body}${suffix}`;
  return `${prefix}${body.slice(0, s)}【${body.slice(s, e)}】${body.slice(e)}${suffix}`;
}

/**
 * 会话分：max(hit) + λ·log(1+hitCount)
 *
 * @param hitScores - 命中分
 * @returns 会话分
 */
export function sessionScore(hitScores: number[]): number {
  if (!hitScores.length) return 0;
  const max = Math.max(...hitScores);
  return max + 0.1 * Math.log(1 + hitScores.length);
}

function safeJson(value: unknown): string | null {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return s && s !== '{}' && s !== 'null' ? s.slice(0, 500) : null;
  } catch {
    return null;
  }
}

function safeResultText(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') return result.slice(0, 500);
  try {
    return JSON.stringify(result).slice(0, 500);
  } catch {
    return null;
  }
}
