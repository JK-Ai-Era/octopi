/**
 * Distributed Intelligence — Core Data Types
 *
 * 贯穿整个分布式智能架构的核心数据类型定义。
 * 包含智能体输入、输出、触发上下文、输出上下文等。
 */

import type { Message, RegisteredTool } from '../../core/types.js';
import type { EventBus, AgentEvent } from '../../core/event-bus.js';

// ── AgentMessage（从旧 agent-communicator 吸收的通信概念） ──

/** Agent 消息类型 */
export type AgentMessageType =
  | 'request'      // 请求（任务分配）
  | 'response'     // 响应（任务结果）
  | 'query'        // 查询（请求信息）
  | 'reply'        // 回复（提供信息）
  | 'broadcast'    // 广播（通知所有）
  | 'delegate'     // 委托（转交任务）
  | 'escalate';    // 上报（交给上级）

/** Agent 消息元数据 */
export interface AgentMessageMetadata {
  /** 优先级 */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** 消息过期时间（毫秒） */
  ttl?: number;
  /** 需要的能力标签 */
  capabilities?: string[];
  /** 标签 */
  tags?: string[];
  /** 扩展数据 */
  extra?: Record<string, unknown>;
}

/**
 * Agent 间通信消息
 *
 * 用于分布式智能体之间的结构化通信。
 * 从旧 agent-communicator.ts 吸收，保留消息格式和对话关联能力。
 */
export interface AgentMessage {
  /** 消息 ID */
  id: string;
  /** 消息类型 */
  type: AgentMessageType;
  /** 发送者 Agent ID */
  from: string;
  /** 接收者（支持多播，'*' 表示广播） */
  to: string | string[];
  /** 会话 ID（用于关联相关消息） */
  conversationId?: string;
  /** 回复的消息 ID */
  replyTo?: string;
  /** 时间戳 */
  timestamp: number;
  /** 消息内容 */
  content: string;
  /** 结构化数据（可选） */
  structured?: unknown;
  /** 元数据 */
  metadata?: AgentMessageMetadata;
}

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
