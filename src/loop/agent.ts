/**
 * Agent — 状态容器 + 上下文持有者
 *
 * 职责：
 * - 管理消息历史（context.messages）
 * - 管理工具列表（context.tools）
 * - 提供配置与上下文访问能力
 *
 * 不包含：运行入口、可靠性机制、安全检查、任务监督。
 * 实际执行应通过 Harness 层的 runAgentWithReliability() 完成。
 */

import type { Message } from '../core/types.js';
import type { ModelProvider } from '../core/interfaces/model-provider.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentTool,
} from './types.js';

// ── Agent 选项 ──

export interface AgentOptions {
  /** 模型提供者（唯一必需） */
  model: ModelProvider;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 初始工具列表 */
  tools?: AgentTool[];

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

  constructor(options: AgentOptions) {
    this._context = {
      systemPrompt: options.systemPrompt ?? '',
      messages: [],
      tools: options.tools ?? [],
    };
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
}
