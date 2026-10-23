/**
 * SessionAwareRunner — Session 感知的运行器
 *
 * Harness 层组件。在 Agent.run()（自带 reliability）之上管理 Session 生命周期：
 * - 消息持久化（Discourse 追加日志；不因 idle/跨日清空）
 * - Session 锁（同一 session 同时只有一个运行）
 * - 上下文租约（`idleExpiryMs` opt-in：只截 LLM 默认窗口）
 * - 中止轮标记（`abortedTurn`，供 UI 编辑重发）
 * - 并发控制
 *
 * Agent 是 Harness 运行时门面；不要再手拼 runAgentWithReliability。
 */

import type { Message, Turn, SessionStatus } from '@octopi-agent/core/types.js';
import { getTextContent } from '@octopi-agent/core/types.js';
import type { ToolContextProvider } from '../agent/builder.js';
import { tightenSessionRights } from '../governance/session-acl/rights.js';
import type { SessionStore } from '@octopi-agent/core/interfaces/session-store.js';
import type { SessionData } from '../session/types.js';

type TypedSessionStore = SessionStore<SessionData>;
import type { Agent } from './agent/index.js';
import type { AgentContext } from '@octopi-agent/core/loop/types.js';
import type { HarnessLoopEvent } from './reliability/harness-events.js';
import type { ReliabilityHarness } from './reliability/run-agent.js';
import { createSessionStateMachine } from '../session/state-machine.js';
import type { StateMachine } from '@octopi-agent/core/primitives/state-machine.js';
import { HeuristicTokenEstimator } from '../context/index.js';
import { extractLayerQuery, isEngineCarrierSource } from '../context/layer-types.js';
import {
  formatTurnEndContent,
  formatTurnId,
  formatTurnStartContent,
  formatTurnContextXml,
  isTurnEndContent,
  isTurnStartContent,
  joinSlotXml,
  parseTurnIdFromContent,
} from '../context/turn-envelope.js';
import { splitRuntimeEnvironmentInjection, withRuntimeEnvironmentInjection } from '../context/runtime-datetime.js';
import { loadRootInstructionsInjection } from '../context/root-instructions.js';
import type { SessionTaskService } from '../session/tasks/service.js';
import { extractTaskQueryHints, renderSessionTasksInjection } from '../session/tasks/render.js';
import { createRunId, type RunScope } from './run-scope.js';
import {
  DEFAULT_TOOL_ISOLATION,
  resolveToolIsolationCwd,
  type ToolIsolationMode,
} from '../extension/execution-environment/isolation.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { toSessionFileName } from '@octopi-agent/core/session-filename.js';
import { readSessionCompact, writeSessionCompact } from '../session/compact.js';
import type { ContextCompactSnapshot } from '../context/types.js';
import {
  InProcessSessionLock,
  type SessionLease,
} from './concurrency/session-lease.js';
import { isToolPermitted } from '../governance/session-acl/tool-rights.js';
import { resolveToolCapabilities } from '../extension/execution-environment/tool-capabilities.js';

/** 运行器配置 */
export interface SessionAwareRunnerConfig {
  /**
   * 上下文租约（毫秒）。**显式配置才生效**；缺省 / 0 = 关闭。
   *
   * 闲置超过本值后，下一轮 LLM 默认消息窗口从租约点截断（Discourse 全量保留）。
   * 需要旧内容时走 session_search / session_read。与 memory 冷沉淀解耦。
   */
  idleExpiryMs?: number;
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
   * 会话日程服务（Agent 自发起定时）
   *
   * handle() 每轮注入未闭合 schedule；与 schedule_* 工具共用同一实例。
   */
  sessionScheduleService?: import('../session/schedules/service.js').SessionScheduleService;
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
  sessionAcl?: import('../governance/session-acl/service.js').SessionAclService;
  /**
   * Agent 模板 Session 权利天花板（L1 · E6）。
   * 来自 AgentDefinition.maxSessionRights；authorizeRun 时取交集。
   */
  agentMaxSessionRights?: import('../governance/session-acl/types.js').SessionRights;
  /**
   * Agent 静态工具策略（agents[].tools allow/deny）。
   * 与 sessionToolRights 求交；deny 优先（SEC-2）。
   */
  agentToolPolicy?: import('@octopi-agent/core/types.js').ToolPolicy;
  /** 产品 Observer 通道（Run 现场快照；缺省不采集） */
  observerHub?: import('../observability/observer/hub.js').ObserverHub;
  /**
   * 会话数据根目录（`OCTOPI_HOME/sessions`）。附件根 = `<sessionsDir>/<sid>/attachments`；
   * turn 文件 undo = `<sessionsDir>/<sid>/undo`（ToolEffectPolicy L3）。
   */
  sessionsDir?: string;
  /** ToolEffectPolicy（P3）；展开后驱动 toolIsolation / L2 */
  effectPolicy?: import("../extension/execution-environment/effect-policy.js").EffectPolicyConfig;
  /** credentials.requireBindings（SEC-3c）：无绑定凭证不可 resolve */
  requireCredentialBindings?: boolean;
  confirmEffect?: import("../extension/execution-environment/effect-policy.js").ConfirmEffect;
  /** 附件注入参数（knowledge.attachments.inject；缺省用内建默认） */
  sessionAttachmentInject?: {
    fullTextMaxChars?: number;
    intent?: 'llm' | 'off';
    intentTimeoutMs?: number;
    emptyMessagePrompt?: string;
  };
  /**
   * 事件旁路（Telemetry）。每条适配后事件调用（含 llm_stream_delta），
   * 不改变 yield 语义。由 Builder 注入 RunTelemetry.onEvent。
   */
  eventSink?: (
    event: import('@octopi-agent/core/primitives/event-bus.js').AgentEvent,
    ctx: { sessionId: string; agentId: string },
  ) => void;
}

const DEFAULT_CONFIG: SessionAwareRunnerConfig = {
  // idleExpiryMs 缺省关闭：上下文租约 opt-in，续聊默认带全量窗口
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
  /**
   * 本 Run 的权利天花板（`arch/delegation.md` D3：只能收紧不能放宽）。
   *
   * 与 Runner 的 `agentMaxSessionRights` **取交集**后进 `authorizeRun`；
   * 委派子 Run 用它传 `DelegateRequest.rightsCeiling`。
   */
  rightsCeiling?: import('../governance/session-acl/types.js').SessionRights;
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
  state: {
    assistantContent: string;
    lastUserContent?: string;
    stopReason?: string;
    /** 引擎为何终止（人类可读）；收口落一条 runStopped 消息，禁止静默停止 */
    stopMessage?: string;
    /** 判定细节（规则名/指标），供审计与日志 */
    stopDetail?: string;
    /**
     * loop 的 `agent_end.reason`（completed / should_stop / aborted / error）。
     *
     * 是否真的「提前停止」只能看这里：`security_blocked` 单次拦截后 run 会继续，
     * 只看它会把正常完成的 run 误报成停止。
     */
    loopEndReason?: string;
  },
): import('@octopi-agent/core/primitives/event-bus.js').AgentEvent | null {
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
      //
      // 注意：单次拦截**不是终态**——reject/confirm 路径 `terminate: false`，
      // run 会继续跑完。所以这里只描述拦截事实，不宣称「已停止」；
      // 是否真的停了由 loopEndReason 决定。
      state.stopReason = 'security_stopped';
      state.stopMessage ??= '安全策略拦截了工具调用。';
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
      // 记录 loop 终止原因：是否「引擎主动提前停止」的唯一权威来源
      state.loopEndReason = event.reason;
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
    case 'llm_thinking_delta':
      return { type: 'llm_thinking_delta', timestamp: event.timestamp, agentId: meta.agentId, sessionId: meta.sessionId, data: event.data };
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
          purpose: event.result.purpose,
        },
      };
    case 'stream.fallback_to_sync':
    case 'stream.fallback_failed':
      // 必须带 session 元数据：gatewayBus.onAll 以 event.sessionId 为 WS 广播前提
      return { type: event.type, timestamp: event.timestamp, agentId: meta.agentId, sessionId: meta.sessionId, data: event.data };
    case 'budget_exceeded': {
      // 预算 hard 终态（wall_clock / iteration / tool_calls）——也是「引擎主动停止」，
      // 必须带来可读原因，否则收口只能落到「引擎判定停止」的空泛兜底。
      //
      // 终态事件用赋值（不用 ??=）：同一 turn 里若先有非终态信号（如 security_blocked），
      // 最终文案必须归因到真正的停止闸门。
      const budgetReason = event.data?.reason ?? 'wall_clock';
      state.stopReason = 'policy_stopped';
      state.stopDetail = budgetReason;
      state.stopMessage =
        budgetReason === 'wall_clock'
          ? '本轮运行时间达到预算上限，已停止。'
          : budgetReason === 'iteration'
            ? '本轮迭代次数达到预算上限，已停止。'
            : '本轮工具调用次数达到预算上限，已停止。';
      // 对齐 EventBus BUDGET_EXCEEDED；用户可见停止原因
      return {
        type: 'budget.exceeded',
        timestamp: event.timestamp,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        data: { ...event.data },
      };
    }
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
      // 跟踪停止原因：context / policy（终态；覆盖此前非终态信号）
      state.stopReason = event.metric === 'context' ? 'context_stopped' : 'policy_stopped';
      state.stopMessage = event.userMessage;
      state.stopDetail = `${event.metric}${event.unit ? `/${event.unit}` : ''}`;
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
      // 跟踪停止原因：behavior（终态；覆盖此前非终态信号）
      state.stopReason = 'behavior_stopped';
      state.stopMessage = event.data.userMessage;
      state.stopDetail = event.data.reason;
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
  /** 本 Runner 生效的 L2 级别（由 effectPolicy 展开） */
  private effectPathContainment: "strict" | "soft" | "none" = "none";
  private effectChannel: "engine" | "host-gate" = "engine";
  private effectAllowRoots: string[] = [];
  /** Effective effectPolicy.mode (for Runtime injection / UI) */
  private effectMode = 'workspace';
  private effectCommitManual = false;
  private effectProcessLimits = true;
  private effectNetwork: 'open' | 'deny' | 'allowlist' | undefined;
  private effectRequireJail: boolean | undefined;
  private effectRequireCredentialBindings = false;
  private effectHomeWrite: boolean | undefined;
  private effectShellEscape: "deny" | "confirm" | "allow" = "allow";
  private effectShellJournal: "snapshot" | "off" = "snapshot";
  private effectShellJournalLimit?: { maxFiles?: number; maxBytes?: number; maxFileSize?: number };
  private effectUndoLimit?: { maxEntries?: number; maxBlobBytes?: number };
  private agent: Agent;
  private harness: ReliabilityHarness;
  private store: TypedSessionStore;
  /** Session lease（E2/E7）：默认 in-process FIFO；可替换 */
  private sessionLease: SessionLease;
  private config: SessionAwareRunnerConfig;
  /** Session 状态机缓存 */
  private stateMachines = new Map<string, StateMachine<SessionStatus>>();
  /** 自主子系统运行时 */
  private _subsystemRuntime?: import('../collaboration/autonomous-subsystem/runtime.js').SubsystemRuntime;
  private _backfillTrigger?: import('../memory/backfill-trigger.js').BackfillTrigger;
  private _memoryHealthProbe?: import('../memory/health-probe.js').MemoryHealthProbe;
  /** EventBus 引用（用于子系统/多 Agent 上下文） */
  private _events?: import('@octopi-agent/core/primitives/event-bus.js').EventBus;
  /** 产品 Observer Hub（Run 现场；可选） */
  private _observerHub?: import('../observability/observer/hub.js').ObserverHub;
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
    /** E8：易变注入份（datetime/tasks/guidance）；优先于 injectedContext */
    volatileContext?: string;
    /** E8：稳定运行时锚点（留 system prompt） */
    runtimeAnchors?: string;
    contextWindow?: number;
    /** 任务主题线索（Memory/Cognition 检索 query） */
    topicHints?: string;
    signal?: AbortSignal;
  }) => Promise<{
    systemPrompt: string;
    /** E8：本轮易变快照（消息尾部插槽送达） */
    runtimeSnapshot?: string;
    manifest?: import('../context/layer-types.js').AssembleManifest;
    skippedBudget?: boolean;
  }>;
  /** Assembler 层缓存清理钩子（可选接线；与 contextDetachIndex 无关） */
  private systemPromptAssemblerClear?: (sessionId: string) => void;
  /** turn 级 Knowledge grounding（可选；arch/knowledge-layer.md §4.4） */
  private groundingAssembler?: (input: {
    sessionId: string;
    agentId?: string;
    messages: Message[];
  }) => Promise<{
    query: string;
    mode: 'inject' | 'hint' | 'none';
    hits: Array<{ path: string; startLine: number; endLine: number; text: string }>;
    hint?: string;
    coverage?: number;
    tokens: number;
    text?: string;
  }>;
  /** 模型快照解析器（Gateway 注入；每 run 只调一次） */
  private resolveModelOverride?: SessionAwareRunnerConfig['resolveModelOverride'];

  constructor(agent: Agent, harness: ReliabilityHarness, store: TypedSessionStore, config?: SessionAwareRunnerConfig & { events?: import('@octopi-agent/core/primitives/event-bus.js').EventBus }) {
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
  setObserverHub(hub: import('../observability/observer/hub.js').ObserverHub | undefined): void {
    this._observerHub = hub;
  }

  /**
   * 发射事件：先采 Observer Hub，再进 EventBus（协调总线）
   */
  private emitObserved(event: import('@octopi-agent/core/primitives/event-bus.js').AgentEvent): void {
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
  setSubsystemRuntime(runtime: import('../collaboration/autonomous-subsystem/runtime.js').SubsystemRuntime): void {
    this._subsystemRuntime = runtime;
  }

  /** 补录触发协调器（idle 漂移 / 硬收敛快照） */
  setBackfillTrigger(trigger: import('../memory/backfill-trigger.js').BackfillTrigger | undefined): void {
    this._backfillTrigger?.dispose();
    this._backfillTrigger = trigger;
  }

  /** health 探测（govern 双脉搏） */
  setMemoryHealthProbe(probe: import('../memory/health-probe.js').MemoryHealthProbe | undefined): void {
    this._memoryHealthProbe?.stop();
    this._memoryHealthProbe = probe;
  }

  /**
   * 释放 Runner 侧后台定时器/监听（BackfillTrigger / HealthProbe / SubsystemRuntime）。
   * Gateway 热重建 agent 或进程内多次 build 时必须调用，否则 timer 泄漏、重复 emit。
   */
  dispose(): void {
    this._backfillTrigger?.dispose();
    this._backfillTrigger = undefined;
    this._memoryHealthProbe?.stop();
    this._memoryHealthProbe = undefined;
    this._subsystemRuntime?.dispose();
    this._subsystemRuntime = undefined;
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
   *
   * E8 契约：`injectedContext` 保持合并形态（兼容旧 assembler，零能力丢失）；
   * 拆分字段 `volatileContext`（易变份→快照）与 `runtimeAnchors`（稳定份→system）同时传入，
   * 默认 assembler 优先用拆分字段；降级/无 assembler 路径同样产出快照（E8 形态不破）。
   */
  setSystemPromptAssembler(
    assembler: (input: {
      sessionId: string;
      agentId?: string;
      messages: Message[];
      persona: string;
      injectedContext?: string;
      /** E8：易变注入份（datetime/tasks/guidance）；优先于 injectedContext */
      volatileContext?: string;
      /** E8：稳定运行时锚点（留 system prompt） */
      runtimeAnchors?: string;
      contextWindow?: number;
      topicHints?: string;
      signal?: AbortSignal;
    }) => Promise<{
      systemPrompt: string;
      /** E8：本轮易变快照（消息尾部插槽送达） */
      runtimeSnapshot?: string;
      manifest?: import('../context/layer-types.js').AssembleManifest;
    }>,
    clearSession?: (sessionId: string) => void,
  ): void {
    this.systemPromptAssembler = assembler;
    this.systemPromptAssemblerClear = clearSession;
  }

  /**
   * 注入 turn 级 Knowledge grounding（可选）
   */
  setGroundingAssembler(
    assembler: (input: {
      sessionId: string;
      agentId?: string;
      messages: Message[];
    }) => Promise<{
      query: string;
      mode: 'inject' | 'hint' | 'none';
      hits: Array<{ path: string; startLine: number; endLine: number; text: string }>;
      hint?: string;
      coverage?: number;
      tokens: number;
      text?: string;
    }>,
  ): void {
    this.groundingAssembler = assembler;
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
  ): AsyncGenerator<import('@octopi-agent/core/primitives/event-bus.js').AgentEvent> {
    /** 本轮文件 undo（L3）；中止保留，其余出口 commit */
    let turnFileUndo: import('../extension/execution-environment/undo-log.js').TurnFileUndoLog | undefined;
    // [timing probe] 长 session 首 run 延迟定位（诊断后移除或转正）
    const timingRunEnter = Date.now();
    console.log(`[timing] stage=run_enter ms=${timingRunEnter} session=${sessionId}`);
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

    // 2. 获取锁（等锁期间响应 abort；被中止则不进入 Run）
    let release: () => void;
    try {
      release = await this.acquireLock(sessionId, signal);
    } catch (err) {
      if (signal?.aborted) {
        gateRelease?.();
        return;
      }
      throw err;
    }

    // 拿锁后若已中止：不 load / 不 push，避免幽灵用户消息（arch/agent-runtime.md 审查项）
    if (signal?.aborted) {
      release();
      gateRelease?.();
      return;
    }

    // [timing probe] 排队/等锁耗时 = wait
    console.log(`[timing] stage=run_start ms=${Date.now()} session=${sessionId} wait=${Date.now() - timingRunEnter}`);

    const _agentId = runConfig.agentId ?? 'default';

    /** Observer 收口状态（finally 统一关闭，含异常路径） */
    let observerRunId = '';
    let observerFinalMessages: Message[] | undefined;
    let observerEndReason: string | undefined;
    /**
     * 桥接状态（assistant 文本 / 停止原因）。
     *
     * 声明在 try 之外：finally 的 run_end 观测要读 stopReason，
     * 否则「run 为什么结束」在日志里不可见。
     */
    const adaptState: {
      assistantContent: string;
      lastUserContent: string;
      stopReason?: string;
      stopMessage?: string;
      stopDetail?: string;
      loopEndReason?: string;
    } = { assistantContent: '', lastUserContent: '' };
    let observerErrorMsg: string | undefined;
    let hasTurnEnd = false;
    /** 正常完成时需在持久化后真删 metadata.lastStop（save 浅合并删不掉） */
    let clearLastStop = false;
    /** 本 user turn 内第 N 次 LLM 调用（0-based；cache 观测） */
    let llmCallIndexInUserTurn = 0;

    try {
      // 3. 加载或创建 session
      let session = await this.store.load(sessionId);
      if (!session) {
        session = this.createSession(sessionId, runConfig.agentId ?? 'default');
      }
      /** 上下文租约点之前的 Discourse 前缀（写回时并回，不进默认 LLM 窗口） */
      let contextLeasePrefix: Message[] = [];
      // 模型 2：历史数据缺省 primary 时回填（单 agent 行为不变）
      if (!session.primaryAgentId) {
        session.primaryAgentId = session.agentId || _agentId;
      }
      if (!session.tasks) session.tasks = [];

      // E6：可选 ACL（注入时才强制）；primary 自动 owner；带入 agent 天花板
      const acl = this.config.sessionAcl;
      let sessionToolRights:
        | import('../governance/session-acl/types.js').ToolRights
        | undefined;
      // D3：本 Run 的 effective rights，供委派传播（只读，不改共享 harness）
      let runSessionRights:
        | import('../governance/session-acl/types.js').EffectiveSessionRights
        | undefined;
      if (acl) {
        const auth = acl.authorizeRun({
          session,
          agentId: _agentId,
          // D3：Run 级天花板与模板天花板取交集，只收紧不放宽
          agentMax: tightenSessionRights(
            this.config.agentMaxSessionRights,
            runConfig.rightsCeiling,
          ),
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
        sessionToolRights = auth.rights?.toolRights;
        runSessionRights = auth.rights;
      }
      // SEC-2: keep rights on this run only (harness is shared across sessions)
      const runToolRights = sessionToolRights;
      const runToolPolicy = this.config.agentToolPolicy;

      // 4. 上下文租约（opt-in；只标截断点，不改 Discourse）
      this.applyContextLease(session);

      // 4a. 新一轮开始：作废上一轮中止标记（避免已完成轮仍显示编辑重发）
      if (session.metadata?.abortedTurn) {
        session.metadata = { ...session.metadata };
        delete session.metadata.abortedTurn;
        // 与 save 浅合并对齐：立即 updateMetadata 真删，防止本轮 save 又合并回来
        if (this.store.updateMetadata) {
          await this.store.updateMetadata(sessionId, (meta) => {
            delete meta.abortedTurn;
          });
        }
      }

      // 4b. 绑定会话任务服务（工具与注入共用同一内存对象）
      this.config.sessionTaskService?.attachSession(session);

      // 4c. turn 信封：补闭上一 turn；分配本 turn id（t1,t2,… 会话内单调）
      this.ensurePreviousTurnClosed(session);
      const turnSeq = Number(session.metadata?.turnSeq ?? 0) + 1;
      const currentTurnId = formatTurnId(turnSeq);
      session.metadata = { ...session.metadata, turnSeq };

      // 5. 追加用户消息（正文稍后一次定形为 <turn_start>）
      session.messages.push(input);
      session.meta.lastInteractionAt = Date.now();
      session.meta.updatedAt = Date.now();
      this._backfillTrigger?.noteActivity(sessionId, _agentId, session.meta.lastInteractionAt);

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

      // 状态机：→ processing
      // 持锁后无并发 handle；processing/error 残留来自崩溃或异常退出，先恢复再进入
      const sm = this.getOrCreateStateMachine(sessionId, session.meta.status);
      if (!sm.canTransition('processing')) {
        if (sm.canTransition('idle')) {
          sm.transition('idle');
        } else {
          sm.force('idle');
        }
      }
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

      // 6b. 会话日程注入（arch/session-schedules.md §8）
      if (this.config.sessionScheduleService) {
        const schedules = this.config.sessionScheduleService.list(session.id, {
          activeOnly: true,
        });
        const { renderSessionSchedulesInjection } = await import(
          '../session/schedules/render.js'
        );
        const scheduleInjection = renderSessionSchedulesInjection(schedules);
        if (scheduleInjection) {
          const baseInjected = effectiveRunConfig.injectedContext;
          effectiveRunConfig = {
            ...effectiveRunConfig,
            injectedContext: baseInjected
              ? `${baseInjected}\n\n${scheduleInjection}`
              : scheduleInjection,
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

      // P3：effectPolicy → L2 path containment + session 临时 root
      // 必须在 Runtime 注入之前，system prompt 才能带上 allowRoots / effectMode
      {
        const { resolveEffectiveEffectPolicy, readSessionEffectOverrides, mergeTransactionRoots, requiresJail } =
          await import('../extension/execution-environment/effect-policy.js');
        const { probeProcessIsolation } = await import(
          '../extension/execution-environment/process-isolation.js'
        );
        const isolation = await probeProcessIsolation();
        const eff = resolveEffectiveEffectPolicy(
          this.config.effectPolicy ?? {},
          this.config.agentWorkspace ?? effectiveRunConfig.cwd ?? undefined,
          isolation,
        );
        const sessionExtraRoots = readSessionEffectOverrides(session.metadata).transactionRoots;
        this.effectPathContainment = eff.pathContainment;
        this.effectChannel = eff.effects;
        this.effectAllowRoots = mergeTransactionRoots(eff.allowRoots, sessionExtraRoots);
        this.effectMode = eff.mode;
        this.effectCommitManual = eff.commit === 'manual';
        this.effectProcessLimits = eff.processLimits;
        this.effectShellEscape = eff.shellEscape;
        this.effectShellJournal = eff.shellJournal;
        this.effectNetwork = eff.network;
        this.effectRequireJail = requiresJail(eff);
        this.effectRequireCredentialBindings =
          this.config.requireCredentialBindings === true || requiresJail(eff);
        this.effectHomeWrite = eff.mode === 'project' || eff.mode === 'host';
        this.effectShellJournalLimit = eff.shellJournalLimit;
        this.effectUndoLimit = eff.undoLimit;
        // untrusted admission: reduced surface strips egress/exec tools
        this.harness.toolSurface = eff.toolSurface;
        if (eff.securityDegraded.length > 0) {
          this.harness.securityDegraded = eff.securityDegraded;
        }
      }

      // Runtime 锚点：时间 + 工具工作目录 + 允许根/效应模式
      // cwd 与下方 I5 toolRuntime.cwd 同源同构；allowRoots 含 session 临时 root
      // E8：拆稳定锚点（留 system）与易变注入（进本轮快照）
      let runtimeAnchorsText = '';
      let runtimeVolatileText = '';
      let runtimeSnapshotText: string | null = null;
      {
        const runtimeIsolationMode: ToolIsolationMode =
          effectiveRunConfig.toolIsolation
          ?? this.config.toolIsolation
          ?? DEFAULT_TOOL_ISOLATION;
        const runtimeBaseCwd =
          (effectiveRunConfig.cwd?.trim() ? effectiveRunConfig.cwd.trim() : undefined)
          ?? (this.config.agentWorkspace?.trim() ? this.config.agentWorkspace.trim() : undefined);
        const runtimeCwd = resolveToolIsolationCwd({
          mode: runtimeIsolationMode,
          sessionId,
          baseCwd: runtimeBaseCwd,
        }).cwd;
        const rootInstructions = await loadRootInstructionsInjection(this.effectAllowRoots, {
          cwd: runtimeCwd,
        });
        const runtimeSplit = splitRuntimeEnvironmentInjection(effectiveRunConfig.injectedContext, {
          cwd: runtimeCwd,
          allowRoots: this.effectAllowRoots,
          effectMode: this.effectMode,
          rootInstructions,
        });
        runtimeAnchorsText = runtimeSplit.anchors;
        runtimeVolatileText = runtimeSplit.volatile;
        effectiveRunConfig = {
          ...effectiveRunConfig,
          injectedContext: withRuntimeEnvironmentInjection(effectiveRunConfig.injectedContext, {
            cwd: runtimeCwd,
            allowRoots: this.effectAllowRoots,
            effectMode: this.effectMode,
            rootInstructions,
          }),
        };
      }

      // 8. 工具运行时：setRuntime 仅作无 ALS 时的回退；权威身份在 RunScope
      if (this.toolContextProvider) {
        this.toolContextProvider.setRuntime(sessionId, _agentId, session.messages);
      }

      // 9. 本 Run 私有 AgentContext（宪法 I1）——禁止写入共享 agent.context.messages
      const runContext: AgentContext = {
        systemPrompt: '',
        messages: session.messages,
        // 会话级 tool 面：Client Tool 无 live client 时不进 LLM 列表
        tools: this.filterToolsForSessionRights(
          this.agent.toolsForSession(sessionId),
          runToolRights,
          runToolPolicy,
        ),
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
          const topicHints = extractTaskQueryHints(session.tasks ?? []);
          const assembled = await this.systemPromptAssembler({
            sessionId,
            agentId: _agentId,
            messages: session.messages,
            persona: basePrompt,
            injectedContext: effectiveRunConfig.injectedContext,
            volatileContext: runtimeVolatileText,
            runtimeAnchors: runtimeAnchorsText,
            contextWindow: effectiveRunConfig.contextWindow,
            topicHints,
            signal,
          });
          runContext.systemPrompt = assembled.systemPrompt;
          runtimeSnapshotText = assembled.runtimeSnapshot?.trim()
            ? assembled.runtimeSnapshot
            : null;
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
                query: extractLayerQuery(session.messages, { topicHints }),
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
          // F12：降级轮保持 E8 形态——锚点进 system，易变份走**新鲜**快照（防旧快照被 last-only 回放）
          runContext.systemPrompt = this.concatSystemPrompt(basePrompt, runtimeAnchorsText, personaFromResolver);
          runtimeSnapshotText = runtimeVolatileText.trim() ? runtimeVolatileText : null;
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
        // F12：无 assembler 也保持 E8 形态（锚点进 system，易变份走快照）
        runContext.systemPrompt = this.concatSystemPrompt(basePrompt, runtimeAnchorsText, personaFromResolver);
        runtimeSnapshotText = runtimeVolatileText.trim() ? runtimeVolatileText : null;
      }

      // system prompt 终装后：turn 级 Knowledge grounding（消息侧插槽，不进 system）
      // 先算 pack；写入 runScope / 插入消息在 runScope 创建之后
      let pendingGrounding: {
        query: string;
        mode: 'inject' | 'hint' | 'none';
        hits: Array<{ path: string; startLine: number; endLine: number; text: string }>;
        hint?: string;
        coverage?: number;
        tokens: number;
        text?: string;
      } | null = null;
      if (this.groundingAssembler) {
        try {
          pendingGrounding = await this.groundingAssembler({
            sessionId,
            agentId: _agentId,
            messages: session.messages,
          });
        } catch (gErr) {
          const gMsg = gErr instanceof Error ? gErr.message : String(gErr);
          console.warn(`[octopi] knowledge grounding failed (session=${sessionId}): ${gMsg}`);
          pendingGrounding = null;
        }
      }

      // [timing probe] system prompt 装配 + grounding 全部就绪；build = 组装耗时
      console.log(
        `[timing] stage=context_ready ms=${Date.now()} session=${sessionId} build=${Date.now() - timingRunEnter} msgs=${session.messages.length} sysChars=${(runContext.systemPrompt ?? '').length} grounding=${pendingGrounding ? pendingGrounding.tokens : 0}`,
      );

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
      const attachmentRoots = this.config.sessionsDir
        ? [join(this.config.sessionsDir, toSessionFileName(sessionId), 'attachments')]
        : undefined;
      // L3：本轮文件 undo（ToolEffectPolicy）。无 sessionsDir 时 fail-closed，禁止静默免记写盘。
      const { TurnFileUndoLog, createUnconfiguredFileEffects } = await import(
        '../extension/execution-environment/undo-log.js'
      );
      const fileUndo = this.config.sessionsDir
        ? await TurnFileUndoLog.begin({
            sessionsDir: this.config.sessionsDir,
            sessionId,
            undoLimit: this.effectUndoLimit,
          })
        : undefined;
      turnFileUndo = fileUndo;
      const {
        createUnconfiguredMemoryEffects: unconfMem,
        resolveSessionUndoPaths,
      } = await import('../extension/execution-environment/undo-log.js');
      const fileEffects = fileUndo ?? createUnconfiguredFileEffects();
      const memoryEffects = fileUndo?.memoryEffects ?? unconfMem();
      const undoRoots = this.config.sessionsDir
        ? [resolveSessionUndoPaths(this.config.sessionsDir, sessionId).root]
        : undefined;
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
          attachmentRoots,
          fileEffects,
          memoryEffects,
          undoRoots,
          networkPolicy: this.effectNetwork,
          requireCredentialBindings:
            this.effectMode === 'untrusted' || this.effectRequireCredentialBindings,
          requireJail: this.effectRequireJail,
          homeWrite: this.effectHomeWrite,
          noteSecurityDegraded: (reason: string) => {
            this.harness.securityDegraded = [
              ...(this.harness.securityDegraded ?? []),
              reason as never,
            ];
          },
          pathRoots: this.effectAllowRoots.length
            ? this.effectAllowRoots
            : resolvedToolCwd.cwd
              ? [resolvedToolCwd.cwd]
              : undefined,
          pathContainment: this.effectPathContainment,
          confirmEffect: this.config.confirmEffect,
          effectChannel: this.effectChannel,
          processLimits: this.effectProcessLimits,
          shellEscape: this.effectShellEscape,
          shellJournal: this.effectShellJournal,
          shellJournalLimit: this.effectShellJournalLimit,
          sessionToolRights: runToolRights,
          sessionRights: runSessionRights,
          agentToolPolicy: runToolPolicy,
        },
      };

      if (pendingGrounding) {
        runScope.grounding = {
          query: pendingGrounding.query,
          mode: pendingGrounding.mode,
          hitCount: pendingGrounding.hits.length,
          coverage: pendingGrounding.coverage,
          tokens: pendingGrounding.tokens,
        };
      }
      {
        // turn 信封：槽位拼进本 turn user 消息（一次定形），全回放、不再剥插槽。
        // 上下文租约：detach 点之前的历史不进默认 LLM 窗口（Discourse 仍在 session.messages）
        const detachIdx = Math.min(
          Math.max(session.contextDetachIndex ?? 0, 0),
          session.messages.length,
        );
        contextLeasePrefix = session.messages.slice(0, detachIdx);
        const baseMsgs = session.messages.slice(detachIdx);

        // OP-15：会话附件资料块（进 turn_context）
        let attachmentText: string | null = null;
        if (this.config.sessionsDir) {
          try {
            const {
              SessionAttachmentService,
              buildAttachmentGroundingText,
              resolveInjectPlan,
              createLlmIntentResolver,
            } = await import('../session/attachments/index.js');
            const attachSvc = new SessionAttachmentService({
              sessionsDir: this.config.sessionsDir,
            });
            const lastUser = input;
            const attachIds = Array.isArray(lastUser?.metadata?.attachmentIds)
              ? (lastUser!.metadata!.attachmentIds as string[]).filter((x) => typeof x === 'string')
              : [];
            const userText = lastUser ? getTextContent(lastUser.content) : '';
            if (attachIds.length > 0) {
              const items = attachIds
                .map((id) => attachSvc.get(sessionId, id))
                .filter((x): x is NonNullable<typeof x> => Boolean(x) && x!.status !== 'promoted');
              if (items.length > 0) {
                // 意图分流：大文件 + 非空正文时走 LLM（fail-open structure）
                const plan = await resolveInjectPlan(
                  {
                    userText,
                    attachments: items,
                    outlines: Object.fromEntries(
                      items.map((a) => [
                        a.name,
                        (attachSvc.readExtractedText(sessionId, a.id, 200) ?? '').replace(/\s+/g, ' ').slice(0, 200),
                      ]),
                    ),
                  },
                  {
                    fullTextMaxChars: this.config.sessionAttachmentInject?.fullTextMaxChars ?? 12_000,
                    intent: this.config.sessionAttachmentInject?.intent ?? 'llm',
                    timeoutMs: this.config.sessionAttachmentInject?.intentTimeoutMs ?? 800,
                    resolver: resolvedModel?.provider
                      ? createLlmIntentResolver(resolvedModel.provider)
                      : undefined,
                  },
                );
                attachmentText = buildAttachmentGroundingText(
                  items,
                  {
                    fullTextMaxChars: this.config.sessionAttachmentInject?.fullTextMaxChars ?? 12_000,
                    readText: (id, max) => attachSvc.readExtractedText(sessionId, id, max),
                    absolutePath: (id) => attachSvc.resolveAbsolutePath(sessionId, id),
                  },
                  plan.mode === 'full' ? 'full' : plan.mode,
                );
                if (plan.focus && attachmentText) {
                  attachmentText = attachmentText.replace(
                    '</session-attachments>',
                    `\n检索焦点: ${plan.focus}\n</session-attachments>`,
                  );
                }
              }
            }
          } catch (attErr) {
            console.warn(
              `[octopi] attachment grounding failed (session=${sessionId}): ${attErr instanceof Error ? attErr.message : String(attErr)}`,
            );
          }
        }

        const slotsXml = joinSlotXml([
          {
            tag: 'runtime_snapshot',
            body: runtimeSnapshotText ? runtimeSnapshotText : '',
          },
          {
            tag: 'session_attachments',
            body: attachmentText ?? '',
          },
          {
            tag: 'knowledge_grounding',
            body:
              pendingGrounding && pendingGrounding.mode !== 'none' && pendingGrounding.text?.trim()
                ? pendingGrounding.text
                : '',
          },
        ]);
        const turnContextXml = formatTurnContextXml({
          turnId: currentTurnId,
          slotsXml,
        });
        this.bakeTurnStart(input, currentTurnId, turnContextXml);

        // 视图 = detach 切片（含已定形 user）；全回放，无条件成为 LLM 窗口
        runContext.messages = baseMsgs;
        if (runScope.toolRuntime) {
          runScope.toolRuntime.messages = baseMsgs;
        }
      }

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
      let lastUsage: import('@octopi-agent/core/types/turn.js').TokenUsage | undefined = undefined;
      /** 最近一次 turn.end 的上下文用量（供收尾持久化；compact 视图值不进此账） */
      let lastContextTokens: number | undefined = undefined;
      let lastContextWindow: number | undefined = undefined;
      const meta = { agentId: effectiveRunConfig.agentId ?? 'default', sessionId };
      /** 本轮起始消息下标（afterTurn 只传增量） */
      let turnStartIndex = runContext.messages.length;
      /** 用户中止（编辑重发标记用） */
      let runAborted = false;

      // resolvedModel 已在 system assembler 之前解析；此处只组装 run options
      const agentRunOptions = {
        resolvedModel: resolvedModel ?? undefined,
        context: runContext,
        runScope,
      };

      for await (const loopEvent of this.agent.run(signal, undefined, agentRunOptions)) {
        if (loopEvent.type === 'agent_end' && loopEvent.reason === 'aborted') {
          runAborted = true;
        }
        // 适配事件格式（向后兼容）
        const adapted = adaptLoopEvent(loopEvent, meta, adaptState);
        if (adapted) {
          // 捕获 usage 数据，并在 turn.end 事件中附加上下文信息（必须在 yield 之前，
          // 否则 gateway 收到事件后立即广播，data 里还没有 context 字段）
          if (adapted.type === 'turn.end') {
            const rawUsage = adapted.data?.usage as
              | import('@octopi-agent/core/types/turn.js').TokenUsage
              | undefined;
            if (rawUsage) {
              lastUsage = rawUsage;
            }
            const contextTokens =
              lastUsage?.inputReportedTokens ??
              (lastUsage
                ? lastUsage.inputUncachedTokens + lastUsage.inputCachedTokens + lastUsage.inputCacheWriteTokens
                : undefined) ??
              estimator.estimateMessages(session.messages);
            (adapted.data as Record<string, unknown>).contextTokens = contextTokens;
            (adapted.data as Record<string, unknown>).contextWindow = effectiveRunConfig.contextWindow;
            // cache 观测：user 轮首调用 vs 同轮后续（跨轮前缀是否命中）
            if (lastUsage) {
              const cached = lastUsage.inputCachedTokens ?? 0;
              const uncached = lastUsage.inputUncachedTokens ?? 0;
              const cacheWrite = lastUsage.inputCacheWriteTokens ?? 0;
              const prompt = lastUsage.inputReportedTokens ?? cached + uncached + cacheWrite;
              const ratio = prompt > 0 ? cached / prompt : 0;
              (adapted.data as Record<string, unknown>).userTurnId = currentTurnId;
              (adapted.data as Record<string, unknown>).llmCallIndexInUserTurn = llmCallIndexInUserTurn;
              (adapted.data as Record<string, unknown>).cachedInputTokens = cached;
              (adapted.data as Record<string, unknown>).uncachedInputTokens = uncached;
              (adapted.data as Record<string, unknown>).cacheHitRatio = ratio;
              console.log(
                `[cache] session=${sessionId} turn=${currentTurnId} call=${llmCallIndexInUserTurn}` +
                  ` cached=${cached} uncached=${uncached} write=${cacheWrite} prompt=${prompt}` +
                  ` ratio=${(ratio * 100).toFixed(1)}% cacheAware=${lastUsage.cacheAware}`,
              );
            }
            // 记账供收尾持久化：UI 重开会话恢复显示（口径 = 实际 prompt / 全量估算）
            lastContextTokens = contextTokens;
            lastContextWindow = effectiveRunConfig.contextWindow;
          }

          yield adapted;
          // Telemetry 旁路（含 stream delta；由 RunTelemetry 决定采样）
          this.config.eventSink?.(adapted, meta);
          // 事件桥：循环事件同时广播到 EventBus
          // 跳过高频流式 delta（每 token 一次），避免 EventBus 拥塞
          if (adapted.type !== 'llm_stream_delta' && adapted.type !== 'llm_thinking_delta') {
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
          llmCallIndexInUserTurn += 1;
          const turnMessages = runContext.messages.slice(turnStartIndex);
          await this.agent.notifyAfterTurn(lastUsage, turnMessages);
          turnStartIndex = runContext.messages.length;
          const content = adaptState.assistantContent || streamedContent;
          if (content) {
            session.turns.push({
              id: `turn_${Date.now()}`,
              inputCount: Math.max(0, session.messages.length - 1),
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
      // 租约点之前的历史必须保留（I2 Discourse）；窗口内为 runContext.messages（含本轮新消息）
      // 全回放：不再剥 grounding/attachment（历史中部删改会打穿前缀缓存）
      // ephemeral 消息（委派状态等运行期 steering）只属于本次 Run，不落历史——
      // 否则「当时的状态」会被固化成对话历史，过期后仍占用上下文并打穿前缀缓存。
      const keptPrefix = contextLeasePrefix;
      const durableMessages = runContext.messages.filter((m) => m.ephemeral !== true);
      session.messages = [...keptPrefix, ...durableMessages];
      // contextDetachIndex 是 messages 下标：写回重排后必须对齐 keptPrefix 长度
      if (typeof session.contextDetachIndex === 'number') {
        session.contextDetachIndex = keptPrefix.length;
      }
      // 引擎主动终止（RunGuard / Budget / Security）必须留下可见凭证：
      // 只有事件、没有消息时，UI 看到的就是「跑着跑着突然结束」。
      //
      // 触发条件 = loop 的 agent_end.reason === 'should_stop'（唯一权威的「提前停止」信号）。
      // 不能只看 stopReason：`security_blocked` 单次拦截后 run 会继续跑完，
      // 那样会把正常完成的 run 误报成「已停止」。
      //
      // 该消息不进 LLM 上下文（buildLlmMessages 跳过 source=runStopped），
      // 但进聊天回放（系统提示条）与 session 审计。
      // 位置在 turn_end 之前：它属于被终止的这个 turn。
      if (adaptState.loopEndReason === 'should_stop') {
        const label =
          adaptState.stopReason === 'behavior_stopped'
            ? '引擎监督器判定停止'
            : adaptState.stopReason === 'policy_stopped'
              ? '资源策略停止'
              : adaptState.stopReason === 'context_stopped'
                ? '上下文压力停止'
                : adaptState.stopReason === 'security_stopped'
                  ? '安全策略停止'
                  : '引擎判定停止';
        const detail = adaptState.stopDetail ? `（${adaptState.stopDetail}）` : '';
        const body =
          adaptState.stopMessage ??
          '本轮由引擎主动终止，未收到模型的收尾回复。可继续对话，让 agent 从当前状态接着做。';
        const reason = adaptState.stopReason ?? 'engine_stopped';
        session.messages.push({
          role: 'user',
          content: `${label}${detail}：${body}`,
          timestamp: Date.now(),
          metadata: {
            source: 'runStopped',
            turnId: currentTurnId,
            stopReason: reason,
            ...(adaptState.stopDetail ? { stopDetail: adaptState.stopDetail } : {}),
          },
        });
        session.metadata = {
          ...session.metadata,
          lastStop: {
            reason,
            detail: adaptState.stopDetail,
            message: body,
            turnId: currentTurnId,
            at: Date.now(),
          },
        };
      } else if (session.metadata?.lastStop) {
        // 正常完成的 run 必须清掉上次的停止标。
        // 只从内存对象删不够：save 是 metadata 浅合并（{...prev, ...data}），
        // 磁盘上的 lastStop 会被合并回来——持久化后再 updateMetadata 真删。
        const { lastStop: _dropLastStop, ...restMeta } = session.metadata;
        session.metadata = restMeta;
        clearLastStop = true;
      }

      // turn 闭标（write-once）
      this.appendTurnEnd(session, currentTurnId);

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
            inputCount: Math.max(0, session.messages.length - 1),
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

      // 中止标记：仅在本轮**未完成**被掐断时打标（hasTurnEnd = 正常收尾）。
      // 迟到 abort / signal 竞态不得给已完成轮贴编辑重发。
      let clearAbortedTurn = false;
      const abortedMidTurn = runAborted || (Boolean(signal?.aborted) && !hasTurnEnd);
      // L3：中止保留 undo（供编辑重发 discard）；其余出口 commit（继续对话=隐式提交）
      if (turnFileUndo) {
        // Observer tool.effect：效应账本摘要（§5.6）
        this.emitObserved({
          type: 'tool.effect.ledger',
          timestamp: Date.now(),
          agentId: _agentId,
          sessionId,
          data: {
            entries: turnFileUndo.size,
            truncated: turnFileUndo.truncated,
          },
        } as never);
      }
      if (turnFileUndo && !abortedMidTurn && !this.effectCommitManual) {
        await turnFileUndo.commit();
        turnFileUndo = undefined;
      }
      if (abortedMidTurn) {
        let userIdx = -1;
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const m = session.messages[i];
          // 与 isMidTurn / extractLayerQuery 同口径：引擎载体（含 turnEnd）不是真实 user
          if (m.role === 'user' && !isEngineCarrierSource(m.metadata?.source)) {
            userIdx = i;
            break;
          }
        }
        if (userIdx >= 0) {
          session.metadata = {
            ...session.metadata,
            abortedTurn: { userMessageIndex: userIdx, at: Date.now() },
          };
        }
      } else if (session.metadata?.abortedTurn) {
        // save 浅合并删不掉 metadata 键，这里先从对象移除，persist 后再 updateMetadata 真删
        const { abortedTurn: _drop, ...rest } = session.metadata;
        session.metadata = rest;
        clearAbortedTurn = true;
      }

      // 12. 持久化
      sm.transition('idle');
      session.meta.status = sm.state;
      session.meta.updatedAt = Date.now();
      // 压缩状态写回 Session（E4 分桶 + primary 兼容视图）
      const compactSnap = this.agent.getSessionCompactState(sessionId, _agentId);
      writeSessionCompact(session, _agentId, compactSnap);
      // 上下文用量随会话持久化：重开会话恢复显示（不靠 UI 用末页消息猜）。
      // 只记 turn.end 口径（实际 prompt / 全量估算）；compact 视图值不写入。
      if (lastContextTokens !== undefined || lastContextWindow !== undefined) {
        session.metadata = {
          ...session.metadata,
          ...(lastContextTokens !== undefined ? { contextTokens: lastContextTokens } : {}),
          ...(lastContextWindow !== undefined ? { contextWindow: lastContextWindow } : {}),
        };
      }
      await this.store.save(sessionId, session);
      if (clearAbortedTurn && this.store.updateMetadata) {
        await this.store.updateMetadata(sessionId, (meta) => {
          delete meta.abortedTurn;
        });
      }
      if (clearLastStop && this.store.updateMetadata) {
        await this.store.updateMetadata(sessionId, (meta) => {
          delete meta.lastStop;
        });
      }

      // 通知子系统：本轮处理完成（保持 active，但刷新 lastInteractionAt）
      this._backfillTrigger?.noteActivity(sessionId, _agentId, session.meta.lastInteractionAt);
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
      // 引擎出错：无编辑重发入口，效应保留（commit undo）
      if (turnFileUndo) {
        await turnFileUndo.commit().catch(() => undefined);
        turnFileUndo = undefined;
      }
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
      // [timing probe] run 收口必须留痕：本次事故里「run 结束原因」零日志，
      // 只能靠反推落盘消息定位。reason = 观测口径，stopReason = 停止闸门。
      console.log(
        `[timing] stage=run_end ms=${Date.now()} session=${sessionId}` +
          ` dur=${Date.now() - timingRunEnter}` +
          ` reason=${observerEndReason ?? (signal?.aborted ? 'aborted' : 'unknown')}` +
          ` loopEnd=${adaptState.loopEndReason ?? 'none'}` +
          (adaptState.stopReason ? ` stopReason=${adaptState.stopReason}` : ''),
      );
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
          messages: import('@octopi-agent/core/interfaces/model-provider.js').LLMMessage[],
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
        /** 摘要覆盖终点（tailStart，不含） */
        coveredMessageCount?: number;
      }>;
      summarize?: (
        messages: import('@octopi-agent/core/interfaces/model-provider.js').LLMMessage[],
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

      if (result.ok && result.summary && result.compacted) {
        const snap: ContextCompactSnapshot = {
          summary: result.summary,
          lastProactiveMessageCount: session.messages.length,
          lastProactiveCoverEnd: result.coveredMessageCount,
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
  private async acquireLock(sessionId: string, signal?: AbortSignal): Promise<() => void> {
    return this.sessionLease.acquire(sessionId, signal ? { signal } : undefined);
  }

  /**
   * SEC-2: strip tools by agent ToolPolicy ∩ sessionToolRights (narrow-only).
   * Listing filter; beforeToolCall repeats the same check as defense-in-depth.
   * Rights are passed per-run (harness is shared across concurrent sessions).
   */
  private filterToolsForSessionRights(
    tools: import('@octopi-agent/core/loop/types.js').AgentTool[],
    sessionToolRights?: import('../governance/session-acl/types.js').ToolRights,
    agentToolPolicy?: import('@octopi-agent/core/types.js').ToolPolicy,
  ): import('@octopi-agent/core/loop/types.js').AgentTool[] {
    if (!agentToolPolicy && !sessionToolRights) return tools;
    return tools.filter((t) =>
      isToolPermitted(t.name, resolveToolCapabilities(t.name), [
        agentToolPolicy,
        sessionToolRights,
      ]),
    );
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

  /**
   * 补闭上一 turn（崩溃/中止后无 turn_end 时 write-once 追加）。
   * 新 turn 禁止在 open 未闭时叠加。
   */
  private ensurePreviousTurnClosed(session: SessionData): void {
    let lastStartId: string | undefined;
    let lastStartIdx = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]!;
      if (isTurnStartContent(m.content)) {
        lastStartId = parseTurnIdFromContent(m.content);
        lastStartIdx = i;
        break;
      }
    }
    if (!lastStartId) return;
    for (let i = lastStartIdx + 1; i < session.messages.length; i++) {
      const m = session.messages[i]!;
      if (m.metadata?.source !== 'turnEnd') continue;
      if (parseTurnIdFromContent(m.content) === lastStartId) return;
    }
    session.messages.push({
      role: 'user',
      content: formatTurnEndContent(lastStartId),
      timestamp: Date.now(),
      metadata: { source: 'turnEnd', turnId: lastStartId },
    });
  }

  /**
   * user 消息一次定形为 `<turn_start>…</turn_start>`（write-once）。
   * @param userMessage - 本 turn 用户消息对象（session.messages 中的同一引用）
   * @param turnId - 会话内单调 turn id
   * @param turnContextXml - `<turn_context>…</turn_context>` 整段
   * @throws 若已定形（禁止二次改写）
   */
  private bakeTurnStart(userMessage: Message, turnId: string, turnContextXml: string): void {
    const content = userMessage.content;
    const text = typeof content === 'string' ? content : getTextContent(content);
    if (isTurnStartContent(text)) {
      throw new Error(`turn_start already baked (turnId=${turnId}); user message is write-once`);
    }
    const xml = formatTurnStartContent({
      turnId,
      at: new Date().toISOString(),
      turnContextXml,
      userText: text,
    });
    if (typeof content === 'string' || content == null) {
      userMessage.content = xml;
    } else if (Array.isArray(content)) {
      userMessage.content = [
        { type: 'text', text: xml },
        ...content.filter((b) => b.type !== 'text'),
      ] as Message['content'];
    }
    userMessage.metadata = { ...userMessage.metadata, turnId };
  }

  /** 追加 turn 闭标（write-once；同 id 重复 → throw） */
  private appendTurnEnd(session: SessionData, turnId: string): void {
    const exists = session.messages.some(
      (m) =>
        m.metadata?.source === 'turnEnd' &&
        parseTurnIdFromContent(m.content) === turnId,
    );
    if (exists) {
      throw new Error(`turn_end already exists (turnId=${turnId})`);
    }
    session.messages.push({
      role: 'user',
      content: formatTurnEndContent(turnId),
      timestamp: Date.now(),
      metadata: { source: 'turnEnd', turnId },
    });
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
  /**
   * 上下文租约（opt-in）：闲置超时后仅记录截断点，供 LLM 默认窗口裁剪。
   *
   * 不删 Discourse、不碰 compact/memory。冷沉淀归 memory.steward 的 idle 扫描。
   * 在 push 本轮 input 之前调用，保证新消息落在租约点之后。
   */
  private applyContextLease(session: SessionData): void {
    const leaseMs = this.config.idleExpiryMs;
    if (!leaseMs || leaseMs <= 0) return;
    const idle = Date.now() - session.meta.lastInteractionAt;
    if (idle > leaseMs) {
      session.contextDetachIndex = session.messages.length;
    }
  }
}
