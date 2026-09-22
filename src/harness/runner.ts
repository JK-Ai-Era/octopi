/**
 * SessionAwareRunner — Session 感知的运行器
 *
 * Harness 层组件。在 Agent.run()（自带 reliability）之上管理 Session 生命周期：
 * - 消息持久化
 * - Session 锁（同一 session 同时只有一个运行）
 * - Daily reset / Idle reset
 * - 并发控制
 *
 * Agent 是 Harness 运行时门面；不要再手拼 runAgentWithReliability。
 */

import type { Message, Turn, SessionStatus } from '../core/types.js';
import type { ToolContextProvider } from './agent-building/builder.js';
import type { SessionStore } from '../core/interfaces/session-store.js';
import type { SessionData } from './session-types.js';

type TypedSessionStore = SessionStore<SessionData>;
import type { Agent } from './agent/index.js';
import type { AgentContext } from '../loop/types.js';
import type { HarnessLoopEvent } from './reliability/harness-events.js';
import type { ReliabilityHarness } from './reliability/run-agent.js';
import { createSessionStateMachine } from './session-state-machine.js';
import type { StateMachine } from '../core/primitives/state-machine.js';
import { HeuristicTokenEstimator } from './context/index.js';
import { extractLayerQuery } from './context/layer-types.js';
import { withRuntimeDatetimeInjection } from './context/runtime-datetime.js';
import type { SessionTaskService } from './session-tasks/service.js';
import { renderSessionTasksInjection } from './session-tasks/render.js';
import { createRunId, type RunScope } from './run-scope.js';
import {
  DEFAULT_TOOL_ISOLATION,
  resolveToolIsolationCwd,
  type ToolIsolationMode,
} from './tool-effect/isolation.js';
import { mkdirSync } from 'node:fs';
import { readSessionCompact, writeSessionCompact } from './session-compact.js';
import type { ContextCompactSnapshot } from './context/types.js';
import {
  InProcessSessionLock,
  type SessionLease,
} from './concurrency/session-lease.js';

/** 运行器配置 */
export interface SessionAwareRunnerConfig {
  /** Session 过期时间（毫秒，默认 24 小时） */
  sessionExpiryMs?: number;
  /** 空闲过期时间（毫秒，默认 2 小时） */
  idleExpiryMs?: number;
  /** 是否启用 daily reset */
  enableDailyReset?: boolean;
  /**
   * 并发 session 门控（可选）
   *
   * 限制同时运行的 Agent Loop 数量，防止服务器资源耗尽。
   * 不传则不限制并发。
   */
  sessionGate?: import('./concurrency/session-gate.js').SessionGate;
  /**
   * 会话任务服务
   *
   * handle() 在 load session 后 attach，每轮注入未闭合 goal（step 仅 rollup）。
   * 与 task_* 工具共用同一实例。
   */
  sessionTaskService?: SessionTaskService;
  /**
   * 解析 run 级模型快照（Gateway 注入；每 run 调用一次）
   *
   * `modelRef` 为空表示 agent 默认模型。
   * 返回 null 表示解析失败（provider 缺失），回退 Agent 实例上的默认 provider。
   */
  resolveModelOverride?: (input: {
    modelRef?: string;
    defaultProvider?: string;
  }) => import('./model/types.js').ResolvedModel | null;
  /**
   * 工具效应隔离策略（宪法 I5）
   *
   * 默认 `'none'`（共享 agent.workspace）。多 Session 写文件建议 `'session-subdir'`。
   */
  toolIsolation?: ToolIsolationMode;
  /**
   * Agent 沙箱工作目录（agent.workspace）——toolIsolation 解析 cwd 的基路径回退。
   * RunConfig.cwd 优先于本字段。
   */
  agentWorkspace?: string;
  /**
   * Session lease（E2/E7）。默认 `InProcessSessionLock`。
   * 分布式部署注入 `DistributedSessionLease` 实现；勿假设内存锁全局有效。
   * Gateway 应向同一进程内所有 Runner 注入**同一** lease 实例。
   */
  sessionLease?: SessionLease;
  /**
   * 可选 Session ACL（E6）。注入后 handle 在 run 前 authorizeRun；
   * primary 无绑定自动 owner；非 primary 无绑定拒绝。
   */
  sessionAcl?: import('./session-acl/service.js').SessionAclService;
  /**
   * Agent 模板 Session 权利天花板（L1 · E6）。
   * 来自 AgentDefinition.maxSessionRights；authorizeRun 时取交集。
   */
  agentMaxSessionRights?: import('./session-acl/types.js').SessionRights;
  /** 产品 Observer 通道（Run 现场快照；缺省不采集） */
  observerHub?: import('./observer/hub.js').ObserverHub;
}

const DEFAULT_CONFIG: SessionAwareRunnerConfig = {
  sessionExpiryMs: 24 * 60 * 60 * 1000, // 24 小时
  idleExpiryMs: 2 * 60 * 60 * 1000,     // 2 小时
  enableDailyReset: true,
};

export interface RunConfig {
  systemPrompt: string;
  agentId?: string;
  sessionId?: string;
  /**
   * 模型名覆盖（裸名或 provider/model）。
   * 仅作用于本次 run；未设置时使用 Agent 默认模型。
   */
  model?: string;
  /** model 为裸名时的 provider 缺省 */
  modelProvider?: string;
  temperature?: number;
  cwd?: string;
  /** 本次 Run 的工具隔离覆盖（缺省用 Runner 配置 / DEFAULT_TOOL_ISOLATION） */
  toolIsolation?: ToolIsolationMode;
  /** Agent 模板 revision 绑 Run（Reserved：AgentRevision）；写入 RunScope / 审计 */
  agentRevision?: string;
  contextWindow?: number;
  injectedContext?: string;
}

/**
 * 适配 HarnessLoopEvent → AgentEvent（向后兼容）
 *
 * HarnessLoopEvent = Loop 协议事件 + budget/run_guard 扩展。
 * 旧消费者（Gateway/TUI）期望 AgentEvent。
 * 此函数桥接两者，避免一次性更新所有下游。
 */
/**
 * 将 Loop yield 事件适配为 EventBus 信封（向后兼容词表）
 *
 * @param event - HarnessLoopEvent
 * @param meta - agentId / sessionId
 * @param state - 桥接过程中的可变状态（assistant 文本等）
 * @returns AgentEvent；不广播时返回 null
 *
 * 导出供桥接映射测试使用；生产调用方仍为 SessionAwareRunner.handle。
 */
export function adaptLoopEvent(
  event: HarnessLoopEvent,
  meta: { agentId: string; sessionId: string },
  state: { assistantContent: string; lastUserContent?: string; stopReason?: string },
): import('../core/primitives/event-bus.js').AgentEvent | null {
  switch (event.type) {
    case 'run_guard_metrics':
      return {
        type: 'run.guard.metrics',
        timestamp: event.timestamp,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: { ...(event.data as Record<string, unknown>) },
      };
    case 'security_blocked':
      // 跟踪停止原因：security
      state.stopReason = 'security_stopped';
      return {
        type: 'security.blocked',
        timestamp: event.timestamp,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: { ...(event.data as Record<string, unknown>) },
      };
    case 'agent_start':
      return { type: 'engine.start', timestamp: event.timestamp, agentId: meta.agentId, sessionId: meta.sessionId, data: {} };
    case 'agent_end':
      // reason='error' 时映射为 engine.error（向后兼容旧引擎行为）
      if (event.reason === 'error') {
        return { type: 'engine.error', timestamp: event.timestamp, agentId: meta.agentId, sessionId: meta.sessionId, data: { error: event.error instanceof Error ? event.error.message : String(event.error ?? 'Unknown error') } };
      }
      return { type: 'engine.end', timestamp: event.timestamp, agentId: meta.agentId, sessionId: meta.sessionId, data: { reason: event.reason } };
    case 'turn_start':
      // 必须带 session 元数据：gatewayBus.onAll 以 event.sessionId 为 WS 广播前提
      return { type: 'iteration.start', timestamp: event.timestamp, agentId: meta.agentId, sessionId: meta.sessionId, data: {} };
    case 'assistant_message':
      state.assistantContent = typeof event.message.content === 'string' ? event.message.content : '';
      return null;
    case 'turn_end':
      // phase 透传给 UI：pre_tools ≠ 本轮 run 结束（见 architecture.md）
      return {
        type: 'turn.end',
        timestamp: Date.now(),
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: {
          content: state.assistantContent,
          userText: state.lastUserContent ?? '',
          hasToolCalls: event.hasToolCalls,
          phase: event.phase,
          usage: event.usage,
          truncated: event.truncated,
          error: event.error,
        },
      };
    case 'llm_stream_delta':
      return { type: 'llm_stream_delta', timestamp: event.timestamp, agentId: meta.agentId, sessionId: meta.sessionId, data: event.data };
    case 'tool_start':
      return { type: 'tool.exec.start', timestamp: event.timestamp, agentId: meta.agentId, sessionId: meta.sessionId, data: { toolCallId: event.toolCall.id, toolName: event.toolCall.name, args: event.toolCall.arguments } };
    case 'tool_end':
      return {
        type: 'tool.exec.end',
        timestamp: event.timestamp,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: {
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
          args: event.toolCall.arguments,
          hasError: !!event.result.isError,
          result: event.result.content,
          durationMs: event.result.durationMs,
        },
      };
    case 'stream.fallback_to_sync':
    case 'stream.fallback_failed':
      // 必须带 session 元数据：gatewayBus.onAll 以 event.sessionId 为 WS 广播前提
      return { type: event.type, timestamp: event.timestamp, agentId: meta.agentId, sessionId: meta.sessionId, data: event.data };
    case 'budget_exceeded':
      // 对齐 EventBus BUDGET_EXCEEDED；用户可见停止原因
      return {
        type: 'budget.exceeded',
        timestamp: event.timestamp,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: { ...event.data },
      };
    // P2 BudgetControlEvent 新形状
    case 'budget.wrap_up':
      return {
        type: 'budget.wrap_up',
        timestamp: event.timestamp,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: {
          metric: event.metric,
          unit: event.unit,
          used: event.used,
          hard: event.hard,
          userMessage: event.userMessage,
          resumeHint: event.resumeHint,
        },
      };
    case 'budget.exceeded':
      // 跟踪停止原因：context / policy
      state.stopReason = event.metric === 'context' ? 'context_stopped' : 'policy_stopped';
      return {
        type: 'budget.exceeded',
        timestamp: event.timestamp,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: {
          metric: event.metric,
          userMessage: event.userMessage,
          resumeHint: event.resumeHint,
        },
      };
    case 'run_guard_stopped':
      // 跟踪停止原因：behavior
      state.stopReason = 'behavior_stopped';
      return {
        type: 'run_guard.stopped',
        timestamp: event.timestamp,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: { ...event.data },
      };
    case 'run_guard_recovered':
      return {
        type: 'run_guard.recovered',
        timestamp: event.timestamp,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: { ...event.data },
      };
    case 'usage.advisory':
      return {
        type: 'usage.advisory',
        timestamp: event.timestamp,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: {
          metric: event.metric,
          unit: event.unit,
          used: event.used,
          hard: event.hard,
          userMessage: event.userMessage,
        },
      };
    default:
      return null;
  }
}

/**
 * SessionAwareRunner
 */
export class SessionAwareRunner {
  private agent: Agent;
  private harness: ReliabilityHarness;
  private store: TypedSessionStore;
  /** Session lease（E2/E7）：默认 in-process FIFO；可替换 */
  private sessionLease: SessionLease;
  private config: SessionAwareRunnerConfig;
  /** Session 状态机缓存 */
  private stateMachines = new Map<string, StateMachine<SessionStatus>>();
  /** 自主子系统运行时 */
  private _subsystemRuntime?: import('./autonomous-subsystem/runtime.js').SubsystemRuntime;
  /** EventBus 引用（用于子系统/多 Agent 上下文） */
  private _events?: import('../core/primitives/event-bus.js').EventBus;
  /** 产品 Observer Hub（Run 现场；可选） */
  private _observerHub?: import('./observer/hub.js').ObserverHub;
  /** 工具运行时上下文提供者 */
  private toolContextProvider?: ToolContextProvider;
  /** 文件式 persona 的 run 时解析器；每次 handle 前解析，实现热更新 */
  private systemPromptResolver?: () => Promise<string>;
  /** 最后一次成功解析的纯 persona（不含 injectedContext），用于 resolver 失败时的干净回退 */
  private lastCleanPersonaPrompt?: string;
  /** 按层契约组装 system prompt（persona + runtime）；未设置时退回字符串拼接 */
  private systemPromptAssembler?: (input: {
    sessionId: string;
    agentId?: string;
    messages: Message[];
    persona: string;
    injectedContext?: string;
    contextWindow?: number;
    signal?: AbortSignal;
  }) => Promise<{
    systemPrompt: string;
    manifest?: import('./context/layer-types.js').AssembleManifest;
    skippedBudget?: boolean;
  }>;
  /** 会话重置时清理 Assembler 层缓存 */
  private systemPromptAssemblerClear?: (sessionId: string) => void;
  /** 模型快照解析器（Gateway 注入；每 run 只调一次） */
  private resolveModelOverride?: SessionAwareRunnerConfig['resolveModelOverride'];

  constructor(agent: Agent, harness: ReliabilityHarness, store: TypedSessionStore, config?: SessionAwareRunnerConfig & { events?: import('../core/primitives/event-bus.js').EventBus }) {
    this.agent = agent;
    this.harness = harness;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionLease = config?.sessionLease ?? new InProcessSessionLock();
    this._events = config?.events;
    this._observerHub = config?.observerHub;
    this.resolveModelOverride = config?.resolveModelOverride;
  }

  /**
   * 注入 Observer Hub（Gateway / 测试用）
   *
   * @param hub - ObserverHub 实例
   */
  setObserverHub(hub: import('./observer/hub.js').ObserverHub | undefined): void {
    this._observerHub = hub;
  }

  /**
   * 发射事件：先采 Observer Hub，再进 EventBus（协调总线）
   */
  private emitObserved(event: import('../core/primitives/event-bus.js').AgentEvent): void {
    try {
      this._observerHub?.ingestEvent(event);
    } catch {
      // 观测 fail-open：不阻断事件广播
    }
    this._events?.emit(event);
  }

  /**
   * 注入模型快照解析器（Gateway 在 buildAgent 后调用）
   *
   * @param resolver - modelRef → ResolvedModel
   */
  setModelResolver(
    resolver: SessionAwareRunnerConfig['resolveModelOverride'],
  ): void {
    this.resolveModelOverride = resolver;
  }

  /**
   * 提取 run 级 modelRef
   *
   * 优先级：
   * 1. 消息级覆盖（RunConfig.model，仅当调用方显式传入）
   * 2. 会话覆盖（session.metadata.model）
   * 3. undefined → Resolver 按 agent 默认解析
   *
   * **不要**把 agent 默认模型写进 RunConfig.model，否则会吞掉会话覆盖。
   */
  private readRunModelRef(
    session: SessionData,
    runConfig: RunConfig,
  ): string | undefined {
    const fromRun = runConfig.model?.trim() || undefined;
    const sessionMetaModel = session.metadata?.model;
    let fromSession: string | undefined;
    if (typeof sessionMetaModel === 'string') {
      fromSession = sessionMetaModel.trim() || undefined;
    } else if (sessionMetaModel && typeof sessionMetaModel === 'object') {
      const obj = sessionMetaModel as { provider?: unknown; model?: unknown };
      if (typeof obj.model === 'string' && obj.model) {
        fromSession = typeof obj.provider === 'string' && obj.provider
          ? `${obj.provider}/${obj.model}`
          : obj.model;
      }
    }
    return fromRun || fromSession || undefined;
  }

  /** 设置自主子系统运行时 */
  setSubsystemRuntime(runtime: import('./autonomous-subsystem/runtime.js').SubsystemRuntime): void {
    this._subsystemRuntime = runtime;
  }

  /** 设置工具运行时上下文提供者 */
  setToolContextProvider(provider: ToolContextProvider): void {
    this.toolContextProvider = provider;
  }

  /**
   * 设置 persona 解析器
   *
   * 每次 handle 且 RunConfig.systemPrompt 为空时调用；
   * 文件变更后下一轮自动生效，无需重启。
   *
   * @param resolver - 从磁盘解析纯 persona
   * @param initialCleanPersona - build 时读到的磁盘 persona（可能为 ''）；
   *   用于区分「从未有人格文件」（保留默认 tools prompt）与「有过后被删空」（热删除清空）
   */
  setSystemPromptResolver(resolver: () => Promise<string>, initialCleanPersona = ''): void {
    this.systemPromptResolver = resolver;
    // 仅首次挂 resolver 时播种；替换 resolver 不得用可能被 injectedContext 污染的 context 覆盖
    if (this.lastCleanPersonaPrompt === undefined) {
      this.lastCleanPersonaPrompt = initialCleanPersona;
    }
  }

  /**
   * 设置 system prompt 层装配器
   *
   * 每轮在 persona resolve 与 injectedContext 计算完成后调用，
   * 替代原先的字符串拼接。未设置时保持旧路径（兼容）。
   */
  setSystemPromptAssembler(
    assembler: (input: {
      sessionId: string;
      agentId?: string;
      messages: Message[];
      persona: string;
      injectedContext?: string;
      contextWindow?: number;
      signal?: AbortSignal;
    }) => Promise<{ systemPrompt: string; manifest?: import('./context/layer-types.js').AssembleManifest }>,
    clearSession?: (sessionId: string) => void,
  ): void {
    this.systemPromptAssembler = assembler;
    this.systemPromptAssemblerClear = clearSession;
  }

  /**
   * 处理一条消息
   *
   * @param sessionId - Session 标识
   * @param input - 用户输入消息
   * @param runConfig - Agent 运行配置
   * @param signal - 中止信号
   * @yields AgentEvent 事件流（向后兼容格式）
   */
  async *handle(
    sessionId: string,
    input: Message,
    runConfig: RunConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<import('../core/primitives/event-bus.js').AgentEvent> {
    // 1. 并发门控（如果配置了 SessionGate）；排队期间响应 abort
    const gate = this.config.sessionGate;
    let gateRelease: (() => void) | undefined;
    if (gate) {
      try {
        gateRelease = await gate.enter(signal);
      } catch (err) {
        // 用户中止：空 generator，Runtime 按 signal.aborted 判 skipped(aborted)，勿成 failed
        if (signal?.aborted) {
          return;
        }
        throw err;
      }
    }

    // 2. 获取锁（等锁期间可能被 abort）
    const release = await this.acquireLock(sessionId);

    // 拿锁后若已中止：不 load / 不 push，避免幽灵用户消息（arch/agent-runtime.md 审查项）
    if (signal?.aborted) {
      release();
      gateRelease?.();
      return;
    }

    const _agentId = runConfig.agentId ?? 'default';

    /** Observer 收口状态（finally 统一关闭，含异常路径） */
    let observerRunId = '';
    let observerFinalMessages: Message[] | undefined;
    let observerEndReason: string | undefined;
    let observerErrorMsg: string | undefined;
    let hasTurnEnd = false;

    try {
      // 3. 加载或创建 session
      let session = await this.store.load(sessionId);
      if (!session) {
        session = this.createSession(sessionId, runConfig.agentId ?? 'default');
      }
      // 模型 2：历史数据缺省 primary 时回填（单 agent 行为不变）
      if (!session.primaryAgentId) {
        session.primaryAgentId = session.agentId || _agentId;
      }
      if (!session.tasks) session.tasks = [];

      // E6：可选 ACL（注入时才强制）；primary 自动 owner；带入 agent 天花板
      const acl = this.config.sessionAcl;
      if (acl) {
        const auth = acl.authorizeRun({
          session,
          agentId: _agentId,
          agentMax: this.config.agentMaxSessionRights,
        });
        if (!auth.ok) {
          yield {
            type: 'engine.error',
            timestamp: Date.now(),
            agentId: _agentId,
            sessionId,
            data: { error: auth.reason ?? 'session ACL denied run' },
          } as never;
          return;
        }
      }

      // 4. 检查 session 是否需要重置
      this.checkSessionReset(session);

      // 4b. 绑定会话任务服务（工具与注入共用同一内存对象）
      this.config.sessionTaskService?.attachSession(session);

      // 5. 追加用户消息
      session.messages.push(input);
      session.meta.lastInteractionAt = Date.now();
      session.meta.updatedAt = Date.now();

      // 通知子系统：主会话生命周期态（通用）
      this.emitObserved({
        type: 'session.lifecycle.updated',
        timestamp: Date.now(),
        agentId: _agentId,
        sessionId,
        data: {
          lifecycle: 'active',
          lastInteractionAt: session.meta.lastInteractionAt,
        },
      });

      // 状态机：idle → processing
      const sm = this.getOrCreateStateMachine(sessionId, session.meta.status);
      sm.transition('processing');
      session.meta.status = sm.state;

      // 6. 会话任务注入
      let effectiveRunConfig = runConfig;
      if (this.config.sessionTaskService) {
        const taskInjection = renderSessionTasksInjection(session.tasks ?? []);
        if (taskInjection) {
          const baseInjected = runConfig.injectedContext;
          effectiveRunConfig = {
            ...runConfig,
            injectedContext: baseInjected ? `${baseInjected}\n\n${taskInjection}` : taskInjection,
          };
        }
      }

      // 7. 应用自主子系统的待处理注入
      if (this._subsystemRuntime) {
        if (this._events) {
          this._subsystemRuntime.setMainAgentContext({
            messages: session.messages,
            runConfig: effectiveRunConfig,
            events: this._events,
            sessionLifecycle: session.lifecycle?.lifecycle ?? 'active',
            lastInteractionAt: session.meta.lastInteractionAt,
            idleMs: Date.now() - (session.meta.lastInteractionAt ?? Date.now()),
            extractionStatus: 'pending',
          });
          // 注入指标
          this._subsystemRuntime.metrics.update('turn.count', session.messages.filter(m => m.role === 'assistant').length);
        }
        this._subsystemRuntime.applyPendingInjections(session.messages);

        // steering / escalate：当前轮次立即生效（escalate 优先，写入 injectedContext）
        const guidance = this._subsystemRuntime.consumePendingGuidance();
        if (guidance) {
          const base = effectiveRunConfig.injectedContext;
          effectiveRunConfig = {
            ...effectiveRunConfig,
            injectedContext: base ? `${base}\n\n${guidance}` : guidance,
          };
        }
      }

      // Runtime datetime：每轮锚定当前时间，供时间敏感任务使用
      effectiveRunConfig = {
        ...effectiveRunConfig,
        injectedContext: withRuntimeDatetimeInjection(effectiveRunConfig.injectedContext),
      };

      // 8. 工具运行时：setRuntime 仅作无 ALS 时的回退；权威身份在 RunScope
      if (this.toolContextProvider) {
        this.toolContextProvider.setRuntime(sessionId, _agentId, session.messages);
      }

      // 9. 本 Run 私有 AgentContext（宪法 I1）——禁止写入共享 agent.context.messages
      const runContext: AgentContext = {
        systemPrompt: '',
        messages: session.messages,
        tools: this.agent.tools,
      };
      // 播种压缩状态（E4 键 = sessionId × agentId）；供 convertToLlm / 重启重建
      this.agent.setSessionCompactState(
        sessionId,
        _agentId,
        readSessionCompact(session, _agentId),
      );
      let basePrompt = effectiveRunConfig.systemPrompt;
      let personaFromResolver = false;
      if (!basePrompt && this.systemPromptResolver) {
        try {
          const resolved = await this.systemPromptResolver();
          const previouslyHadPersona = (this.lastCleanPersonaPrompt ?? '') !== '';
          this.lastCleanPersonaPrompt = resolved;
          if (resolved) {
            // 有 persona：同步到 Agent / SecurityGuard（模板级，非「当前会话」）
            this.agent.setSystemPrompt(resolved);
            this.harness.security?.setSystemPrompt?.(resolved);
            basePrompt = resolved;
            personaFromResolver = true;
          } else if (previouslyHadPersona) {
            // 热删除：曾有内容、现被删空 → 显式清空
            this.agent.setSystemPrompt('');
            this.harness.security?.setSystemPrompt?.('');
            basePrompt = '';
            personaFromResolver = true;
          } else {
            // 从未有 persona 文件：保留 build 时的 fallback（如默认 tools prompt），不视为失败
            basePrompt = '';
            personaFromResolver = false;
          }
        } catch (err) {
          // 仅磁盘读失败：回退到上次成功的纯 persona，避免吃到 injectedContext 拼接结果
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[octopi] persona resolve failed (agent=${_agentId} session=${sessionId}): ${errMsg}; falling back to last clean persona`,
          );
          this.emitObserved({
            type: 'persona.resolve.failed',
            timestamp: Date.now(),
            agentId: _agentId,
            sessionId,
            data: { error: errMsg },
          });
          basePrompt = this.lastCleanPersonaPrompt ?? effectiveRunConfig.systemPrompt ?? '';
        }
      }
      if (!basePrompt && !personaFromResolver) {
        basePrompt = effectiveRunConfig.systemPrompt || this.agent.context.systemPrompt || '';
      }

      // ── Run 级模型快照：每 run 只 resolve 一次（必须在 system assembler 之前）──
      const modelRef = this.readRunModelRef(session, effectiveRunConfig);
      const resolvedModel = this.resolveModelOverride
        ? this.resolveModelOverride({
            modelRef,
            defaultProvider: effectiveRunConfig.modelProvider,
          })
        : null;
      if (resolvedModel) {
        effectiveRunConfig = {
          ...effectiveRunConfig,
          contextWindow: resolvedModel.contextWindow,
          model: resolvedModel.modelName,
        };
      }

      // system prompt 终装：Assembler（层契约）优先，否则退回字符串拼接
      // 结果只写入 runContext / RunScope，不作为「Agent 当前会话状态」
      if (this.systemPromptAssembler) {
        try {
          const assembled = await this.systemPromptAssembler({
            sessionId,
            agentId: _agentId,
            messages: session.messages,
            persona: basePrompt,
            injectedContext: effectiveRunConfig.injectedContext,
            contextWindow: effectiveRunConfig.contextWindow,
            signal,
          });
          runContext.systemPrompt = assembled.systemPrompt;
          if (assembled.manifest) {
            const assembledAt = Date.now();
            this.emitObserved({
              type: 'context.layers.assembled',
              timestamp: assembledAt,
              agentId: _agentId,
              sessionId,
              data: {
                sessionId,
                agentId: _agentId,
                manifest: assembled.manifest,
                enabledLayerIds: assembled.manifest.layers.map((l) => l.id),
                query: extractLayerQuery(session.messages),
                assembledAt,
              },
            });
          }
        } catch (err) {
          // 装配失败：回退拼接，保证本轮可跑
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[octopi] system prompt assemble failed (session=${sessionId}): ${errMsg}; falling back to concat`,
          );
          runContext.systemPrompt = this.concatSystemPrompt(basePrompt, effectiveRunConfig.injectedContext, personaFromResolver);
          this.emitObserved({
            type: 'context.layers.assembled',
            timestamp: Date.now(),
            agentId: _agentId,
            sessionId,
            data: {
              sessionId,
              agentId: _agentId,
              manifest: {
                sessionId,
                systemBudget: 0,
                usedTokens: 0,
                shares: {},
                layers: [],
              },
              fallback: true,
              fallbackError: errMsg,
              assembledAt: Date.now(),
            },
          });
        }
      } else {
        runContext.systemPrompt = this.concatSystemPrompt(basePrompt, effectiveRunConfig.injectedContext, personaFromResolver);
      }

      // 更新 harness 的 sessionId/agentId（checkpoint 回退；权威身份在 RunScope ALS）
      this.harness.sessionId = sessionId;
      this.harness.agentId = effectiveRunConfig.agentId ?? 'default';
      // 兼容回退：无 ALS 消费方时的 contextSessionId（Map 键场景仍用显式 sessionId）
      this.agent.setContextSessionId(sessionId);

      // I5：工具效应 cwd —— RunConfig.cwd > agent.workspace；session-subdir 再拼 sessionId
      const isolationMode: ToolIsolationMode =
        effectiveRunConfig.toolIsolation
        ?? this.config.toolIsolation
        ?? DEFAULT_TOOL_ISOLATION;
      const baseCwd =
        (effectiveRunConfig.cwd?.trim() ? effectiveRunConfig.cwd.trim() : undefined)
        ?? (this.config.agentWorkspace?.trim() ? this.config.agentWorkspace.trim() : undefined);
      const resolvedToolCwd = resolveToolIsolationCwd({
        mode: isolationMode,
        sessionId,
        baseCwd,
      });
      if (isolationMode === 'session-subdir' && resolvedToolCwd.cwd) {
        try {
          mkdirSync(resolvedToolCwd.cwd, { recursive: true });
        } catch (err) {
          // 目录创建失败不阻断 run：工具侧仍可能自行 mkdir；此处吞掉仅因非致命 IO
          console.warn(
            `[octopi] toolIsolation session-subdir mkdir failed (session=${sessionId}, cwd=${resolvedToolCwd.cwd}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Run 身份与 RunScope 对齐（Observer/审计共用，不另造第二套 ID）
      const runId = createRunId(sessionId, _agentId);
      const runScope: RunScope = {
        sessionId,
        agentId: _agentId,
        runId,
        systemPrompt: runContext.systemPrompt,
        agentRevision: effectiveRunConfig.agentRevision,
        toolRuntime: {
          sessionId,
          agentId: _agentId,
          messages: session.messages,
          cwd: resolvedToolCwd.cwd,
          isolation: resolvedToolCwd.mode,
        },
      };

      // Observer 通道：Run 现场快照（摘要进事件；全文由 Hub/REST 提供）
      if (this._observerHub?.isEnabled()) {
        observerRunId =
          this._observerHub.recordRunStart({
            scope: runScope,
            runId,
            resolvedModel: resolvedModel
              ? {
                  modelName: resolvedModel.modelName,
                  providerId: resolvedModel.providerName,
                  contextWindow: resolvedModel.contextWindow,
                }
              : undefined,
            messages: session.messages,
          }) || runId;
        if (observerRunId) {
          const hubSnapshot = this._observerHub.getRunById(observerRunId);
          if (hubSnapshot) {
            this.emitObserved({
              type: 'run.scope.ready',
              timestamp: hubSnapshot.scope.capturedAt,
              agentId: _agentId,
              sessionId,
              data: {
                sessionId,
                agentId: _agentId,
                runId: observerRunId,
                scope: hubSnapshot.scope,
                messages: hubSnapshot.messagesSummary,
              },
            });
            if (hubSnapshot.messagesSummary) {
              this.emitObserved({
                type: 'run.scope.messages',
                timestamp: Date.now(),
                agentId: _agentId,
                sessionId,
                data: {
                  sessionId,
                  agentId: _agentId,
                  runId: observerRunId,
                  phase: 'entry',
                  summary: hubSnapshot.messagesSummary,
                },
              });
            }
          }
        }
      }

      // Token 估算器（当 LLM 不返回 usage 时用于回退估算）
      const estimator = new HeuristicTokenEstimator();

      // 10. 运行 Agent（Agent.run = reliability 包装；context/runScope 为本 Run 私有）
      let streamedContent = '';
      let lastUsage: import('../core/types/turn.js').TokenUsage | undefined = undefined;
      const meta = { agentId: effectiveRunConfig.agentId ?? 'default', sessionId };
      const adaptState: { assistantContent: string; lastUserContent: string; stopReason?: string } = { assistantContent: '', lastUserContent: '' };
      /** 本轮起始消息下标（afterTurn 只传增量） */
      let turnStartIndex = runContext.messages.length;

      // resolvedModel 已在 system assembler 之前解析；此处只组装 run options
      const agentRunOptions = {
        resolvedModel: resolvedModel ?? undefined,
        context: runContext,
        runScope,
      };

      for await (const loopEvent of this.agent.run(signal, undefined, agentRunOptions)) {
        // 适配事件格式（向后兼容）
        const adapted = adaptLoopEvent(loopEvent, meta, adaptState);
        if (adapted) {
          // 捕获 usage 数据，并在 turn.end 事件中附加上下文信息（必须在 yield 之前，
          // 否则 gateway 收到事件后立即广播，data 里还没有 context 字段）
          if (adapted.type === 'turn.end') {
            const rawUsage = adapted.data?.usage as
              | import('../core/types/turn.js').TokenUsage
              | undefined;
            if (rawUsage) {
              lastUsage = rawUsage;
            }
            (adapted.data as Record<string, unknown>).contextTokens =
              lastUsage?.inputReportedTokens ??
              (lastUsage
                ? lastUsage.inputUncachedTokens + lastUsage.inputCachedTokens + lastUsage.inputCacheWriteTokens
                : undefined) ??
              estimator.estimateMessages(session.messages);
            (adapted.data as Record<string, unknown>).contextWindow = effectiveRunConfig.contextWindow;
          }

          yield adapted;
          // 事件桥：循环事件同时广播到 EventBus
          // 跳过高频流式 delta（每 token 一次），避免 EventBus 拥塞
          if (adapted.type !== 'llm_stream_delta') {
            this.emitObserved(adapted);
          }
        }

        // 收集流式内容
        if (loopEvent.type === 'llm_stream_delta' && loopEvent.data?.delta) {
          streamedContent += loopEvent.data.delta;
        }

        // 捕获 assistant 消息内容
        if (loopEvent.type === 'assistant_message') {
          adaptState.assistantContent = typeof loopEvent.message.content === 'string' ? loopEvent.message.content : '';
        }

        // turn_start：重置本轮增量游标（afterTurn 只传本轮消息）
        if (loopEvent.type === 'turn_start') {
          turnStartIndex = runContext.messages.length;
        }

        // turn.end → 记录 turn
        if (loopEvent.type === 'turn_end') {
          hasTurnEnd = true;
          if (loopEvent.usage) {
            lastUsage = loopEvent.usage;
          }
          const turnMessages = runContext.messages.slice(turnStartIndex);
          await this.agent.notifyAfterTurn(lastUsage, turnMessages);
          turnStartIndex = runContext.messages.length;
          const content = adaptState.assistantContent || streamedContent;
          if (content) {
            session.turns.push({
              id: `turn_${Date.now()}`,
              input: session.messages.slice(0, -1),
              output: { role: 'assistant', content, timestamp: Date.now(), agentId: _agentId },
              usage: lastUsage,
              durationMs: 0,
              model: effectiveRunConfig.model ?? 'unknown',
              timestamp: Date.now(),
            });
          }
        }
      }

      // 10. 将本 Run 工作区写回 session（Loop 原地修改的是 runContext.messages）
      //     含 Loop 注入的托管 systemPrompt（metadata.source='systemPrompt'）：
      //     落盘保留审计价值；聊天 UI 在 history 映射时过滤，不回放进对话
      //     模型 2 归因：assistant/tool 消息补齐本 Run 的 agentId（来自 Run 身份）
      for (const m of runContext.messages) {
        if ((m.role === 'assistant' || m.role === 'tool') && m.agentId === undefined) {
          m.agentId = _agentId;
        }
      }
      session.messages = runContext.messages;

      // 11. 引擎异常退出时的 session 一致性修复（须在 Observer final 采样之前）
      if (!hasTurnEnd) {
        const fallbackContent = streamedContent || '';
        if (fallbackContent) {
          session.messages.push({
            role: 'assistant',
            content: fallbackContent,
            timestamp: Date.now(),
            agentId: _agentId,
          });
          session.turns.push({
            id: `turn_${Date.now()}`,
            input: session.messages.slice(0, -1),
            output: { role: 'assistant', content: fallbackContent, timestamp: Date.now(), agentId: _agentId },
            usage: lastUsage,
            durationMs: 0,
            model: effectiveRunConfig.model ?? 'unknown',
            timestamp: Date.now(),
          });
        }
      }

      // Observer：记录最终 messages 与 endReason（真正 close 在 finally，保证异常也闭合）
      observerFinalMessages = session.messages;
      // P5: 使用 stopReason 区分终态（context_stopped / behavior_stopped / policy_stopped / security_stopped / completed）
      observerEndReason = adaptState.stopReason ?? (hasTurnEnd ? 'completed' : 'no_turn_end');

      // 12. 持久化
      sm.transition('idle');
      session.meta.status = sm.state;
      session.meta.updatedAt = Date.now();
      // 压缩状态写回 Session（E4 分桶 + primary 兼容视图）
      const compactSnap = this.agent.getSessionCompactState(sessionId, _agentId);
      writeSessionCompact(session, _agentId, compactSnap);
      await this.store.save(sessionId, session);

      // 通知子系统：本轮处理完成（保持 active，但刷新 lastInteractionAt）
      this.emitObserved({
        type: 'session.lifecycle.updated',
        timestamp: Date.now(),
        agentId: _agentId,
        sessionId,
        data: {
          lifecycle: session.lifecycle?.lifecycle ?? 'active',
          extractionStatus: 'pending',
          lastInteractionAt: session.meta.lastInteractionAt,
        },
      });

    } catch (err) {
      observerEndReason = 'error';
      observerErrorMsg = err instanceof Error ? err.message : String(err);
      // 引擎出错：状态机转到 error，持久化
      const sm = this.stateMachines.get(sessionId);
      if (sm?.canTransition('error')) {
        sm.transition('error');
        const session = await this.store.load(sessionId);
        if (session) {
          session.meta.status = sm.state;
          session.meta.updatedAt = Date.now();
          if (!observerFinalMessages) observerFinalMessages = session.messages;
          await this.store.save(sessionId, session);

          this.emitObserved({
            type: 'engine.error',
            timestamp: Date.now(),
            agentId: _agentId,
            sessionId,
            data: { error: observerErrorMsg },
          });

          // 通知子系统：异常路径下保持生命周期可感知
          this.emitObserved({
            type: 'session.lifecycle.updated',
            timestamp: Date.now(),
            agentId: _agentId,
            sessionId,
            data: {
              lifecycle: 'recent',
              extractionStatus: 'pending',
              lastInteractionAt: session.meta.lastInteractionAt,
            },
          });
        }
      }
      throw err;
    } finally {
      // 清理 task service 的活 session 缓存（避免长时间运行进程内存泄漏）
      this.config.sessionTaskService?.detachSession(_agentId, sessionId);

      // Observer 统一收口：成功/失败都关闭 run，避免僵尸 active
      if (observerRunId && this._observerHub?.isEnabled()) {
        try {
          this._observerHub.recordRunEnd({
            runId: observerRunId,
            sessionId,
            messages: observerFinalMessages,
            endReason: observerEndReason ?? 'unknown',
            error: observerErrorMsg,
          });
          // 事件投影用 getRunById（不要求 webPanel）；REST 才受 webPanel 门控
          const finalSnap = this._observerHub.getRunById(observerRunId);
          const finalSummary =
            finalSnap?.messagesSummary ??
            this._observerHub
              .getRunMessages(sessionId, { runId: observerRunId, phase: 'final' })?.summary;
          if (finalSummary) {
            this.emitObserved({
              type: 'run.scope.messages',
              timestamp: Date.now(),
              agentId: _agentId,
              sessionId,
              data: {
                sessionId,
                agentId: _agentId,
                runId: observerRunId,
                phase: 'final',
                summary: finalSummary,
              },
            });
          }
        } catch {
          // 观测收口失败不阻断锁释放
        }
      }
      release();
      gateRelease?.();
    }
  }

  /**
   * Session compact under the same session lock as handle (E1/E4).
   *
   * Authority is the runner session lock, not status==='processing'.
   * Compact key = (sessionId, agentId). Concurrent handle/compact on the
   * same sessionId queue FIFO; different sessions stay concurrent.
   *
   * @param sessionId - session id
   * @param agentId - compact view owner (usually session.agentId / primary)
   * @param options - structural compact engine callback + summarize params
   * @returns compact result
   */
  async compactSession(
    sessionId: string,
    agentId: string,
    options: {
      compactStructural: (input: {
        sessionId: string;
        agentId: string;
        messages: Message[];
        summarize?: (
          messages: import('../core/interfaces/model-provider.js').LLMMessage[],
          opts?: { maxTokens?: number },
        ) => Promise<string>;
        compactTargetTokens?: number;
      }) => Promise<{
        ok: boolean;
        compacted: boolean;
        reason?: string;
        tokensBefore: number;
        tokensAfter?: number;
        summary?: string;
      }>;
      summarize?: (
        messages: import('../core/interfaces/model-provider.js').LLMMessage[],
        opts?: { maxTokens?: number },
      ) => Promise<string>;
      compactTargetTokens?: number;
    },
  ): Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    tokensBefore: number;
    tokensAfter?: number;
    summary?: string;
  }> {
    const release = await this.acquireLock(sessionId);
    try {
      const session = await this.store.load(sessionId);
      if (!session) {
        return {
          ok: false,
          compacted: false,
          reason: 'session not found',
          tokensBefore: 0,
        };
      }

      const result = await options.compactStructural({
        sessionId,
        agentId,
        messages: session.messages,
        summarize: options.summarize,
        compactTargetTokens: options.compactTargetTokens,
      });

      if (result.ok && result.summary) {
        const snap: ContextCompactSnapshot = {
          summary: result.summary,
          lastProactiveMessageCount: session.messages.length,
          lastProactiveTokens: result.tokensAfter,
        };
        this.agent.setSessionCompactState(sessionId, agentId, snap);
        writeSessionCompact(session, agentId, snap);
        session.meta.updatedAt = Date.now();
        await this.store.save(sessionId, session);
      }

      return result;
    } finally {
      release();
    }
  }

  /**
   * 获取 Session 锁（经 SessionLease；E2 键 = sessionId）
   *
   * 使用 Promise 队列实现，避免 polling 开销。
   * 请求按 FIFO 顺序获取锁，无饥饿问题。
   * 分布式：注入 DistributedSessionLease；勿假设 in-process 锁全局有效（E7）。
   */
  private async acquireLock(sessionId: string): Promise<() => void> {
    return this.sessionLease.acquire(sessionId);
  }

  /**
   * 创建新 Session
   *
   * 模型 2：`primaryAgentId` = 创建时的 agentId（Accountability）。
   * 存储主键 = sessionId；agentId 只作归属/参与投影。
   */
  private createSession(sessionId: string, agentId: string): SessionData {
    return {
      id: sessionId,
      agentId,
      primaryAgentId: agentId,
      meta: {
        id: sessionId,
        agentId,
        channelId: 'unknown',
        peerId: 'unknown',
        status: 'idle',
        createdAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        updatedAt: Date.now(),
      },
      messages: [],
      turns: [],
      metadata: {},
      tasks: [],
    };
  }

  /** 旧路径：persona + injectedContext 字符串拼接；结果返回给 runContext，不写共享 Agent */
  private concatSystemPrompt(
    basePrompt: string,
    injectedContext: string | undefined,
    personaFromResolver: boolean,
  ): string {
    if (injectedContext) {
      return basePrompt
        ? `${basePrompt}\n\n${injectedContext}`
        : injectedContext;
    }
    if (personaFromResolver || basePrompt) {
      return basePrompt;
    }
    return basePrompt;
  }

  /**
   * 获取或创建 Session 状态机
   *
   * 如果 session 已有状态，从该状态初始化状态机（避免重启后状态不同步）。
   */
  private getOrCreateStateMachine(sessionId: string, currentStatus?: SessionStatus): StateMachine<SessionStatus> {
    let sm = this.stateMachines.get(sessionId);
    if (!sm) {
      sm = createSessionStateMachine();
      // 从 session 当前状态初始化（处理重启/恢复场景）
      if (currentStatus && currentStatus !== 'idle') {
        sm.force(currentStatus);
      }
      this.stateMachines.set(sessionId, sm);
    }
    return sm;
  }

  /**
   * 检查 Session 是否需要重置
   */
  private checkSessionReset(session: SessionData): void {
    const now = Date.now();
    let didReset = false;

    // Daily reset
    if (this.config.enableDailyReset) {
      const sessionDay = new Date(session.meta.sessionStartedAt).toDateString();
      const today = new Date(now).toDateString();
      if (sessionDay !== today) {
        session.messages = [];
        session.turns = [];
        session.meta.sessionStartedAt = now;
        didReset = true;
      }
    }

    // Idle reset：历史清空前把会话标为 recent+pending，供 memory extract 触发
    if (this.config.idleExpiryMs) {
      const idle = now - session.meta.lastInteractionAt;
      if (idle > this.config.idleExpiryMs) {
        this.markSessionRecent(session, now);
        session.messages = [];
        session.turns = [];
        session.meta.sessionStartedAt = now;
        didReset = true;
      }
    }

    if (didReset) {
      // 历史清空后，层指纹与压缩快照一并失效（E4：清全部 agent 桶）
      this.systemPromptAssemblerClear?.(session.id);
      writeSessionCompact(session, session.primaryAgentId ?? session.agentId, undefined);
      const resetAgentIds = new Set<string>([
        session.primaryAgentId ?? session.agentId,
        session.agentId,
        ...Object.keys(session.contextCompacts ?? {}),
      ]);
      for (const aid of resetAgentIds) {
        this.agent.setSessionCompactState(session.id, aid, undefined);
      }
      delete session.contextCompact;
      delete session.contextCompacts;
    }
  }

  /**
   * 将 session 生命周期落到 recent + endedAt，并广播事件。
   * 状态在 SessionData.lifecycle；由后续 save 持久化（meta 索引投影）。
   * 不写 memoryExtraction（进度归 memory.steward）；事件仍带 extractionStatus 供 Sense 感知。
   */
  private markSessionRecent(session: SessionData, now: number): void {
    session.lifecycle = {
      lifecycle: 'recent',
      endedAt: now,
    };

    this.emitObserved({
      type: 'session.lifecycle.updated',
      timestamp: now,
      agentId: session.agentId,
      sessionId: session.id,
      data: {
        lifecycle: 'recent',
        extractionStatus: 'pending',
        lastInteractionAt: session.meta.lastInteractionAt,
      },
    });
  }
}
