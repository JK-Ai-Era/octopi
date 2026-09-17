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
import { DefaultToolBus } from '../plugin-ecosystem/tools/tool-bus.js';
import type {
  ModelProvider,
} from '../../core/interfaces/model-provider.js';
import type {
  AgentTool as LoopAgentTool,
} from '../../loop/types.js';
import { Agent } from '../agent/index.js';
import type { AgentOptions } from '../agent/index.js';
import { DEFAULT_RELIABILITY_CONFIG } from '../reliability/run-agent.js';
import type { ReliabilityConfig, ReliabilityHarness } from '../reliability/run-agent.js';
import type {
  ContextEngine,
  SummarizeFunction,
} from '../context/types.js';
import type {
  ErrorStrategy,
  ClassifiedError,
  ErrorAction,
  OverflowAction,
} from '../../core/interfaces/error-strategy.js';
import type { SecurityViolation, SecurityAction } from '../../core/security-guard.js';
import type {
  RunGuard,
} from '../../core/interfaces/run-guard.js';
import type { RunGuardConfig } from '../run-guard/default-run-guard.js';
import { DefaultRunGuard } from '../run-guard/default-run-guard.js';
import type {
  Observer,
} from '../../core/interfaces/observer.js';
import type { TraceCollectorConfig } from '../../integration/observability/trace-collector.js';
import type { MetricsAggregatorConfig } from '../../integration/observability/metrics.js';
import type { TraceLoggerConfig } from '../../integration/observability/trace-logger.js';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import { SessionTaskService } from '../session-tasks/service.js';
import { createSessionTaskTools } from '../session-tasks/tools.js';
import type { SessionData } from '../session-types.js';
import { InMemorySessionStore } from '../../integration/storage/memory.js';

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

import { PersonaSource } from './persona.js';
import { DefaultContextEngine } from '../context/default-context-engine.js';
import { createProviderSummarize } from '../context/summarize.js';
import { createDefaultSystemPromptAssembler } from '../context/system-prompt-assembler.js';
import { SessionAwareRunner } from '../runner.js';
import type { SessionAwareRunnerConfig } from '../runner.js';
import { DefaultMcpManager } from '../plugin-ecosystem/mcp/manager.js';
import type { McpManagerCallbacks, McpClientFactory } from '../plugin-ecosystem/mcp/manager.js';
import type { McpServerConfig, McpManager } from '../plugin-ecosystem/mcp/types.js';

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


/** 工具运行时上下文提供者 */
export interface ToolContextProvider {
  get(): { sessionId: string; agentId: string; messages: import('../../core/types.js').Message[]; cwd?: string };
  setRuntime(sessionId: string, agentId: string, messages: import('../../core/types.js').Message[]): void;
}

class RuntimeToolContextProvider implements ToolContextProvider {
  private sessionId = '';
  private agentId = '';
  private messages: import('../../core/types.js').Message[] = [];
  private cwd?: string;

  constructor(defaults?: { cwd?: string }) {
    this.cwd = defaults?.cwd;
  }

  setRuntime(sessionId: string, agentId: string, messages: import('../../core/types.js').Message[]): void {
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.messages = messages;
  }

  get() {
    return { sessionId: this.sessionId, agentId: this.agentId, messages: this.messages, cwd: this.cwd };
  }
}

/**
 * 将 RegisteredTool 转换为 AgentTool（新循环格式）
 */
function convertToAgentTool(tool: RegisteredTool, contextProvider: ToolContextProvider): LoopAgentTool {
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
        const context = contextProvider.get();
        const result = await tool.handler(args as Record<string, unknown>, { ...context, abortSignal: signal });
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

// ── Builder ──

/** ModelProvider 未声明 contextWindow 时的默认窗口（可被 provider 覆盖） */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * AgentBuilder — Fluent API
 */
export class AgentBuilder {
  // Core 组件
  private _model?: ModelProvider;
  private _toolBus = new DefaultToolBus();
  private _contextEngine?: ContextEngine;
  private _summarize?: SummarizeFunction;
  /** 为 true 时禁止自动挂默认 summarize（测试/特殊场景） */
  private _disableAutoSummarize = false;
  private _events?: EventBus;
  private _security?: SecurityGuard;
  private _riskPolicy?: import('../../core/security-guard.js').ToolCallRiskPolicy;
  private _budget?: IterationBudget;
  private _errorStrategy?: ErrorStrategy;
  private _observer?: Observer;
  private _runGuard?: RunGuard;
  private _runGuardConfig?: RunGuardConfig;
  private _checkpointInterval?: number;
  private _reliabilityConfig?: ReliabilityConfig;

  // Harness 组件
  private _personaWorkspaces: string[] = [];
  private _systemPrompt?: string;
  /** Skill 目录（SKILL.md）；build 时 discover 并注入 system prompt 索引 */
  private _skillDirectory?: string;
  private _skillManager?: import('../plugin-ecosystem/skills/types.js').SkillManager;
  /** 记忆检索（注入 system prompt MemoryLayer） */
  private _memoryStore?: import('../memory/types.js').MemoryStore;
  /** 知识检索（注入 system prompt KnowledgeLayer） */
  private _knowledgeStore?: import('../context/knowledge/types.js').KnowledgeStore;
  /** 智慧（注入 system prompt WisdomLayer） */
  private _wisdomStore?: import('../memory/types.js').WisdomStore;
  /** 认知图谱（注入 system prompt CognitionLayer） */
  private _cognitionStore?: import('../memory/types.js').ConceptGraphStore;
  /** system prompt 装配器调参 */
  private _contextAssemblerConfig?: {
    systemBudgetRatio?: number;
    layerShares?: Partial<Record<import('../context/layer-types.js').ContextLayerId, number>>;
    includeLayerPreview?: boolean;
    layerPreviewChars?: number;
    includeLayerContent?: boolean;
  };
  /** 文件式 persona 的 run 时解析器（指纹缓存，改文件下一轮生效） */
  private _personaResolver?: () => Promise<string>;
  /** build 时从磁盘读到的纯 persona（可能为空；不含默认 tools prompt） */
  private _initialPersonaContent?: string;
  private _securityConfig?: SecurityGuardConfig;

  // Observability 配置
  private _traceConfig?: TraceCollectorConfig;
  private _loggerConfig?: Partial<TraceLoggerConfig>;
  private _metricsConfig?: MetricsAggregatorConfig;

  // Runner 配置
  private _store?: SessionStore<SessionData>;
  private _runnerConfig?: SessionAwareRunnerConfig;

  // MCP 配置
  private _mcpConfigs: import('../plugin-ecosystem/mcp/types.js').McpServerConfig[] = [];

  // 自主子系统配置
  private _subsystemSpecs: import('../autonomous-subsystem/types.js').SubsystemSpec[] = [];
  private _subsystemAuditDir?: string;
  private _modelLevels?: import('../autonomous-subsystem/types.js').ModelLevelMap;
  private _subsystemDir?: string;

  // 注册的 named providers（用于 ProviderPool）
  private _namedProviders = new Map<string, ModelProvider>();

  // 并发控制配置
  private _concurrencyConfig?: import('../../config.js').HarnessConfig['concurrency'];
  /** Agent 沙箱工作目录（工具 cwd 注入） */
  private _workspace?: string;


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
    this._toolBus.register(tool);
    return this;
  }

  /** 批量注册工具 */
  tools(...tools: RegisteredTool[]): this {
    for (const t of tools) this.tool(t);
    return this;
  }

  private _contextProvider = new RuntimeToolContextProvider();

  /** 获取运行时上下文提供者 */
  getContextProvider(): ToolContextProvider {
    return this._contextProvider;
  }

  /**
   * 配置 MCP Server 连接
   *
   * 构建时自动连接，工具注册到 ToolBus。
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
  mcp(config: import('../plugin-ecosystem/mcp/types.js').McpServerConfig): this {
    this._mcpConfigs.push(config);
    return this;
  }

  /** 注册自主子系统 */
  withSubsystem(spec: import('../autonomous-subsystem/types.js').SubsystemSpec): this {
    this._subsystemSpecs.push(spec);
    return this;
  }

  /** 设置子系统目录（用于自动加载） */
  withSubsystemDir(dir: string): this {
    this._subsystemDir = dir;
    return this;
  }

  /** 设置子系统审计日志目录 */
  withSubsystemAuditDir(dir: string): this {
    this._subsystemAuditDir = dir;
    return this;
  }

  /**
   * 设置模型级别映射（来自 config.models.level）
   *
   * 子系统通过 think.model: 'mini' 引用，运行时自动解析到具体 provider/model。
   */
  withModelLevels(levels: import('../autonomous-subsystem/types.js').ModelLevelMap): this {
    this._modelLevels = levels;
    return this;
  }

  /** 设置上下文引擎 */
  contextEngine(engine: ContextEngine): this {
    this._contextEngine = engine;
    return this;
  }

  /**
   * 设置 Skill 目录（子目录内含 SKILL.md）
   *
   * build 时 discover，每轮以索引形式注入 system prompt（formatForPrompt）。
   */
  skillDirectory(dir: string): this {
    this._skillDirectory = dir;
    return this;
  }

  /** 直接注入 SkillManager（跳过目录 discover） */
  skills(manager: import('../plugin-ecosystem/skills/types.js').SkillManager): this {
    this._skillManager = manager;
    return this;
  }

  /** 注入 MemoryStore（每轮按 query 召回进 system prompt） */
  memoryStore(store: import('../memory/types.js').MemoryStore): this {
    this._memoryStore = store;
    return this;
  }

  /** 注入 KnowledgeStore（每轮按 query 召回进 system prompt） */
  knowledgeStore(store: import('../context/knowledge/types.js').KnowledgeStore): this {
    this._knowledgeStore = store;
    return this;
  }

  /** 注入 WisdomStore（半静态思维范式，进 system prompt WisdomLayer） */
  wisdomStore(store: import('../memory/types.js').WisdomStore): this {
    this._wisdomStore = store;
    return this;
  }

  /** 注入 ConceptGraphStore（按 query 召回概念边，进 system prompt CognitionLayer） */
  cognitionStore(store: import('../memory/types.js').ConceptGraphStore): this {
    this._cognitionStore = store;
    return this;
  }

  /**
   * system prompt 装配器调参
   *
   * @param config.systemBudgetRatio - system 预算占 contextWindow 比例
   * @param config.layerShares - 单层硬顶（仅配置的层生效；默认不配额）
   * @param config.includeLayerPreview - 是否在 manifest 写入层 preview
   * @param config.layerPreviewChars - preview 最大字符数
   * @param config.includeLayerContent - 是否在 manifest 写入层正文全文
   */
  contextAssembler(config: {
    systemBudgetRatio?: number;
    layerShares?: Partial<Record<import('../context/layer-types.js').ContextLayerId, number>>;
    includeLayerPreview?: boolean;
    layerPreviewChars?: number;
    includeLayerContent?: boolean;
  }): this {
    this._contextAssemblerConfig = { ...this._contextAssemblerConfig, ...config };
    return this;
  }

  /** 设置摘要函数（用于 LLM 摘要压缩） */
  summarize(fn: SummarizeFunction): this {
    this._summarize = fn;
    return this;
  }

  /**
   * 关闭「未显式 summarize 时用主模型自动挂接」
   *
   * 默认开启自动挂接，保证长会话能走 LLM 摘要而非纯截断。
   */
  disableAutoSummarize(disabled = true): this {
    this._disableAutoSummarize = disabled;
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

  /** 设置过程监督（自动创建，使用主模型做 LLM 审查） */
  runGuard(config?: RunGuardConfig): this;
  /** 设置过程监督（手动传入实例） */
  runGuard(guard: RunGuard, checkpointInterval?: number): this;
  runGuard(guardOrConfig?: RunGuard | RunGuardConfig, checkpointInterval?: number): this {
    if (!guardOrConfig) {
      // 无参调用：使用默认配置自动创建，延迟到 buildAgent 时注入 model
      this._runGuardConfig = {};
    } else if (typeof (guardOrConfig as RunGuard).checkpoint === 'function') {
      // RunGuard 实例（含自定义实现）
      this._runGuard = guardOrConfig as RunGuard;
    } else {
      // RunGuardConfig 对象：延迟到 buildAgent 时注入 model
      this._runGuardConfig = guardOrConfig as RunGuardConfig;
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

  /** 设置 Agent 沙箱工作目录（注入到内置工具的 cwd） */
  workspace(dir: string): this {
    this._workspace = dir;
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
   * 使用新架构：Harness Agent 门面（agent.run = reliability）。
   */
  async build(): Promise<{
    agent: Agent;
    harness: ReliabilityHarness;
    runner: SessionAwareRunner;
    mcpManager: McpManager;
    runtime?: import('../autonomous-subsystem/runtime.js').SubsystemRuntime;
    events: EventBus;
    /** 七层数据面健康探针（store 计数 / 注册状态） */
    contextHealth: (agentId?: string) => Promise<import('../context/layer-health.js').ContextLayerHealth>;
  }> {
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

    // 创建 SessionStore（须在 buildAgent 之前，以便 task_* 工具进入 Agent 的工具快照）
    const store = this._store ?? new InMemorySessionStore();
    this._store = store;

    // 会话任务：默认创建 Service；注册 task_* 工具后再 buildAgent
    const sessionTaskService =
      this._runnerConfig?.sessionTaskService ?? new SessionTaskService(store, events);
    this._runnerConfig = {
      ...this._runnerConfig,
      sessionTaskService,
    };

    if (!this._toolBus.getTool('task_list')) {
      for (const t of createSessionTaskTools(sessionTaskService)) {
        this._toolBus.register(t);
      }
    }

    // 使用 buildAgent() 构建核心组件（此时 toolBus 已含 task_*）
    const { agent, harness, mcpManager } = await this.buildAgent();

    const runner = new SessionAwareRunner(agent, harness, store, {
      ...this._runnerConfig,
      sessionTaskService,
      events,
    });
    runner.setToolContextProvider(this._contextProvider);
    if (this._personaResolver) {
      // 传入磁盘 persona 真实内容（可能为 ''），供 runner 区分「从未有人格」与「热删除」
      runner.setSystemPromptResolver(this._personaResolver, this._initialPersonaContent ?? '');
    }
    // 层契约装配：persona + skill 索引 + wisdom/cognition/memory/knowledge 召回 + runtime
    const skillManager = this._skillManager;
    const memoryStore = this._memoryStore;
    const knowledgeStore = this._knowledgeStore;
    const wisdomStore = this._wisdomStore;
    const cognitionStore = this._cognitionStore;
    const assemblerCfg = this._contextAssemblerConfig;
    const systemPromptAssembler = createDefaultSystemPromptAssembler({
      getSkillPromptText: skillManager
        ? () => skillManager.formatForPrompt()
        : undefined,
      memoryStore,
      knowledgeStore,
      wisdomStore,
      cognitionStore,
      systemBudgetRatio: assemblerCfg?.systemBudgetRatio,
      assemblerConfig: {
        layerShares: assemblerCfg?.layerShares,
        includeLayerPreview: assemblerCfg?.includeLayerPreview,
        layerPreviewChars: assemblerCfg?.layerPreviewChars,
        includeLayerContent: assemblerCfg?.includeLayerContent,
      },
    });
    runner.setSystemPromptAssembler(
      (input) => systemPromptAssembler.assemble(input),
      (sid) => systemPromptAssembler.clearSession(sid),
    );

    // 创建 SubsystemRuntime（如果有自主子系统）
    let subsystemRuntime: import('../autonomous-subsystem/runtime.js').SubsystemRuntime | undefined;
    if (this._subsystemSpecs.length > 0 || this._subsystemDir) {
      const { SubsystemRuntime } = await import('../autonomous-subsystem/runtime.js');
      subsystemRuntime = new SubsystemRuntime({
        deps: {
          model: agent.model,
          events,
          errorStrategy: this._errorStrategy ?? new DefaultErrorStrategy(),
          mainTools: this._toolBus,
          modelLevels: this._modelLevels,
        },
        auditDir: this._subsystemAuditDir,
      });
      // 注册代码中定义的子系统
      for (const spec of this._subsystemSpecs) {
        const regErrors = subsystemRuntime.register(spec);
        if (regErrors.length > 0) {
          console.warn(`[octopi] subsystem "${spec.id}" rejected: ${regErrors.join('; ')}`);
        }
      }
      // 从目录加载子系统
      if (this._subsystemDir) {
        const { SubsystemLoader } = await import('../autonomous-subsystem/loader.js');
        const loader = new SubsystemLoader({ builtinDir: this._subsystemDir });
        const loadResult = await loader.loadAll();
        for (const err of loadResult.errors) {
          console.warn(`[octopi] subsystem load failed ${err.path}: ${err.error}`);
        }
        for (const spec of loadResult.specs) {
          const regErrors = subsystemRuntime.register(spec);
          if (regErrors.length > 0) {
            console.warn(`[octopi] subsystem "${spec.id}" rejected: ${regErrors.join('; ')}`);
          }
        }
      }
      runner.setSubsystemRuntime(subsystemRuntime);
    }

    const skillManagerForHealth = skillManager;
    const memoryStoreForHealth = memoryStore;
    const knowledgeStoreForHealth = knowledgeStore;
    const wisdomStoreForHealth = wisdomStore;
    const cognitionStoreForHealth = cognitionStore;
    const personaLoadedForHealth = Boolean(
      (this._systemPrompt ?? '').trim() ||
        (this._initialPersonaContent ?? '').trim() ||
        this._personaResolver,
    );

    return {
      agent,
      harness,
      runner,
      mcpManager,
      runtime: subsystemRuntime,
      events,
      contextHealth: async (agentId?: string) => {
        const { probeContextLayerHealth } = await import('../context/layer-health.js');
        return probeContextLayerHealth({
          agentId: agentId ?? 'default',
          skillCount: skillManagerForHealth?.list().length,
          memoryStore: memoryStoreForHealth,
          knowledgeStore: knowledgeStoreForHealth,
          wisdomStore: wisdomStoreForHealth,
          cognitionStore: cognitionStoreForHealth,
          personaLoaded: personaLoadedForHealth,
        });
      },
    };
  }

  /**
   * 构建 Agent 类（Harness 门面 + reliability）
   *
   * 返回已绑定 harness 的 Agent；集成方应使用 `agent.run()`：
   * ```ts
   * const { agent, harness } = await builder.buildAgent();
   * for await (const event of agent.run()) {
   *   // 处理事件
   * }
   * ```
   */
  async buildAgent(): Promise<{ agent: Agent; harness: ReliabilityHarness; mcpManager: McpManager }> {
    if (!this._model) {
      throw new Error('ModelProvider is required. Call .model() before .buildAgent()');
    }

    // 单独 buildAgent() 时也保证有 bus，压缩事件不会静默丢失
    if (!this._events) {
      this._events = new DefaultEventBus();
    }

    // 加载 systemPrompt：文件式 persona 走 PersonaSource（run 时热更新）
    let systemPrompt = this._systemPrompt ?? '';
    this._personaResolver = undefined;
    this._initialPersonaContent = undefined;
    if (!systemPrompt && this._personaWorkspaces.length > 0) {
      const source = new PersonaSource();
      const dirs = [...this._personaWorkspaces];
      this._personaResolver = () => source.load(...dirs);
      this._initialPersonaContent = await this._personaResolver();
      systemPrompt = this._initialPersonaContent;
    }
    if (!systemPrompt && this._toolBus.listForAgent('default').length > 0) {
      systemPrompt = this.buildDefaultSystemPrompt();
    }

    // Skill：目录 discover（或外部注入的 manager）
    if (!this._skillManager && this._skillDirectory) {
      const { DefaultSkillManager } = await import('../plugin-ecosystem/skills/manager.js');
      const mgr = new DefaultSkillManager(this._skillDirectory);
      try {
        await mgr.discover(this._skillDirectory);
        this._skillManager = mgr;
      } catch (err) {
        console.warn(
          `[octopi] skill discover failed (${this._skillDirectory}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 构建 McpManager
    const mcpManager = await this.buildMcpManager();

    // 转换 RegisteredTool → AgentTool
    this._contextProvider = new RuntimeToolContextProvider({ cwd: this._workspace });
    const agentTools: LoopAgentTool[] = this._toolBus.listForAgent('default').map(t => convertToAgentTool(t, this._contextProvider));

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

    // ContextEngine 接线：经 convertToLlm 调用 assemble（Loop 不依赖引擎类型）
    // sessionId 从 agent.contextSessionId 读取（Runner 每 handle 注入）
    const contextEngine = this._contextEngine ?? new DefaultContextEngine();
    // 未显式 summarize 时用主模型自动挂接，避免默认路径永远只截断
    const summarizeFn =
      this._summarize ??
      (!this._disableAutoSummarize && this._model
        ? createProviderSummarize(this._model)
        : undefined);
    const provider = this._model;
    agent.setConvertToLlm(async (messages) => {
      const systemPrompt = agent.context.systemPrompt;
      const tools: import('../../core/interfaces/model-provider.js').LLMToolDefinition[] = (agent.context.tools ?? []).map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? { type: 'object', properties: {} },
        },
      }));
      const infos = provider?.getModelInfos?.() ?? [];
      const info =
        (provider?.defaultModel ? provider.getModelInfo(provider.defaultModel) : null)
        ?? infos[0]
        ?? null;
      const contextWindow = info?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const result = await contextEngine.assemble({
        sessionId: agent.contextSessionId,
        messages,
        systemPrompt,
        tools,
        tokenBudget: contextWindow,
        contextWindow,
        summarize: summarizeFn,
        loadCompactState: (sid) => agent.getSessionCompactState(sid),
        // 惰性读 bus：覆盖 buildAgent 之后才 setEvents 的场景
        emit: (e) => {
          const bus = this._events;
          if (!bus) return;
          const { type, sessionId, ...data } = e;
          bus.emit({
            type,
            timestamp: Date.now(),
            sessionId,
            data,
          });
        },
      });
      // 压缩状态回写 Agent 内存桥；Runner 在 session save 前写入 SessionData.contextCompact
      if (result.compactState) {
        agent.setSessionCompactState(agent.contextSessionId, result.compactState);
      }
      // droppedSummary：并入已有 system，避免连续两条 system（严格网关）
      const llmMessages = [...result.messages];
      if (result.droppedSummary) {
        const note = `[Context compacted] ${result.droppedSummary}`;
        const sysIdx = llmMessages.findIndex((m) => m.role === 'system');
        if (sysIdx >= 0) {
          const sys = llmMessages[sysIdx]!;
          const prev = typeof sys.content === 'string' ? sys.content : '';
          llmMessages[sysIdx] = {
            ...sys,
            content: prev ? `${prev}\n\n${note}` : note,
          };
        } else {
          llmMessages.unshift({ role: 'system', content: note });
        }
      }
      return llmMessages;
    });
    agent.setOnAfterTurn(async (usage, turn) => {
      await contextEngine.afterTurn?.({
        sessionId: agent.contextSessionId,
        turn: turn ?? [],
        usage: usage
          ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }
          : undefined,
      });
    });

    // 构建可靠性 harness（systemPrompt 用于泄露检测；文件式 persona 每轮由 runner 同步）
    // 统一 EventBus 实例（security / budget 共用）
    const events = this._events ?? new DefaultEventBus();
    this._events = events;
    const security = this._security ?? new DefaultSecurityGuard(events, {
      ...this._securityConfig,
      systemPrompt: this._securityConfig?.systemPrompt ?? systemPrompt,
    });
    if (this._riskPolicy && security.setToolCallRiskPolicy) {
      security.setToolCallRiskPolicy(this._riskPolicy);
    }
    const errorStrategy = this._errorStrategy ?? new DefaultErrorStrategy();

    // 自动创建 RunGuard（如果通过 config 配置但未手动传入实例）
    const runGuard = this._runGuard
      ?? (this._runGuardConfig !== undefined
        ? new DefaultRunGuard(this._runGuardConfig, this._model)
        : undefined);

    // ResourceBudget：始终挂默认实例（可被 .budget() 覆盖），保证主路径硬停生效
    const budget =
      this._budget ?? new IterationBudget(events, {});

    // checkpointInterval：builder.runGuard(guard, n) 或默认
    if (this._checkpointInterval !== undefined) {
      this._reliabilityConfig = {
        ...(this._reliabilityConfig ?? DEFAULT_RELIABILITY_CONFIG),
        checkpointInterval: this._checkpointInterval,
      };
    }

    const harness: ReliabilityHarness = {
      config: this._reliabilityConfig ?? DEFAULT_RELIABILITY_CONFIG,
      security,
      errorStrategy,
      runGuard,
      budget,
    };

    // Agent.run() 需要 harness；Builder 组装期绑定
    agent.setHarness(harness);

    return { agent, harness, mcpManager };
  }

  /**
   * 构建 McpManager 并连接所有配置的 MCP Server
   */
  private async buildMcpManager(): Promise<McpManager> {
    const { createSdkMcpClient } = await import('../../integration/mcp/sdk-client.js');

    // 创建回调，桥接到 this._toolBus
    // MCP 工具全局注册（外部 server 发现的工具天然跨 agent 共享）
    // Agent 级过滤通过 ToolPolicy.deny 实现
    const callbacks: McpManagerCallbacks = {
      registerTool: (tool) => this._toolBus.register(tool),
      unregisterTool: (name) => this._toolBus.unregister(name),
      getTool: (name) => this._toolBus.getTool(name),
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
    const toolList = this._toolBus.listForAgent('default')
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
