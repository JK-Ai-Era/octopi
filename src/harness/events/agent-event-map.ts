/**
 * AgentEventMap / AgentEvents — 产品事件词表
 *
 * @layer harness/events — 非 Core Kernel。
 * 生产端在 Runner 桥接、reliability、SecurityGuard、orchestration、archive。
 * Core 只提供开放 AgentEvent + EventBus 机制。
 *
 * stream.fallback_* 以 loop/types.ts 的 AgentLoopEvent 为准；桥接透传 type，
 * 不在本 Map 重复定义。
 */

// ── 规范事件载荷 ──

export interface AgentEventMap {
  // ── 引擎桥接（yield → bus） ──
  'engine.start': { sessionId?: string };
  'engine.end': { reason: string };
  'engine.error': { error: string; reason?: string };
  'iteration.start': Record<string, never>;
  'turn.end': {
    content?: string;
    userText?: string;
    hasToolCalls: boolean;
    phase: 'pre_tools' | 'final';
    truncated?: boolean;
    stopped?: boolean;
    error?: boolean;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    contextTokens?: number;
    contextWindow?: number;
  };
  'tool.exec.start': {
    toolCallId: string;
    toolName: string;
    args?: unknown;
  };
  'tool.exec.end': {
    toolCallId: string;
    toolName: string;
    args?: unknown;
    hasError?: boolean;
    result?: unknown;
    durationMs?: number;
  };

  // ── 预算 / 过程监督 ──
  'budget.exceeded': {
    reason: 'tokens' | 'wall_clock' | 'iteration' | 'tool_calls';
    report?: unknown;
  };
  'budget.renewed': {
    renews: number;
    softTokens: number;
    softWallClockMs: number;
  };
  'run_guard.stopped': { reason: string; userMessage?: string };
  'run_guard.recovered': { reason: string; actions: string[] };

  // ── 安全 ──
  'injection.detected': {
    severity?: string;
    description?: string;
    [k: string]: unknown;
  };
  'sensitive_data.detected': {
    severity?: string;
    description?: string;
    [k: string]: unknown;
  };
  'policy.violated': {
    severity?: string;
    description?: string;
    [k: string]: unknown;
  };

  // ── Session / Task ──
  'session.lifecycle.updated': {
    sessionId: string;
    status?: string;
    [k: string]: unknown;
  };
  'session.ended': {
    sessionId?: string;
    agentId?: string;
    reason?: string;
  };
  /** Persona 磁盘解析失败（Runner） */
  'persona.resolve.failed': {
    error: string;
  };
  'task.created': { taskId: string; taskType: string; status: string };
  'task.started': { taskId: string; taskType: string; status: string };
  'task.completed': { taskId: string; taskType: string; status: string };
  'task.failed': { taskId: string; taskType: string; status: string; retryCount?: number };
  'task.cancelled': { taskId: string; taskType: string; status: string };
  'task.timeout': { taskId: string; taskType: string; status: string };
  'task.retrying': {
    taskId: string;
    taskType: string;
    status: string;
    retryCount: number;
    maxRetries: number;
    lastError?: string;
  };
}

export type KnownAgentEventType = keyof AgentEventMap;

export type TypedAgentEvent<K extends KnownAgentEventType> = {
  type: K;
  timestamp: number;
  agentId?: string;
  sessionId?: string;
  data?: AgentEventMap[K];
};

/**
 * 标准事件类型常量 — 与 AgentEventMap 一一对应
 *
 * 注意：`llm_stream_delta` 是 Loop 协议事件；SessionAwareRunner 桥接产出
 * 但**故意不 emit 到 EventBus**（防拥塞），因此不在本 Map。
 */
export const AgentEvents = {
  ENGINE_START: 'engine.start',
  ENGINE_END: 'engine.end',
  ENGINE_ERROR: 'engine.error',
  ITERATION_START: 'iteration.start',
  TURN_END: 'turn.end',

  TOOL_EXEC_START: 'tool.exec.start',
  TOOL_EXEC_END: 'tool.exec.end',

  INJECTION_DETECTED: 'injection.detected',
  POLICY_VIOLATED: 'policy.violated',
  SENSITIVE_DATA_DETECTED: 'sensitive_data.detected',

  BUDGET_EXCEEDED: 'budget.exceeded',
  BUDGET_RENEWED: 'budget.renewed',
  RUN_GUARD_STOPPED: 'run_guard.stopped',
  RUN_GUARD_RECOVERED: 'run_guard.recovered',

  SESSION_LIFECYCLE_UPDATED: 'session.lifecycle.updated',
  SESSION_ENDED: 'session.ended',
  PERSONA_RESOLVE_FAILED: 'persona.resolve.failed',

  TASK_CREATED: 'task.created',
  TASK_STARTED: 'task.started',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_CANCELLED: 'task.cancelled',
  TASK_TIMEOUT: 'task.timeout',
  TASK_RETRYING: 'task.retrying',
} as const satisfies Record<string, KnownAgentEventType>;
