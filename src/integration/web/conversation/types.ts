/**
 * Conversation View Model
 *
 * WebUI 展示层统一使用 ConversationItem，不再直接消费
 * MessageRecord[] 或 AgentEventEnvelope[]。
 *
 * 三层来源：
 * - runtime: 当前 session 的实时流事件
 * - history: 从 Session History API 加载的已完成消息
 * - merged:  runtime overlay 叠加到 history 之上的合成结果
 */

// ──────────────────────────────────────
// Roles & Source
// ──────────────────────────────────────

export type ConversationRole = 'user' | 'assistant' | 'tool' | 'system';
export type ConversationSource = 'runtime' | 'history' | 'merged';

// ──────────────────────────────────────
// Base
// ──────────────────────────────────────

interface BaseConversationItem {
  id: string;
  role: ConversationRole;
  createdAt: number;
  sessionId: string;
  source: ConversationSource;
  /** 此 item 在面板中可被 focus/选中 */
  focusable?: boolean;
}

// ──────────────────────────────────────
// Concrete items
// ──────────────────────────────────────

export interface UserConversationItem extends BaseConversationItem {
  role: 'user';
  content: string;
}

export interface AssistantConversationItem extends BaseConversationItem {
  role: 'assistant';
  status: 'streaming' | 'completed' | 'error';
  content: string;
  toolCalls?: string[];   // 关联的 toolCallId 列表
  toolResults?: string[]; // 关联的 tool result id 列表
  error?: string;
}

export interface ToolConversationItem extends BaseConversationItem {
  role: 'tool';
  toolName: string;
  toolCallId: string;
  status: 'running' | 'success' | 'error';
  summary?: string;
  expandable?: boolean;
  args?: unknown;
  result?: unknown;
  error?: string;
}

export interface SystemConversationItem extends BaseConversationItem {
  role: 'system';
  kind: 'info' | 'warning' | 'error' | 'retry' | 'truncated' | 'blocked' | 'aborted';
  message: string;
}

export type ConversationItem =
  | UserConversationItem
  | AssistantConversationItem
  | ToolConversationItem
  | SystemConversationItem;

// ──────────────────────────────────────
// Session view state
// ──────────────────────────────────────

export type ViewMode = 'runtime' | 'history' | 'hybrid';

export interface StreamingState {
  active: boolean;
  content: string;
  assistantItemId?: string;
}

export interface SessionViewState {
  sessionId: string;
  agentId: string;
  mode: ViewMode;
  items: ConversationItem[];
  streaming: StreamingState;
  /** toolCallId → conversationItemId 索引 */
  toolIndex: Record<string, string>;
}
