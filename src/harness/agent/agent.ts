/**
 * Agent — Harness 层运行时门面
 *
 * 职责：
 * - 持有 AgentContext（消息 / 工具 / systemPrompt）
 * - 持有 AgentLoopConfig 与 ReliabilityHarness
 * - `run()` = runAgentWithReliability：**唯一推荐入口**，自带可靠性包装
 *
 * 分层：Loop 只提供 agentLoop 纯函数；Agent 作为可运行门面住在 Harness，
 * 因此可以合法依赖 reliability，而不让 Loop 反向依赖策略。
 */

import type { Message } from '../../core/types.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopEvent,
  AgentTool,
} from '../../loop/types.js';
import type { ReliabilityHarness } from '../reliability/run-agent.js';
import { runAgentWithReliability } from '../reliability/run-agent.js';
import { withResolvedModel } from '../model/run-scope.js';
import { withRunScope } from '../run-scope.js';
import type { ResolvedModel } from '../model/types.js';
import type { HarnessLoopEvent } from '../reliability/harness-events.js';
import { compactStateKey } from '../context/compact-key.js';

// ── Agent 选项 ──

export interface AgentOptions {
  /** 模型提供者（唯一必需的运行时依赖） */
  model: ModelProvider;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 初始工具列表 */
  tools?: AgentTool[];

  /**
   * 可靠性装备。可稍后 `setHarness()`；`run()` 前必须已就绪。
   * Builder 组装路径会注入完整 harness。
   */
  harness?: ReliabilityHarness;

  // ── 消息格式边界 ──
  convertToLlm?: AgentLoopConfig['convertToLlm'];

  // ── 上下文变换 ──
  transformContext?: (messages: Message[], signal?: AbortSignal) => Promise<Message[]>;

  // ── 工具执行回调 ──
  beforeToolCall?: AgentLoopConfig['beforeToolCall'];
  afterToolCall?: AgentLoopConfig['afterToolCall'];
  toolExecution?: 'parallel' | 'sequential';

  // ── 轮次控制回调 ──
  shouldStopAfterTurn?: AgentLoopConfig['shouldStopAfterTurn'];
  onTurnComplete?: AgentLoopConfig['onTurnComplete'];
  prepareNextTurn?: AgentLoopConfig['prepareNextTurn'];
  onError?: AgentLoopConfig['onError'];

  // ── 消息队列 ──
  getSteeringMessages?: AgentLoopConfig['getSteeringMessages'];
  getFollowUpMessages?: AgentLoopConfig['getFollowUpMessages'];

  // ── 可观测性 ──
  observer?: AgentLoopConfig['observer'];

  // ── 超时配置 ──
  modelCallIdleTimeoutMs?: number;
  modelCallAbsoluteTimeoutMs?: number;
}

// ── Agent 类 ──

export class Agent {
  private _context: AgentContext;
  private _config: AgentLoopConfig;
  private _harness: ReliabilityHarness | undefined;
  /**
   * ContextEngine 按 session 维护 CompactState。
   * SessionAwareRunner 在 handle() 开始时注入真实 sessionId，避免多会话串味。
   */
  private _contextSessionId = 'default';
  /** sessionId → 压缩状态快照；Runner 从 Session 播种，assemble 后回写 Session */
  private _sessionCompactStates = new Map<string, {
    summary?: string;
    lastProactiveMessageCount?: number;
    lastProactiveTokens?: number;
  }>();
  private _onAfterTurn?: (usage?: import('../../core/types/turn.js').TokenUsage, turn?: Message[]) => Promise<void>;

  constructor(options: AgentOptions) {
    this._context = {
      systemPrompt: options.systemPrompt ?? '',
      messages: [],
      tools: options.tools ?? [],
    };
    this._harness = options.harness;
    this._config = {
      model: options.model,
      convertToLlm: options.convertToLlm,
      transformContext: options.transformContext,
      beforeToolCall: options.beforeToolCall,
      afterToolCall: options.afterToolCall,
      shouldStopAfterTurn: options.shouldStopAfterTurn,
      onTurnComplete: options.onTurnComplete,
      prepareNextTurn: options.prepareNextTurn,
      onError: options.onError,
      observer: options.observer,
      getSteeringMessages: options.getSteeringMessages,
      getFollowUpMessages: options.getFollowUpMessages,
      toolExecution: options.toolExecution ?? 'parallel',
      modelCallIdleTimeoutMs: options.modelCallIdleTimeoutMs,
      modelCallAbsoluteTimeoutMs: options.modelCallAbsoluteTimeoutMs,
    };
  }

  // ── 状态与配置访问 ──

  get context(): AgentContext { return this._context; }
  get messages(): Message[] { return this._context.messages; }
  get tools(): AgentTool[] { return this._context.tools ?? []; }
  get model(): ModelProvider { return this._config.model; }
  /**
   * 配置快照（浅拷贝）。改返回值不影响实例；请用 setModel 等 API 变更。
   * 不是 deep-freeze，嵌套引用仍共享。
   */
  get config(): Readonly<AgentLoopConfig> {
    return { ...this._config };
  }
  get harness(): ReliabilityHarness | undefined { return this._harness; }

  // ── 工具管理 ──

  registerTool(tool: AgentTool): void {
    this._context.tools = [...(this._context.tools ?? []), tool];
  }

  setTools(tools: AgentTool[]): void {
    this._context.tools = [...tools];
  }

  // ── 动态配置 ──

  setModel(model: ModelProvider): void {
    this._config = { ...this._config, model };
  }

  setSystemPrompt(prompt: string): void {
    this._context.systemPrompt = prompt;
  }

  setHarness(harness: ReliabilityHarness): void {
    this._harness = harness;
  }

  /** 当前 ContextEngine 会话键（多 Session 时由 Runner 注入） */
  get contextSessionId(): string {
    return this._contextSessionId;
  }

  /** 设置 ContextEngine 会话键 */
  setContextSessionId(sessionId: string): void {
    this._contextSessionId = sessionId;
  }

  /**
   * 播种/更新会话压缩状态快照（Runner 从 SessionData 注入）
   *
   * E4：键 = `(sessionId, agentId)`，不按纯 sessionId 共享。
   *
   * @param sessionId - 会话 id
   * @param agentId - 产出/消费该 compact 视图的 agent
   * @param state - 快照；undefined 清除
   */
  setSessionCompactState(
    sessionId: string,
    agentId: string,
    state: { summary?: string; lastProactiveMessageCount?: number; lastProactiveTokens?: number } | undefined,
  ): void {
    const key = compactStateKey(sessionId, agentId);
    if (state && (state.summary || state.lastProactiveMessageCount != null)) {
      this._sessionCompactStates.set(key, { ...state });
    } else {
      this._sessionCompactStates.delete(key);
    }
  }

  /**
   * 读取会话压缩状态快照（E4 键）
   *
   * @param sessionId - 会话 id
   * @param agentId - 目标 agent
   * @returns 快照；无则 undefined
   */
  getSessionCompactState(sessionId: string, agentId: string):
    | { summary?: string; lastProactiveMessageCount?: number; lastProactiveTokens?: number }
    | undefined {
    return this._sessionCompactStates.get(compactStateKey(sessionId, agentId));
  }

  /** 每轮结束后通知 ContextEngine（afterTurn 校准等）；turn 为本轮增量消息 */
  setOnAfterTurn(fn?: (usage?: import('../../core/types/turn.js').TokenUsage, turn?: Message[]) => Promise<void>): void {
    this._onAfterTurn = fn;
  }

  /** 由 Runner 在 turn 结束后调用 */
  async notifyAfterTurn(usage?: import('../../core/types/turn.js').TokenUsage, turn?: Message[]): Promise<void> {
    if (this._onAfterTurn) {
      await this._onAfterTurn(usage, turn);
    }
  }

  /** 动态替换 convertToLlm（ContextEngine 接线等） */
  setConvertToLlm(fn?: AgentLoopConfig['convertToLlm']): void {
    this._config = { ...this._config, convertToLlm: fn };
  }

  /** 动态替换 transformContext */
  setTransformContext(fn?: AgentLoopConfig['transformContext']): void {
    this._config = { ...this._config, transformContext: fn };
  }

  /**
   * 运行 Agent（推荐唯一入口）
   *
   * `options.resolvedModel` 为 run 级模型快照（方案 B 收口）：
   * - `config.model` 使用 snapshot.provider
   * - ALS 注入完整 snapshot，convertToLlm/summarize 只读不再 resolve
   *
   * `options.context`（宪法 I1）：本 Run 的 AgentContext 工作区。
   * 生产路径（SessionAwareRunner）必须传入；省略时退回实例上的 `_context`
   * （单测 / 旧 multi-agent 路径）。不得将共享实例当作多 session 工作区。
   *
   * `options.runScope`：本 Run 身份，经 ALS 供 convertToLlm / 工具 / checkpoint 读取。
   *
   * @param signal - 中止信号
   * @param harnessOverride - 临时覆盖 harness
   * @param options - run 级覆盖
   */
  run(
    signal?: AbortSignal,
    harnessOverride?: ReliabilityHarness,
    options?: {
      /** 已解析模型快照（唯一推荐） */
      resolvedModel?: ResolvedModel;
      /** 本 Run 的上下文工作区（I1）；缺省用实例 _context */
      context?: AgentContext;
      /** 本 Run 身份（sessionId/agentId/systemPrompt/toolRuntime） */
      runScope?: import('../run-scope.js').RunScope;
      /** @deprecated 旧路径：仅绑定 provider */
      model?: ModelProvider;
      /** @deprecated 旧路径：仅窗口 */
      contextWindow?: number;
    },
  ): AsyncGenerator<HarnessLoopEvent> {
    const harness = harnessOverride ?? this._harness;
    if (!harness) {
      throw new Error(
        'Agent.run() requires a ReliabilityHarness. Pass it to the constructor or call setHarness() first.',
      );
    }
    const resolved = options?.resolvedModel;
    const loopModel = resolved?.provider ?? options?.model;
    const config = loopModel ? { ...this._config, model: loopModel } : this._config;
    const context = options?.context ?? this._context;
    const runScope: import('../run-scope.js').RunScope = {
      sessionId: options?.runScope?.sessionId ?? this._contextSessionId,
      agentId: options?.runScope?.agentId ?? harness.agentId ?? 'default',
      systemPrompt: options?.runScope?.systemPrompt ?? context.systemPrompt,
      toolRuntime: options?.runScope?.toolRuntime,
      agentRevision: options?.runScope?.agentRevision,
    };

    let gen = runAgentWithReliability(context, config, harness, signal);
    gen = withRunScope(runScope, gen);
    if (resolved) {
      return withResolvedModel(resolved, gen);
    }
    // 兼容：无完整 snapshot 时仍进入模型 ALS
    if (options?.model) {
      const fallbackSnapshot: ResolvedModel = {
        ref: `${options.model.name}/${options.model.defaultModel ?? ''}`,
        providerName: options.model.name,
        modelName: options.model.defaultModel ?? '',
        provider: options.model,
        contextWindow: options.contextWindow,
        source: options.contextWindow != null ? 'config' : 'unknown',
        known: options.contextWindow != null,
        isOverride: false,
      };
      return withResolvedModel(fallbackSnapshot, gen);
    }
    return withResolvedModel(undefined, gen);
  }
}

/** 供需要纯 Loop 事件类型的调用方引用 */
export type { AgentLoopEvent };
