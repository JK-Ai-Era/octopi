/**
 * Core 层类型定义 — barrel re-export
 *
 * 原始实现已按职责拆分到 types/ 子模块。
 * 本文件保持向后兼容：所有既有 import 路径不变。
 *
 * 子模块结构：
 * - types/messages.ts    — 消息系统（Message, ContentBlock, ToolCall, ToolResult）
 * - types/agent-definition.ts — ModelInfo / ToolPolicy（Kernel；AgentDefinition 在 harness）
 * - types/session.ts     — Session（SessionStatus, SessionMeta）
 * - types/turn.ts        — Turn（TokenUsage, Turn）
 * - types/tools.ts       — 工具系统（ToolDefinition, RegisteredTool, ToolHandler）
 * - types/queue-mode.ts  — QueueMode
 * - types/thinking-level.ts — ThinkingLevel
 */

export * from './types/index.js';

export type { ErrorReason, ClassifiedError } from './interfaces/error-strategy.js';

// ContextEngine 契约已迁 harness/context/types.ts（产品端口，非 Kernel）
