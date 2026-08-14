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
} from '../core/types.js';
import type {
  ModelProvider,
} from '../core/interfaces/model-provider.js';
import type {
  ToolExecutor,
  ExecutionContext,
} from '../core/interfaces/tool-executor.js';
import type {
  ContextEngine,
  SummarizeFunction,
} from '../core/interfaces/context-engine.js';
import type {
  ErrorStrategy,
  ClassifiedError,
  SecurityViolation,
  ErrorAction,
  OverflowAction,
  SecurityAction,
} from '../core/interfaces/error-strategy.js';
import type {
  TaskSupervisor,
} from '../core/interfaces/task-supervisor.js';
import type { TaskSupervisorConfig } from './supervisor/task-supervisor.js';
import { DefaultTaskSupervisor } from './supervisor/task-supervisor.js';
import type {
  Observer,
} from '../core/interfaces/observer.js';
import type { TraceCollectorConfig } from '../integration/observability/trace-collector.js';
import type { MetricsAggregatorConfig } from '../integration/observability/metrics.js';
import type { TraceLoggerConfig } from '../integration/observability/trace-logger.js';
import type {
  SessionStore,
} from '../core/interfaces/session-store.js';
import {
  AgentEngine,
} from '../core/engine.js';
import type { AgentEngineDeps, RunConfig } from '../core/engine.js';
import {
  DefaultEventBus,
  NoopEventBus,
} from '../core/event-bus.js';
import type { EventBus } from '../core/event-bus.js';
import {
  DefaultSecurityGuard,
} from '../core/security-guard.js';
import type { SecurityGuard, SecurityGuardConfig } from '../core/security-guard.js';
import {
  IterationBudget,
} from '../core/budget.js';
import type { IterationBudgetConfig } from '../core/budget.js';

import { loadPersona, composePersonas } from './persona/loader.js';
import { DefaultContextEngine } from './context/default-context-engine.js';
import { SessionAwareRunner } from './runner.js';
import type { SessionAwareRunnerConfig } from './runner.js';
import { DefaultMcpManager } from './mcp/manager.js';
import type { McpManagerCallbacks, McpClientFactory } from './mcp/manager.js';
import type { McpServerConfig, McpManager } from '../core/interfaces/mcp-client.js';

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

/** 默认工具执行器（直接调用 handler） */
class DefaultToolExecutor implements ToolExecutor {
  private tools: Map<string, RegisteredTool>;

  constructor(tools: Map<string, RegisteredTool>) {
    this.tools = tools;
  }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<unknown> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      throw new Error(`Tool "${call.name}" not found`);
    }
    return tool.handler(call.arguments, ctx as any);
  }
}

/** 内存 Session 存储（默认） */
class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, any>();

  async load(sessionId: string): Promise<any> {
    return this.sessions.get(sessionId) ?? null;
  }

  async save(sessionId: string, data: any): Promise<void> {
    this.sessions.set(sessionId, data);
  }

  async list(_agentId: string): Promise<any[]> {
    return Array.from(this.sessions.values());
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async exists(sessionId: string): Promise<boolean> {
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
  private _executor?: ToolExecutor;
  private _contextEngine?: ContextEngine;
  private _summarize?: SummarizeFunction;
  private _events?: EventBus;
  private _security?: SecurityGuard;
  private _riskPolicy?: import('../core/security-guard.js').ToolCallRiskPolicy;
  private _safetyGuardConfig?: { cwd?: string; model?: string; maxDurationMs?: number };
  private _budget?: IterationBudget;
  private _errorStrategy?: ErrorStrategy;
  private _observer?: Observer;
  private _taskSupervisor?: TaskSupervisor;
  private _taskSupervisorConfig?: TaskSupervisorConfig;
  private _checkpointInterval?: number;

  // Harness 组件
  private _personaWorkspaces: string[] = [];
  private _systemPrompt?: string;
  private _securityConfig?: SecurityGuardConfig;

  // Observability 配置
  private _traceConfig?: TraceCollectorConfig;
  private _loggerConfig?: Partial<TraceLoggerConfig>;
  private _metricsConfig?: MetricsAggregatorConfig;

  // Runner 配置
  private _store?: SessionStore;
  private _runnerConfig?: SessionAwareRunnerConfig;

  // MCP 配置
  private _mcpConfigs: import('../core/interfaces/mcp-client.js').McpServerConfig[] = [];

  // 分布式智能体配置
  private _distributedAgentSpecs: import('./distributed/spec.js').DistributedAgentSpec[] = [];
  private _distributedAuditDir?: string;

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
  mcp(config: import('../core/interfaces/mcp-client.js').McpServerConfig): this {
    this._mcpConfigs.push(config);
    return this;
  }

  /** 注册分布式智能体 */
  withDistributedAgent(spec: import('./distributed/spec.js').DistributedAgentSpec): this {
    this._distributedAgentSpecs.push(spec);
    return this;
  }

  /** 设置分布式智能体审计日志目录 */
  withDistributedAuditDir(dir: string): this {
    this._distributedAuditDir = dir;
    return this;
  }

  /** 设置工具执行器 */
  executor(executor: ToolExecutor): this {
    this._executor = executor;
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
  withRiskPolicy(policy: import('../core/security-guard.js').ToolCallRiskPolicy): this {
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

  /** 设置观测器 */
  observer(observer: Observer): this {
    this._observer = observer;
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
      // 无参调用：使用默认配置自动创建，延迟到 buildEngine 时注入 model
      this._taskSupervisorConfig = {};
    } else if ('checkpointInterval' in supervisorOrConfig || 'enableLLMReview' in supervisorOrConfig || 'hardLimit' in supervisorOrConfig) {
      // TaskSupervisorConfig 对象：延迟到 buildEngine 时注入 model
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
  store(store: SessionStore): this {
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
   * 构建 AgentEngine + SessionAwareRunner
   */
  async build(): Promise<{ engine: AgentEngine; runner: SessionAwareRunner; mcpManager: McpManager; runtime?: import('./distributed/runtime.js').AgentRuntime }> {
    // 统一创建 events 实例，确保 engine、runner、runtime 共享同一个 EventBus
    const events = this._events ?? new DefaultEventBus();
    this._events = events;  // 注入到 builder，让 buildEngine() 也使用同一个

    const engine = await this.buildEngine();
    const store = this._store ?? new InMemorySessionStore();
    const runner = new SessionAwareRunner(engine, store, { ...this._runnerConfig, events });

    // 创建 McpManager
    const mcpManager = await this.buildMcpManager();

    // 风险策略（确定性规则引擎）独立于安全守卫（LLM），始终注入
    if (!this._riskPolicy) {
      const { DefaultToolCallRiskPolicy } = await import('./security/default-risk-policy.js');
      const cwd = this._safetyGuardConfig?.cwd;
      this._riskPolicy = new DefaultToolCallRiskPolicy({ cwd });
    }

    // 如果启用了安全守卫，注册安全守卫 Spec（LLM 语义判断层）
    if (this._safetyGuardConfig) {
      const { buildSafetyGuardSpec } = await import('./security/safety-agent-spec.js');
      const alreadyRegistered = this._distributedAgentSpecs.some(s => s.id === 'safety-guard');
      if (!alreadyRegistered) {
        this._distributedAgentSpecs.push(buildSafetyGuardSpec(this._safetyGuardConfig.model, this._safetyGuardConfig.maxDurationMs));
      }
    }

    // 创建 AgentRuntime（如果有分布式智能体）
    let runtime: import('./distributed/runtime.js').AgentRuntime | undefined;
    if (this._distributedAgentSpecs.length > 0) {
      const { AgentRuntime } = await import('./distributed/runtime.js');
      runtime = new AgentRuntime({
        deps: {
          model: this._model!,
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
      // 将 runtime 的 intercept 拦截钩子连到 engine
      engine.beforeToolExecution = (call) => runtime!.beforeToolExecution(call);
      runner.setDistributedRuntime(runtime);
    }

    return { engine, runner, mcpManager, runtime };
  }

  /**
   * 只构建 AgentEngine（无 Session 管理）
   *
   * 适用于：
   * - 单次调用（不需要 Session）
   * - 批处理
   * - 测试
   */
  async buildEngine(): Promise<AgentEngine> {
    // 验证必需组件
    if (!this._model) {
      throw new Error('ModelProvider is required. Call .model() before .build()');
    }

    // 加载 systemPrompt：直接设置优先于 persona 目录
    let systemPrompt = this._systemPrompt ?? '';
    if (!systemPrompt && this._personaWorkspaces.length > 0) {
      if (this._personaWorkspaces.length === 1) {
        systemPrompt = await loadPersona(this._personaWorkspaces[0]);
      } else {
        systemPrompt = await composePersonas(...this._personaWorkspaces);
      }
    }

    // 如果有工具但没有 systemPrompt，自动生成工具说明
    if (!systemPrompt && this._tools.size > 0) {
      systemPrompt = this.buildDefaultSystemPrompt();
    }

    // 创建默认组件
    const events = this._events ?? new DefaultEventBus();
    const security = this._security ?? new DefaultSecurityGuard(events, this._securityConfig);

    // 注入风险策略（如果有）
    if (this._riskPolicy && security.setToolCallRiskPolicy) {
      security.setToolCallRiskPolicy(this._riskPolicy);
    }
    const errorStrategy = this._errorStrategy ?? new DefaultErrorStrategy();
    const executor = this._executor ?? new DefaultToolExecutor(this._tools);

    // 创建上下文引擎
    const contextEngine = this._contextEngine ?? new DefaultContextEngine();

    // 自动创建 TaskSupervisor（如果通过 config 配置但未手动传入实例）
    const taskSupervisor = this._taskSupervisor
      ?? (this._taskSupervisorConfig !== undefined
        ? new DefaultTaskSupervisor(this._taskSupervisorConfig, this._model)
        : undefined);

    // 当有 TaskSupervisor 时，放宽 IterationBudget 的 wall-clock 限制
    // 让 TaskSupervisor 成为主要的智能控制，IterationBudget 只做安全兜底
    let budget = this._budget;
    if (!budget && taskSupervisor) {
      // 如果没有手动设置 budget 但有 TaskSupervisor，创建一个宽松的默认 budget
      budget = new IterationBudget(events, {
        maxWallClockMs: 3_600_000, // 1 小时（TaskSupervisor 会在此之前介入）
      });
    } else if (!budget) {
      budget = new IterationBudget(events);
    }

    // 自动创建 ObserverBridge（如果配置了 trace 但未手动设置 observer）
    let observer = this._observer;
    if (!observer && this._traceConfig) {
      const { ObserverBridge } = await import('../integration/observability/observer-bridge.js');
      observer = new ObserverBridge({
        logger: {
          level: 4, // TraceLevel.DEBUG
          outputDir: this._traceConfig.outputDir,
          ...this._loggerConfig,
        },
        metrics: this._metricsConfig,
      });
    }

    // 注入 systemPrompt 到引擎的运行时配置
    // AgentEngine 本身不存储 systemPrompt，由调用方在 run() 时传入
    const deps: AgentEngineDeps = {
      model: this._model,
      tools: this._tools,
      executor,
      contextEngine,
      events,
      security,
      budget,
      errorStrategy,
      observer,
      systemPrompt,
      taskSupervisor,
      checkpointInterval: this._checkpointInterval,
    };

    return new AgentEngine(deps);
  }

  /**
   * 构建 McpManager 并连接所有配置的 MCP Server
   */
  private async buildMcpManager(): Promise<McpManager> {
    const { createSdkMcpClient } = await import('../integration/mcp/sdk-client.js');

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
  store?: SessionStore;
  budget?: Partial<IterationBudgetConfig>;
  mcp?: McpServerConfig[];
}): Promise<{ engine: AgentEngine; runner: SessionAwareRunner; mcpManager: McpManager }> {
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
