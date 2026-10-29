/**
 * AgentEventMap / AgentEvents — 产品事件词表
 *
 * @layer harness/shared/events — 非 Core Kernel。
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
  /**
   * 模型调用即将重试（重试窗口对用户可见）
   *
   * 此前重试不产生任何事件：一次 52 分钟停滞期间前端零反馈。
   * `attempt` 从 1 起；`delayMs` 是**即将**等待的退避时长（通知先于等待发出）。
   */
  'engine.model_retry': {
    attempt: number;
    maxAttempts: number;
    reason: string;
    delayMs: number;
    error: string;
  };
  'iteration.start': Record<string, never>;
  'llm.usage': {
    usage: import('@octopi-agent/core/types/turn.js').TokenUsage;
  };
  'turn.end': {
    /** 本次调用的正文；error=true 时 = 中断前的部分流出（不是回答，不得当回复外发） */
    content?: string;
    userText?: string;
    hasToolCalls: boolean;
    phase: 'pre_tools' | 'final';
    truncated?: boolean;
    stopped?: boolean;
    /** 本次 LLM 调用失败（只出现在重试中途；彻底失败走 agent_end reason='error'） */
    error?: boolean;
    usage?: import('@octopi-agent/core/types/turn.js').TokenUsage;
    /** F3 LLM 计时摘要（loop turn_end 透传；Run 页签耗时区消费） */
    llmTiming?: import('@octopi-agent/core/loop/types.js').LoopLLMTiming;
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
    /** 行动简述 */
    purpose?: string;
  };
  /**
   * 工具执行中的部分输出（展示通道；不进对话历史、不参与 afterToolCall 定形）。
   * 载荷已经过 SecurityGuard 出口扫描（与 tool.exec.end 同一判定），违规部分被扣发。
   */
  'tool.exec.update': {
    toolCallId: string;
    toolName: string;
    /** 部分输出内容（对齐 LoopToolResult.content 语义；发射端已截断） */
    content?: unknown;
  };
  /** ToolEffectPolicy §5.6 效应账本摘要（turn 级；Observer tool.effect） */
  'tool.effect.ledger': {
    entries: number;
    truncated?: boolean;
    notReversed?: {
      reason: string;
      created?: string[];
      modified?: string[];
      deleted?: string[];
    };
  };
  /** Runner 收口计时（F3 `[timing]` 探针转正；wait/build/run_end 分段，事件旁路 eventSink） */
  'run.timing': {
    stage: 'run_start' | 'context_ready' | 'run_end';
    /** 排队/等锁耗时（stage=run_start） */
    waitMs?: number;
    /** 上下文组装耗时，从拿锁后起算（stage=context_ready） */
    buildMs?: number;
    /** 消息数（stage=context_ready） */
    msgs?: number;
    /** system prompt 稳定前缀字符数（E8 后不含易变快照） */
    sysChars?: number;
    /** grounding 估算 tokens（stage=context_ready） */
    groundingTokens?: number;
    /** run 总耗时（stage=run_end） */
    durMs?: number;
    /** 观测口径结束原因（stage=run_end） */
    reason?: string;
    /** 循环结束原因（stage=run_end） */
    loopEnd?: string;
    /** 停止闸门原因（stage=run_end） */
    stopReason?: string;
  };

  // ── 预算 / 过程监督 ──
  'budget.exceeded': {
    reason: 'wall_clock' | 'iteration' | 'tool_calls';
    report?: unknown;
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
  /** 会话展示元数据变更（标题等；UI 列表刷新） */
  'session.updated': {
    sessionId: string;
    title?: string;
    titleSource?: 'snippet' | 'auto' | 'user';
    updatedAt?: number;
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
  /** 摘要请求 cache-miss 旁路/穷尽可观测（F22）：no_prefix=无同形前缀，window_guard=前缀放不下改文本化旁路，window_exhausted=最终失败 */
  'context.compact.summarize_fallback': {
    reason?: 'proactive' | 'overflow';
    fallback?: string;
    cached?: boolean;
  };
  /**
   * system prompt 七层装配完成（AssembleManifest 可观测快照）
   * UI 用此事件渲染 Context Runtime；不进入模型输入。
   */
  'context.layers.assembled': {
    sessionId: string;
    agentId?: string;
    /** Assembler 原始清单 */
    manifest: import('../../context/layer-types.js').AssembleManifest;
    /** 本轮启用的层 id（区分 unregistered） */
    enabledLayerIds?: import('../../context/layer-types.js').ContextLayerId[];
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
    scope: import('../../observability/observer/types.js').RunScopeView;
    messages?: import('../../observability/observer/types.js').RunMessagesSummary;
  };
  /** Run messages 快照摘要（entry/final） */
  'run.scope.messages': {
    sessionId: string;
    agentId?: string;
    runId: string;
    phase: 'entry' | 'final';
    summary: import('../../observability/observer/types.js').RunMessagesSummary;
  };
  /** LLM 实际输入（ContextEngine assemble 出口；Observer 通道） */
  'run.scope.llm': {
    sessionId: string;
    agentId?: string;
    runId?: string;
    summary: import('../../observability/observer/types.js').RunMessagesSummary;
    estimatedTokens?: number;
  };
  /** RunMetricsCollector 快照（reliability → Observer） */
  'run.guard.metrics': import('../../run/reliability/harness-events.js').RunGuardMetricsEvent['data'];
  /** ops P0：jail 意图 × 实测后端（授权 vs 故障的事后判据，run 开始即记录） */
  'ops.jail.state': import('../../extension/execution-environment/effect-policy.js').OpsJailState;
  /** ops P2：run 级降级申报（securityDegraded 快照） */
  'ops.policy.degraded': {
    degradation: string[];
    requestedVsEffective: { requestedMode: string; mode: string };
    origin: { sessionId: string; agentId: string; runId?: string | null };
  };
  /** ops P2：安全配置漂移 → 拒新 run（§8.4） */
  'ops.config.security_changed': {
    changed: string[];
    action: string;
    /** 旧→新摘要（§7） */
    previousFingerprint: string | null;
    currentFingerprint: string | null;
    /** 谁改的无法从文件判定（agent 写与宿主写同样是磁盘字节）→ 如实 unattributed */
    source: 'unattributed';
    hostAttested: boolean;
    origin: { sessionId: string; agentId: string };
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
  ENGINE_MODEL_RETRY: 'engine.model_retry',
  ITERATION_START: 'iteration.start',
  TURN_END: 'turn.end',

  /** Runner 收口计时（F3 转正） */
  RUN_TIMING: 'run.timing',

  TOOL_EXEC_START: 'tool.exec.start',
  TOOL_EXEC_END: 'tool.exec.end',
  TOOL_EXEC_UPDATE: 'tool.exec.update',

  INJECTION_DETECTED: 'injection.detected',
  POLICY_VIOLATED: 'policy.violated',
  SENSITIVE_DATA_DETECTED: 'sensitive_data.detected',
  SECURITY_BLOCKED: 'security.blocked',
  SECURITY_BEHAVIOR_BLOCKED: 'security.behavior_blocked',

  BUDGET_EXCEEDED: 'budget.exceeded',
  RUN_GUARD_STOPPED: 'run_guard.stopped',
  RUN_GUARD_RECOVERED: 'run_guard.recovered',

  SESSION_LIFECYCLE_UPDATED: 'session.lifecycle.updated',
  SESSION_ENDED: 'session.ended',
  SESSION_UPDATED: 'session.updated',
  PERSONA_RESOLVE_FAILED: 'persona.resolve.failed',
  CONTEXT_COMPACT_START: 'context.compact.start',
  CONTEXT_COMPACT_END: 'context.compact.end',
  CONTEXT_COMPACT_ERROR: 'context.compact.error',
  CONTEXT_LAYERS_ASSEMBLED: 'context.layers.assembled',
  RUN_SCOPE_READY: 'run.scope.ready',
  RUN_SCOPE_MESSAGES: 'run.scope.messages',
  RUN_SCOPE_LLM: 'run.scope.llm',
  RUN_GUARD_METRICS: 'run.guard.metrics',
  OPS_JAIL_STATE: 'ops.jail.state',
  OPS_POLICY_DEGRADED: 'ops.policy.degraded',
  OPS_CONFIG_SECURITY_CHANGED: 'ops.config.security_changed',

  TASK_CREATED: 'task.created',
  TASK_STARTED: 'task.started',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_CANCELLED: 'task.cancelled',
  TASK_TIMEOUT: 'task.timeout',
  TASK_RETRYING: 'task.retrying',
} as const satisfies Record<string, KnownAgentEventType>;
