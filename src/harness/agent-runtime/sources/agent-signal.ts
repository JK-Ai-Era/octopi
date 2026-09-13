/**
 * AgentSignalSource — 多 Agent 通知 → Trigger
 *
 * 提供 runtime.signal() API 与 Run 结束可选转发；不实现 Swarm 拓扑。
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../../core/index.js';
import type { Disposable } from '../../../core/primitives/event-bus.js';
import type { Trigger, TriggerPayload, TriggerSource } from '../types.js';
import { RuntimeEvents } from '../types.js';

export const AGENT_SIGNAL_EVENT_TYPE = 'runtime.agent_signal';

export interface AgentSignal {
  fromAgentId: string;
  toAgentId: string;
  sessionId?: string;
  payload: TriggerPayload;
  reason?: string;
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

  constructor(private readonly config: AgentSignalSourceConfig = {}) {
    this.id = config.id ?? `agent-signal-${randomUUID().slice(0, 8)}`;
  }

  async start(emit: (t: Trigger) => void): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.config.events) {
      this.disposables.push(
        this.config.events.on(AGENT_SIGNAL_EVENT_TYPE, (event) => {
          if (!this.running) return;
          const data = (event.data ?? {}) as {
            fromAgentId?: string;
            toAgentId?: string;
            sessionId?: string;
            content?: string;
            reason?: string;
          };
          if (!data.toAgentId) return;
          const trigger = this.toTrigger({
            fromAgentId: data.fromAgentId ?? 'unknown',
            toAgentId: data.toAgentId,
            sessionId: data.sessionId,
            payload: { kind: 'system_note', content: data.content ?? data.reason ?? 'agent signal' },
            reason: data.reason,
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
    },
  });
}
