/**
 * Memory 存量变化信号 — 每条命题落库后 emit `memory.stored`
 *
 * 消费方（sense.filter.events 订阅）：wisdom.steward.formation 等增量触发的子系统。
 * 事件类型必须真实存在于 EventBus；发射失败静默（不得阻断 memory 写路径）。
 *
 * @module harness/memory/memory-events
 */

import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';

/** 命题落库信号（每条一发；消费方按 minEvents 累积节流） */
export const MEMORY_STORED_EVENT = 'memory.stored';

export interface MemoryStoredPayload {
  memoryId: string;
  type?: string;
  status?: string;
  sessionId?: string;
  agentId?: string;
}

/**
 * 发射命题落库信号。失败静默（不得阻断 Memory 写入）。
 *
 * @param events - EventBus
 * @param payload - 落库载荷
 */
export function emitMemoryStored(events: EventBus | undefined, payload: MemoryStoredPayload): void {
  if (!events) return;
  try {
    events.emit({
      type: MEMORY_STORED_EVENT,
      timestamp: Date.now(),
      agentId: payload.agentId,
      sessionId: payload.sessionId,
      data: {
        memoryId: payload.memoryId,
        type: payload.type,
        status: payload.status,
        sessionId: payload.sessionId,
        agentId: payload.agentId,
      },
    });
  } catch {
    // 总线异常不得拖垮 Memory 写入
  }
}
