/**
 * Session history 检索契约（Information 层只读检索）。
 *
 * 与 memory_search 分工：Memory=命题；本模块=Discourse 原文片段。
 * 只读，不写 Session / Memory。
 */

import type { Message, MessageRole } from '../../core/types.js';

/** 检索模式 */
export type SessionHistoryQueryMode = 'keyword' | 'phrase' | 'regex';

/** 命中字段 */
export type SessionHistoryMatchField =
  | 'content'
  | 'tool_call'
  | 'tool_result'
  | 'source';

/** 作者过滤（相关性，非安全边界） */
export type SessionHistoryAuthorFilter = 'any' | 'self' | 'others';

export interface SessionHistoryQuery {
  query: string;
  mode?: SessionHistoryQueryMode;
  roles?: MessageRole[];
  includeToolIo?: boolean;
  agentId?: string;
  sessionIds?: string[];
  since?: number;
  until?: number;
  author?: SessionHistoryAuthorFilter;
  groupBy?: 'session' | 'message';
  limit?: number;
  snippetChars?: number;
  includeArchived?: boolean;
}

export interface SessionHistoryHit {
  /** `sessionId#index` 稳定句柄，供 session_read 开窗 */
  ref: string;
  sessionId: string;
  messageIndex: number;
  role: MessageRole;
  timestamp: number;
  agentId?: string;
  snippet: string;
  matchField: SessionHistoryMatchField;
  score: number;
}

export interface SessionHistorySessionHit {
  sessionId: string;
  score: number;
  hitCount: number;
  updatedAt: number;
  lifecycle?: string;
  primaryAgentId?: string;
  agentId: string;
  hits: SessionHistoryHit[];
  source: 'hot' | 'archive';
}

export interface SessionHistorySearchResult {
  sessions: SessionHistorySessionHit[];
  searched: { sessions: number; messages: number };
  truncated: boolean;
  totalHits: number;
}

export interface SessionHistoryOpenRequest {
  sessionId: string;
  /** 当前 agent（ACL / participated 过滤） */
  agentId?: string;
  aroundIndex?: number;
  aroundRef?: string;
  before?: number;
  after?: number;
  includeToolIo?: boolean;
  format?: 'transcript' | 'messages';
  includeArchived?: boolean;
}

export interface SessionHistoryWindowMessage {
  index: number;
  role: MessageRole;
  timestamp: number;
  agentId?: string;
  text: string;
  toolNames?: string[];
}

export interface SessionHistoryWindow {
  sessionId: string;
  source: 'hot' | 'archive';
  messages: SessionHistoryWindowMessage[];
  totalMessages: number;
  fromIndex: number;
  toIndex: number;
  truncated: boolean;
}

export interface SessionHistoryListFilter {
  agentId?: string;
  lifecycle?: string;
  limit?: number;
}

export interface SessionHistoryBrief {
  sessionId: string;
  agentId: string;
  primaryAgentId?: string;
  updatedAt: number;
  lifecycle?: string;
  messageCount?: number;
}

export interface SessionHistoryPort {
  search(query: SessionHistoryQuery): Promise<SessionHistorySearchResult>;
  open(request: SessionHistoryOpenRequest): Promise<SessionHistoryWindow | null>;
  list(filter?: SessionHistoryListFilter): Promise<SessionHistoryBrief[]>;
}

/** 从 ref 解析 index；非法返回 null */
export function parseHistoryRef(ref: string): { sessionId: string; messageIndex: number } | null {
  const i = ref.lastIndexOf('#');
  if (i <= 0) return null;
  const sessionId = ref.slice(0, i);
  const messageIndex = Number(ref.slice(i + 1));
  if (!sessionId || !Number.isInteger(messageIndex) || messageIndex < 0) return null;
  return { sessionId, messageIndex };
}

export function formatHistoryRef(sessionId: string, messageIndex: number): string {
  return `${sessionId}#${messageIndex}`;
}

/** 消息文本抽取（ContentBlock → text；不含 media base64） */
export function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
}
