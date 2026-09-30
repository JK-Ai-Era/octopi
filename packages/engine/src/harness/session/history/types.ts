/**
 * Session history 检索契约（Information 层只读检索）。
 *
 * 与 memory_search 分工：Memory=命题；本模块=Discourse 原文片段。
 * 只读，不写 Session / Memory。
 */

import type { Message, MessageRole } from '@octopi-agent/core/types.js';
import type { SessionData } from '../types.js';

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

// ── 可选投影索引契约（I2：可重建，非权威） ──

/** 与 Jsonl 旁路钩子对齐 */
export interface SessionIndexSink {
  upsertFromSession(sessionId: string, data: SessionData): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

export interface SessionIndexPrefilterQuery {
  /** 关键词（keyword AND，子串）或 phrase 整串 */
  terms: string[];
  mode: 'keyword' | 'phrase' | 'regex';
  roles?: string[];
  agentId?: string;
  sessionIds?: string[];
  since?: number;
  until?: number;
  includeArchived?: boolean;
  includeToolIo?: boolean;
  limitSessions?: number;
}

export interface SessionIndexCandidate {
  sessionId: string;
  msgIndexes: number[];
}

export interface SessionIndexBackend extends SessionIndexSink {
  ensureSchema(): Promise<void>;
  /**
   * SQL 缩候选 session（及命中行）；具体打分/ACL 仍由 Port 完成。
   * 返回 `null` 表示索引不可用/陈旧/可能截断漏检 —— 调用方应回退全量扫描。
   * 返回 `[]` 表示索引确信无命中。
   */
  prefilter(query: SessionIndexPrefilterQuery): Promise<SessionIndexCandidate[] | null>;
  /** 全量重建（扫权威 store） */
  rebuildFrom(loadAll: () => AsyncIterable<SessionData>): Promise<{ sessions: number; messages: number }>;
  /** 权威侧 session 数（用于新鲜度校验） */
  countSessions(): Promise<number>;
  /** 是否启用 FTS5 */
  readonly ftsEnabled: boolean;
  close(): void;
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
