/**
 * Autonomous Subsystem — Input Builder
 *
 * 从主 Agent 上下文中提取子系统输入。
 * 根据 SubsystemSpec 的 boundary.visibility 和 sense.fields 裁剪信息。
 *
 * @module autonomous-subsystem/sense/input-builder
 */

import type { Message } from '../../../core/types.js';
import type { SubsystemSpec, SubsystemInput, AgentContext, TaskSummary } from '../types.js';

/**
 * 根据 SubsystemSpec 从 AgentContext 构建 SubsystemInput
 */
export function buildAgentInput(spec: SubsystemSpec, ctx: AgentContext): SubsystemInput {
  const input: SubsystemInput = {};
  const vis = spec.boundary.visibility;

  // isolated: 看不到主系统信息
  if (vis === 'isolated') return input;

  // structured: 只看结构化摘要
  if (vis === 'structured') {
    input.taskSummary = buildTaskSummary(ctx);
    input.sessionMetadata = {
      agentId: ctx.runConfig.agentId ?? 'unknown',
      sessionId: ctx.runConfig.sessionId ?? 'unknown',
      turnCount: ctx.messages.filter((m) => m.role === 'assistant').length,
    };
    if (ctx.pendingToolCall) {
      input.pendingToolCall = ctx.pendingToolCall;
    }
    return input;
  }

  // partial: 看到指定字段
  const fields = spec.sense.fields ?? [];
  for (const field of fields) {
    switch (field) {
      case 'task_summary':
        input.taskSummary = buildTaskSummary(ctx);
        break;
      case 'pending_tool_call':
        if (ctx.pendingToolCall) input.pendingToolCall = ctx.pendingToolCall;
        break;
      case 'tool_calls':
        input.recentToolCalls = ctx.recentToolCalls?.slice(-5);
        break;
      case 'working_directory':
        input.workingDirectory = ctx.runConfig.cwd;
        break;
      case 'session_metadata':
        input.sessionMetadata = {
          agentId: ctx.runConfig.agentId ?? 'unknown',
          sessionId: ctx.runConfig.sessionId ?? 'unknown',
          turnCount: ctx.messages.filter((m) => m.role === 'assistant').length,
        };
        break;
      case 'token_count':
        if (ctx.tokenCount) input.tokenCount = ctx.tokenCount;
        break;
      case 'conversation_history':
        input.conversationHistory = ctx.messages.slice(-20);
        break;
      case 'agent_events':
        if (ctx.agentEvents) input.agentEvents = ctx.agentEvents.slice(-10);
        break;
    }
  }

  // full: 看到全部信息
  if (vis === 'full') {
    input.taskSummary = buildTaskSummary(ctx);
    input.conversationHistory = ctx.messages;
    input.workingDirectory = ctx.runConfig.cwd;
    input.recentToolCalls = ctx.recentToolCalls;
    input.tokenCount = ctx.tokenCount;
    input.agentEvents = ctx.agentEvents;
    input.sessionMetadata = {
      agentId: ctx.runConfig.agentId ?? 'unknown',
      sessionId: ctx.runConfig.sessionId ?? 'unknown',
      turnCount: ctx.messages.filter((m) => m.role === 'assistant').length,
    };
    if (ctx.pendingToolCall) input.pendingToolCall = ctx.pendingToolCall;
  }

  return input;
}

function buildTaskSummary(ctx: AgentContext): TaskSummary {
  const recentTools: string[] = [];
  for (const msg of ctx.messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        recentTools.push(tc.name);
      }
    }
  }

  return {
    agentId: ctx.runConfig.agentId ?? 'unknown',
    sessionId: ctx.runConfig.sessionId ?? 'unknown',
    recentTools,
    phase: ctx.messages.at(-1)?.role === 'user' ? 'user_request' : 'agent_working',
    pendingAction: ctx.pendingToolCall?.name,
  };
}
