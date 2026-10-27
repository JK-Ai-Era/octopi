/**
 * Agent Runtime 类型 — 激活宿主契约
 *
 * 见 arch/agent-runtime.md。激活 ≠ 执行；串行互斥归 SessionAwareRunner（模型 A）。
 */

import type { Message } from '@octopi-agent/core/types.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

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

/** Trigger 的裁剪引用：用于事件回执等「只要关联、不要正文」的场合（dropped 事件） */
export type TriggerRef = Omit<Trigger, 'payload'>;

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
    /** 委派单 ID（`collaboration/delegation`）；notify 通道透传，供 UI/下游过滤 */
    delegationId?: string;
    /** 消息级模型覆盖（`provider/model` 或裸名） */
    modelOverride?: string;
    /** modelOverride 为裸名时的 provider */
    modelProvider?: string;
    /** 会话附件指针（OP-15）；compile 后进 FileBlock */
    attachments?: TriggerAttachmentRef[];
    /** 引擎合成的默认指令（空正文+附件） */
    syntheticInstruction?: boolean;
  };
}

/** Trigger 上的附件指针（绝对路径由宿主填好） */
export interface TriggerAttachmentRef {
  id: string;
  name: string;
  mime?: string;
  sizeBytes?: number;
  /** 可读绝对路径（抽取优先） */
  path: string;
  kind?: string;
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
  /** Principal / Intent 字段位（宪法 I6）；宿主填充，引擎不做权限 NLU */
  actorId?: string;
  actorType?: 'host' | 'user' | 'agent' | 'service' | 'timer' | 'subsystem';
  tenantId?: string;
  intent?: string;
}

/** Run audit record (Principal fields reserved — I6) */
export interface RunAuditRecord {
  requestId: string;
  sessionId: string;
  agentId: string;
  at: number;
  actorId?: string;
  actorType?: 'host' | 'user' | 'agent' | 'service' | 'timer' | 'subsystem';
  tenantId?: string;
  intent?: string;
  agentRevision?: string;
}

// ── Dispatcher ──

export interface RunDispatcher {
  execute(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  /** 可选：活跃 Run 接续；缺省保持原 Trigger 排队语义。 */
  inbox?: {
    offer(signal: import('./inbox.js').SessionInboxSignal): import('./inbox.js').InboxOfferResult;
  };
}

/** dispatch 调用方选项 */
export interface DispatchOptions {
  /** Run 事件流转发（频道回复捕获等）；不变量 #6 */
  onEvent?: (event: AgentEvent) => void;
  /** 活跃 Run 接收即回执（早于 Run 结束）；run = 走新 Run。 */
  onDelivery?: (delivery: 'steered' | 'run') => void;
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
  /** 特质标签（委派/路由发现用；无权限语义） */
  traits?: string[];
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
      /** 已交活跃 Run 在下一消息边界接续（不开新 Run）。 */
      status: 'accepted';
      agentId: string;
      sessionId: string;
      delivery: 'steered';
    }
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
  RUN_EVENT: 'runtime.run.event',
  INBOX_ADMITTED: 'runtime.inbox.admitted',
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
