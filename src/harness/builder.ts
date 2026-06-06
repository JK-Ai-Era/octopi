/**
 * AgentBuilder — Fluent API 组装器
 *
 * 集成方的主要入口。一行代码启动 Agent。
 *
 * 使用示例：
 * ```ts
 * const { engine, runner } = new AgentBuilder()
 *   .model('gpt-4')
 *   .persona('./personas/my-agent')
 *   .tool(myTool)
 *   .budget({ maxIterations: 15 })
 *   .build();
 * ```
 */

import type {
  RegisteredTool,
  Message,
} from '../core/types.js';
import type {
  ModelProvider,
} from '../core/interfaces/model-provider.js';
import type {
  ToolExecutor,
  ExecutionContext,
} from '../core/interfaces/tool-executor.js';
import type {
  ContextPipeline,
} from '../core/interfaces/context-pipeline.js';
import type {
  ErrorStrategy,
  ClassifiedError,
  SecurityViolation,
  ErrorAction,
  OverflowAction,
  SecurityAction,
} from '../core/interfaces/error-strategy.js';
import type {
  Observer,
} from '../core/interfaces/observer.js';
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
import { DefaultContextPipeline } from './context/pipeline.js';
import type { ContextStage } from './context/pipeline.js';
import { SessionAwareRunner } from './runner.js';
import type { SessionAwareRunnerConfig } from './runner.js';

// ── 默认实现 ──

/** 默认错误策略（简单重试 + 中止） */
class DefaultErrorStrategy implements ErrorStrategy {
  onModelError(error: ClassifiedError, attempt: number): ErrorAction {
    if (error.reason === 'rate_limit' && attempt < 3) {
      // 优先使用服务端返回的 retry-after，否则用指数退避
      const delayMs = error.retryAfterMs ?? (attempt + 1) * 1000;
      return { action: 'retry', delayMs };
    }
    if (error.reason === 'timeout' && attempt < 2) {
      return { action: 'retry', delayMs: 500 };
    }
    return { action: 'abort', reason: error.message };
  }

  onToolError(_error: ClassifiedError, _call: any): ErrorAction {
    return { action: 'skip', reason: 'Tool execution failed' };
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
  async execute(call: any, _ctx: ExecutionContext): Promise<any> {
    // 工具执行由 AgentEngine 内部处理
    // 这里是兜底，实际不会被调用
    throw new Error(`Tool "${call.name}" executor not configured`);
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
  private _context?: ContextPipeline;
  private _events?: EventBus;
  private _security?: SecurityGuard;
  private _budget?: IterationBudget;
  private _errorStrategy?: ErrorStrategy;
  private _observer?: Observer;

  // Harness 组件
  private _personaWorkspaces: string[] = [];
  private _systemPrompt?: string;
  private _contextStages?: ContextStage[];
  private _securityConfig?: SecurityGuardConfig;

  // Runner 配置
  private _store?: SessionStore;
  private _runnerConfig?: SessionAwareRunnerConfig;

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

  /** 设置工具执行器 */
  executor(executor: ToolExecutor): this {
    this._executor = executor;
    return this;
  }

  /** 设置上下文管道 */
  contextPipeline(pipeline: ContextPipeline): this {
    this._context = pipeline;
    return this;
  }

  /** 设置上下文阶段（替换默认阶段） */
  contextStages(stages: ContextStage[]): this {
    this._contextStages = stages;
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
  async build(): Promise<{ engine: AgentEngine; runner: SessionAwareRunner }> {
    const engine = await this.buildEngine();
    const store = this._store ?? new InMemorySessionStore();
    const runner = new SessionAwareRunner(engine, store, this._runnerConfig);
    return { engine, runner };
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

    // 创建默认组件
    const events = this._events ?? new DefaultEventBus();
    const security = this._security ?? new DefaultSecurityGuard(events, this._securityConfig);
    const budget = this._budget ?? new IterationBudget(events);
    const errorStrategy = this._errorStrategy ?? new DefaultErrorStrategy();
    const context = this._context ?? new DefaultContextPipeline(this._contextStages);
    const executor = this._executor ?? new DefaultToolExecutor();

    // 注入 systemPrompt 到引擎的运行时配置
    // AgentEngine 本身不存储 systemPrompt，由调用方在 run() 时传入
    const deps: AgentEngineDeps = {
      model: this._model,
      tools: this._tools,
      executor,
      context,
      events,
      security,
      budget,
      errorStrategy,
      observer: this._observer,
      systemPrompt,
    };

    return new AgentEngine(deps);
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
}): Promise<{ engine: AgentEngine; runner: SessionAwareRunner }> {
  const builder = new AgentBuilder()
    .model(config.model);

  if (config.persona) builder.persona(config.persona);
  if (config.tools) builder.tools(...config.tools);
  if (config.store) builder.store(config.store);
  if (config.budget) builder.budget(config.budget);

  return builder.build();
}
