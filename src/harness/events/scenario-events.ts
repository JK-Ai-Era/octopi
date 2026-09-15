/**
 * 场景 / 测试侧事件载荷
 *
 * @layer harness/events — 测试编排词表，非 Loop 协议、非 Core Kernel。
 * Loop 协议见 loop/types.ts；产品 bus 词表见 agent-event-map.ts。
 */

import type { ToolCall } from '../../core/types.js';
import type { TokenUsage } from '../../core/types.js';
import type { ClassifiedError, ErrorReason } from '../../core/interfaces/error-strategy.js';

export type { ErrorReason, ClassifiedError };

export type LoopEndReason =
  | 'completed'
  | 'max_turns'
  | 'budget_exhausted'
  | 'plugin_stop'
  | 'interrupted'
  | 'error';

export type AgentEventDetail =
  | { type: 'loop_start'; sessionId: string }
  | { type: 'loop_end'; reason: LoopEndReason; response?: string }
  | { type: 'turn_start'; turnId: string; turnIndex: number }
  | {
      type: 'turn_end';
      turnId: string;
      shouldContinue: boolean;
      phase?: 'pre_tools' | 'final';
    }
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
