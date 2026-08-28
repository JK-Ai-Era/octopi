/**
 * Core 类型子模块 barrel
 *
 * 按职责拆分的类型定义。types.ts 从此处 re-export 以保持向后兼容。
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

// ── Agent 定义 ──
export type {
  AgentPersona,
  ModelInfo,
  ModelConfig,
  ToolPolicy,
  AgentDefinition,
} from './agent-definition.js';

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
} from './tools.js';

// ── Skill 系统 ──
export type { SkillDefinition, SkillManager } from './skills.js';

// ── Channel Adapter ──
export type { ChannelMessage, ChannelReply, ChannelAdapter } from './channels.js';

// ── Plugin Hooks ──
export type { HookContext } from './hooks.js';

// ── Agent Event ──
export type {
  LoopEndReason,
  LLMStreamChunk,
  AgentEventDetail,
  AgentEventListener,
} from './events.js';
export type { ErrorReason, ClassifiedError } from './events.js';

// ── Gateway 配置 ──
export type { GatewayConfig } from './gateway-config.js';

// ── 队列模式 ──
export type { QueueMode } from './queue-mode.js';

// ── 思考级别 ──
export type { ThinkingLevel } from './thinking-level.js';
