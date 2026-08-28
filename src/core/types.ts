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

// ── 全量 re-export（向后兼容） ──
export * from './types/index.js';

// ── 从 interfaces re-export 的类型（保持原路径兼容） ──

/** @deprecated 从 ./interfaces/error-strategy.js 导入 */
export type { ErrorReason, ClassifiedError } from './interfaces/error-strategy.js';

// ContextEngine 类型已移至 core/interfaces/context-engine.ts
export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
} from './interfaces/context-engine.js';
