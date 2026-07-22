/**
 * Distributed Intelligence — AgentRuntime
 *
 * 核心运行时，管理分布式智能体的注册、触发、执行和生命周期。
 * 集成 TriggerEngine、InjectionQueue、AuditTrail。
 */

import type { EventBus, AgentEvent } from '../../core/event-bus.js';
import type { RegisteredTool, Message } from '../../core/types.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { ErrorStrategy } from '../../core/interfaces/error-strategy.js';
import type { Observer } from '../../core/interfaces/observer.js';
import type { AgentEngine } from '../../core/engine.js';
import type { DistributedAgentSpec } from './spec.js';
import type { AgentInput, AgentOutput, TriggerContext, AgentContext, ContextOutput } from './types.js';
import type { ResultInjectionMode } from './output-policy.js';
import type { LLMExecution, HybridExecution } from './execution.js';
import { TriggerEngine, getPriority } from './trigger.js';
import { buildAgentInput } from './input-policy.js';
import {
  handleIntercept,
  handleReplaceContext,
  handleInjectContext,
  handleNotify,
  InjectionQueue,
} from './output-policy.js';
import { AuditTrail } from './audit-trail.js';
import { NoopSecurityGuard } from './noop-security-guard.js';

// ── SharedDeps ──

/**
 * 共享依赖
 *
 * 由 Builder 注入，不自己创建。
 */
export interface SharedDeps {
  /** 模型提供者（共享，无状态 HTTP 客户端） */
  model: ModelProvider;
  /** EventBus（共享，智能体之间通过事件通信） */
  events: EventBus;
  /** 错误策略（共享） */
  errorStrategy: ErrorStrategy;
  /** 观测器（共享，广播模型） */
  observer?: Observer;
  /** 主 Agent 的工具集（供 resolveTools 使用） */
  mainTools: Map<string, RegisteredTool>;
}

// ── RegisteredAgent ──

/** 已注册的分布式智能体 */
interface RegisteredAgent {
  /** 规格定义 */
  spec: DistributedAgentSpec;
  /** LLM/Hybrid 模式的 Engine 实例 */
  engine?: AgentEngine;
  /** Code 模式的执行函数 */
  handler?: (input: AgentInput) => Promise<AgentOutput>;
  /** 当前并发数 */
  concurrency: number;
}

// ── AgentRuntimeConfig ──

export interface AgentRuntimeConfig {
  /** 共享依赖 */
  deps: SharedDeps;
  /** 审计日志输出目录（可选，不传则不启用审计） */
  auditDir?: string;
}

// ── AgentRuntime ──

/**
 * AgentRuntime — 分布式智能体核心运行时
 *
 * 职责：
 * 1. 注册分布式智能体
 * 2. 监听 EventBus，评估触发规则
 * 3. 执行智能体（LLM / Code / Hybrid）
 * 4. 处理输出（四种 OutputPolicy 模式）
 * 5. 管理注入队列
 */
export class AgentRuntime {
  private deps: SharedDeps;
  private agents = new Map<string, RegisteredAgent>();
  private triggerEngine: TriggerEngine;
  private injectionQueue: InjectionQueue;
  private auditTrail?: AuditTrail;
  private globalDisposables: Array<{ dispose(): void }> = [];

  constructor(config: AgentRuntimeConfig) {
    this.deps = config.deps;
    this.triggerEngine = new TriggerEngine({ events: config.deps.events });
    this.injectionQueue = new InjectionQueue();

    if (config.auditDir) {
      this.auditTrail = new AuditTrail({
        events: config.deps.events,
        outputDir: config.auditDir,
      });
    }

    // 监听所有事件，评估触发规则
    this.setupEventListeners();
  }

  /**
   * 注册分布式智能体
   *
   * LLM/Hybrid 模式自动创建独立 Engine。
   * Code 模式直接存储 handler。
   */
  register(spec: DistributedAgentSpec): void {
    if (this.agents.has(spec.id)) {
      throw new Error(`Agent "${spec.id}" already registered`);
    }

    const agent: RegisteredAgent = {
      spec,
      concurrency: 0,
    };

    if (spec.execution.kind === 'code') {
      // Code 模式：不需要 Engine，直接存储 handler
      agent.handler = spec.execution.handler;
    } else if (spec.execution.kind === 'llm' || spec.execution.kind === 'hybrid') {
      // LLM / Hybrid 模式：自动创建独立 Engine
      agent.engine = this.createEngine(spec);
    }

    this.agents.set(spec.id, agent);

    // 注册 ConditionTrigger 的轮询评估
    for (const trigger of spec.triggers) {
      if (trigger.type === 'condition' && typeof trigger.condition.evaluateOn === 'number') {
        this.triggerEngine.registerConditionPolling(trigger, (ctx) => {
          this.onTrigger(spec.id, ctx);
        });
      }
    }

    // 发射注册事件
    this.deps.events.emit({
      type: 'distributed_agent.registered',
      timestamp: Date.now(),
      data: { agentId: spec.id, name: spec.name },
    });
  }

  /**
   * 注销分布式智能体
   */
  unregister(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * 获取已注册的智能体数量
   */
  get agentCount(): number {
    return this.agents.size;
  }

  /**
   * 获取注入队列实例
   */
  get injections(): InjectionQueue {
    return this.injectionQueue;
  }

  /**
   * 应用所有待处理的注入
   *
   * 供 ContextEngine 在 assemble 前调用。
   * 这是安全的时间点：两次 LLM 调用之间。
   */
  applyPendingInjections(messages: Message[]): void {
    this.injectionQueue.applyPending(messages);
  }

  /**
   * 手动触发指定智能体
   *
   * @param agentId - 智能体 ID
   * @param ctx - 触发上下文
   */
  async trigger(agentId: string, ctx: TriggerContext): Promise<void> {
    await this.onTrigger(agentId, ctx);
  }

  /**
   * 工具解析
   *
   * 四种模式：
   * 1. 不传 tools → 继承主 Agent 的工具集
   * 2. 空数组 → 无工具
   * 3. string[] → 从主 Agent 的工具集中按名称查找
   * 4. RegisteredTool[] → 直接使用
   */
  resolveTools(tools?: string[] | RegisteredTool[]): Map<string, RegisteredTool> {
    const result = new Map<string, RegisteredTool>();

    if (!tools) {
      // 不传 → 继承主 Agent 的工具集
      return new Map(this.deps.mainTools);
    }

    if (Array.isArray(tools) && tools.length === 0) {
      // 空数组 → 无工具
      return result;
    }

    if (typeof tools[0] === 'string') {
      // 工具名列表 → 从主 Agent 的工具集中查找
      for (const name of tools as string[]) {
        const tool = this.deps.mainTools.get(name);
        if (tool) result.set(name, tool);
      }
    } else {
      // 工具定义列表 → 直接使用
      for (const tool of tools as RegisteredTool[]) {
        result.set(tool.definition.name, tool);
      }
    }

    return result;
  }

  /**
   * 创建独立 Engine 实例
   *
   * 每个 LLM/Hybrid 模式的智能体有独立的 Engine，
   * 共享 model、events、errorStrategy、observer，
   * 独立的 tools、security、systemPrompt。
   */
  createEngine(spec: DistributedAgentSpec): AgentEngine {
    const llm: LLMExecution = spec.execution.kind === 'llm'
      ? spec.execution
      : (spec.execution as HybridExecution).llm;

    const tools = this.resolveTools(llm.tools);

    // 动态导入 AgentEngine 避免循环依赖
    // AgentEngine 的构造需要完整的 deps
    // 这里返回一个占位，实际使用时需要 Builder 配合
    const deps = {
      model: this.deps.model,
      tools,
      events: this.deps.events,
      errorStrategy: this.deps.errorStrategy,
      observer: this.deps.observer,
      security: new NoopSecurityGuard(),
      systemPrompt: llm.systemPrompt,
    };

    // 由于 AgentEngine 需要 executor 和 contextEngine，
    // 实际创建需要通过 Builder 或工厂方法
    // 这里抛出提示，由集成层（Builder）完成实际创建
    throw new Error(
      `AgentRuntime.createEngine() for "${spec.id}" requires Builder integration. ` +
      `Use AgentBuilder.withDistributedAgent() instead.`
    );
  }

  /**
   * 清理所有资源
   */
  dispose(): void {
    this.triggerEngine.dispose();
    this.auditTrail?.dispose();
    for (const d of this.globalDisposables) {
      d.dispose();
    }
    this.globalDisposables = [];
    this.agents.clear();
  }

  // ── 内部方法 ──

  /**
   * 设置 EventBus 监听器
   */
  private setupEventListeners(): void {
    // 监听所有事件，评估触发规则
    const disposable = this.deps.events.onAll((event) => {
      this.evaluateAllAgents(event);
    });
    this.globalDisposables.push(disposable);
  }

  /**
   * 评估所有已注册智能体的触发规则
   */
  private evaluateAllAgents(event: AgentEvent): void {
    for (const [agentId, agent] of this.agents) {
      const ctx: TriggerContext = {
        eventData: event.data,
        metrics: this.triggerEngine.getMetrics(),
        agentId: event.agentId,
        sessionId: event.sessionId,
      };

      // 事件驱动的 ConditionTrigger 评估
      const matched = this.triggerEngine.evaluateRules(agent.spec.triggers, ctx);

      if (matched.length > 0) {
        // 检查并发限制
        if (agent.spec.limits?.maxConcurrent &&
            agent.concurrency >= agent.spec.limits.maxConcurrent) {
          // 达到并发上限，跳过（可扩展为排队）
          continue;
        }

        this.onTrigger(agentId, ctx);
      }
    }
  }

  /**
   * 触发智能体执行
   */
  private async onTrigger(agentId: string, ctx: TriggerContext): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // 生命周期钩子：onTrigger
    if (agent.spec.lifecycle?.onTrigger) {
      const shouldContinue = agent.spec.lifecycle.onTrigger(ctx);
      if (!shouldContinue) return;
    }

    // 并发控制
    agent.concurrency++;

    try {
      // 构建 AgentInput
      const agentCtx = this.buildAgentContext();
      const input = buildAgentInput(agent.spec.inputPolicy, agentCtx);

      // 发射开始事件
      this.deps.events.emit({
        type: 'distributed_agent.start',
        timestamp: Date.now(),
        agentId,
        data: { trigger: ctx },
      });

      // 生命周期钩子：onStart
      agent.spec.lifecycle?.onStart?.();

      const startTime = Date.now();

      // 执行
      let output: AgentOutput;
      if (agent.spec.execution.kind === 'code' && agent.handler) {
        output = await agent.handler(input);
      } else if (agent.spec.execution.kind === 'llm' && agent.engine) {
        output = await this.executeLLM(agent, input);
      } else if (agent.spec.execution.kind === 'hybrid' && agent.engine) {
        output = await this.executeHybrid(agent, input);
      } else {
        throw new Error(`Agent "${agentId}" has no valid execution handler`);
      }

      const durationMs = Date.now() - startTime;

      // 处理输出
      this.processOutput(agent, output, agentCtx);

      // 发射完成事件
      this.deps.events.emit({
        type: 'distributed_agent.complete',
        timestamp: Date.now(),
        agentId,
        data: { output, durationMs },
      });

      // 生命周期钩子：onComplete
      agent.spec.lifecycle?.onComplete?.(output);

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      this.deps.events.emit({
        type: 'distributed_agent.error',
        timestamp: Date.now(),
        agentId,
        data: { error: error.message },
      });

      // 生命周期钩子：onError
      agent.spec.lifecycle?.onError?.(error);

    } finally {
      agent.concurrency--;
    }
  }

  /**
   * 执行 LLM 模式
   */
  private async executeLLM(agent: RegisteredAgent, input: AgentInput): Promise<AgentOutput> {
    // LLM 模式通过 Engine 执行
    // 实际实现需要调用 engine.run() 并收集输出
    // 这里提供框架，具体实现由 Builder 集成时完成
    throw new Error('LLM execution requires Engine integration via Builder');
  }

  /**
   * 执行 Hybrid 模式
   */
  private async executeHybrid(agent: RegisteredAgent, input: AgentInput): Promise<AgentOutput> {
    const hybrid = agent.spec.execution as HybridExecution;

    // preProcess
    let processedInput = input;
    if (hybrid.preProcess) {
      processedInput = await hybrid.preProcess(input);
    }

    // LLM 执行
    let output: AgentOutput;
    if (agent.engine) {
      output = await this.executeLLM(agent, processedInput);
    } else {
      throw new Error('Hybrid execution requires Engine');
    }

    // postProcess
    if (hybrid.postProcess) {
      output = await hybrid.postProcess(output);
    }

    return output;
  }

  /**
   * 处理智能体输出
   */
  private processOutput(
    agent: RegisteredAgent,
    output: AgentOutput,
    ctx: AgentContext,
  ): void {
    const mode = agent.spec.outputPolicy.mode;

    switch (mode) {
      case 'intercept':
        if (output.kind === 'intercept') {
          handleIntercept(output, ctx);
        }
        break;

      case 'replace_context':
        if (output.kind === 'context') {
          // 入队，等 ContextEngine 在 assemble 前应用
          this.injectionQueue.enqueue({
            agentId: agent.spec.id,
            output: output as ContextOutput,
            mode: 'replace_context',
          });
        }
        break;

      case 'inject_context':
        if (output.kind === 'context') {
          // 入队，等 ContextEngine 在 assemble 前应用
          this.injectionQueue.enqueue({
            agentId: agent.spec.id,
            output: output as ContextOutput,
            mode: 'inject_context',
          });
        }
        break;

      case 'notify':
        if (output.kind === 'notify') {
          handleNotify(output, ctx);
        }
        break;
    }
  }

  /**
   * 构建 AgentContext（占位，实际由主 Agent 的上下文提供）
   */
  private buildAgentContext(): AgentContext {
    return {
      messages: [],
      runConfig: {
        systemPrompt: '',
        agentId: 'main',
        sessionId: 'main',
      },
      events: this.deps.events,
    };
  }
}

/**
 * 按优先级排序分布式智能体
 *
 * intercept (最高) > replace_context > inject_context > notify (最低)
 */
export function sortByPriority(
  agents: Array<{ id: string; mode: ResultInjectionMode }>,
): Array<{ id: string; mode: ResultInjectionMode }> {
  return [...agents].sort((a, b) => getPriority(a.mode) - getPriority(b.mode));
}
