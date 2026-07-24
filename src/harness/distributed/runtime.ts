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
import type { AgentEngineDeps } from '../../core/engine.js';
import { AgentEngine } from '../../core/engine.js';
import type { DistributedAgentSpec } from './spec.js';
import type { AgentInput, AgentOutput, InterceptOutput, ContextOutput, NotifyOutput, TriggerContext, AgentContext } from './types.js';
import type { ResultInjectionMode } from './output-policy.js';
import type { LLMExecution, HybridExecution } from './execution.js';
import { TriggerEngine, getPriority } from './trigger.js';
import { buildAgentInput } from './input-policy.js';
import {
  handleIntercept,
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

  // ── 智能体分流 ──
  /** intercept 模式的智能体（需要同步阻塞，在工具执行前判断） */
  private interceptAgents = new Map<string, RegisteredAgent>();
  /** 异步模式的智能体（replace_context / inject_context / notify，fire-and-forget） */
  private asyncAgents = new Map<string, RegisteredAgent>();

  /** 主 Agent 的上下文引用（由外部注入） */
  private mainAgentContext?: AgentContext;

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
   * 设置主 Agent 的上下文引用
   *
   * 由外部（Runner 或 Engine 循环）在每轮开始时调用，
   * 让分布式智能体能访问主 Agent 的消息和配置。
   */
  setMainAgentContext(ctx: AgentContext): void {
    this.mainAgentContext = ctx;
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
      agent.handler = spec.execution.handler;
    } else if (spec.execution.kind === 'llm' || spec.execution.kind === 'hybrid') {
      agent.engine = this.createEngine(spec);
    }

    this.agents.set(spec.id, agent);

    // 按 OutputPolicy.mode 分流
    if (spec.outputPolicy.mode === 'intercept') {
      this.interceptAgents.set(spec.id, agent);
    } else {
      this.asyncAgents.set(spec.id, agent);
    }

    // 注册 ConditionTrigger 的轮询评估（仅异步模式）
    if (spec.outputPolicy.mode !== 'intercept') {
      for (const trigger of spec.triggers) {
        if (trigger.type === 'condition' && typeof trigger.condition.evaluateOn === 'number') {
          this.triggerEngine.registerConditionPolling(trigger, (ctx) => {
            this.onTrigger(spec.id, ctx);
          });
        }
      }
    }

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
   * 工具执行前的同步拦截（intercept 模式）
   *
   * 由 Engine 的 beforeToolExecution 钩子调用。
   * Engine 只在 SecurityGuard 返回 riskUnknown 时才调用此方法，
   * 所以 intercept 智能体不需要触发器评估——直接执行。
   *
   * 触发器机制只用于异步智能体（replace_context / inject_context / notify），
   * intercept 智能体的触发由 Engine 的 riskUnknown 标记控制。
   */
  async beforeToolExecution(call: import('../../core/types.js').ToolCall): Promise<{ proceed: boolean; result?: unknown } | undefined> {
    for (const [id, agent] of this.interceptAgents) {
      const ctx: TriggerContext = {
        eventData: { toolCall: call },
        metrics: this.triggerEngine.getMetrics(),
      };

      // intercept 模式跳过触发器评估
      // 触发由 Engine 的 riskUnknown 标记控制，不在这里判断

      // 检查并发限制
      if (agent.spec.limits?.maxConcurrent &&
          agent.concurrency >= agent.spec.limits.maxConcurrent) {
        continue;
      }

      // 同步等待智能体执行
      const result = await this.onTrigger(id, ctx);
      if (result && !result.proceed) {
        return result;  // block 或 degrade
      }
    }
    return undefined;  // allow
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

    const deps: AgentEngineDeps = {
      model: this.deps.model,
      tools,
      executor: {
        // 当前设计：分布式智能体的 executor 是空壳，不支持工具执行。
        // 安全守卫等纯判断型智能体不需要工具。
        // 未来如果需要工具支持的分布式智能体，这里需要从 Builder 注入真实的 executor。
        execute: async () => ({ error: 'Distributed agent has no tool execution capability' }),
      },
      contextEngine: {
        info: { id: 'distributed-agent-context', name: 'distributed-agent-context', ownsCompaction: false },
        assemble: async (params) => {
          // 分布式智能体的 contextEngine：只做 Message → LLMMessage 转换，不做压缩/裁剪
          const messages = (params.messages ?? []).map((msg) => ({
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            ...(msg.toolCalls ? {
              tool_calls: msg.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              })),
            } : {}),
            ...(msg.toolResults ? {
              tool_call_id: msg.toolResults[0]?.toolCallId,
              content: JSON.stringify(msg.toolResults.map(tr => tr.result)),
            } : {}),
          }));
          return {
            messages,
            estimatedTokens: 0,
            systemPrompt: params.systemPrompt ?? '',
          };
        },
      },
      events: this.deps.events,
      security: new NoopSecurityGuard(),
      skipSecurityValidation: true,
      errorStrategy: this.deps.errorStrategy,
      observer: this.deps.observer,
      systemPrompt: llm.systemPrompt,
    };

    return new AgentEngine(deps);
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
    // 只评估异步模式的智能体（replace_context / inject_context / notify）
    // intercept 模式通过 beforeToolExecution 钩子同步调用
    for (const [agentId, agent] of this.asyncAgents) {
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
          // 达到并发上限，跳过
          continue;
        }

        this.onTrigger(agentId, ctx);
      }
    }
  }

  /**
   * 触发智能体执行
   *
   * @returns InterceptResult（仅 intercept 模式），其他模式返回 undefined
   */
  private async onTrigger(agentId: string, ctx: TriggerContext): Promise<import('./output-policy.js').InterceptResult | undefined> {
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
      const agentCtx = this.mainAgentContext ?? this.buildFallbackAgentContext();
      const input = buildAgentInput(agent.spec.inputPolicy, agentCtx, {
        recentToolCalls: agentCtx.recentToolCalls,
        tokenCount: agentCtx.tokenCount,
        agentEvents: agentCtx.agentEvents,
      });

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
      const interceptResult = this.processOutput(agent, output, agentCtx);

      // 发射完成事件
      this.deps.events.emit({
        type: 'distributed_agent.complete',
        timestamp: Date.now(),
        agentId,
        data: { output, durationMs },
      });

      // 生命周期钩子：onComplete
      agent.spec.lifecycle?.onComplete?.(output);

      return interceptResult;
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
   *
   * 调用 engine.run() 收集输出。
   */
  private async executeLLM(agent: RegisteredAgent, input: AgentInput): Promise<AgentOutput> {
    if (!agent.engine) {
      throw new Error('LLM execution requires Engine');
    }

    const llm = agent.spec.execution as LLMExecution;

    // 解析 model 覆盖：provider/model 格式 → 提取 model 名
    const modelOverride = llm.model ? parseModelName(llm.model) : undefined;

    // 将 AgentInput 转换为 messages 数组传给 Engine
    const messages: Message[] = [];
    const inputContent = JSON.stringify(input, null, 2);
    messages.push({
      role: 'user',
      content: inputContent,
      timestamp: Date.now(),
    });

    // 调用 Engine 的 run 方法
    let lastContent = '';
    for await (const event of agent.engine.run(messages, {
      systemPrompt: llm.systemPrompt,
      agentId: agent.spec.id,
      model: modelOverride,
    })) {
      if (event.type === 'turn.end' && event.data) {
        lastContent = (event.data.content as string) ?? '';
      }
    }

    return this.parseAgentOutput(lastContent, agent.spec.outputPolicy.mode);
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
    let output = await this.executeLLM(agent, processedInput);

    // postProcess
    if (hybrid.postProcess) {
      output = await hybrid.postProcess(output);
    }

    return output;
  }

  /**
   * 解析 LLM 输出为 AgentOutput
   *
   * 尝试从 LLM 的文本输出中提取 JSON 格式的 AgentOutput。
   * 如果解析失败，根据 mode 返回默认值。
   */
  private parseAgentOutput(content: string, mode: ResultInjectionMode): AgentOutput {
    const jsonStr = this.extractFirstJsonObject(content);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        const validated = this.validateAgentOutput(parsed, mode);
        if (validated) return validated;
      } catch {
        // JSON 解析失败，走兜底
      }
    }

    // 兜底：根据 mode 返回安全默认值
    // 解析失败默认放行，保证系统运行优先
    switch (mode) {
      case 'intercept':
        return {
          kind: 'intercept',
          decision: 'allow',
          reason: 'LLM output could not be parsed, defaulting to allow',
          confidence: 0.0,
        };
      case 'replace_context':
      case 'inject_context':
        return {
          kind: 'context',
          messages: [{ role: 'system', content }],
          compressed: false,
        };
      case 'notify':
        return {
          kind: 'notify',
          content,
          level: 'info',
        };
    }
  }

  /**
   * 验证解析结果是否为有效的 AgentOutput
   * 通过类型守卫确保结构正确，不做盲目断言
   */
  private validateAgentOutput(parsed: Record<string, unknown>, mode: ResultInjectionMode): AgentOutput | null {
    if (parsed.kind !== 'intercept' && parsed.kind !== 'context' && parsed.kind !== 'notify') {
      return null;
    }

    // 验证 kind 和 mode 匹配
    if (mode === 'intercept' && parsed.kind === 'intercept') {
      if (parsed.decision !== 'allow' && parsed.decision !== 'degrade' && parsed.decision !== 'block') return null;
      if (typeof parsed.reason !== 'string') return null;
      if (typeof parsed.confidence !== 'number') return null;
      return parsed as unknown as InterceptOutput;
    }

    if ((mode === 'replace_context' || mode === 'inject_context') && parsed.kind === 'context') {
      if (!Array.isArray(parsed.messages)) return null;
      return parsed as unknown as ContextOutput;
    }

    if (mode === 'notify' && parsed.kind === 'notify') {
      if (typeof parsed.content !== 'string') return null;
      if (parsed.level !== 'info' && parsed.level !== 'warning' && parsed.level !== 'error') return null;
      return parsed as unknown as NotifyOutput;
    }

    return null;
  }

  /**
   * 从文本中提取第一个完整的 JSON 对象
   * 用括号计数而非贪婪匹配，避免捕获错误内容
   */
  private extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\') {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }

    return null;
  }

  /**
   * 处理智能体输出
   */
  private processOutput(
    agent: RegisteredAgent,
    output: AgentOutput,
    ctx: AgentContext,
  ): import('./output-policy.js').InterceptResult | undefined {
    const mode = agent.spec.outputPolicy.mode;

    switch (mode) {
      case 'intercept':
        if (output.kind === 'intercept') {
          return handleIntercept(output, ctx);
        }
        return undefined;

      case 'replace_context':
        if (output.kind === 'context') {
          this.injectionQueue.enqueue({
            agentId: agent.spec.id,
            output: output as ContextOutput,
            mode: 'replace_context',
          });
        }
        break;

      case 'inject_context':
        if (output.kind === 'context') {
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
        return undefined;
    }
    return undefined;
  }

  /**
   * 构建兜底的 AgentContext（当主 Agent 上下文未注入时）
   */
  private buildFallbackAgentContext(): AgentContext {
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

/**
 * 解析 provider/model 格式，提取 model 名
 *
 * - 'xiaomi-coding/mimo-v2.5-pro' → 'mimo-v2.5-pro'
 * - 'gpt-5.5' → 'gpt-5.5'（无 provider 前缀，原样返回）
 */
export function parseModelName(model: string): string {
  const slashIdx = model.lastIndexOf('/');
  return slashIdx >= 0 ? model.slice(slashIdx + 1) : model;
}
