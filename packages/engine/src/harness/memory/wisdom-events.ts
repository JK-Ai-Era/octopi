/**
 * Wisdom 判决信号 — 判官产出的弱归因结局事件 → `wisdom.steward.evaluate.request`
 *
 * 消费方（sense.filter.events 订阅）：wisdom.steward.evaluate（入账 + 状态迁移）。
 * 事件类型必须真实存在于 EventBus；发射失败静默（不得阻断判官主流程，窗口已标记
 * judged，宁丢勿重）。
 *
 * @module harness/memory/wisdom-events
 */

import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { WisdomOutcomeEvent } from './types.js';

/** 弱归因结局入账请求（判官批量判决产物） */
export const WISDOM_EVALUATE_REQUEST_EVENT = 'wisdom.steward.evaluate.request';

/** 治理脉搏（govern 每轮完成；判官等维护动作挂此脉搏） */
export const WISDOM_GOVERNED_EVENT = 'wisdom.steward.governed';

/**
 * 发射治理脉搏信号。失败静默（不得阻断 govern 主流程）。
 *
 * @param events - EventBus
 * @param payload - 载荷（可选 agentId/sessionId）
 */
export function emitWisdomGoverned(
  events: EventBus | undefined,
  payload?: { agentId?: string; sessionId?: string },
): void {
  if (!events) return;
  try {
    events.emit({
      type: WISDOM_GOVERNED_EVENT,
      timestamp: Date.now(),
      agentId: payload?.agentId,
      sessionId: payload?.sessionId,
      data: { at: Date.now() },
    });
  } catch {
    // 总线异常不得拖垮 govern
  }
}

export interface WisdomEvaluateRequestPayload {
  events: WisdomOutcomeEvent[];
  agentId?: string;
  sessionId?: string;
}

/**
 * 发射弱归因结局入账请求。失败静默（不得阻断判官；窗口已 judged，宁丢勿重）。
 *
 * @param events - EventBus
 * @param payload - 结局事件集
 */
export function emitWisdomEvaluateRequest(
  events: EventBus | undefined,
  payload: WisdomEvaluateRequestPayload,
): void {
  if (!events || payload.events.length === 0) return;
  try {
    events.emit({
      type: WISDOM_EVALUATE_REQUEST_EVENT,
      timestamp: Date.now(),
      agentId: payload.agentId,
      sessionId: payload.sessionId,
      data: {
        events: payload.events,
        agentId: payload.agentId,
        sessionId: payload.sessionId,
      },
    });
  } catch {
    // 总线异常不得拖垮判官；判决可由下轮窗口重新积累
  }
}
