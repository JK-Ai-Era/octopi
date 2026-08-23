/**
 * 事件适配器 — AgentLoopEvent → AgentEvent 映射
 *
 * 将新的 AgentLoopEvent（agentLoop 纯函数产出）映射为旧的 AgentEvent（TUI/Gateway 消费）。
 * 用于过渡期，让现有 TUI/Gateway 不需要立即适配新事件格式。
 *
 * @deprecated 过渡期使用。TUI/Gateway 适配新事件后移除。
 */

import type { AgentEvent } from '../event-bus.js';
import type { AgentLoopEvent } from './types.js';

/**
 * 将 AgentLoopEvent 映射为旧的 AgentEvent
 *
 * 映射表：
 * | 新事件                   | 旧事件                  |
 * |-------------------------|------------------------|
 * | agent_start             | engine.start           |
 * | agent_end               | engine.end             |
 * | turn_start              | iteration.start        |
 * | turn_end                | iteration.end          |
 * | assistant_message       | （无直接对应，跳过）     |
 * | llm_stream_delta        | llm_stream_delta       |
 * | tool_start              | tool.exec.start        |
 * | tool_end                | tool.exec.end          |
 * | stream.fallback_to_sync | stream.fallback_to_sync|
 * | stream.fallback_failed  | stream.fallback_failed |
 */
export function adaptEvent(
  event: AgentLoopEvent,
  meta?: { agentId?: string; sessionId?: string; iteration?: number },
): AgentEvent | null {
  switch (event.type) {
    case 'agent_start':
      return {
        type: 'engine.start',
        timestamp: event.timestamp,
        agentId: meta?.agentId,
        sessionId: meta?.sessionId,
        data: {},
      };

    case 'agent_end':
      return {
        type: 'engine.end',
        timestamp: event.timestamp,
        agentId: meta?.agentId,
        sessionId: meta?.sessionId,
        data: { reason: event.reason },
      };

    case 'turn_start':
      return {
        type: 'iteration.start',
        timestamp: event.timestamp,
        data: { iteration: meta?.iteration ?? 0 },
      };

    case 'turn_end':
      return {
        type: 'iteration.end',
        timestamp: Date.now(),
        data: {
          hasToolCalls: event.hasToolCalls,
          truncated: event.truncated,
          stopped: event.stopped,
        },
      };

    case 'assistant_message':
      // 无直接对应，跳过（旧引擎不单独发 assistant_message 事件）
      return null;

    case 'llm_stream_delta':
      return {
        type: 'llm_stream_delta',
        timestamp: event.timestamp,
        data: event.data,
      };

    case 'tool_start':
      return {
        type: 'tool.exec.start',
        timestamp: event.timestamp,
        data: {
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
        },
      };

    case 'tool_end':
      return {
        type: 'tool.exec.end',
        timestamp: event.timestamp,
        data: {
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
          hasError: !!event.result.isError,
          result: event.result.content,
          error: event.result.isError ? String(event.result.content) : undefined,
          durationMs: event.result.durationMs,
        },
      };

    case 'stream.fallback_to_sync':
    case 'stream.fallback_failed':
      return {
        type: event.type,
        timestamp: event.timestamp,
        data: event.data,
      };

    default:
      return null;
  }
}

/**
 * 包装 async generator，自动将 AgentLoopEvent 适配为 AgentEvent 并 emit 到 EventBus
 */
export async function* adaptEventStream(
  stream: AsyncGenerator<AgentLoopEvent>,
  emit: (event: AgentEvent) => void,
  meta?: { agentId?: string; sessionId?: string },
): AsyncGenerator<AgentLoopEvent> {
  let iteration = 0;
  for await (const event of stream) {
    if (event.type === 'turn_start') iteration++;
    const adapted = adaptEvent(event, { ...meta, iteration });
    if (adapted) emit(adapted);
    yield event;
  }
}
