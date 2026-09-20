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
  /** 工具/输出被 SecurityGuard 拦截 */
  'security.blocked': {
    reason?: string;
    toolName?: string;
    action?: string;
    severity?: string;
    violations?: Array<{ type?: string; severity?: string; description?: string }>;
    [k: string]: unknown;
  };
  'security.behavior_blocked': {
    reason?: string;
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
  /** 上下文压缩开始（主动摘要 / 硬溢出；UI 可显示进行中） */
  'context.compact.start': {
    reason: 'proactive' | 'overflow';
    tokensBefore?: number;
    threshold?: number;
  };
  /** 上下文压缩结束 */
  'context.compact.end': {
    reason: 'proactive' | 'overflow';
    tokensBefore?: number;
    tokensAfter?: number;
    durationMs?: number;
    cached?: boolean;
  };
  /** 上下文压缩失败（引擎已回退截断，本轮继续） */
  'context.compact.error': {
    reason?: 'proactive' | 'overflow';
    error: string;
    durationMs?: number;
  };
  /**
   * system prompt 七层装配完成（AssembleManifest 可观测快照）
   * UI 用此事件渲染 Context Runtime；不进入模型输入。
   */
  'context.layers.assembled': {
    sessionId: string;
    agentId?: string;
    /** Assembler 原始清单 */
    manifest: import('../context/layer-types.js').AssembleManifest;
    /** 本轮启用的层 id（区分 unregistered） */
    enabledLayerIds?: import('../context/layer-types.js').ContextLayerId[];
    /** 检索查询（memory/knowledge empty 解释用） */
    query?: string;
    assembledAt?: number;
    /** 装配失败回退 concat 时为 true */
    fallback?: boolean;
    fallbackError?: string;
  };
  /**
   * Run 作用域观测快照（摘要；全文经 REST run/scope/messages）
   * Observer 通道：开发/调试；不进入模型输入。
   */
  'run.scope.ready': {
    sessionId: string;
    agentId?: string;
    runId: string;
    scope: import('../observer/types.js').RunScopeView;
    messages?: import('../observer/types.js').RunMessagesSummary;
  };
  /** Run messages 快照摘要（entry/final） */
  'run.scope.messages': {
    sessionId: string;
    agentId?: string;
    runId: string;
    phase: 'entry' | 'final';
    summary: import('../observer/types.js').RunMessagesSummary;
  };
  /** LLM 实际输入（ContextEngine assemble 出口；Observer 通道） */
  'run.scope.llm': {
    sessionId: string;
    agentId?: string;
    runId?: string;
    summary: import('../observer/types.js').RunMessagesSummary;
    estimatedTokens?: number;
  };
  /** RunMetricsCollector 快照（reliability → Observer） */
  'run.guard.metrics': import('../reliability/harness-events.js').RunGuardMetricsEvent['data'];
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
  SECURITY_BLOCKED: 'security.blocked',
  SECURITY_BEHAVIOR_BLOCKED: 'security.behavior_blocked',

  BUDGET_EXCEEDED: 'budget.exceeded',
  BUDGET_RENEWED: 'budget.renewed',
  RUN_GUARD_STOPPED: 'run_guard.stopped',
  RUN_GUARD_RECOVERED: 'run_guard.recovered',

  SESSION_LIFECYCLE_UPDATED: 'session.lifecycle.updated',
  SESSION_ENDED: 'session.ended',
  PERSONA_RESOLVE_FAILED: 'persona.resolve.failed',
  CONTEXT_COMPACT_START: 'context.compact.start',
  CONTEXT_COMPACT_END: 'context.compact.end',
  CONTEXT_COMPACT_ERROR: 'context.compact.error',
  CONTEXT_LAYERS_ASSEMBLED: 'context.layers.assembled',
  RUN_SCOPE_READY: 'run.scope.ready',
  RUN_SCOPE_MESSAGES: 'run.scope.messages',
  RUN_SCOPE_LLM: 'run.scope.llm',
  RUN_GUARD_METRICS: 'run.guard.metrics',

  TASK_CREATED: 'task.created',
  TASK_STARTED: 'task.started',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_CANCELLED: 'task.cancelled',
  TASK_TIMEOUT: 'task.timeout',
  TASK_RETRYING: 'task.retrying',
} as const satisfies Record<string, KnownAgentEventType>;
