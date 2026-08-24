/**
 * SessionAwareRunner — Session 感知的运行器
 *
 * Harness 层组件。在 Agent + runAgentWithReliability 之上管理 Session 生命周期：
 * - 消息持久化
 * - Session 锁（同一 session 同时只有一个运行）
 * - Daily reset / Idle reset
 * - 并发控制
 *
 * Agent 是状态管理器，runAgentWithReliability 提供可靠性包装。
 */

import type { Message, Turn, SessionStatus } from '../core/types.js';
import type { SessionStore, SessionData } from '../core/interfaces/session-store.js';
import type { Agent } from '../core/loop/agent.js';
import type { AgentLoopEvent } from '../core/loop/types.js';
import type { ReliabilityHarness } from './reliability/run-agent.js';
import { runAgentWithReliability } from './reliability/run-agent.js';
import { createSessionStateMachine, type StateMachine } from '../core/state-machine.js';

/**
 * 任务决策提供者接口
 *
 * Harness 层组件，在用户消息到达时调用 LLM 判断任务状态。
 * SessionAwareRunner 在调用 engine.run() 之前调用一次。
 */
export interface TaskDecisionProvider {
  decide(params: {
    sessionId: string;
    messages: Message[];
  }): Promise<TaskDecisionResult>;
}

/** 任务决策结果 */
export interface TaskDecisionResult {
  /** 注入到 systemPrompt 的任务上下文 */
  taskContext?: string;
  /** 决策理由（用于日志/可观测性） */
  reason?: string;
}

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
   * 任务决策提供者（可选）
   *
   * 在用户消息到达时调用 LLM 判断任务状态，
   * 将结果注入到 runConfig.injectedContext，由 ContextEngine 透传到 systemPrompt。
   *
   * 调用时机：handle() 中追加用户消息后、engine.run() 前，只调用一次。
   * 工具调用循环中不会重复调用。
   */
  taskDecisionProvider?: TaskDecisionProvider;
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
 * 适配 AgentLoopEvent → AgentEvent（向后兼容）
 *
 * 新架构产出 AgentLoopEvent，旧消费者（Gateway/TUI）期望 AgentEvent。
 * 此函数桥接两者，避免一次性更新所有下游。
 */
function adaptLoopEvent(
  event: AgentLoopEvent,
  meta: { agentId: string; sessionId: string },
  state: { assistantContent: string },
): import('../core/event-bus.js').AgentEvent | null {
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
      return { type: 'iteration.start', timestamp: event.timestamp, data: {} };
    case 'assistant_message':
      state.assistantContent = typeof event.message.content === 'string' ? event.message.content : '';
      return null;
    case 'turn_end':
      return { type: 'turn.end', timestamp: Date.now(), data: { content: state.assistantContent } };
    case 'llm_stream_delta':
      return { type: 'llm_stream_delta', timestamp: event.timestamp, data: event.data };
    case 'tool_start':
      return { type: 'tool.exec.start', timestamp: event.timestamp, data: { toolCallId: event.toolCall.id, toolName: event.toolCall.name } };
    case 'tool_end':
      return { type: 'tool.exec.end', timestamp: event.timestamp, data: { toolCallId: event.toolCall.id, toolName: event.toolCall.name, hasError: !!event.result.isError } };
    case 'stream.fallback_to_sync':
    case 'stream.fallback_failed':
      return { type: event.type, timestamp: event.timestamp, data: event.data };
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
  private store: SessionStore;
  /** 锁状态：true = 已锁定，false = 空闲 */
  private locked = new Map<string, boolean>();
  /** 等待队列：每个 session 一个 FIFO 队列 */
  private queues = new Map<string, QueueEntry[]>();
  private config: SessionAwareRunnerConfig;
  /** Session 状态机缓存 */
  private stateMachines = new Map<string, StateMachine<SessionStatus>>();
  /** 分布式智能体运行时（可选） */
  private _distributedRuntime?: import('./distributed/runtime.js').AgentRuntime;
  /** EventBus 引用（用于分布式智能体上下文） */
  private _events?: import('../core/event-bus.js').EventBus;

  constructor(agent: Agent, harness: ReliabilityHarness, store: SessionStore, config?: SessionAwareRunnerConfig & { events?: import('../core/event-bus.js').EventBus }) {
    this.agent = agent;
    this.harness = harness;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._events = config?.events;
  }

  /** 设置分布式智能体运行时 */
  setDistributedRuntime(runtime: import('./distributed/runtime.js').AgentRuntime): void {
    this._distributedRuntime = runtime;
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
  ): AsyncGenerator<import('../core/event-bus.js').AgentEvent> {
    // 1. 并发门控（如果配置了 SessionGate）
    const gate = this.config.sessionGate;
    let gateRelease: (() => void) | undefined;
    if (gate) {
      gateRelease = await gate.enter();
    }

    // 2. 获取锁
    const release = await this.acquireLock(sessionId);

    try {
      // 3. 加载或创建 session
      let session = await this.store.load(sessionId);
      if (!session) {
        session = this.createSession(sessionId, runConfig.agentId ?? 'default');
      }

      // 4. 检查 session 是否需要重置
      this.checkSessionReset(session);

      // 5. 追加用户消息
      session.messages.push(input);
      session.meta.lastInteractionAt = Date.now();
      session.meta.updatedAt = Date.now();

      // 状态机：idle → processing
      const sm = this.getOrCreateStateMachine(sessionId, session.meta.status);
      sm.transition('processing');
      session.meta.status = sm.state;

      // 6. 任务决策（如果配置了 TaskDecisionProvider）
      let effectiveRunConfig = runConfig;
      if (this.config.taskDecisionProvider && input.role === 'user') {
        try {
          const decision = await this.config.taskDecisionProvider.decide({
            sessionId,
            messages: session.messages,
          });
          if (decision.taskContext) {
            effectiveRunConfig = {
              ...runConfig,
              injectedContext: decision.taskContext,
            };
          }
        } catch (err) {
          console.warn('[SessionAwareRunner] TaskDecisionProvider failed:', err);
        }
      }

      // 7. 应用分布式智能体的待处理注入
      if (this._distributedRuntime) {
        if (this._events) {
          this._distributedRuntime.setMainAgentContext({
            messages: session.messages,
            runConfig: effectiveRunConfig,
            events: this._events,
          });
        }
        this._distributedRuntime.applyPendingInjections(session.messages);
      }

      // 8. 同步 session 消息到 Agent 上下文
      this.agent.context.messages = session.messages;
      const basePrompt = effectiveRunConfig.systemPrompt || this.agent.context.systemPrompt || '';
      if (effectiveRunConfig.injectedContext) {
        this.agent.context.systemPrompt = basePrompt + '\n\n' + effectiveRunConfig.injectedContext;
      } else if (effectiveRunConfig.systemPrompt) {
        this.agent.context.systemPrompt = effectiveRunConfig.systemPrompt;
      }

      // 更新 harness 的 sessionId/agentId（用于检查点）
      this.harness.sessionId = sessionId;
      this.harness.agentId = effectiveRunConfig.agentId ?? 'default';

      // 9. 运行 Agent（runAgentWithReliability 包装）
      let hasTurnEnd = false;
      let streamedContent = '';
      let lastUsage: any = undefined;
      const meta = { agentId: effectiveRunConfig.agentId ?? 'default', sessionId };
      const adaptState = { assistantContent: '' };

      for await (const loopEvent of runAgentWithReliability(
        this.agent.context,
        { model: this.agent.model },
        this.harness,
        signal,
      )) {
        // 适配事件格式（向后兼容）
        const adapted = adaptLoopEvent(loopEvent, meta, adaptState);
        if (adapted) yield adapted;

        // 收集流式内容
        if (loopEvent.type === 'llm_stream_delta' && loopEvent.data?.delta) {
          streamedContent += loopEvent.data.delta;
        }

        // 捕获 assistant 消息内容
        if (loopEvent.type === 'assistant_message') {
          adaptState.assistantContent = typeof loopEvent.message.content === 'string' ? loopEvent.message.content : '';
        }

        // turn.end → 记录 turn
        if (loopEvent.type === 'turn_end') {
          hasTurnEnd = true;
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
      //     runAgentWithReliability 修改了 agent.context.messages（原地）
      //     将新增的消息同步回 session
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
      await this.store.save(sessionId, session);

    } catch (err) {
      // 引擎出错：状态机转到 error，持久化
      const sm = this.stateMachines.get(sessionId);
      if (sm?.canTransition('error')) {
        sm.transition('error');
        const session = await this.store.load(sessionId);
        if (session) {
          session.meta.status = sm.state;
          session.meta.updatedAt = Date.now();
          await this.store.save(sessionId, session);
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
    };
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

    // Daily reset
    if (this.config.enableDailyReset) {
      const sessionDay = new Date(session.meta.sessionStartedAt).toDateString();
      const today = new Date(now).toDateString();
      if (sessionDay !== today) {
        session.messages = [];
        session.turns = [];
        session.meta.sessionStartedAt = now;
      }
    }

    // Idle reset
    if (this.config.idleExpiryMs) {
      const idle = now - session.meta.lastInteractionAt;
      if (idle > this.config.idleExpiryMs) {
        session.messages = [];
        session.turns = [];
        session.meta.sessionStartedAt = now;
      }
    }
  }
}
