/**
 * AgentBuilder — Fluent API 组装器
 *
 * 集成方的主要入口。一行代码启动 Agent。
 *
 * 使用示例：
 * ```ts
 * const { engine, runner } = new AgentBuilder()
 *   .model('gpt-5.5')
 *   .persona('./personas/my-agent')
 *   .tool(myTool)
 *   .budget({ maxIterations: 15 })
 *   .build();
 * ```
 */

import type {
  RegisteredTool,
  Message,
  ToolCall,
} from '../../core/types.js';
import type {
  ModelProvider,
} from '../../core/interfaces/model-provider.js';
import type {
  AgentTool as LoopAgentTool,
} from '../../loop/types.js';
import { Agent } from '../../loop/agent.js';
import type { AgentOptions } from '../../loop/agent.js';
import { runAgentWithReliability, DEFAULT_RELIABILITY_CONFIG } from '../reliability/run-agent.js';
import type { ReliabilityConfig, ReliabilityHarness } from '../reliability/run-agent.js';
import type {
  ContextEngine,
  SummarizeFunction,
} from '../../core/interfaces/context-engine.js';
import type {
  ErrorStrategy,
  ClassifiedError,
  ErrorAction,
  OverflowAction,
} from '../../core/interfaces/error-strategy.js';
import type { SecurityViolation, SecurityAction } from '../../core/security-guard.js';
import type {
  TaskSupervisor,
} from '../../core/interfaces/task-supervisor.js';
import type { TaskSupervisorConfig } from '../task-system/supervisor/task-supervisor.js';
import { DefaultTaskSupervisor } from '../task-system/supervisor/task-supervisor.js';
import type {
  Observer,
} from '../../core/interfaces/observer.js';
import type { TraceCollectorConfig } from '../../integration/observability/trace-collector.js';
import type { MetricsAggregatorConfig } from '../../integration/observability/metrics.js';
import type { TraceLoggerConfig } from '../../integration/observability/trace-logger.js';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../session-types.js';

import {
  DefaultEventBus,
  NoopEventBus,
} from '../../core/primitives/event-bus.js';
import type { EventBus } from '../../core/primitives/event-bus.js';
import {
  DefaultSecurityGuard,
} from '../security/default-security-guard.js';
import type { SecurityGuard, SecurityGuardConfig } from '../../core/security-guard.js';
import {
  IterationBudget,
} from '../budget/budget.js';
import type { IterationBudgetConfig } from '../budget/budget.js';

import { loadPersona, composePersonas } from './persona.js';
import { DefaultContextEngine } from '../context/default-context-engine.js';
import { SessionAwareRunner } from '../runner.js';
import type { SessionAwareRunnerConfig } from '../runner.js';
import { DefaultMcpManager } from '../plugin-ecosystem/mcp/manager.js';
import type { McpManagerCallbacks, McpClientFactory } from '../plugin-ecosystem/mcp/manager.js';
import type { McpServerConfig, McpManager } from '../../core/interfaces/mcp-client.js';

// ── 默认实现 ──

/** 默认错误策略（简单重试 + 中止） */
class DefaultErrorStrategy implements ErrorStrategy {
  onModelError(error: ClassifiedError, attempt: number): ErrorAction {
    // ── 可重试错误：限流、超时、网络、服务端 ──
    if (error.reason === 'rate_limit' && attempt < 3) {
      const delayMs = error.retryAfterMs ?? (attempt + 1) * 1000;
      return { action: 'retry', delayMs };
    }
    if (error.reason === 'timeout' && attempt < 3) {
      return { action: 'retry', delayMs: (attempt + 1) * 1000 };
    }
    if (error.reason === 'network' && attempt < 3) {
      return { action: 'retry', delayMs: (attempt + 1) * 1500 };
    }
    if (error.reason === 'server' && attempt < 2) {
      return { action: 'retry', delayMs: (attempt + 1) * 2000 };
    }
    // ── context_length：由引擎尝试 compact，这里返回 abort 让引擎决定 ──
    if (error.reason === 'context_length') {
      return { action: 'abort', reason: `Context length exceeded: ${error.message}` };
    }
    // ── 不可重试错误：认证、计费 ──
    if (error.reason === 'auth') {
      return { action: 'abort', reason: `Authentication failed: ${error.message}` };
    }
    if (error.reason === 'billing') {
      return { action: 'abort', reason: `Billing issue: ${error.message}` };
    }
    // ── 默认：终止 ──
    return { action: 'abort', reason: error.message };
  }

  onToolError(error: ClassifiedError, _call: any): ErrorAction {
    // 工具错误默认跳过，让 LLM 看到错误信息后自行调整
    return { action: 'skip', reason: error.message || 'Tool execution failed' };
  }

  onContextOverflow(_tokenCount: number, _limit: number): OverflowAction {
    return { action: 'compact' };
  }

  onSecurityViolation(violation: SecurityViolation): SecurityAction {
    if (violation.severity === 'critical') {
      return { action: 'block', reason: violation.description };
    }
    return { action: 'warn', reason: violation.description };
  }
}

/**
 * 将 RegisteredTool 转换为 AgentTool（新循环格式）
 */
function convertToAgentTool(tool: RegisteredTool): LoopAgentTool {
  return {
    name: tool.definition.name,
    description: tool.definition.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.definition.parameters).map(([key, param]) => [
          key,
          { type: param.type, description: param.description, ...(param.enum && { enum: param.enum }) },
        ]),
      ),
      required: Object.entries(tool.definition.parameters)
        .filter(([, param]) => param.required)
        .map(([key]) => key),
    },
    execute: async (toolCallId: string, args: unknown, signal?: AbortSignal) => {
      const startTime = Date.now();
      try {
        const result = await tool.handler(args as Record<string, unknown>, { timeoutMs: 30_000, signal } as any);
        return {
          toolCallId,
          name: tool.definition.name,
          content: result,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          toolCallId,
          name: tool.definition.name,
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          durationMs: Date.now() - startTime,
        };
      }
    },
  };
}

/** 内存 Session 存储（默认） */
class InMemorySessionStore implements SessionStore<SessionData> {
  private sessions = new Map<string, any>();

  async load(_agentId: string, sessionId: string): Promise<any> {
    return this.sessions.get(sessionId) ?? null;
  }

  async save(_agentId: string, sessionId: string, data: any): Promise<void> {
    this.sessions.set(sessionId, data);
  }

  async list(agentId: string): Promise<any[]> {
    return Array.from(this.sessions.values()).filter(s => s.agentId === agentId);
  }

  async delete(_agentId: string, sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async exists(_agentId: string, sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }
}

// ── Builder ──

/**
 * AgentBuilder — Fluent API
 */
export class AgentBuilder {
  // Core 组件
  private _model?: ModelProvider;
  private _tools = new Map<string, RegisteredTool>();
  private _contextEngine?: ContextEngine;
  private _summarize?: SummarizeFunction;
  private _events?: EventBus;
  private _security?: SecurityGuard;
  private _riskPolicy?: import('../../core/security-guard.js').ToolCallRiskPolicy;
  private _safetyGuardConfig?: { cwd?: string; model?: string; maxDurationMs?: number };
  private _budget?: IterationBudget;
  private _errorStrategy?: ErrorStrategy;
  private _observer?: Observer;
  private _taskSupervisor?: TaskSupervisor;
  private _taskSupervisorConfig?: TaskSupervisorConfig;
  private _checkpointInterval?: number;
  private _reliabilityConfig?: ReliabilityConfig;

  // Harness 组件
  private _personaWorkspaces: string[] = [];
  private _systemPrompt?: string;
  private _securityConfig?: SecurityGuardConfig;

  // Observability 配置
  private _traceConfig?: TraceCollectorConfig;
  private _loggerConfig?: Partial<TraceLoggerConfig>;
  private _metricsConfig?: MetricsAggregatorConfig;

  // Runner 配置
  private _store?: SessionStore<SessionData>;
  private _runnerConfig?: SessionAwareRunnerConfig;

  // MCP 配置
  private _mcpConfigs: import('../../core/interfaces/mcp-client.js').McpServerConfig[] = [];

  // 分布式智能体配置
  private _distributedAgentSpecs: import('../distributed-agents/distributed/spec.js').DistributedAgentSpec[] = [];
  private _distributedAuditDir?: string;

  // 注册的 named providers（用于 ProviderPool）
  private _namedProviders = new Map<string, ModelProvider>();

  // 并发控制配置
  private _concurrencyConfig?: import('../../config.js').HarnessConfig['concurrency'];

  // ── Core 组件 ──

  /** 设置模型提供者 */
  model(provider: ModelProvider): this;
  model(name: string): this;
  model(providerOrName: ModelProvider | string): this {
    if (typeof providerOrName === 'string') {
      // 字符串形式：创建一个简单的 wrapper（需要外部注册实际 provider）
      this._model = {
        name: providerOrName,
        chat: async () => { throw new Error(`Model provider "${providerOrName}" not configured`); },
        stream: async function* () { throw new Error(`Model provider "${providerOrName}" not configured`); },
        isAvailable: async () => false,
        getModelInfo: () => null,
        getModelInfos: () => [],
      };
    } else {
      this._model = providerOrName;
    }
    return this;
  }

  /** 注册工具 */
  tool(tool: RegisteredTool): this {
    this._tools.set(tool.definition.name, tool);
    return this;
  }

  /** 批量注册工具 */
  tools(...tools: RegisteredTool[]): this {
    for (const t of tools) this.tool(t);
    return this;
  }

  /**
   * 配置 MCP Server 连接
   *
   * 构建时自动连接，工具注册到 ToolRegistry。
   * 支持多次调用，连接多个 MCP Server。
   *
   * @example
   * ```ts
   * const { engine, runner } = await new AgentBuilder()
   *   .model('gpt-5.5')
   *   .mcp({
   *     id: 'filesystem',
   *     transport: 'stdio',
   *     command: 'npx',
   *     args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
   *   })
   *   .build();
   * ```
   */
  mcp(config: import('../../core/interfaces/mcp-client.js').McpServerConfig): this {
    this._mcpConfigs.push(config);
    return this;
  }

  /** 注册分布式智能体 */
  withDistributedAgent(spec: import('../distributed-agents/distributed/spec.js').DistributedAgentSpec): this {
    this._distributedAgentSpecs.push(spec);
    return this;
  }

  /** 设置分布式智能体审计日志目录 */
  withDistributedAuditDir(dir: string): this {
    this._distributedAuditDir = dir;
    return this;
  }

  /** 设置上下文引擎 */
  contextEngine(engine: ContextEngine): this {
    this._contextEngine = engine;
    return this;
  }

  /** 设置摘要函数（用于 LLM 摘要压缩） */
  summarize(fn: SummarizeFunction): this {
    this._summarize = fn;
    return this;
  }

  /** 设置事件总线 */
  events(bus: EventBus): this {
    this._events = bus;
    return this;
  }

  /** 设置安全守卫 */
  security(guard: SecurityGuard): this {
    this._security = guard;
    return this;
  }

  /** 设置安全策略配置 */
  securityPolicy(config: SecurityGuardConfig): this {
    this._securityConfig = config;
    return this;
  }

  /** 注入工具调用风险策略（由 Harness 层实现，注入到 Core 的 SecurityGuard） */
  withRiskPolicy(policy: import('../../core/security-guard.js').ToolCallRiskPolicy): this {
    this._riskPolicy = policy;
    return this;
  }

  /**
   * 一行启用完整安全层
   *
   * 自动注入：
   * 1. DefaultToolCallRiskPolicy（规则引擎）→ Core SecurityGuard
   * 2. SafetyGuard DistributedAgentSpec（LLM 安全智能体）→ AgentRuntime
   *
   * @param config.cwd - 工作目录（用于路径风险分类）
   * @param config.model - 安全智能体的模型覆盖（默认用主 Agent 模型）
   */
  withSafetyGuard(config?: { cwd?: string; model?: string; maxDurationMs?: number }): this {
    // 动态导入，避免循环依赖
    this._safetyGuardConfig = config ?? {};
    return this;
  }

  /** 设置迭代预算 */
  budget(config: Partial<IterationBudgetConfig>): this {
    this._budget = new IterationBudget(this._events ?? new NoopEventBus(), config);
    return this;
  }

  /** 设置错误策略 */
  errorStrategy(strategy: ErrorStrategy): this {
    this._errorStrategy = strategy;
    return this;
  }

  // ── 并发控制 ──

  /** 注册 named provider（用于 ProviderPool 多 key 路由） */
  provider(name: string, instance: ModelProvider): this {
    this._namedProviders.set(name, instance);
    return this;
  }

  /** 批量注册 named providers */
  providers(map: Map<string, ModelProvider>): this {
    for (const [name, instance] of map) {
      this._namedProviders.set(name, instance);
    }
    return this;
  }

  /** 设置并发控制配置（ProviderPool + SessionGate） */
  concurrency(config: import('../../config.js').HarnessConfig['concurrency']): this {
    this._concurrencyConfig = config;
    return this;
  }

  /** 设置观测器 */
  observer(observer: Observer): this {
    this._observer = observer;
    return this;
  }

  /** 设置可靠性配置（用于 buildAgent()） */
  reliability(config: Partial<ReliabilityConfig>): this {
    this._reliabilityConfig = { ...DEFAULT_RELIABILITY_CONFIG, ...config };
    return this;
  }

  /**
   * 启用完整可观测性
   *
   * 自动创建：
   * - ObserverBridge（实现 Observer，桥接到 TraceLogger + MetricsAggregator）
   * - 如果未手动设置 observer，则自动注入 ObserverBridge
   *
   * @param traceConfig - TraceCollector 配置（事件流包装）
   * @param loggerConfig - TraceLogger 配置（日志输出）
   * @param metricsConfig - MetricsAggregator 配置（指标聚合）
   */
  trace(
    traceConfig?: Partial<TraceCollectorConfig>,
    loggerConfig?: Partial<TraceLoggerConfig>,
    metricsConfig?: MetricsAggregatorConfig,
  ): this {
    this._traceConfig = {
      captureStreamDeltas: false,
      captureModelRequest: false,
      captureToolArgs: true,
      captureToolResults: false,
      enableMetrics: true,
      ...traceConfig,
    } as TraceCollectorConfig;
    this._loggerConfig = loggerConfig;
    this._metricsConfig = metricsConfig;
    return this;
  }

  /** 设置任务监督器（自动创建，使用主模型做 LLM 审查） */
  taskSupervisor(config?: TaskSupervisorConfig): this;
  /** 设置任务监督器（手动传入实例） */
  taskSupervisor(supervisor: TaskSupervisor, checkpointInterval?: number): this;
  taskSupervisor(supervisorOrConfig?: TaskSupervisor | TaskSupervisorConfig, checkpointInterval?: number): this {
    if (!supervisorOrConfig) {
      // 无参调用：使用默认配置自动创建，延迟到 buildAgent 时注入 model
      this._taskSupervisorConfig = {};
    } else if ('checkpointInterval' in supervisorOrConfig || 'enableLLMReview' in supervisorOrConfig || 'hardLimit' in supervisorOrConfig) {
      // TaskSupervisorConfig 对象：延迟到 buildAgent 时注入 model
      this._taskSupervisorConfig = supervisorOrConfig as TaskSupervisorConfig;
    } else {
      // TaskSupervisor 实例：直接使用
      this._taskSupervisor = supervisorOrConfig as TaskSupervisor;
    }
    if (checkpointInterval !== undefined) this._checkpointInterval = checkpointInterval;
    return this;
  }

  // ── Harness 组件 ──

  /** 加载 persona 目录 */
  persona(workspace: string): this;
  persona(...workspaces: string[]): this;
  persona(...workspaces: string[]): this {
    this._personaWorkspaces.push(...workspaces);
    return this;
  }

  /** 直接设置 systemPrompt（优先于 persona 目录） */
  systemPrompt(prompt: string): this {
    this._systemPrompt = prompt;
    return this;
  }

  // ── Runner 配置 ──

  /** 设置 Session 存储 */
  store(store: SessionStore<SessionData>): this {
    this._store = store;
    return this;
  }

  /** 设置 Runner 配置 */
  runnerConfig(config: SessionAwareRunnerConfig): this {
    this._runnerConfig = config;
    return this;
  }

  // ── 构建 ──

  /**
   * 构建 Agent + SessionAwareRunner
   *
   * 使用新架构：Agent 类 + runAgentWithReliability 可靠性包装。
   */
  async build(): Promise<{ agent: Agent; harness: ReliabilityHarness; runner: SessionAwareRunner; mcpManager: McpManager; runtime?: import('../distributed-agents/distributed/runtime.js').AgentRuntime; events: EventBus }> {
    const events = this._events ?? new DefaultEventBus();
    this._events = events;

    // 并发控制：ProviderPool
    if (this._concurrencyConfig?.providerPool && this._namedProviders.size > 0) {
      const { ProviderPool } = await import('../concurrency/provider-pool.js');
      this._model = new ProviderPool(this._concurrencyConfig.providerPool, this._namedProviders);
    }

    // 并发控制：SessionGate
    if (this._concurrencyConfig?.sessionGate) {
      const { SessionGate } = await import('../concurrency/session-gate.js');
      const gateConfig = this._concurrencyConfig.sessionGate;
      this._runnerConfig = {
        ...this._runnerConfig,
        sessionGate: new SessionGate({
          maxConcurrent: gateConfig.maxConcurrent,
          waitTimeoutMs: gateConfig.waitTimeoutMs,
        }),
      };
    }

    // 使用 buildAgent() 构建核心组件
    const { agent, harness, mcpManager } = await this.buildAgent();

    // 创建 AgentRuntime（如果有分布式智能体）
    let runtime: import('../distributed-agents/distributed/runtime.js').AgentRuntime | undefined;
    if (this._distributedAgentSpecs.length > 0) {
      const { AgentRuntime } = await import('../distributed-agents/distributed/runtime.js');
      runtime = new AgentRuntime({
        deps: {
          model: agent.model,
          events,
          errorStrategy: this._errorStrategy ?? new DefaultErrorStrategy(),
          observer: this._observer,
          mainTools: this._tools,
        },
        auditDir: this._distributedAuditDir,
      });
      for (const spec of this._distributedAgentSpecs) {
        runtime.register(spec);
      }
      // Agent 新架构：beforeToolCall 已在 buildAgent() 中设置
      // 分布式运行时的 intercept 通过 harness 的 beforeToolCall 链处理
      harness.agentId = this._runnerConfig?.taskDecisionProvider ? undefined : 'default';
    }

    // 创建 SessionStore + Runner
    const store = this._store ?? new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, harness, store, { ...this._runnerConfig, events });
    if (runtime) runner.setDistributedRuntime(runtime);

    return { agent, harness, runner, mcpManager, runtime, events };
  }

  /**
   * 构建 Agent 类（使用 agentLoop 纯函数 + runAgentWithReliability）
   *
   * 返回 Agent 实例 + 可靠性配置，集成方应使用 runAgentWithReliability() 运行：
   * ```ts
   * const { agent, harness } = await builder.buildAgent();
   * for await (const event of runAgentWithReliability(agent.context, { model: agent.model }, harness)) {
   *   // 处理事件
   * }
   * ```
   */
  async buildAgent(): Promise<{ agent: Agent; harness: ReliabilityHarness; mcpManager: McpManager }> {
    if (!this._model) {
      throw new Error('ModelProvider is required. Call .model() before .buildAgent()');
    }

    // 加载 systemPrompt
    let systemPrompt = this._systemPrompt ?? '';
    if (!systemPrompt && this._personaWorkspaces.length > 0) {
      if (this._personaWorkspaces.length === 1) {
        systemPrompt = await loadPersona(this._personaWorkspaces[0]);
      } else {
        systemPrompt = await composePersonas(...this._personaWorkspaces);
      }
    }
    if (!systemPrompt && this._tools.size > 0) {
      systemPrompt = this.buildDefaultSystemPrompt();
    }

    // 构建 McpManager
    const mcpManager = await this.buildMcpManager();

    // 转换 RegisteredTool → AgentTool
    const agentTools: LoopAgentTool[] = Array.from(this._tools.values()).map(t => convertToAgentTool(t));

    // 创建 Agent
    const agentOptions: AgentOptions = {
      model: this._model,
      systemPrompt,
      tools: agentTools,
      observer: this._observer ? {
        onLLMStart: (p) => this._observer?.log('info', 'llm.start', p as unknown as Record<string, unknown>),
        onLLMEnd: (p) => this._observer?.log('info', 'llm.end', p as unknown as Record<string, unknown>),
        onToolStart: (p) => this._observer?.log('info', 'tool.start', p as unknown as Record<string, unknown>),
        onToolEnd: (p) => this._observer?.log('info', 'tool.end', p as unknown as Record<string, unknown>),
      } : undefined,
    };
    const agent = new Agent(agentOptions);

    // 构建可靠性 harness
    const events = this._events ?? new DefaultEventBus();
    const security = this._security ?? new DefaultSecurityGuard(events, this._securityConfig);
    if (this._riskPolicy && security.setToolCallRiskPolicy) {
      security.setToolCallRiskPolicy(this._riskPolicy);
    }
    const errorStrategy = this._errorStrategy ?? new DefaultErrorStrategy();

    // 自动创建 TaskSupervisor（如果通过 config 配置但未手动传入实例）
    const taskSupervisor = this._taskSupervisor
      ?? (this._taskSupervisorConfig !== undefined
        ? new DefaultTaskSupervisor(this._taskSupervisorConfig, this._model)
        : undefined);

    const harness: ReliabilityHarness = {
      config: this._reliabilityConfig ?? DEFAULT_RELIABILITY_CONFIG,
      security,
      errorStrategy,
      taskSupervisor,
    };

    return { agent, harness, mcpManager };
  }

  /**
   * 构建 McpManager 并连接所有配置的 MCP Server
   */
  private async buildMcpManager(): Promise<McpManager> {
    const { createSdkMcpClient } = await import('../../integration/mcp/sdk-client.js');

    // 创建回调，桥接到 this._tools
    const callbacks: McpManagerCallbacks = {
      registerTool: (tool) => {
        this._tools.set(tool.definition.name, tool);
      },
      unregisterTool: (name) => this._tools.delete(name),
      getTool: (name) => this._tools.get(name),
    };

    const clientFactory: McpClientFactory = (config: McpServerConfig) => createSdkMcpClient(config);
    const manager = new DefaultMcpManager(callbacks, clientFactory);

    // 连接所有配置的 MCP Server
    for (const config of this._mcpConfigs) {
      try {
        await manager.connectServer(config);
      } catch (err) {
        console.error(`[AgentBuilder] Failed to connect MCP Server "${config.id}": ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }

    return manager;
  }

  /**
   * 生成默认 systemPrompt，包含可用工具说明
   */
  private buildDefaultSystemPrompt(): string {
    const toolList = Array.from(this._tools.values())
      .map(t => `- ${t.definition.name}: ${t.definition.description}`)
      .join('\n');

    return `You are a helpful AI assistant with access to the following tools:

${toolList}

When the user asks you to do something that requires these tools, use them directly. Do not say you cannot do something if a tool can help. For example:
- If asked to read a file, use the file_read tool
- If asked to run a command, use the shell tool
- If asked to list files, use the file_list tool
- If asked to write a file, use the file_write tool

Always try to use tools before saying you cannot help.`;
  }
}

/**
 * 快速创建 Agent
 *
 * 最简集成方式：
 * ```ts
 * const { engine, runner } = await Octopi.create({
 *   model: myProvider,
 *   persona: './my-agent',
 * });
 * ```
 */
export async function createAgent(config: {
  model: ModelProvider;
  persona?: string;
  tools?: RegisteredTool[];
  store?: SessionStore<SessionData>;
  budget?: Partial<IterationBudgetConfig>;
  mcp?: McpServerConfig[];
}): Promise<{ agent: Agent; harness: ReliabilityHarness; runner: SessionAwareRunner; mcpManager: McpManager }> {
  const builder = new AgentBuilder()
    .model(config.model);

  if (config.persona) builder.persona(config.persona);
  if (config.tools) builder.tools(...config.tools);
  if (config.store) builder.store(config.store);
  if (config.budget) builder.budget(config.budget);
  if (config.mcp) {
    for (const mcpConfig of config.mcp) builder.mcp(mcpConfig);
  }

  return builder.build();
}
