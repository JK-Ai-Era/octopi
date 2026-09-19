/**
 * Agent Runtime 类型 — 激活宿主契约
 *
 * 见 arch/agent-runtime.md。激活 ≠ 执行；串行互斥归 SessionAwareRunner（模型 A）。
 */

import type { Message } from '../../core/types.js';
import type { AgentEvent } from '../../core/primitives/event-bus.js';

// ── Trigger ──

export type TriggerType =
  | 'message'
  | 'schedule'
  | 'event'
  | 'escalate'
  | 'agent_signal'
  | 'manual';

export type TriggerPayload =
  | { kind: 'user_message'; content: string; source?: Message['source'] }
  | { kind: 'system_note'; content: string }
  | { kind: 'structured'; data: unknown };

export interface Trigger {
  id: string;
  type: TriggerType;
  /** 目标；与 toAgents 二选一，或都空交给 Router */
  agentId?: string;
  toAgents?: string[];
  sessionId?: string;
  /** 来源端时间戳；缺省用 dispatch 时刻 */
  timestamp?: number;
  payload: TriggerPayload;
  coalesceKey?: string;
  coalesceWindowMs?: number;
  /** 字段保留；v1 不参与排序（OP-AR-1） */
  priority?: number;
  metadata?: {
    source?: string;
    reason?: string;
    parentAgentId?: string;
    causalRunId?: string;
    /** 消息级模型覆盖（`provider/model` 或裸名） */
    modelOverride?: string;
    /** modelOverride 为裸名时的 provider */
    modelProvider?: string;
  };
}

// ── RunRequest ──

export interface RunRequest {
  requestId: string;
  /** 合批后的触发列表（length >= 1） */
  triggers: Trigger[];
  agentId: string;
  sessionId: string;
  /** Compiler 产出；合批时可能多条 */
  messages: Message[];
  /**
   * 消息级模型覆盖（裸名或 provider/model）。
   * 来自 Trigger.metadata.modelOverride；会话级选择不经过此字段。
   */
  modelOverride?: string;
  /** modelOverride 为裸名时的 provider */
  modelProvider?: string;
}

// ── Dispatcher ──

export interface RunDispatcher {
  execute(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}

// ── Router ──

export interface RouteTarget {
  agentId: string;
  sessionId?: string;
}

export interface AgentRouter {
  resolve(
    trigger: Trigger,
    agents: ReadonlyMap<string, RuntimeAgent>,
  ): Promise<RouteTarget[]>;
}

// ── RuntimeAgent ──

export interface RuntimeAgent {
  agentId: string;
  dispatcher: RunDispatcher;
  /** Trigger → sessionId；缺省用 trigger.sessionId 或 `${agentId}:main` */
  resolveSession?: (trigger: Trigger) => string;
  discoverable?: boolean;
  capabilities?: string[];
}

// ── TriggerSource ──

/**
 * emit 必须同步、非阻塞（arch/agent-runtime.md §5.1）。
 * 实现方禁止 await runtime.dispatch。
 */
export interface TriggerSource {
  readonly id: string;
  readonly type: TriggerType;
  start(emit: (t: Trigger) => void): Promise<void>;
  stop(): Promise<void>;
}

// ── DispatchResult ──

export type DispatchResult =
  | { status: 'ran'; requestId: string; agentId: string; sessionId: string }
  | {
      status: 'skipped';
      reason: 'no_agent' | 'filtered' | 'runtime_stopped' | 'aborted';
    }
  | { status: 'failed'; error: string };

/** fan-out 聚合结果（toAgents 长度 > 1 时由 dispatch 返回） */
export type FanoutDispatchResult =
  | { status: 'ran'; results: Array<{ agentId: string; result: DispatchResult }> }
  | { status: 'failed'; results: Array<{ agentId: string; result: DispatchResult }> }
  | {
      status: 'skipped';
      reason: 'no_agent' | 'runtime_stopped' | 'aborted';
    };

// ── Events ──

export const RuntimeEvents = {
  TRIGGER_RECEIVED: 'runtime.trigger.received',
  RUN_SCHEDULED: 'runtime.run.scheduled',
  RUN_STARTED: 'runtime.run.started',
  RUN_ENDED: 'runtime.run.ended',
  RUN_FAILED: 'runtime.run.failed',
  AGENT_SIGNAL_EMITTED: 'runtime.agent_signal.emitted',
  TRIGGER_DROPPED: 'runtime.trigger.dropped',
} as const;

export type RuntimeEventType = (typeof RuntimeEvents)[keyof typeof RuntimeEvents];

export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: number;
  agentId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;
