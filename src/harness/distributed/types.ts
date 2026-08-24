/**
 * Distributed Intelligence — Core Data Types
 *
 * 贯穿整个分布式智能架构的核心数据类型定义。
 * 包含智能体输入、输出、触发上下文、输出上下文等。
 */

import type { Message, RegisteredTool } from '../../core/types.js';
import type { EventBus, AgentEvent } from '../../core/event-bus.js';

/**
 * 分布式智能体的运行配置
 *
 * 从主 Agent 透传的关键配置，不依赖 engine.ts 的 RunConfig。
 */
export interface AgentRunConfig {
  systemPrompt?: string;
  agentId?: string;
  sessionId?: string;
  model?: string;
  cwd?: string;
}

// ── TaskSummary ──

/**
 * 系统生成的任务摘要
 *
 * 不含用户原始消息，仅包含结构化信息。
 * 用于 InputPolicy 的 snapshot: 'structured' 模式。
 */
export interface TaskSummary {
  /** 主 Agent ID */
  agentId: string;
  /** 主 Agent Session ID */
  sessionId: string;
  /** 最近使用的工具名列表 */
  recentTools: string[];
  /** 当前阶段 */
  phase: 'user_request' | 'agent_working';
  /** 当前待执行的工具调用（如有） */
  pendingAction?: string;
}

// ── AgentInput ──

/**
 * 智能体输入
 *
 * 由 InputPolicy 从主 Agent 的上下文中构造，传给 Execution。
 * 字段是否出现由 InputPolicy.visible 决定。
 */
export interface AgentInput {
  /** 当前工具调用（仅 intercept 场景） */
  pendingToolCall?: { name: string; arguments: Record<string, unknown> };
  /** 系统生成的任务摘要 */
  taskSummary?: TaskSummary;
  /** 最近的工具调用记录 */
  recentToolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result?: unknown }>;
  /** 工作目录 */
  workingDirectory?: string;
  /** 会话元数据 */
  sessionMetadata?: { agentId: string; sessionId: string; turnCount: number };
  /** Token 使用量 */
  tokenCount?: { used: number; limit: number };
  /** 对话历史（仅 conversation_history 可见时） */
  conversationHistory?: Message[];
  /** Agent 事件 */
  agentEvents?: AgentEvent[];
}

// ── AgentOutput ──

/**
 * 拦截输出
 *
 * 用于安全守卫等需要直接决定操作结果的场景。
 */
export interface InterceptOutput {
  kind: 'intercept';
  /** 决策 */
  decision: 'allow' | 'degrade' | 'block';
  /** 决策原因 */
  reason: string;
  /** 置信度 (0-1) */
  confidence: number;
  /** degrade 时的替代操作 */
  alternative?: { command: string; notice: string };
}

/**
 * 上下文输出
 *
 * 用于上下文压缩、动态注入等场景。
 */
export interface ContextOutput {
  kind: 'context';
  /** 要注入或替换的消息 */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** 是否标记为压缩结果（透明度） */
  compressed?: boolean;
}

/**
 * 通知输出
 *
 * 用于审计、日志、建议等场景。
 */
export interface NotifyOutput {
  kind: 'notify';
  /** 通知内容 */
  content: string;
  /** 通知级别 */
  level: 'info' | 'warning' | 'error';
}

/**
 * 智能体输出 — 联合类型
 */
export type AgentOutput = InterceptOutput | ContextOutput | NotifyOutput;

// ── TriggerContext ──

/**
 * 触发规则评估上下文
 *
 * 传给 Trigger 规则的 check / condition 函数。
 */
export interface TriggerContext {
  /** 当前事件数据（EventTrigger 使用） */
  eventData?: unknown;
  /** 当前指标值（ThresholdTrigger 使用） */
  metrics?: Record<string, number>;
  /** 主 Agent 最近的工具调用 */
  recentToolCalls?: Array<{ name: string; success: boolean }>;
  /** 当前 token 数 */
  tokenCount?: number;
  /** 主 Agent 的 agentId */
  agentId?: string;
  /** 主 Agent 的 sessionId */
  sessionId?: string;
}

// ── AgentContext ──

/**
 * 输出注入上下文
 *
 * 传给 OutputPolicy 的处理函数。
 */
export interface AgentContext {
  /** 主 Agent 的消息数组引用 */
  messages: Message[];
  /** 主 Agent 的运行配置 */
  runConfig: AgentRunConfig;
  /** 当前待执行的工具调用（intercept 模式使用） */
  pendingToolCall?: { name: string; arguments: Record<string, unknown> };
  /** EventBus（用于 notify 模式发送事件） */
  events: EventBus;
  /** 最近的工具调用记录（可选） */
  recentToolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result?: unknown }>;
  /** Token 使用量（可选） */
  tokenCount?: { used: number; limit: number };
  /** Agent 事件（可选） */
  agentEvents?: AgentEvent[];
}
