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
import type { HarnessLoopEvent } from './reliability/harness-events.js';
import type { ReliabilityHarness } from './reliability/run-agent.js';
import { createSessionStateMachine } from './session-state-machine.js';
import type { StateMachine } from '../core/primitives/state-machine.js';
import { HeuristicTokenEstimator } from './context/index.js';
import { extractLayerQuery } from './context/layer-types.js';
import { withRuntimeDatetimeInjection } from './context/runtime-datetime.js';
import type { SessionTaskService } from './session-tasks/service.js';
import { renderSessionTasksInjection } from './session-tasks/render.js';

/** Session 锁队列项 */
interface QueueEntry {
  resolve: () => void;
}

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
  model?: string;
  temperature?: number;
  cwd?: string;
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
  state: { assistantContent: string; lastUserContent?: string },
): import('../core/primitives/event-bus.js').AgentEvent | null {
  switch (event.type) {
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
    case 'run_guard_stopped':
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
  /** 锁状态：true = 已锁定，false = 空闲 */
  private locked = new Map<string, boolean>();
  /** 等待队列：每个 session 一个 FIFO 队列 */
  private queues = new Map<string, QueueEntry[]>();
  private config: SessionAwareRunnerConfig;
  /** Session 状态机缓存 */
  private stateMachines = new Map<string, StateMachine<SessionStatus>>();
  /** 自主子系统运行时 */
  private _subsystemRuntime?: import('./autonomous-subsystem/runtime.js').SubsystemRuntime;
  /** EventBus 引用（用于子系统/多 Agent 上下文） */
  private _events?: import('../core/primitives/event-bus.js').EventBus;
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
  }) => Promise<{ systemPrompt: string; manifest?: import('./context/layer-types.js').AssembleManifest }>;
  /** 会话重置时清理 Assembler 层缓存 */
  private systemPromptAssemblerClear?: (sessionId: string) => void;

  constructor(agent: Agent, harness: ReliabilityHarness, store: TypedSessionStore, config?: SessionAwareRunnerConfig & { events?: import('../core/primitives/event-bus.js').EventBus }) {
    this.agent = agent;
    this.harness = harness;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._events = config?.events;
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

    try {
      // 3. 加载或创建 session
      let session = await this.store.load(_agentId, sessionId);
      if (!session) {
        session = this.createSession(sessionId, runConfig.agentId ?? 'default');
      }
      if (!session.tasks) session.tasks = [];

      // 4. 检查 session 是否需要重置
      this.checkSessionReset(session);

      // 4b. 绑定会话任务服务（工具与注入共用同一内存对象）
      this.config.sessionTaskService?.attachSession(session);

      // 5. 追加用户消息
      session.messages.push(input);
      session.meta.lastInteractionAt = Date.now();
      session.meta.updatedAt = Date.now();

      // 通知子系统：主会话生命周期态（通用）
      this._events?.emit({
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
            extractionStatus: session.lifecycle?.memoryExtraction ?? 'pending',
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

      // 8. 同步运行时上下文到工具上下文提供者
      if (this.toolContextProvider) {
        this.toolContextProvider.setRuntime(sessionId, _agentId, session.messages);
      }

      // 9. 同步 session 消息到 Agent 上下文
      this.agent.context.messages = session.messages;
      // 播种压缩状态（摘要 + lastProactiveMessageCount），供重启后缓存重建
      this.agent.setSessionCompactState(sessionId, session.contextCompact);
      let basePrompt = effectiveRunConfig.systemPrompt;
      let personaFromResolver = false;
      if (!basePrompt && this.systemPromptResolver) {
        try {
          const resolved = await this.systemPromptResolver();
          const previouslyHadPersona = (this.lastCleanPersonaPrompt ?? '') !== '';
          this.lastCleanPersonaPrompt = resolved;
          if (resolved) {
            // 有 persona：同步到 Agent / SecurityGuard
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
          this._events?.emit({
            type: 'persona.resolve.failed',
            timestamp: Date.now(),
            agentId: _agentId,
            sessionId,
            data: { error: errMsg },
          });
          basePrompt = this.lastCleanPersonaPrompt ?? (this.agent.context.systemPrompt || '');
        }
      }
      if (!basePrompt && !personaFromResolver) {
        basePrompt = this.agent.context.systemPrompt || '';
      }

      // system prompt 终装：Assembler（层契约）优先，否则退回字符串拼接
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
          this.agent.context.systemPrompt = assembled.systemPrompt;
          if (assembled.manifest) {
            const assembledAt = Date.now();
            this._events?.emit({
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
          this.applyConcatSystemPrompt(basePrompt, effectiveRunConfig.injectedContext, personaFromResolver);
          this._events?.emit({
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
        this.applyConcatSystemPrompt(basePrompt, effectiveRunConfig.injectedContext, personaFromResolver);
      }

      // 更新 harness 的 sessionId/agentId（用于检查点）
      this.harness.sessionId = sessionId;
      this.harness.agentId = effectiveRunConfig.agentId ?? 'default';
      // ContextEngine CompactState 按 session 隔离
      this.agent.setContextSessionId(sessionId);

      // Token 估算器（当 LLM 不返回 usage 时用于回退估算）
      const estimator = new HeuristicTokenEstimator();

      // 10. 运行 Agent（Agent.run = reliability 包装）
      let hasTurnEnd = false;
      let streamedContent = '';
      let lastUsage: any = undefined;
      const meta = { agentId: effectiveRunConfig.agentId ?? 'default', sessionId };
      const adaptState = { assistantContent: '', lastUserContent: '' };
      /** 本轮起始消息下标（afterTurn 只传增量） */
      let turnStartIndex = this.agent.context.messages.length;

      for await (const loopEvent of this.agent.run(signal)) {
        // 适配事件格式（向后兼容）
        const adapted = adaptLoopEvent(loopEvent, meta, adaptState);
        if (adapted) {
          // 捕获 usage 数据，并在 turn.end 事件中附加上下文信息（必须在 yield 之前，
          // 否则 gateway 收到事件后立即广播，data 里还没有 context 字段）
          if (adapted.type === 'turn.end') {
            if (adapted.data?.usage) {
              lastUsage = adapted.data.usage;
            }
            (adapted.data as Record<string, unknown>).contextTokens = lastUsage?.promptTokens ?? estimator.estimateMessages(session.messages);
            (adapted.data as Record<string, unknown>).contextWindow = effectiveRunConfig.contextWindow;
          }

          yield adapted;
          // 事件桥：循环事件同时广播到 EventBus
          // 跳过高频流式 delta（每 token 一次），避免 EventBus 拥塞
          if (adapted.type !== 'llm_stream_delta') {
            this._events?.emit(adapted);
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
          turnStartIndex = this.agent.context.messages.length;
        }

        // turn.end → 记录 turn
        if (loopEvent.type === 'turn_end') {
          hasTurnEnd = true;
          if (loopEvent.usage) {
            lastUsage = loopEvent.usage;
          }
          const turnMessages = this.agent.context.messages.slice(turnStartIndex);
          await this.agent.notifyAfterTurn(lastUsage, turnMessages);
          turnStartIndex = this.agent.context.messages.length;
          const content = adaptState.assistantContent || streamedContent;
          if (content) {
            session.turns.push({
              id: `turn_${Date.now()}`,
              input: session.messages.slice(0, -1),
              output: { role: 'assistant', content, timestamp: Date.now() },
              usage: lastUsage,
              durationMs: 0,
              model: effectiveRunConfig.model ?? 'unknown',
              timestamp: Date.now(),
            });
          }
        }
      }

      // 10. 同步 Agent 上下文回 session
      //     Agent.run() 修改了 agent.context.messages（原地）
      //     含 Loop 注入的托管 systemPrompt（metadata.source='systemPrompt'）：
      //     落盘保留审计价值；聊天 UI 在 history 映射时过滤，不回放进对话
      session.messages = this.agent.context.messages;

      // 11. 引擎异常退出时的 session 一致性修复
      if (!hasTurnEnd) {
        const fallbackContent = streamedContent || '';
        if (fallbackContent) {
          session.messages.push({
            role: 'assistant',
            content: fallbackContent,
            timestamp: Date.now(),
          });
          session.turns.push({
            id: `turn_${Date.now()}`,
            input: session.messages.slice(0, -1),
            output: { role: 'assistant', content: fallbackContent, timestamp: Date.now() },
            usage: lastUsage,
            durationMs: 0,
            model: effectiveRunConfig.model ?? 'unknown',
            timestamp: Date.now(),
          });
        }
      }

      // 12. 持久化
      sm.transition('idle');
      session.meta.status = sm.state;
      session.meta.updatedAt = Date.now();
      // 压缩状态写回 Session（供重启快速装配 LLM 视图）
      const compactSnap = this.agent.getSessionCompactState(sessionId);
      if (compactSnap) {
        session.contextCompact = compactSnap;
      } else {
        delete session.contextCompact;
      }
      await this.store.save(_agentId, sessionId, session);

      // 通知子系统：本轮处理完成（保持 active，但刷新 lastInteractionAt）
      this._events?.emit({
        type: 'session.lifecycle.updated',
        timestamp: Date.now(),
        agentId: _agentId,
        sessionId,
        data: {
          lifecycle: session.lifecycle?.lifecycle ?? 'active',
          extractionStatus: session.lifecycle?.memoryExtraction ?? 'pending',
          lastInteractionAt: session.meta.lastInteractionAt,
        },
      });

    } catch (err) {
      // 引擎出错：状态机转到 error，持久化
      const sm = this.stateMachines.get(sessionId);
      if (sm?.canTransition('error')) {
        sm.transition('error');
        const session = await this.store.load(_agentId, sessionId);
        if (session) {
          session.meta.status = sm.state;
          session.meta.updatedAt = Date.now();
          await this.store.save(_agentId, sessionId, session);

          // 通知子系统：异常路径下保持生命周期可感知
          this._events?.emit({
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
      release();
      gateRelease?.();
    }
  }

  /**
   * 获取 Session 锁
   * 同一 session 同时只有一个运行
   *
   * 使用 Promise 队列实现，避免 polling 开销。
   * 请求按 FIFO 顺序获取锁，无饥饿问题。
   */
  private async acquireLock(sessionId: string): Promise<() => void> {
    // 如果已锁定，入队等待
    if (this.locked.get(sessionId)) {
      await new Promise<void>(resolve => {
        if (!this.queues.has(sessionId)) {
          this.queues.set(sessionId, []);
        }
        this.queues.get(sessionId)!.push({ resolve });
      });
    }

    // 获取锁
    this.locked.set(sessionId, true);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      // 释放锁：唤醒队列中下一个等待者
      const queue = this.queues.get(sessionId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        next.resolve();
      } else {
        // 队列为空，标记为未锁定
        this.locked.set(sessionId, false);
        // 清理空队列
        this.queues.delete(sessionId);
      }
    };
  }

  /**
   * 创建新 Session
   */
  private createSession(sessionId: string, agentId: string): SessionData {
    return {
      id: sessionId,
      agentId,
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

  /** 旧路径：persona + injectedContext 字符串拼接 */
  private applyConcatSystemPrompt(
    basePrompt: string,
    injectedContext: string | undefined,
    personaFromResolver: boolean,
  ): void {
    if (injectedContext) {
      this.agent.context.systemPrompt = basePrompt
        ? `${basePrompt}\n\n${injectedContext}`
        : injectedContext;
    } else if (personaFromResolver || basePrompt) {
      this.agent.context.systemPrompt = basePrompt;
    }
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

    // Idle reset
    if (this.config.idleExpiryMs) {
      const idle = now - session.meta.lastInteractionAt;
      if (idle > this.config.idleExpiryMs) {
        session.messages = [];
        session.turns = [];
        session.meta.sessionStartedAt = now;
        didReset = true;
      }
    }

    if (didReset) {
      // 历史清空后，层指纹与压缩快照一并失效
      this.systemPromptAssemblerClear?.(session.id);
      delete session.contextCompact;
      this.agent.setSessionCompactState(session.id, undefined);
    }
  }
}
