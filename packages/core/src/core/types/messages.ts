/**
 * 消息系统类型
 *
 * 定义消息角色、多模态内容块、工具调用/结果、消息结构。
 * 这些是 Core 层最基础的数据模型。
 */

// ── 消息角色 ──

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** 消息来源信息 */
export interface MessageSource {
  /** 渠道名称（如 feishu、telegram、http） */
  channel: string;
  /** 发送者 ID */
  senderId?: string;
  /** 发送者显示名 */
  senderName?: string;
  /** 原始消息 ID */
  messageId?: string;
  /** 会话 ID（渠道侧） */
  conversationId?: string;
}

// ── 多模态内容块 ──

/** 文本内容块 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** 图片内容块 */
export interface ImageBlock {
  type: 'image';
  url?: string;
  data?: string;
  mimeType?: string;
  alt?: string;
}

/** 音频内容块 */
export interface AudioBlock {
  type: 'audio';
  url?: string;
  data?: string;
  mimeType?: string;
  durationSeconds?: number;
}

/** 视频内容块 */
export interface VideoBlock {
  type: 'video';
  url?: string;
  data?: string;
  mimeType?: string;
  durationSeconds?: number;
}

/** 文件内容块 */
export interface FileBlock {
  type: 'file';
  url?: string;
  data?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** 内容块联合类型 */
export type ContentBlock = TextBlock | ImageBlock | AudioBlock | VideoBlock | FileBlock;

// ── 工具调用/结果 ──

/** 工具调用请求（LLM 返回的 tool_calls） */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * arguments 原文不是合法 JSON 时的说明。
   * 存在时 Loop 会直接以 isError 结果拒绝执行，不把空参数交给工具。
   */
  argumentsParseError?: string;
}

/** 工具执行结果 */
export interface ToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  error?: string;
  durationMs?: number;
  /** 行动简述 / 调用意图（UI 标题；取自 result.purpose 或 toolCall.arguments.purpose） */
  purpose?: string;
  /** 标记为无操作（内容未变化），用于检测 tool-loop 死循环 */
  noop?: boolean;
}

// ── 消息结构 ──

/** 核心消息结构 */
export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
  source?: MessageSource;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
  /**
   * 产出本条消息的 agent（模型 2 归因）。
   * assistant/tool 消息由 Runner 在写回时按 RunScope 身份补齐。
   */
  agentId?: string;
  metadata?: Record<string, unknown>;
  /**
   * 仅属于当前 run 的瞬时消息（如委派状态提示、运行期 steering）。
   *
   * 语义：本轮 LLM 调用可见，但**不写入会话持久层**——它不是对话历史，
   * 而是运行期提示。写回时由 Runner 过滤掉，避免把「当时的状态」固化成历史
   * （会造成：状态过期后仍留在历史里、每次状态变化打穿前缀缓存）。
   */
  ephemeral?: boolean;
}

// ── 工具函数 ──

/** 从消息内容中提取纯文本 */
export function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('');
}

/** 检查消息内容是否包含非文本块（图片、音频等） */
export function hasMediaContent(content: string | ContentBlock[]): boolean {
  if (typeof content === 'string') return false;
  return content.some(block => block.type !== 'text');
}
