/**
 * 场景 / 测试侧事件载荷（非 Loop 协议）
 *
 * 注意：这里的 `AgentEventDetail` **不是** `loop/types.ts` 的 `AgentLoopEvent`。
 * - Loop 协议事件见 `loop/types.ts`（含 `turn_end.phase`）
 * - Harness 扩展事件见 `harness/reliability/harness-events.ts`
 * - 本文件保留给 scenario-runner 等测试编排使用的松散事件词表
 *
 * LLM 流式 chunk 的规范定义在 `interfaces/model-provider.ts`（此处不再重复定义）。
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

/**
 * 测试编排用事件详情
 *
 * `turn_end.phase` 与 Loop 协议对齐：
 * - `pre_tools`：工具即将执行，run 未结束
 * - `final`：本轮无工具路径结束
 */
export type AgentEventDetail =
  | { type: 'loop_start'; sessionId: string }
  | { type: 'loop_end'; reason: LoopEndReason; response?: string }
  | { type: 'turn_start'; turnId: string; turnIndex: number }
  | {
      type: 'turn_end';
      turnId: string;
      shouldContinue: boolean;
      /** 与 AgentLoopEvent.turn_end.phase 同构 */
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
