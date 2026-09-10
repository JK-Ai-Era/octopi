/**
 * Core 层类型定义 — barrel re-export
 *
 * 原始实现已按职责拆分到 types/ 子模块。
 * 本文件保持向后兼容：所有既有 import 路径不变。
 *
 * 子模块结构：
 * - types/messages.ts    — 消息系统（Message, ContentBlock, ToolCall, ToolResult）
 * - types/agent-definition.ts — Agent 定义（AgentPersona, ModelConfig, AgentDefinition）
 * - types/session.ts     — Session（SessionStatus, SessionMeta）
 * - types/turn.ts        — Turn（TokenUsage, Turn）
 * - types/tools.ts       — 工具系统（ToolDefinition, RegisteredTool, ToolHandler）
 * - types/skills.ts      — Skill 系统（SkillDefinition, SkillManager）
 * - types/channels.ts    — Channel Adapter（@layer integration）
 * - types/hooks.ts       — Plugin Hooks（@layer harness）
 * - types/events.ts      — Agent Event（@layer harness）
 * - types/gateway-config.ts — Gateway 配置（@layer integration）
 * - types/queue-mode.ts  — QueueMode（@layer harness）
 * - types/thinking-level.ts — ThinkingLevel（@layer harness）
 */

export * from './types/index.js';

export type { ErrorReason, ClassifiedError } from './interfaces/error-strategy.js';

export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
} from './interfaces/context-engine.js';
