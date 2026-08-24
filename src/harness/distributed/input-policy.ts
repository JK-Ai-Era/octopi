/**
 * Distributed Intelligence — InputPolicy
 *
 * 定义智能体能访问什么信息——隔离的核心。
 * 根据 InputPolicy.visible 从主 Agent 的上下文中提取对应字段，构造 AgentInput。
 */

import type { Message } from '../../core/types.js';
import type { AgentEvent } from '../../core/event-bus.js';
import type { AgentRunConfig } from './types.js';
import type { AgentInput, AgentContext, TaskSummary } from './types.js';

// ── ContextField ──

/**
 * 上下文字段类型
 *
 * 定义智能体能看到的上下文信息。
 */
export type ContextField =
  | 'task_summary'
  | 'tool_calls'
  | 'tool_results'
  | 'working_directory'
  | 'agent_events'
  | 'session_metadata'
  | 'token_count'
  | 'conversation_history'
  | 'pending_tool_call';

// ── InputPolicy ──

/**
 * 输入策略
 *
 * 定义智能体能访问什么信息。
 */
export interface InputPolicy {
  /** 能看到的上下文字段 */
  visible: ContextField[];

  /**
   * 上下文快照方式
   *
   * - 'full': 完整数据，不做裁剪
   * - 'summary': 对大数据字段做摘要（如对话历史取最近 N 条）
   * - 'structured': 只提取结构化字段，不包含自由文本
   */
  snapshot: 'full' | 'summary' | 'structured';
}

// ── buildTaskSummary ──

/**
 * 构建任务摘要
 *
 * 系统生成的结构化摘要，不含用户原始消息。
 */
export function buildTaskSummary(context: AgentContext): TaskSummary {
  const recentTools: string[] = [];

  for (const msg of context.messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        recentTools.push(tc.name);
      }
    }
  }

  return {
    agentId: context.runConfig.agentId ?? 'unknown',
    sessionId: context.runConfig.sessionId ?? 'unknown',
    recentTools,
    phase: context.messages.at(-1)?.role === 'user' ? 'user_request' : 'agent_working',
    pendingAction: context.pendingToolCall?.name,
  };
}

// ── buildAgentInput ──

/**
 * 根据 InputPolicy 从 AgentContext 构造 AgentInput
 *
 * 不在 visible 中的字段不会出现在 AgentInput 中。
 */
export function buildAgentInput(
  policy: InputPolicy,
  context: AgentContext,
  options?: {
    recentToolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result?: unknown }>;
    tokenCount?: { used: number; limit: number };
    agentEvents?: AgentEvent[];
  },
): AgentInput {
  const input: AgentInput = {};

  for (const field of policy.visible) {
    switch (field) {
      case 'task_summary':
        input.taskSummary = buildTaskSummary(context);
        break;

      case 'pending_tool_call':
        if (context.pendingToolCall) {
          input.pendingToolCall = context.pendingToolCall;
        }
        break;

      case 'tool_calls':
        if (options?.recentToolCalls) {
          input.recentToolCalls = applySnapshot(
            policy.snapshot,
            options.recentToolCalls,
            (items) => items.slice(-5), // summary 模式取最近 5 条
          );
        }
        break;

      case 'tool_results':
        // tool_results 包含在 recentToolCalls 的 result 字段中
        // 已通过 tool_calls 字段一起提供
        break;

      case 'working_directory':
        input.workingDirectory = context.runConfig.cwd;
        break;

      case 'agent_events':
        if (options?.agentEvents) {
          input.agentEvents = applySnapshot(
            policy.snapshot,
            options.agentEvents,
            (items) => items.slice(-10), // summary 模式取最近 10 条
          );
        }
        break;

      case 'session_metadata':
        input.sessionMetadata = {
          agentId: context.runConfig.agentId ?? 'unknown',
          sessionId: context.runConfig.sessionId ?? 'unknown',
          turnCount: context.messages.filter(m => m.role === 'assistant').length,
        };
        break;

      case 'token_count':
        if (options?.tokenCount) {
          input.tokenCount = options.tokenCount;
        }
        break;

      case 'conversation_history':
        input.conversationHistory = applySnapshot(
          policy.snapshot,
          context.messages,
          (msgs) => msgs.slice(-20), // summary 模式取最近 20 条
        );
        break;
    }
  }

  return input;
}

// ── 内部工具函数 ──

/**
 * 根据 snapshot 模式对数据应用裁剪
 */
function applySnapshot<T>(
  snapshot: 'full' | 'summary' | 'structured',
  data: T,
  summarize: (data: T) => T,
  filter?: (data: T) => T,
): T {
  switch (snapshot) {
    case 'full':
      return data;
    case 'summary':
      return summarize(data);
    case 'structured':
      // structured 模式：如果提供了 filter 则过滤，否则返回空数据
      // 只保留结构化字段，不包含自由文本
      return filter ? filter(data) : data;
  }
}
