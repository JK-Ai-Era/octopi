/**
 * AgentSignalSource — 多 Agent 通知 → Trigger
 *
 * 提供 runtime.signal() API 与 Run 结束可选转发；不实现 Swarm 拓扑。
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '@octopi-agent/core/index.js';
import type { Disposable } from '@octopi-agent/core/primitives/event-bus.js';
import type { Trigger, TriggerPayload, TriggerSource } from '../types.js';
import { RuntimeEvents } from '../types.js';

export const AGENT_SIGNAL_EVENT_TYPE = 'runtime.agent_signal';

/**
 * 已挂载 `AgentSignalSource` 的总线登记表（引用计数）。
 *
 * notify 投递器据此判断「总线上有没有接收端」——`bus.emit` 对有无监听者
 * 零反馈，若不校验，发进空总线的通知会被误标已送达（2026-10-22 断链根因）。
 */
const receiverBuses = new WeakMap<object, number>();

/**
 * 查询总线上是否有存活的 `AgentSignalSource` 接收端。
 *
 * @param events - 事件总线
 * @returns 有接收端返回 true；投递器应据此拒绝把通知判为已送达
 */
export function hasAgentSignalReceiver(events: EventBus): boolean {
  return (receiverBuses.get(events as object) ?? 0) > 0;
}

export interface AgentSignal {
  fromAgentId: string;
  toAgentId: string;
  sessionId?: string;
  payload: TriggerPayload;
  reason?: string;
  /** 委派单 ID（collaboration/delegation）；透传到消息 metadata */
  delegationId?: string;
}

export interface AgentSignalSourceConfig {
  id?: string;
  events?: EventBus;
}

export class AgentSignalSource implements TriggerSource {
  readonly id: string;
  readonly type = 'agent_signal' as const;
  private disposables: Disposable[] = [];
  private running = false;
  /** 本实例是否已计入 receiverBuses（防未 start 的 stop / 二次 stop 误删兄弟登记） */
  private receiverCounted = false;

  constructor(private readonly config: AgentSignalSourceConfig = {}) {
    this.id = config.id ?? `agent-signal-${randomUUID().slice(0, 8)}`;
  }

  async start(emit: (t: Trigger) => void): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.config.events) {
      receiverBuses.set(
        this.config.events as object,
        (receiverBuses.get(this.config.events as object) ?? 0) + 1,
      );
      this.receiverCounted = true;
      this.disposables.push(
        this.config.events.on(AGENT_SIGNAL_EVENT_TYPE, (event) => {
          if (!this.running) return;
          const data = (event.data ?? {}) as {
            fromAgentId?: string;
            toAgentId?: string;
            sessionId?: string;
            content?: string;
            reason?: string;
            delegationId?: string;
          };
          if (!data.toAgentId) return;
          const trigger = this.toTrigger({
            fromAgentId: data.fromAgentId ?? 'unknown',
            toAgentId: data.toAgentId,
            sessionId: data.sessionId,
            payload: { kind: 'system_note', content: data.content ?? data.reason ?? 'agent signal' },
            reason: data.reason,
            delegationId: data.delegationId,
          });
          this.config.events?.emit({
            type: RuntimeEvents.AGENT_SIGNAL_EMITTED,
            timestamp: Date.now(),
            agentId: data.toAgentId,
            sessionId: data.sessionId,
            data: {
              fromAgentId: data.fromAgentId,
              triggerId: trigger.id,
              reason: data.reason,
            },
          });
          emit(trigger);
        }) as Disposable,
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    // 只回收本实例的计数（未 start / 二次 stop 不得误删兄弟 source 的登记）
    if (this.config.events && this.receiverCounted) {
      this.receiverCounted = false;
      const key = this.config.events as object;
      const left = (receiverBuses.get(key) ?? 1) - 1;
      if (left > 0) receiverBuses.set(key, left);
      else receiverBuses.delete(key);
    }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  get isRunning(): boolean {
    return this.running;
  }

  toTrigger(signal: AgentSignal): Trigger {
    return {
      id: `trg-${randomUUID().slice(0, 12)}`,
      type: 'agent_signal',
      agentId: signal.toAgentId,
      sessionId: signal.sessionId,
      payload: signal.payload,
      metadata: {
        source: this.id,
        reason: signal.reason,
        parentAgentId: signal.fromAgentId,
        delegationId: signal.delegationId,
      },
    };
  }
}

export function emitAgentSignal(
  events: EventBus,
  signal: AgentSignal & { content?: string },
): void {
  events.emit({
    type: AGENT_SIGNAL_EVENT_TYPE,
    timestamp: Date.now(),
    agentId: signal.toAgentId,
    sessionId: signal.sessionId,
    data: {
      fromAgentId: signal.fromAgentId,
      toAgentId: signal.toAgentId,
      sessionId: signal.sessionId,
      content:
        signal.content ??
        (signal.payload.kind === 'user_message' || signal.payload.kind === 'system_note'
          ? signal.payload.content
          : JSON.stringify(signal.payload)),
      reason: signal.reason,
      delegationId: signal.delegationId,
    },
  });
}
