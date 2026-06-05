# Octopi 重构方案：三层洋葱架构

> 版本：v2.0 | 日期：2026-06-05 | 状态：设计阶段
>
> 本方案经过完整的反思和修正（见 `ARCHITECTURE.md`），解决了 v1.0 中的职责混乱、安全薄弱、可观测性缺失等问题。

---

## 1. 架构总览

### 设计目标

| 目标 | 含义 |
|---|---|
| **可集成性** | 一行代码嵌入任何应用 |
| **可扩展性** | 每一层都可以被替换或增强 |
| **可塑性** | 不预设 Agent 长什么样，由集成方定义 |
| **安全性** | 生产级安全，纵深防御 |
| **可观测性** | 全链路事件、指标、追踪 |
| **可组合性** | Agent 可以调用 Agent |

### 三层洋葱模型

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 3: Integration                                                │
│  Gateway · Protocols · Storage Backends · Sandbox · Observability    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Layer 2: Harness                                                │ │
│  │  Persona · Plugin · Skill · Task · ToolPolicy                    │ │
│  │  ContextPipeline · ErrorStrategy · SecurityPolicy · AgentBuilder │ │
│  │                                                                  │ │
│  │  ┌─────────────────────────────────────────────────────────────┐ │ │
│  │  │  Layer 1: Core                                               │ │ │
│  │  │  AgentEngine (无状态循环引擎)                                  │ │ │
│  │  │  · ModelProvider 接口                                        │ │ │
│  │  │  · ToolExecutor 接口                                         │ │ │
│  │  │  · ContextPipeline 接口                                      │ │ │
│  │  │  · EventBus (内置事件总线)                                    │ │ │
│  │  │  · SecurityGuard (内置安全检查)                               │ │ │
│  │  │  · IterationBudget (内置资源约束)                             │ │ │
│  │  │  · Observer 接口 (可观测性)                                   │ │ │
│  │  │  · ErrorStrategy 接口 (错误处理)                              │ │ │
│  │  └─────────────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**依赖方向：外层依赖内层，内层不知道外层的存在。**

**Core 的原则：接口极简 + 安全强制 + 事件内置 + 扩展点暴露但不预设实现。**

### 与当前架构的映射

| 当前模块 | 重构后归属 | 变化 |
|---|---|---|
| `AgentRunner` | **拆解** → Core: `AgentEngine` + Harness: `SessionAwareRunner` + `AgentBuilder` | 从"上帝类"拆为三层 |
| `SessionManager` | Harness: `SessionAwareRunner` + Integration: `JsonlSessionStore` | 从 AgentEngine 中解耦 |
| `LegacyContextEngine` | Core: `ContextPipeline` 接口 + Harness: `DefaultContextPipeline` | 改为管道模型 |
| `LLMRouter` | Core: `ModelProvider` 接口 + Harness: 模型选择逻辑 | 路由逻辑上移 |
| `ToolRegistry` | Core: `ToolExecutor` 接口 + Harness: `ToolPolicyManager` | 执行和策略分离 |
| `PluginManager` | Harness 层，实现回调注入 | 不再实现 Core 接口 |
| `DefaultSkillManager` | Harness 层 | 通过 ContextPipeline 注入 |
| `TaskManager` | Harness 层 | 通过回调槽注入 |
| `Gateway` | Integration 层 | 不变 |
| `HttpChannelAdapter` | Integration 层 | 不变 |

---

## 2. Layer 1: Core — 纯引擎

### 设计原则

1. **无状态** — AgentEngine 不持有 Session 状态，消息历史由调用方传入
2. **接口极简** — 只有 5 个核心接口 + 2 个观测接口
3. **安全内置** — SecurityGuard 和 IterationBudget 不可禁用
4. **事件内置** — EventBus 是 Core 的一部分，不是可选插件
5. **扩展槽暴露** — 回调槽暴露扩展点，不预设扩展机制

### 2.1 核心接口

#### ModelProvider — LLM 调用

```typescript
/**
 * 模型提供者接口
 *
 * 职责：调用 LLM 并返回响应。
 * 实现方可以是 OpenAI、Anthropic、本地模型等。
 */
export interface ModelProvider {
  /** Provider 名称 */
  readonly name: string;

  /** 同步调用 */
  chat(request: LLMRequest): Promise<LLMResponse>;

  /** 流式调用 */
  stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk>;

  /** 检查是否可用 */
  isAvailable(): Promise<boolean>;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  model: string;
}

export interface LLMStreamChunk {
  type: 'content' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: Partial<ToolCall>;
  error?: string;
}
```

#### ToolExecutor — 工具执行

```typescript
/**
 * 工具执行器接口
 *
 * 职责：执行工具调用并返回结果。
 * 实现方可以是本地执行、沙盒执行、远程执行等。
 */
export interface ToolExecutor {
  /** 执行工具调用 */
  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult>;
}

export interface ExecutionContext {
  /** 最大执行时间（毫秒） */
  timeoutMs: number;
  /** 文件系统访问范围（白名单目录） */
  allowedPaths?: string[];
  /** 网络访问范围 */
  allowedHosts?: string[];
  /** 环境变量白名单 */
  allowedEnvVars?: string[];
  /** 调用来源标识（用于权限追踪） */
  callerId?: string;
}
```

#### ContextPipeline — 上下文组装管道

```typescript
/**
 * 上下文管道接口
 *
 * 职责：将 session 消息组装成发给 LLM 的上下文。
 * 采用管道模型，支持多阶段处理：
 *   enrich → assemble → compact → filter
 *
 * Core 层只定义接口，不预设管道实现。
 * Harness 层实现具体的管道阶段。
 */
export interface ContextPipeline {
  /**
   * 处理上下文
   *
   * @param messages - 当前消息历史
   * @param input - 管道输入（工具定义、系统提示等）
   * @returns 组装后的管道输出
   */
  process(messages: Message[], input: PipelineInput): Promise<PipelineOutput>;
}

export interface PipelineInput {
  /** 系统提示词（由 Harness 层传入，Core 不关心来源） */
  systemPrompt: string;
  /** 可用工具描述 */
  tools: ToolDefinition[];
  /** 最大 token 数 */
  maxTokens?: number;
  /** 中止信号 */
  signal?: AbortSignal;
}

export interface PipelineOutput {
  /** 组装后的 LLM 消息 */
  messages: LLMMessage[];
  /** token 使用估算 */
  estimatedTokens: number;
  /** 标记的不可信内容范围（用于 injection 防护） */
  untrustedRanges?: Array<{ start: number; end: number; source: string }>;
}
```

#### ErrorStrategy — 错误处理策略

```typescript
/**
 * 错误处理策略接口
 *
 * 职责：决定 Agent 循环中遇到错误时的行为。
 * Core 层在错误发生时调用此接口，由 Harness 层实现具体策略。
 */
export interface ErrorStrategy {
  /** 模型调用失败 */
  onModelError(error: ClassifiedError, attempt: number): ErrorAction;
  /** 工具执行失败 */
  onToolError(error: ClassifiedError, call: ToolCall): ErrorAction;
  /** 上下文溢出（token 超限） */
  onContextOverflow(tokenCount: number, limit: number): OverflowAction;
  /** 安全违规 */
  onSecurityViolation(violation: SecurityViolation): SecurityAction;
}

export type ErrorAction =
  | { action: 'retry'; delayMs: number }
  | { action: 'fallback'; provider: string; model: string }
  | { action: 'skip'; reason: string }
  | { action: 'abort'; reason: string };

export type OverflowAction =
  | { action: 'compact' }
  | { action: 'truncate'; keepRecent: number }
  | { action: 'abort' };

export type SecurityAction =
  | { action: 'block'; reason: string }
  | { action: 'warn'; reason: string }
  | { action: 'sanitize'; replacement: string };
```

#### Observer — 可观测性

```typescript
/**
 * 观测接口
 *
 * 职责：记录指标、追踪、日志。
 * Integration 层实现具体后端（Prometheus、OpenTelemetry 等）。
 */
export interface Observer {
  /** 记录数值指标 */
  recordMetric(name: string, value: number, tags?: Record<string, string>): void;
  /** 开始追踪 span */
  startSpan(name: string, attributes?: Record<string, unknown>): Span;
  /** 记录日志 */
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void;
}

export interface Span {
  readonly id: string;
  setStatus(status: SpanStatus): void;
  setAttribute(key: string, value: unknown): void;
  end(): void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SpanStatus = 'ok' | 'error' | 'cancelled';
```

### 2.2 内置组件（不可禁用）

#### EventBus — 事件总线

```typescript
/**
 * 事件总线 — Core 内置
 *
 * Agent 循环中的所有关键节点都会发射事件。
 * Harness 层和 Integration 层通过订阅事件实现审计、监控、调试。
 *
 * 事件分类：
 * - 生命周期事件：engine.start, engine.end, iteration.start, iteration.end
 * - 模型事件：model.call.start, model.call.end, model.call.error
 * - 工具事件：tool.exec.start, tool.exec.end, tool.exec.error
 * - 安全事件：injection.detected, policy.violated, sandbox.breach
 * - 性能事件：budget.exceeded, latency.high
 */
export interface EventBus {
  emit(event: AgentEvent): void;
  on(eventType: string, handler: EventHandler): Disposable;
  onAll(handler: EventHandler): Disposable;
}

export interface AgentEvent {
  type: string;
  timestamp: number;
  agentId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export interface Disposable {
  dispose(): void;
}

// 内置事件类型
export const AgentEvents = {
  // 生命周期
  ENGINE_START: 'engine.start',
  ENGINE_END: 'engine.end',
  ITERATION_START: 'iteration.start',
  ITERATION_END: 'iteration.end',

  // 模型
  MODEL_CALL_START: 'model.call.start',
  MODEL_CALL_END: 'model.call.end',
  MODEL_CALL_ERROR: 'model.call.error',

  // 工具
  TOOL_EXEC_START: 'tool.exec.start',
  TOOL_EXEC_END: 'tool.exec.end',
  TOOL_EXEC_ERROR: 'tool.exec.error',

  // 安全
  INJECTION_DETECTED: 'injection.detected',
  POLICY_VIOLATED: 'policy.violated',
  SANDBOX_BREACH: 'sandbox.breach',

  // 性能
  BUDGET_EXCEEDED: 'budget.exceeded',
  CONTEXT_OVERFLOW: 'context.overflow',
} as const;
```

#### SecurityGuard — 安全检查

```typescript
/**
 * 安全守卫 — Core 内置，不可禁用
 *
 * 职责：在 Agent 循环的关键节点执行强制安全检查。
 * 这不是 Plugin，不可被替换或禁用。
 */
export interface SecurityGuard {
  /**
   * 检查工具输出是否包含注入
   * 在每次工具执行后自动调用
   */
  checkToolOutput(output: string): SecurityCheckResult;

  /**
   * 检查模型输出是否包含敏感信息
   * 在每次模型调用后自动调用
   */
  checkModelOutput(output: string): SecurityCheckResult;

  /**
   * 检查用户输入是否包含注入
   * 在消息到达时自动调用
   */
  checkUserInput(input: string): SecurityCheckResult;
}

export interface SecurityCheckResult {
  isClean: boolean;
  violations: SecurityViolation[];
  sanitized?: string;
}

export interface SecurityViolation {
  type: 'injection' | 'sensitive_data' | 'policy_violation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  range?: { start: number; end: number };
}
```

#### IterationBudget — 资源约束

```typescript
/**
 * 迭代预算 — Core 内置，不可绕过
 *
 * 职责：强制限制 Agent 循环的资源消耗。
 */
export interface IterationBudgetConfig {
  maxIterations: number;
  maxToolCalls: number;
  maxTokens: number;
  maxWallClockMs: number;
}

export class IterationBudget {
  check(): BudgetStatus;
  consume(tokens: number): void;
  recordToolCall(): void;
  recordIteration(): void;
}

export type BudgetStatus = 'ok' | 'iteration_limit' | 'tool_call_limit' | 'token_limit' | 'timeout';
```

### 2.3 AgentEngine — 无状态循环引擎

```typescript
/**
 * Agent Engine — 核心循环引擎
 *
 * 设计原则：
 * - 无状态：不持有 Session，消息历史由调用方传入
 * - 纯循环：输入 → 上下文组装 → 模型推理 → [工具执行] → 输出
 * - 事件驱动：所有关键节点通过 EventBus 发射事件
 * - 安全内置：SecurityGuard 不可禁用
 * - 预算强制：IterationBudget 不可绕过
 *
 * 扩展点（回调槽）：
 * - onMessage: 消息到达时
 * - beforeAssemble: 上下文组装前
 * - beforeModelCall: 模型调用前
 * - afterModelCall: 模型调用后
 * - beforeToolExec: 工具执行前
 * - afterToolExec: 工具执行后
 * - afterTurn: 回合结束后
 */
export class AgentEngine {
  /** 扩展回调槽 — Harness 层注入 */
  onMessage?: (msg: Message) => Message | null;
  beforeAssemble?: (input: PipelineInput) => PipelineInput;
  beforeModelCall?: (req: LLMRequest) => LLMRequest | null;
  afterModelCall?: (resp: LLMResponse) => LLMResponse;
  beforeToolExec?: (call: ToolCall) => ToolCall | null;
  afterToolExec?: (result: ToolResult) => ToolResult;
  afterTurn?: (turn: Turn) => void;

  constructor(private deps: AgentEngineDeps) {}

  /**
   * 运行 Agent 循环
   *
   * @param messages - 当前完整消息历史（由调用方提供）
   * @param config - 运行配置
   * @param signal - 中止信号
   * @yields AgentEvent 事件流
   */
  async *run(
    messages: Message[],
    config: RunConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    // 1. 触发 onMessage 回调
    // 2. 进入循环（受 IterationBudget 约束）：
    //    a. 触发 beforeAssemble 回调
    //    b. 调用 ContextPipeline.process()
    //    c. SecurityGuard 检查上下文
    //    d. 触发 beforeModelCall 回调
    //    e. 调用 ModelProvider.stream()
    //    f. SecurityGuard 检查模型输出
    //    g. 触发 afterModelCall 回调
    //    h. 如果有 tool_calls：
    //       - SecurityGuard 检查工具参数
    //       - 触发 beforeToolExec 回调
    //       - 调用 ToolExecutor.execute()
    //       - SecurityGuard 检查工具输出
    //       - 触发 afterToolExec 回调
    //       - 继续循环
    //    i. 如果是纯文本 → 完成
    // 3. 触发 afterTurn 回调
    // 4. 发射 engine.end 事件
  }
}

export interface AgentEngineDeps {
  model: ModelProvider;
  tools: Map<string, RegisteredTool>;
  executor: ToolExecutor;
  context: ContextPipeline;
  events: EventBus;
  security: SecurityGuard;
  budget: IterationBudget;
  errorStrategy: ErrorStrategy;
  observer?: Observer;
}
```

### 2.4 Core 导出清单

```typescript
// src/core/index.ts
export { AgentEngine } from './engine.js';
export type { AgentEngineDeps, RunConfig } from './engine.js';
export type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from './interfaces/model-provider.js';
export type { ToolExecutor, ExecutionContext } from './interfaces/tool-executor.js';
export type { ContextPipeline, PipelineInput, PipelineOutput } from './interfaces/context-pipeline.js';
export type { ErrorStrategy, ErrorAction, OverflowAction, SecurityAction } from './interfaces/error-strategy.js';
export type { Observer, Span, LogLevel } from './interfaces/observer.js';
export type { EventBus, AgentEvent, Disposable } from './event-bus.js';
export { AgentEvents } from './event-bus.js';
export type { SecurityGuard, SecurityCheckResult, SecurityViolation } from './security-guard.js';
export { IterationBudget } from './budget.js';
export type { IterationBudgetConfig, BudgetStatus } from './budget.js';
export type { Message, ToolCall, ToolResult, Turn, LLMMessage, ToolDefinition } from './types.js';
```

---

## 3. Layer 2: Harness — 装具层

### 设计原则

1. **通过接口挂载** — Harness 层实现 Core 的接口，通过 AgentEngine 的回调槽注入
2. **Session 管理在这里** — AgentEngine 是无状态的，Session 生命周期由 Harness 管理
3. **安全策略在这里** — Core 只有强制检查，策略配置在 Harness
4. **Persona 在这里** — 文件式人格系统，通过 ContextPipeline 注入

### 3.1 Persona — 文件式人格系统

```typescript
/**
 * Persona Loader — 从 workspace 目录加载 persona 文件
 *
 * 文件约定：
 * - AGENTS.md    — 操作指令（最高优先级）
 * - SOUL.md      — 人格特质、语调
 * - IDENTITY.md  — 身份定义
 * - USER.md      — 用户上下文
 * - TOOLS.md     — 工具使用说明
 * - *.md          — 任意扩展文件
 *
 * 所有文件都是可选的。加载后拼接为 system prompt。
 */
export class PersonaLoader {
  /** 从目录加载 persona */
  async load(workspace: string): Promise<string>;

  /** 组合多个 persona（基础 → 领域 → 场景） */
  async compose(...workspaces: string[]): Promise<string>;
}
```

### 3.2 ContextPipeline — 默认实现

```typescript
/**
 * 默认上下文管道 — Harness 层
 *
 * 采用阶段化管道模型：
 *   PersonaStage → SkillStage → HistoryStage → CompactStage → FilterStage
 *
 * 每个阶段可以独立替换或扩展。
 */
export class DefaultContextPipeline implements ContextPipeline {
  private stages: ContextStage[];

  constructor(config?: { stages?: ContextStage[] }) {
    this.stages = config?.stages ?? [
      new PersonaStage(),     // 注入 persona（system prompt）
      new SkillStage(),       // 注入匹配的 skill 内容
      new HistoryStage(),     // 组装消息历史
      new CompactStage(),     // 上下文压缩（如果超限）
      new FilterStage(),      // 标记不可信内容
    ];
  }

  async process(messages: Message[], input: PipelineInput): Promise<PipelineOutput> {
    let ctx: StageContext = { messages, ...input };
    for (const stage of this.stages) {
      ctx = await stage.process(ctx);
    }
    return ctx.toOutput();
  }
}

export interface ContextStage {
  readonly name: string;
  process(ctx: StageContext): Promise<StageContext>;
}
```

### 3.3 SessionAwareRunner — Session 管理

```typescript
/**
 * Session-Aware Runner — Harness 层
 *
 * 职责：在 AgentEngine 之上管理 Session 生命周期。
 * - 消息持久化
 * - Session 锁（同一 session 同时只有一个运行）
 * - Daily reset / Idle reset
 * - 并发控制
 */
export class SessionAwareRunner {
  constructor(
    private engine: AgentEngine,
    private store: SessionStore,
    private isolation?: SessionIsolation,
  ) {}

  /**
   * 处理一条消息
   *
   * 1. 加载 session
   * 2. 获取锁
   * 3. 追加消息
   * 4. 运行 AgentEngine
   * 5. 持久化
   * 6. 释放锁
   */
  async *handle(
    sessionId: string,
    input: Message,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    // Session 隔离检查
    if (this.isolation) {
      this.isolation.verifyAccess(sessionId, input.source);
    }

    const release = await this.acquireLock(sessionId);
    try {
      const session = await this.store.load(sessionId) ?? this.createSession(sessionId);
      session.messages.push(input);

      for await (const event of this.engine.run(session.messages, config, signal)) {
        yield event;
      }

      await this.store.save(sessionId, session);
    } finally {
      release();
    }
  }
}
```

### 3.4 Plugin System

```typescript
/**
 * Plugin Manager — Harness 层
 *
 * 职责：管理 Plugin 生命周期，将多个 Plugin 的 hooks 组合成回调注入 AgentEngine。
 * Plugin 不直接访问 AgentEngine，只能通过 PluginManager 提供的 PluginApi 操作。
 */
export class PluginManager {
  private plugins: LoadedPlugin[];

  register(plugin: LoadedPlugin): void;

  /**
   * 将所有 Plugin 的 hooks 组合成回调，注入到 AgentEngine
   * 按 priority 降序执行，支持拦截语义
   */
  applyTo(engine: AgentEngine): void {
    engine.onMessage = (msg) => this.runChain('onMessage', msg);
    engine.beforeAssemble = (input) => this.runChain('beforeAssemble', input);
    engine.beforeModelCall = (req) => this.runChain('beforeModelCall', req);
    engine.afterModelCall = (resp) => this.runChain('afterModelCall', resp);
    engine.beforeToolExec = (call) => this.runChain('beforeToolExec', call);
    engine.afterToolExec = (result) => this.runChain('afterToolExec', result);
    engine.afterTurn = (turn) => this.runChain('afterTurn', turn);
  }

  private runChain(hook: string, input: any): any {
    // 按 priority 降序执行
    // 返回非 null/undefined 中断链
  }
}

/**
 * Plugin 定义
 */
export interface PluginDefinition {
  name: string;
  description: string;
  version: string;
  trustLevel: PluginTrustLevel;
  hooks?: Partial<PluginHooks>;
  tools?: ToolDefinition[];
  services?: ServiceDefinition[];
}

export enum PluginTrustLevel {
  BUILTIN = 'builtin',       // 完全信任
  OFFICIAL = 'official',     // 基本信任
  THIRD_PARTY = 'third-party', // 有限信任
  UNTRUSTED = 'untrusted',   // 最小信任
}

/**
 * Plugin Hooks — Harness 层定义，不是 Core 的 LifecycleHooks
 */
export interface PluginHooks {
  onMessage(message: Message): Message | null;
  beforeAssemble(input: PipelineInput): PipelineInput;
  beforeModelCall(request: LLMRequest): LLMRequest | null;
  afterModelCall(response: LLMResponse): LLMResponse;
  beforeToolExec(call: ToolCall): ToolCall | null;
  afterToolExec(result: ToolResult): ToolResult;
  afterTurn(turn: Turn): void;
}
```

### 3.5 Skill System

```typescript
/**
 * Skill Manager — Harness 层
 *
 * 管理 SKILL.md 文件，根据用户意图匹配并注入到上下文。
 * 通过 ContextPipeline 的 SkillStage 注入。
 */
export class SkillManager {
  loadDirectory(skillsDir: string): void;
  match(message: Message, context?: MatchContext): SkillMatch | null;
  getContent(skillId: string): string | null;
}
```

### 3.6 Task System

```typescript
/**
 * Task Manager — Harness 层
 *
 * 通过 AgentEngine 的 afterTurn 回调槽注入。
 * 在每次回合后判断任务状态并更新。
 */
export class TaskManager {
  applyTo(engine: AgentEngine): void {
    const originalAfterTurn = engine.afterTurn;
    engine.afterTurn = (turn) => {
      originalAfterTurn?.(turn);
      this.processTurn(turn);
    };
  }
}
```

### 3.7 Tool Policy

```typescript
/**
 * 工具策略管理器 — Harness 层
 *
 * 控制 Agent 可以使用哪些工具，需要什么确认。
 * 通过 AgentEngine 的 beforeToolExec 回调槽注入。
 */
export class ToolPolicyManager {
  constructor(private policies: ToolPolicy[]) {}

  applyTo(engine: AgentEngine): void {
    const original = engine.beforeToolExec;
    engine.beforeToolExec = (call) => {
      const decision = this.check(call);
      if (!decision.allowed) return null; // 拒绝
      if (decision.requiresConfirmation) {
        // 通过事件总线请求确认
        engine.deps.events.emit({ type: 'tool.confirm_required', data: { call, reason: decision.reason } });
      }
      return original?.(call) ?? call;
    };
  }

  check(call: ToolCall): PolicyDecision;
}

export interface ToolPolicy {
  allow: ToolSelector[];
  deny?: ToolSelector[];
  requireConfirmation?: ToolSelector[];
}
```

### 3.8 Security Policy

```typescript
/**
 * 安全策略 — Harness 层
 *
 * 配置 SecurityGuard 的行为参数。
 * Core 层的 SecurityGuard 是强制的，Harness 层配置其策略。
 */
export interface SecurityPolicyConfig {
  /** 注入检测灵敏度 */
  injectionSensitivity: 'low' | 'medium' | 'high';
  /** 敏感信息模式（PII、密钥等） */
  sensitivePatterns: RegExp[];
  /** 不可信内容标记策略 */
  untrustedTagging: 'wrap' | 'prefix' | 'strip';
}
```

### 3.9 Agent Builder — 组装器

```typescript
/**
 * Agent Builder — Fluent API
 *
 * 集成方的主要入口。组装 Core + Harness 组件，一行代码启动 Agent。
 */
export class AgentBuilder {
  // ─── Core 组件 ───
  model(provider: ModelProvider): this;
  model(name: string): this;
  tools(...tools: RegisteredTool[]): this;
  executor(executor: ToolExecutor): this;

  // ─── Harness 组件 ───
  persona(workspace: string): this;
  persona(...workspaces: string[]): this;
  plugin(plugin: PluginDefinition): this;
  skill(skillDir: string): this;
  toolPolicy(policy: ToolPolicy): this;
  securityPolicy(config: SecurityPolicyConfig): this;
  errorStrategy(strategy: ErrorStrategy): this;
  contextPipeline(pipeline: ContextPipeline): this;

  // ─── 安全与约束 ───
  budget(config: IterationBudgetConfig): this;
  sandbox(level: SandboxLevel): this;

  // ─── 可观测性 ───
  observer(observer: Observer): this;
  events(bus: EventBus): this;

  // ─── 存储 ───
  store(store: SessionStore): this;

  // ─── 构建 ───
  build(): { engine: AgentEngine; runner: SessionAwareRunner };
  buildEngine(): AgentEngine;  // 只构建引擎，不构建 runner（无 Session 场景）
}
```

---

## 4. Layer 3: Integration — 集成层

### 4.1 Protocol Adapters

```typescript
abstract class ProtocolAdapter {
  constructor(protected runner: SessionAwareRunner) {}
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}

class HttpAdapter extends ProtocolAdapter { ... }
class WebSocketAdapter extends ProtocolAdapter { ... }
class StdioAdapter extends ProtocolAdapter { ... }
class FeishuAdapter extends ProtocolAdapter { ... }
```

### 4.2 Storage Backends

```typescript
/** JSONL 文件存储（默认） */
class JsonlSessionStore implements SessionStore { ... }
/** 内存存储（测试用） */
class InMemorySessionStore implements SessionStore { ... }
/** Redis 存储 */
class RedisSessionStore implements SessionStore { ... }
/** SQLite 存储 */
class SqliteSessionStore implements SessionStore { ... }
```

### 4.3 LLM Provider 实现

```typescript
class OpenAIProvider implements ModelProvider { ... }
class AnthropicProvider implements ModelProvider { ... }
```

### 4.4 Sandbox 实现

```typescript
/**
 * 沙盒级别
 */
enum SandboxLevel {
  NONE = 'none',           // 无沙盒（开发环境）
  PROCESS = 'process',     // 进程级隔离（fork + 权限限制）
  CONTAINER = 'container', // 容器级隔离（Docker）
  WASM = 'wasm',           // WASM 沙盒（最强隔离）
}

interface SandboxFactory {
  create(level: SandboxLevel): Sandbox;
}

interface Sandbox {
  execute(command: string, config: SandboxConfig): Promise<SandboxResult>;
}
```

### 4.5 Observability 实现

```typescript
/** No-op 观测器（默认，开发时用） */
class NoopObserver implements Observer { ... }
/** 日志观测器 */
class LogObserver implements Observer { ... }
/** OpenTelemetry 观测器 */
class OTelObserver implements Observer { ... }
```

### 4.6 Gateway（重构后）

```typescript
/**
 * Gateway — Integration 层
 *
 * 职责：组装 Agent + 挂载协议适配器 + 管理生命周期。
 * 不再包含 Agent 循环逻辑。
 */
class Gateway {
  static fromConfig(config: GatewayConfig): Gateway {
    const { engine, runner } = new AgentBuilder()
      .model(config.model)
      .persona(config.persona)
      .store(config.store ?? new JsonlSessionStore())
      .observer(config.observer ?? new NoopObserver())
      // ...
      .build();

    const adapters = config.adapters.map(a => createAdapter(a, runner));
    return new Gateway(engine, runner, adapters);
  }
}
```

---

## 5. 安全架构

### 5.1 五道防线

```
用户输入
  │
  ▼
┌──────────────────────────┐
│ ① 输入检测 (Core 强制)    │  SecurityGuard.checkUserInput()
│   prompt injection 检测   │  不可禁用，不可绕过
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐
│ ② 权限控制 (Harness 策略) │  ToolPolicyManager
│   工具白名单 + 参数约束    │  通过 beforeToolExec 回调注入
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐
│ ③ 沙盒执行 (Integration)  │  Sandbox.execute()
│   超时/资源/路径/网络限制   │  SandboxFactory 创建
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐
│ ④ 输出检测 (Core 强制)    │  SecurityGuard.checkModelOutput()
│   敏感信息过滤 + 注入检测   │  checkToolOutput()
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐
│ ⑤ 审计追踪 (Integration)  │  EventBus + Observer
│   全链路事件 + 指标 + 日志  │  通过事件订阅实现
└──────────────────────────┘
```

### 5.2 安全职责分层

| 层 | 安全职责 | 是否可绕过 |
|---|---|---|
| **Core** | SecurityGuard（注入检测、敏感信息过滤）、IterationBudget（资源约束）、Session 隔离 | ❌ 不可绕过 |
| **Harness** | ToolPolicy（工具权限）、SecurityPolicy（策略配置）、Plugin 信任分级、ErrorStrategy | ⚠️ 配置可改 |
| **Integration** | Sandbox（沙盒执行）、AuditLogger（审计日志）、RateLimiter（速率限制）、SecretManager（密钥管理） | ⚠️ 运维可控 |

### 5.3 关键安全设计

**密钥不经过 LLM：**
- 密钥由 ToolExecutor/Sandbox 层管理
- Agent 只调用工具名，不接触密钥
- SecretManager 在执行时注入密钥，日志中脱敏

**不可信内容标记：**
- ContextPipeline 的 FilterStage 标记外部内容
- SecurityGuard 在检查时使用 untrustedRanges
- 模型看到明确的不可信内容分隔符

**Plugin 信任分级：**
- BUILTIN：完全信任，所有能力
- OFFICIAL：基本信任，workspace 内文件访问
- THIRD_PARTY：有限信任，只能用声明的工具
- UNTRUSTED：最小信任，无工具、无文件、无网络

---

## 6. 目录结构

```
src/
├── core/                          # Layer 1: Core
│   ├── interfaces/                # 核心接口
│   │   ├── model-provider.ts
│   │   ├── tool-executor.ts
│   │   ├── context-pipeline.ts
│   │   ├── error-strategy.ts
│   │   ├── observer.ts
│   │   └── index.ts
│   ├── engine.ts                  # AgentEngine
│   ├── budget.ts                  # IterationBudget
│   ├── event-bus.ts               # EventBus
│   ├── security-guard.ts          # SecurityGuard
│   ├── types.ts                   # 核心类型
│   └── index.ts
│
├── harness/                       # Layer 2: Harness
│   ├── persona/
│   │   ├── loader.ts              # PersonaLoader
│   │   ├── composer.ts            # PersonaComposer
│   │   └── index.ts
│   ├── context/
│   │   ├── pipeline.ts            # DefaultContextPipeline
│   │   ├── stages/                # 管道阶段
│   │   │   ├── persona-stage.ts
│   │   │   ├── skill-stage.ts
│   │   │   ├── history-stage.ts
│   │   │   ├── compact-stage.ts
│   │   │   └── filter-stage.ts
│   │   └── index.ts
│   ├── plugins/
│   │   ├── manager.ts             # PluginManager
│   │   ├── loader.ts
│   │   ├── api.ts
│   │   ├── capability.ts
│   │   ├── entry.ts
│   │   ├── manifest.ts
│   │   └── index.ts
│   ├── skills/
│   │   ├── manager.ts             # SkillManager
│   │   └── index.ts
│   ├── tasks/
│   │   ├── manager.ts             # TaskManager
│   │   ├── tracker.ts
│   │   └── index.ts
│   ├── tools/
│   │   ├── policy.ts              # ToolPolicyManager
│   │   ├── builtin.ts
│   │   └── index.ts
│   ├── security/
│   │   ├── policy.ts              # SecurityPolicyConfig
│   │   └── index.ts
│   ├── runner.ts                  # SessionAwareRunner
│   ├── builder.ts                 # AgentBuilder
│   └── index.ts
│
├── integration/                   # Layer 3: Integration
│   ├── protocols/
│   │   ├── http.ts
│   │   ├── websocket.ts
│   │   ├── stdio.ts
│   │   └── index.ts
│   ├── storage/
│   │   ├── jsonl.ts               # JsonlSessionStore
│   │   ├── memory.ts              # InMemorySessionStore
│   │   ├── redis.ts
│   │   └── index.ts
│   ├── providers/
│   │   ├── openai.ts              # OpenAIProvider
│   │   ├── anthropic.ts           # AnthropicProvider
│   │   └── index.ts
│   ├── sandbox/
│   │   ├── factory.ts             # SandboxFactory
│   │   ├── process-sandbox.ts
│   │   ├── container-sandbox.ts
│   │   └── index.ts
│   ├── observability/
│   │   ├── noop-observer.ts
│   │   ├── log-observer.ts
│   │   ├── otel-observer.ts
│   │   └── index.ts
│   ├── gateway/
│   │   ├── gateway.ts
│   │   └── index.ts
│   └── index.ts
│
├── cli.ts
└── index.ts
```

### 包导出

```json
{
  "exports": {
    ".":                          "./dist/index.js",
    "./core":                     "./dist/core/index.js",
    "./harness":                  "./dist/harness/index.js",
    "./harness/persona":          "./dist/harness/persona/index.js",
    "./harness/plugins":          "./dist/harness/plugins/index.js",
    "./harness/skills":           "./dist/harness/skills/index.js",
    "./harness/tools":            "./dist/harness/tools/index.js",
    "./integration/protocols":    "./dist/integration/protocols/index.js",
    "./integration/storage":      "./dist/integration/storage/index.js",
    "./integration/providers":    "./dist/integration/providers/index.js"
  }
}
```

---

## 7. 公共 API

### 最简集成

```typescript
import { Octopi } from 'octopi';

const agent = Octopi.create({ model: 'gpt-4', persona: './my-agent' });
const reply = await agent.chat('你好');
```

### Builder 模式

```typescript
import { AgentBuilder } from 'octopi/harness';

const { engine, runner } = new AgentBuilder()
  .model('gpt-4')
  .persona('./personas/base')
  .persona('./personas/security')  // 叠加
  .store(new RedisSessionStore(redis))
  .plugin(myPlugin)
  .observer(new OTelObserver())
  .budget({ maxIterations: 15, maxTokens: 100000 })
  .build();
```

### 无 Session 模式

```typescript
// 单次调用，不需要 Session 管理
const engine = new AgentBuilder()
  .model('gpt-4')
  .persona('./reviewer')
  .buildEngine();

for await (const event of engine.run(messages, config)) {
  console.log(event);
}
```

### Agent-as-Tool

```typescript
const reviewer = Octopi.create({ model: 'gpt-4', persona: './reviewer' });
const coder = Octopi.create({ model: 'claude', persona: './coder' });

coder.tool({
  name: 'code_review',
  description: '审查代码质量',
  handler: async (input) => {
    const events = reviewer.run(input.code);
    return collectText(events);
  },
});
```

### 多协议挂载

```typescript
const { engine, runner } = new AgentBuilder().model('gpt-4').build();

new HttpAdapter(runner, { port: 3000 }).start();
new WebSocketAdapter(runner, { path: '/ws' }).start();
new StdioAdapter(runner).start();
```

### 事件订阅

```typescript
engine.events.on('model.call.end', (event) => {
  console.log(`模型调用完成: ${event.data.durationMs}ms`);
});

engine.events.on('injection.detected', (event) => {
  alert(`检测到注入: ${event.data.detail}`);
});
```

---

## 8. 迁移路径

### 原则

1. **渐进式** — 不做大爆炸重写
2. **向后兼容** — 保留旧 API 作为 deprecated 别名
3. **测试先行** — 每一步都有测试覆盖

### 阶段

| Phase | 内容 | 工作量 | 风险 |
|---|---|---|---|
| 1 | Core 接口抽取（ModelProvider, ToolExecutor, ContextPipeline, ErrorStrategy, Observer） | 2-3 天 | 低 |
| 2 | Core 内置组件（EventBus, SecurityGuard, IterationBudget） | 2-3 天 | 低 |
| 3 | AgentEngine 抽取（无状态循环，回调槽） | 2-3 天 | 中 |
| 4 | 目录重组（core/ + harness/ + integration/） | 1-2 天 | 中 |
| 5 | Harness 组件（PersonaLoader, DefaultContextPipeline, SessionAwareRunner, AgentBuilder） | 3-4 天 | 低 |
| 6 | 安全加固（SecurityPolicy, Sandbox, CapabilityEnforcer） | 3-4 天 | 中 |
| 7 | 清理文档（移除 deprecated，更新 README，版本升级） | 1-2 天 | 低 |
| **合计** | | **14-21 天** | |

### 验证标准

每个阶段完成后：
1. ✅ 所有现有测试通过
2. ✅ 新接口有契约测试
3. ✅ 公共 API 向后兼容
4. ✅ 文档同步更新

---

## 附录：当前文件 → 重构后位置

| 当前文件 | 重构后位置 | 说明 |
|---|---|---|
| `src/core/types.ts` | `src/core/types.ts` + `src/core/interfaces/` | 类型保留，接口拆分 |
| `src/agent/agent-runner.ts` | `src/core/engine.ts` + `src/harness/runner.ts` + `src/harness/builder.ts` | 三向拆解 |
| `src/agent/session-manager.ts` | `src/harness/runner.ts` + `src/integration/storage/jsonl.ts` | 接口+实现分离 |
| `src/context/engine.ts` | `src/core/interfaces/context-pipeline.ts` + `src/harness/context/pipeline.ts` | 管道化 |
| `src/providers/router.ts` | Harness 层模型选择逻辑 | 路由上移 |
| `src/providers/openai.ts` | `src/integration/providers/openai.ts` | 移动 |
| `src/providers/anthropic.ts` | `src/integration/providers/anthropic.ts` | 移动 |
| `src/tools/registry.ts` | `src/core/interfaces/tool-executor.ts` + `src/harness/tools/` | 拆分 |
| `src/tools/builtin.ts` | `src/harness/tools/builtin.ts` | 移动 |
| `src/plugins/*` | `src/harness/plugins/*` | 移动 |
| `src/skills/manager.ts` | `src/harness/skills/manager.ts` | 移动 |
| `src/tasks/*` | `src/harness/tasks/*` | 移动 |
| `src/loop/*` | `src/core/loop/*` | 移动 |
| `src/protocol/http.ts` | `src/integration/protocols/http.ts` | 移动 |
| `src/gateway/*` | `src/integration/gateway/*` | 移动 |
| `src/config.ts` | `src/harness/config.ts` | 配置属于 Harness |
| `src/cli.ts` | `src/cli.ts` | 不变 |
