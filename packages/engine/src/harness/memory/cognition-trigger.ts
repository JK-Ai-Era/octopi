/**
 * Cognition 触发 — 命题落库后 emit 概念化请求
 *
 * 事件类型必须真实存在于 EventBus；sense.source=`eventBus` 才会挂监听。
 *
 * @module harness/memory/cognition-trigger
 */

import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { MemoryChannel, MemoryStatus, MemoryType } from './types.js';

/** 概念化请求（cognition.steward.conceptualize 监听） */
export const COGNITIZE_REQUEST_EVENT = 'cognition.conceptualize.request';

export interface ConceptualizeRequestPayload {
  memoryId: string;
  proposition: string;
  evidence: string;
  memoryType: MemoryType;
  memoryStatus?: MemoryStatus;
  channel?: MemoryChannel;
  /** 证据周边语境；缺省由 handler 从 session 补 */
  contextSlice?: string;
  sessionId?: string;
  agentId?: string;
}

/**
 * 发射概念化请求。失败静默（不得阻断 memory 写路径）。
 *
 * @param events - EventBus
 * @param payload - 请求载荷
 */
export function emitConceptualizeRequest(
  events: EventBus | undefined,
  payload: ConceptualizeRequestPayload,
): void {
  if (!events) return;
  try {
    events.emit({
      type: COGNITIZE_REQUEST_EVENT,
      timestamp: Date.now(),
      agentId: payload.agentId,
      sessionId: payload.sessionId,
      data: {
        memoryId: payload.memoryId,
        proposition: payload.proposition,
        evidence: payload.evidence,
        memoryType: payload.memoryType,
        memoryStatus: payload.memoryStatus,
        channel: payload.channel,
        contextSlice: payload.contextSlice,
        sessionId: payload.sessionId,
        agentId: payload.agentId,
      },
    });
  } catch {
    // 总线异常不得拖垮 Memory 写入
  }
}
