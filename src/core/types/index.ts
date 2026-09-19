/**
 * Core 类型子模块 barrel — Kernel 词汇表
 */

// ── 消息系统 ──
export type {
  MessageRole,
  MessageSource,
  TextBlock,
  ImageBlock,
  AudioBlock,
  VideoBlock,
  FileBlock,
  ContentBlock,
  ToolCall,
  ToolResult,
  Message,
} from './messages.js';
export { getTextContent, hasMediaContent } from './messages.js';

// ── 模型能力 / 工具策略 ──
export type {
  ModelInfo,
  ToolPolicy,
} from './agent-definition.js';
export { DEFAULT_CONTEXT_WINDOW } from './model-info.js';

// ── Session ──
export type { SessionStatus, SessionMeta } from './session.js';

// ── Turn ──
export type { TokenUsage, Turn } from './turn.js';

// ── 工具系统 ──
export type {
  ToolParameter,
  ToolDefinition,
  ToolExecutionContext,
  ToolHandler,
  RegisteredTool,
  ToolSource,
} from './tools.js';

// ── 队列 / 思考级别 ──
export type { QueueMode } from './queue-mode.js';
export type { ThinkingLevel } from './thinking-level.js';

// 测试编排词表见 harness/events/scenario-events.ts
