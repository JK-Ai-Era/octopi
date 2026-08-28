/**
 * Agent Event 详细类型
 *
 * @layer harness — 详细事件载荷，Harness 层消费。
 * Core 循环使用 loop/types.ts 的 AgentLoopEvent。
 */

import type { ToolCall } from './messages.js';
import type { TokenUsage } from './turn.js';
import type { ClassifiedError, ErrorReason } from '../interfaces/error-strategy.js';

export type { ErrorReason, ClassifiedError } from '../interfaces/error-strategy.js';

export type LoopEndReason =
  | 'completed'
  | 'max_turns'
  | 'budget_exhausted'
  | 'plugin_stop'
  | 'interrupted'
  | 'error';

export interface LLMStreamChunk {
  type: 'content' | 'thinking';
  text: string;
}

export type AgentEventDetail =
  | { type: 'loop_start'; sessionId: string }
  | { type: 'loop_end'; reason: LoopEndReason; response?: string }
  | { type: 'turn_start'; turnId: string; turnIndex: number }
  | { type: 'turn_end'; turnId: string; shouldContinue: boolean }
  | { type: 'messages_injected'; count: number; source: string }
  | { type: 'llm_request'; model: string; estimatedTokens: number }
  | { type: 'llm_thinking_delta'; delta: string }
  | { type: 'llm_stream_delta'; delta: string }
  | { type: 'llm_response'; content: string; toolCalls?: ToolCall[]; usage?: TokenUsage; durationMs: number }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; arguments: string }
  | { type: 'tool_call_result'; toolCallId: string; toolName: string; result: string; durationMs?: number }
  | { type: 'tool_call_error'; toolCallId: string; toolName: string; error: string }
  | { type: 'error'; error: ClassifiedError; retrying: boolean }
  | { type: 'retry_wait'; attempt: number; maxRetries: number; waitMs: number }
  | { type: 'context_compressed'; beforeTokens: number; afterTokens: number }
  | { type: 'interrupt_requested' }
  | { type: 'interrupted'; phase: string }
  | { type: 'quality_anomaly'; checkResult: unknown; classification: unknown; strategy: string }
  | { type: 'model_change'; model: string; reason: string }
  | { type: 'degrade_mode'; reason: string; config: unknown };

export type AgentEventListener = (event: AgentEventDetail) => void | Promise<void>;
