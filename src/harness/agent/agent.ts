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
import type { HarnessLoopEvent } from '../reliability/harness-events.js';

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

  /**
   * 运行 Agent（推荐唯一入口）
   *
   * 内部 = runAgentWithReliability(context, config, harness)。
   * 产出 HarnessLoopEvent（Loop 协议事件 + budget/run_guard 扩展）。
   *
   * @param signal - 中止信号
   * @param harnessOverride - 临时覆盖 harness（测试/多租户）；默认用实例 harness
   */
  run(
    signal?: AbortSignal,
    harnessOverride?: ReliabilityHarness,
  ): AsyncGenerator<HarnessLoopEvent> {
    const harness = harnessOverride ?? this._harness;
    if (!harness) {
      throw new Error(
        'Agent.run() requires a ReliabilityHarness. Pass it to the constructor or call setHarness() first.',
      );
    }
    return runAgentWithReliability(this._context, this._config, harness, signal);
  }
}

/** 供需要纯 Loop 事件类型的调用方引用 */
export type { AgentLoopEvent };
