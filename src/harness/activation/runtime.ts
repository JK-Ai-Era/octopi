/**
 * AgentRuntime — 激活宿主
 *
 * 把 Trigger 编译成 0..N 次受监督的 Run。
 * 模型 A：dispatch await 至 Run 结束；无第二执行队列；Source emit 不得 await dispatch。
 *
 * 设计：arch/agent-runtime.md
 */

import type { EventBus } from '../../core/index.js';
import type { AgentEvent } from '../../core/primitives/event-bus.js';
import { CoalesceBuffer } from './coalesce.js';
import { buildRunRequest, resolveSessionId } from './compiler.js';
import { ExplicitRouter } from './router.js';
import type {
  AgentRouter,
  DispatchResult,
  FanoutDispatchResult,
  RouteTarget,
  RuntimeAgent,
  RuntimeEvent,
  RuntimeEventListener,
  Trigger,
  TriggerSource,
} from './types.js';
import { RuntimeEvents } from './types.js';

export interface AgentRuntimeConfig {
  events?: EventBus;
  router?: AgentRouter;
  defaultCoalesceMs?: number;
  coalesceBufferLimit?: number;
  admission?: {
    /**
     * 期望的最大并发 Run。硬闸仍只在 SessionGate；
     * 若与 Gate 不一致仅告警，避免双闸语义分叉。
     */
    expectedMaxConcurrentRuns?: number;
    coalesceBufferLimit?: number;
  };
}

interface ActiveRun {
  requestId: string;
  agentId: string;
  sessionId: string;
  controller: AbortController;
}

export class AgentRuntime {
  private readonly events?: EventBus;
  private readonly router: AgentRouter;
  private readonly coalesce: CoalesceBuffer;
  private readonly agents = new Map<string, RuntimeAgent>();
  private readonly sources = new Map<string, TriggerSource>();
  /** requestId → ActiveRun（同 session 可有多条，abort 按 session 全杀） */
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly expectedMaxConcurrentRuns?: number;
  private started = false;

  constructor(config: AgentRuntimeConfig = {}) {
    this.events = config.events;
    this.router = config.router ?? new ExplicitRouter();
    this.expectedMaxConcurrentRuns = config.admission?.expectedMaxConcurrentRuns;
    this.coalesce = new CoalesceBuffer({
      defaultWindowMs: config.defaultCoalesceMs,
      maxEntries:
        config.admission?.coalesceBufferLimit ?? config.coalesceBufferLimit ?? 256,
    });
  }

  get running(): boolean {
    return this.started;
  }

  /** 当前活跃 Run 数（admission 观测用） */
  get activeRunCount(): number {
    return this.activeRuns.size;
  }

  get admission(): { expectedMaxConcurrentRuns?: number } {
    return { expectedMaxConcurrentRuns: this.expectedMaxConcurrentRuns };
  }

  registerAgent(agent: RuntimeAgent): void {
    this.agents.set(agent.agentId, agent);
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  listAgents(): Array<{ agentId: string; busy: boolean }> {
    return Array.from(this.agents.keys()).map((agentId) => ({
      agentId,
      busy: Array.from(this.activeRuns.values()).some((r) => r.agentId === agentId),
    }));
  }

  addSource(source: TriggerSource): void {
    this.sources.set(source.id, source);
    if (this.started) {
      void source.start((t) => {
        void this.dispatch(t);
      });
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.expectedMaxConcurrentRuns !== undefined && this.expectedMaxConcurrentRuns <= 0) {
      console.warn(
        `[AgentRuntime] admission.expectedMaxConcurrentRuns=${this.expectedMaxConcurrentRuns} 无效，已忽略（硬闸仍归 SessionGate）`,
      );
    }
    for (const source of this.sources.values()) {
      await source.start((t) => {
        void this.dispatch(t);
      });
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const source of this.sources.values()) {
      await source.stop().catch(() => {
        // source 停失败不阻塞 Runtime 停机
      });
    }
    for (const run of this.activeRuns.values()) {
      run.controller.abort();
    }
    this.activeRuns.clear();
    this.coalesce.stop();
  }

  /** 中止该 agent+session 下全部活跃 Run（含已入 Runner 锁等待的） */
  abort(agentId: string, sessionId: string): void {
    for (const run of this.activeRuns.values()) {
      if (run.agentId === agentId && run.sessionId === sessionId) {
        run.controller.abort();
      }
    }
  }

  /** 是否存在该 agent+session 的活跃 Run（/stop 文案与竞态观测） */
  hasActiveRun(agentId: string, sessionId: string): boolean {
    for (const run of this.activeRuns.values()) {
      if (run.agentId === agentId && run.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * 监听 Runtime 事件。
   * - `on(listener)`：全部事件
   * - `on(type, listener)`：按类型过滤（对齐 arch 签名）
   */
  on(listener: RuntimeEventListener): () => void;
  on(type: string, listener: RuntimeEventListener): () => void;
  on(
    typeOrListener: string | RuntimeEventListener,
    maybeListener?: RuntimeEventListener,
  ): () => void {
    if (typeof typeOrListener === 'function') {
      this.listeners.add(typeOrListener);
      return () => {
        this.listeners.delete(typeOrListener);
      };
    }
    const type = typeOrListener;
    const wrapped: RuntimeEventListener = (event) => {
      if (event.type === type) maybeListener?.(event);
    };
    this.listeners.add(wrapped);
    return () => {
      this.listeners.delete(wrapped);
    };
  }

  /** 串行 dispatch 多条 Trigger */
  async dispatchMany(
    triggers: Trigger[],
    options?: { onEvent?: (event: AgentEvent) => void },
  ): Promise<Array<DispatchResult | FanoutDispatchResult>> {
    const results: Array<DispatchResult | FanoutDispatchResult> = [];
    for (const t of triggers) {
      results.push(await this.dispatch(t, options));
    }
    return results;
  }

  /**
   * 模型 A：await 至 Run 结束（或 skipped / failed）
   * @param options.onEvent - 转发 Run 事件流（Gateway 流式广播）；不变量 #6
   */
  async dispatch(
    trigger: Trigger,
    options?: { onEvent?: (event: AgentEvent) => void },
  ): Promise<DispatchResult | FanoutDispatchResult> {
    if (!this.started) {
      this.emitRuntime(RuntimeEvents.TRIGGER_DROPPED, {
        triggerId: trigger.id,
        reason: 'runtime_stopped',
      });
      return { status: 'skipped', reason: 'runtime_stopped' };
    }

    this.emitRuntime(RuntimeEvents.TRIGGER_RECEIVED, {
      triggerId: trigger.id,
      type: trigger.type,
      agentId: trigger.agentId,
      sessionId: trigger.sessionId,
    });

    const targets = await this.router.resolve(trigger, this.agents);
    if (targets.length === 0) {
      this.emitRuntime(RuntimeEvents.TRIGGER_DROPPED, {
        triggerId: trigger.id,
        reason: 'no_agent',
      });
      return { status: 'skipped', reason: 'no_agent' };
    }

    if (targets.length === 1) {
      return this.dispatchToTarget(trigger, targets[0]!, options);
    }

    // fan-out：串行；聚合为 FanoutDispatchResult（ran/aborted/failed 均不静默丢弃）
    const results: Array<{ agentId: string; result: DispatchResult }> = [];
    for (const target of targets) {
      const result = await this.dispatchToTarget(trigger, target, options);
      results.push({ agentId: target.agentId, result });
    }

    const anyFailed = results.some((r) => r.result.status === 'failed');
    const anyRan = results.some((r) => r.result.status === 'ran');
    const allSkipped = results.every((r) => r.result.status === 'skipped');

    if (anyFailed) {
      this.emitRuntime(RuntimeEvents.TRIGGER_DROPPED, {
        triggerId: trigger.id,
        reason: 'fanout_partial_failure',
        results: results.map((r) => ({ agentId: r.agentId, status: r.result.status })),
      });
      return { status: 'failed', results };
    }
    if (allSkipped) {
      const reason =
        results[0]?.result.status === 'skipped'
          ? results[0].result.reason
          : 'no_agent';
      return { status: 'skipped', reason };
    }
    // anyRan（含 mixed ran + aborted/skipped）→ ran + 明细
    if (anyRan) {
      return { status: 'ran', results };
    }
    return { status: 'skipped', reason: 'no_agent' };
  }

  private async dispatchToTarget(
    trigger: Trigger,
    target: RouteTarget,
    options?: { onEvent?: (event: AgentEvent) => void },
  ): Promise<DispatchResult> {
    const agent = this.agents.get(target.agentId);
    if (!agent) {
      return { status: 'skipped', reason: 'no_agent' };
    }

    const sessionId = resolveSessionId(agent, {
      ...trigger,
      sessionId: target.sessionId ?? trigger.sessionId,
    });

    if (trigger.coalesceKey) {
      this.emitRuntime(RuntimeEvents.RUN_SCHEDULED, {
        triggerId: trigger.id,
        agentId: agent.agentId,
        sessionId,
        coalesceKey: trigger.coalesceKey,
      });
      const result = this.coalesce.push({
        agentId: agent.agentId,
        sessionId,
        trigger,
        onEvent: options?.onEvent,
        onFlush: (triggers, onEvent) =>
          this.executeTriggers(agent, triggers, sessionId, onEvent ?? options?.onEvent),
      });

      if (result.kind === 'no_key' || result.kind === 'buffer_full') {
        return this.executeTriggers(agent, [trigger], sessionId, options?.onEvent);
      }

      return result.done;
    }

    return this.executeTriggers(agent, [trigger], sessionId, options?.onEvent);
  }

  private async executeTriggers(
    agent: RuntimeAgent,
    triggers: Trigger[],
    sessionId: string,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<DispatchResult> {
    if (!this.started) {
      return { status: 'skipped', reason: 'runtime_stopped' };
    }

    const request = buildRunRequest(agent, triggers, sessionId);
    const controller = new AbortController();
    const run: ActiveRun = {
      requestId: request.requestId,
      agentId: agent.agentId,
      sessionId,
      controller,
    };
    this.activeRuns.set(request.requestId, run);

    this.emitRuntime(RuntimeEvents.RUN_STARTED, {
      requestId: request.requestId,
      agentId: agent.agentId,
      sessionId,
      triggerIds: triggers.map((t) => t.id),
      triggerType: triggers[0]?.type,
    });

    try {
      for await (const event of agent.dispatcher.execute(request, controller.signal)) {
        try {
          onEvent?.(event);
        } catch {
          // 消费者（WS 广播等）异常不中断 Run
        }
      }

      if (controller.signal.aborted) {
        this.emitRuntime(RuntimeEvents.RUN_ENDED, {
          requestId: request.requestId,
          agentId: agent.agentId,
          sessionId,
          reason: 'aborted',
        });
        return { status: 'skipped', reason: 'aborted' };
      }

      this.emitRuntime(RuntimeEvents.RUN_ENDED, {
        requestId: request.requestId,
        agentId: agent.agentId,
        sessionId,
        reason: 'completed',
      });
      return {
        status: 'ran',
        requestId: request.requestId,
        agentId: agent.agentId,
        sessionId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitRuntime(RuntimeEvents.RUN_FAILED, {
        requestId: request.requestId,
        agentId: agent.agentId,
        sessionId,
        error: message,
      });
      return { status: 'failed', error: message };
    } finally {
      this.activeRuns.delete(request.requestId);
    }
  }

  private emitRuntime(
    type: (typeof RuntimeEvents)[keyof typeof RuntimeEvents],
    data?: Record<string, unknown>,
  ): void {
    const event: RuntimeEvent = {
      type,
      timestamp: Date.now(),
      agentId: data?.agentId as string | undefined,
      sessionId: data?.sessionId as string | undefined,
      data,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常不影响激活路径
      }
    }
    if (this.events) {
      const busEvent: AgentEvent = {
        type,
        timestamp: event.timestamp,
        agentId: event.agentId,
        sessionId: event.sessionId,
        data,
      };
      this.events.emit(busEvent);
    }
  }
}
