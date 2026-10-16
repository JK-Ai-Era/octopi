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
  /** history 条目在 session.messages 中的绝对下标（分叉定位） */
  sourceIndex?: number;
}

// ──────────────────────────────────────
// Concrete items
// ──────────────────────────────────────

export interface UserConversationItem extends BaseConversationItem {
  role: 'user';
  content: string;
  /** 本轮被中止时可编辑重发（同会话原地改写，不建分支） */
  editResendable?: boolean;
}

export interface AssistantConversationItem extends BaseConversationItem {
  role: 'assistant';
  status: 'streaming' | 'completed' | 'error';
  content: string;
  /** 思考过程（可折叠展示）；不进 content */
  reasoning?: string;
  toolCalls?: string[];   // 关联的 toolCallId 列表
  toolResults?: string[]; // 关联的 tool result id 列表
  error?: string;
}

export interface ToolConversationItem extends BaseConversationItem {
  role: 'tool';
  toolName: string;
  toolCallId: string;
  /** 行动简述（标题展示用） */
  purpose?: string;
  status: 'running' | 'success' | 'error';
  summary?: string;
  expandable?: boolean;
  args?: unknown;
  result?: unknown;
  error?: string;
  /** 工具完成时刻（tool.exec.end 时打戳） */
  endedAt?: number;
}

export interface SystemConversationItem extends BaseConversationItem {
  role: 'system';
  kind: 'info' | 'warning' | 'error' | 'retry' | 'truncated' | 'blocked' | 'aborted' | 'tools_changed';
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
  reasoning?: string;
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
