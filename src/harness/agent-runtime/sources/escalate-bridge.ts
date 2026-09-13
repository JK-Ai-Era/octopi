/**
 * EscalateBridge — Subsystem escalate → Trigger
 *
 * 只订阅 EventBus；不 import SignalBus 实现。
 * 默认同时订：
 * - `subsystem.signal.escalate`（SignalBus.deliverToEvent）
 * - `subsystem.escalate`（emitEscalate）
 * emit 非阻塞。
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../../core/index.js';
import type { Disposable } from '../../../core/primitives/event-bus.js';
import type { Trigger, TriggerSource } from '../types.js';

/** 手工桥事件类型 */
export const ESCALATE_EVENT_TYPE = 'subsystem.escalate';
/** SignalBus deliverToEvent 实际类型 */
export const SIGNAL_ESCALATE_EVENT_TYPE = 'subsystem.signal.escalate';

const DEFAULT_EVENT_TYPES = [SIGNAL_ESCALATE_EVENT_TYPE, ESCALATE_EVENT_TYPE] as const;

function normalizeEventTypes(eventType?: string | string[]): string[] {
  if (!eventType) return [...DEFAULT_EVENT_TYPES];
  return Array.isArray(eventType) ? eventType : [eventType];
}

export interface EscalateBridgeConfig {
  id?: string;
  events: EventBus;
  /** 无 agentId 时的默认目标 */
  defaultAgentId?: string;
  /** 默认订阅两种 escalate 事件；可覆盖 */
  eventType?: string | string[];
}

export class EscalateBridge implements TriggerSource {
  readonly id: string;
  readonly type = 'escalate' as const;
  private disposables: Disposable[] = [];
  private running = false;

  constructor(private readonly config: EscalateBridgeConfig) {
    this.id = config.id ?? `escalate-${randomUUID().slice(0, 8)}`;
  }

  async start(emit: (t: Trigger) => void): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const eventType of normalizeEventTypes(this.config.eventType)) {
      this.disposables.push(
        this.config.events.on(eventType, (event) => {
          if (!this.running) return;
          const trigger = this.toTrigger(event);
          if (trigger) emit(trigger);
        }) as Disposable,
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  get isRunning(): boolean {
    return this.running;
  }

  private toTrigger(event: {
    type: string;
    timestamp: number;
    agentId?: string;
    sessionId?: string;
    data?: Record<string, unknown>;
  }): Trigger | null {
    const data = (event.data ?? {}) as {
      agentId?: string;
      sessionId?: string;
      subsystemId?: string;
      reason?: string;
      summary?: string;
    };
    const agentId = data.agentId ?? event.agentId ?? this.config.defaultAgentId;
    if (!agentId) return null;

    const summary =
      data.summary ??
      data.reason ??
      `Subsystem ${data.subsystemId ?? 'unknown'} requests main agent attention.`;

    return {
      id: `trg-${randomUUID().slice(0, 12)}`,
      type: 'escalate',
      agentId,
      sessionId: data.sessionId ?? event.sessionId,
      timestamp: event.timestamp,
      payload: { kind: 'system_note', content: summary },
      metadata: {
        source: this.id,
        reason: data.subsystemId ?? 'escalate',
      },
    };
  }
}

/** 供 Subsystem 侧 emit 使用的辅助（避免各处手写 type 字符串） */
export function emitEscalate(
  events: EventBus,
  payload: {
    agentId?: string;
    sessionId?: string;
    subsystemId: string;
    reason?: string;
    summary?: string;
  },
): void {
  events.emit({
    type: ESCALATE_EVENT_TYPE,
    timestamp: Date.now(),
    agentId: payload.agentId,
    sessionId: payload.sessionId,
    data: { ...payload },
  });
}
