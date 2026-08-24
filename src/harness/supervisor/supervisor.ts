/**
 * AgentSupervisor — Agent 持续运行的核心
 *
 * 让 Agent 从"函数调用"变成"持续运行的进程"。
 * 基于 Core ProcessModel 实现，提供认知循环：
 *
 *   感知 → 思考 → 执行 → 反思 → (循环)
 *
 * 设计原则：
 * - 基于 ProcessModel：有独立生命周期，可被 kill/sleep
 * - 事件驱动：所有输入都是事件
 * - Planner 可替换：不同场景用不同的规划策略
 * - Reflector 可选：没有反思器也能运行
 * - 与 Agent 共存：单次推理仍由 Agent 完成
 */

import { randomUUID } from 'node:crypto';
import {
  ProcessModel,
  ProcessEvents,
  AsyncTask,
  DefaultEventBus,
} from '../../core/index.js';
import type { EventBus, EventBusAgentEvent as AgentEvent } from '../../core/index.js';
import type { Agent } from '../../core/loop/agent.js';
import type { ReliabilityHarness } from '../reliability/run-agent.js';
import { runAgentWithReliability } from '../reliability/run-agent.js';
import type { Message } from '../../core/types.js';
import type {
  Planner,
  Reflector,
  AgentState,
  AgentStats,
  Plan,
  PlanStep,
  StepResult,
  ExecutionRecord,
  SupervisorConfig,
} from './types.js';
import { EventCollector } from './event-collector.js';

// ── Supervisor 事件 ──

export const SupervisorEvents = {
  CYCLE_START: 'supervisor.cycle.start',
  CYCLE_END: 'supervisor.cycle.end',
  PLAN_CREATED: 'supervisor.plan.created',
  PLAN_COMPLETED: 'supervisor.plan.completed',
  PLAN_FAILED: 'supervisor.plan.failed',
  STEP_EXECUTING: 'supervisor.step.executing',
  STEP_COMPLETED: 'supervisor.step.completed',
  STEP_FAILED: 'supervisor.step.failed',
  REFLECTION_DONE: 'supervisor.reflection.done',
  IDLE: 'supervisor.idle',
} as const;

// ── AgentSupervisor ──

/**
 * AgentSupervisor — Agent 的"大脑"
 *
 * 持续运行，接收事件，通过 Planner 决策，通过 Agent 执行。
 */
export class AgentSupervisor {
  readonly id: string;
  readonly name: string;
  readonly agentId: string;

  private _process: ProcessModel;
  private _collector: EventCollector;
  private _state: AgentState;
  private _planner: Planner;
  private _reflector?: Reflector;
  private _agent?: Agent;
  private _harness?: ReliabilityHarness;
  private _events: EventBus;
  private _idleTimeoutMs: number;
  private _maxExecutionHistory: number;
  private _running = false;

  constructor(config: SupervisorConfig, events?: EventBus) {
    this.id = randomUUID();
    this.name = config.name ?? `supervisor-${this.id.slice(0, 8)}`;
    this.agentId = config.agentId;
    this._planner = config.planner;
    this._reflector = config.reflector;
    this._idleTimeoutMs = config.idleTimeoutMs ?? 30000;
    this._maxExecutionHistory = config.maxExecutionHistory ?? 100;
    this._events = events ?? new DefaultEventBus();
    this._collector = new EventCollector(this._events);

    this._state = {
      agentId: config.agentId,
      activePlan: null,
      recentExecutions: [],
      stats: {
        totalEvents: 0,
        totalExecutions: 0,
        totalErrors: 0,
        totalTokensUsed: 0,
        startTime: 0,
        lastActiveTime: 0,
      },
      metadata: {},
    };

    this._process = new ProcessModel(
      { name: this.name, agentId: this.agentId },
      this._events,
    );
  }

  // ── 访问器 ──

  /** Supervisor 是否正在运行 */
  get running(): boolean { return this._running; }

  /** 当前 Agent 状态 */
  get state(): Readonly<AgentState> { return this._state; }

  /** 事件收集器 */
  get collector(): EventCollector { return this._collector; }

  /** 底层进程 */
  get process(): ProcessModel { return this._process; }

  // ── 生命周期 ──

  /**
   * 启动 Supervisor
   *
   * 开始持续运行的认知循环。
   *
   * @param agent - Agent 实例（用于单次推理）
   */
  async start(agent: Agent, harness: ReliabilityHarness): Promise<void> {
    if (this._running) {
      throw new Error(`Supervisor ${this.id} is already running`);
    }

    this._agent = agent;
    this._harness = harness;
    this._running = true;
    this._state.stats.startTime = Date.now();

    // 订阅 Core EventBus
    this._collector.subscribeEventBus();

    this._emit(SupervisorEvents.CYCLE_START);

    await this._process.run(async (ctx) => {
      while (ctx.state === 'running') {
        await this._cognitiveCycle(ctx);
      }
    });

    this._running = false;
  }

  /**
   * 停止 Supervisor
   */
  async stop(): Promise<void> {
    this._running = false;
    await this._collector.stop();
    this._process.kill('normal', 'supervisor stopped');
  }

  /**
   * 注入用户消息
   *
   * 从外部（如 ChannelAdapter）注入消息到事件队列。
   */
  injectMessage(message: Message): void {
    this._collector.inject({
      type: 'user.message',
      timestamp: message.timestamp ?? Date.now(),
      data: {
        role: message.role,
        content: message.content,
        source: message.source,
      },
    });
  }

  // ── 认知循环 ──

  /**
   * 单次认知循环：感知 → 思考 → 执行 → 反思
   */
  private async _cognitiveCycle(ctx: import('../../core/index.js').ProcessContext): Promise<void> {
    // 1. 感知：收集事件
    const events = await this._collector.collect(this._idleTimeoutMs);

    if (events.length === 0) {
      this._emit(SupervisorEvents.IDLE);
      return;
    }

    this._state.stats.totalEvents += events.length;
    this._state.stats.lastActiveTime = Date.now();

    // 2. 思考：Planner 决策
    const plan = await this._planner.decide(events, this._state);

    if (plan.steps.length === 0) {
      // 空计划 = "什么都不做"
      return;
    }

    this._state.activePlan = plan;
    this._emit(SupervisorEvents.PLAN_CREATED, { planId: plan.id, goal: plan.goal });

    // 3. 执行：按计划执行步骤
    const results: StepResult[] = [];
    for (const step of plan.steps) {
      if (this._process.state !== 'running') break;

      this._emit(SupervisorEvents.STEP_EXECUTING, {
        planId: plan.id,
        stepId: step.id,
        type: step.type,
      });

      const result = await this._executeStep(step, events);
      step.result = result;
      step.status = result.success ? 'completed' : 'failed';
      results.push(result);

      // 记录执行
      this._recordExecution(events[0], plan, result);

      if (!result.success) {
        // 步骤失败，可以选择中断或继续
        plan.status = 'failed';
        this._emit(SupervisorEvents.PLAN_FAILED, { planId: plan.id, error: result.error });
        break;
      }
    }

    if (plan.status !== 'failed') {
      plan.status = 'completed';
      plan.completedAt = Date.now();
      this._emit(SupervisorEvents.PLAN_COMPLETED, { planId: plan.id });
    }

    this._state.activePlan = null;

    // 4. 反思（可选）
    if (this._reflector && results.length > 0) {
      await this._reflect();
    }
  }

  /**
   * 执行单个步骤
   */
  private async _executeStep(step: PlanStep, triggerEvents: AgentEvent[]): Promise<StepResult> {
    const start = Date.now();

    try {
      switch (step.type) {
        case 'llm_call': {
          if (!this._agent || !this._harness) {
            return { success: false, error: 'No Agent configured', durationMs: Date.now() - start };
          }
          // 用 Agent 执行一次推理
          const messages = this._buildMessages(step, triggerEvents);
          this._agent.context.systemPrompt = step.params.systemPrompt as string ?? '';
          this._agent.context.messages = messages;
          let response = '';
          for await (const event of runAgentWithReliability(
            this._agent.context,
            { model: this._agent.model },
            this._harness,
          )) {
            if (event.type === 'assistant_message') {
              response = typeof event.message.content === 'string' ? event.message.content : '';
            }
          }
          return {
            success: true,
            output: response,
            durationMs: Date.now() - start,
          };
        }

        case 'tool_call': {
          // 工具调用由 Agent 在推理中处理
          // 这里是直接调用的场景（不经过 LLM）
          return {
            success: true,
            output: step.params,
            durationMs: Date.now() - start,
          };
        }

        case 'spawn_agent': {
          // spawn 子进程处理
          // spawn 子进程需要在 ProcessContext 中执行
          // 这里返回一个占位结果，实际 spawn 在认知循环中通过 ctx.spawn 完成
          return {
            success: true,
            output: { action: 'spawn', params: step.params },
            durationMs: Date.now() - start,
          };
        }

        case 'wait': {
          const waitMs = (step.params.durationMs as number) ?? 1000;
          await new Promise(r => setTimeout(r, waitMs));
          return { success: true, durationMs: Date.now() - start };
        }

        case 'custom': {
          // 自定义步骤，执行 params.handler
          const handler = step.params.handler as (() => Promise<unknown>) | undefined;
          if (handler) {
            const output = await handler();
            return { success: true, output, durationMs: Date.now() - start };
          }
          return { success: true, output: step.params, durationMs: Date.now() - start };
        }

        default:
          return { success: false, error: `Unknown step type: ${step.type}`, durationMs: Date.now() - start };
      }
    } catch (err) {
      this._state.stats.totalErrors++;
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * 反思：评估最近的执行
   */
  private async _reflect(): Promise<void> {
    if (!this._reflector) return;

    const recent = this._state.recentExecutions.slice(-10);
    if (recent.length === 0) return;

    const patterns = await this._reflector.detectPatterns(recent);
    this._emit(SupervisorEvents.REFLECTION_DONE, {
      patterns: patterns.length,
      recentCount: recent.length,
    });
  }

  /**
   * 从步骤和事件构建 LLM 消息
   */
  private _buildMessages(step: PlanStep, events: AgentEvent[]): Message[] {
    const content = events
      .filter(e => e.type === 'user.message')
      .map(e => e.data?.content as string)
      .filter(Boolean)
      .join('\n');

    return [{
      role: 'user',
      content: step.params.prompt as string ?? content ?? step.description,
      timestamp: Date.now(),
    }];
  }

  /**
   * 记录执行结果
   */
  private _recordExecution(trigger: AgentEvent | undefined, plan: Plan, result: StepResult): void {
    const record: ExecutionRecord = {
      trigger: trigger ?? { type: 'internal', timestamp: Date.now() },
      plan,
      result,
      timestamp: Date.now(),
    };

    this._state.recentExecutions.push(record);

    // 限制历史长度
    if (this._state.recentExecutions.length > this._maxExecutionHistory) {
      this._state.recentExecutions = this._state.recentExecutions.slice(-this._maxExecutionHistory);
    }

    this._state.stats.totalExecutions++;
  }

  // ── 工具方法 ──

  private _emit(type: string, data?: Record<string, unknown>): void {
    this._events.emit({
      type,
      timestamp: Date.now(),
      agentId: this.agentId,
      data,
    });
  }
}

// ── 工具函数 ──

/**
 * 创建并启动 AgentSupervisor
 */
export async function startSupervisor(
  config: SupervisorConfig,
  agent: Agent,
  harness: ReliabilityHarness,
  events?: EventBus,
): Promise<AgentSupervisor> {
  const supervisor = new AgentSupervisor(config, events);
  supervisor.start(agent, harness).catch(() => {});
  return supervisor;
}
