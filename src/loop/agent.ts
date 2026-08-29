/**
 * Agent — 状态管理 + 生命周期 + 消息队列
 *
 * 职责：
 * - 管理消息历史（context.messages）
 * - 管理工具列表（context.tools）
 * - 提供消息队列（steering / followUp）
 * - 提供 run() / continue_() 生命周期
 * - 提供事件订阅（subscribe）
 *
 * 不包含：可靠性机制、安全检查、任务监督。这些在 Harness 层。
 */

import type { Message, TokenUsage } from '../core/types.js';
import type { ModelProvider } from '../core/interfaces/model-provider.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopEvent,
  AgentTool,
  LoopObserver,
  BeforeToolCallFn,
  AfterToolCallFn,
  ShouldStopAfterTurnFn,
  OnTurnCompleteFn,
  PrepareNextTurnFn,
  OnErrorFn,
} from './types.js';
import { agentLoop } from './agent-loop.js';

// ── 消息队列 ──

type QueueMode = 'all' | 'one-at-a-time';

class PendingMessageQueue {
  private messages: Message[] = [];
  public mode: QueueMode;

  constructor(mode: QueueMode) {
    this.mode = mode;
  }

  enqueue(message: Message): void {
    this.messages.push(message);
  }

  hasItems(): boolean {
    return this.messages.length > 0;
  }

  drain(): Message[] {
    if (this.mode === 'all') {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }
    const first = this.messages[0];
    if (!first) return [];
    this.messages = this.messages.slice(1);
    return [first];
  }

  clear(): void {
    this.messages = [];
  }
}

// ── Agent 选项 ──

export interface AgentOptions {
  /** 模型提供者（唯一必需） */
  model: ModelProvider;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 初始工具列表 */
  tools?: AgentTool[];

  // ── 消息格式边界 ──
  convertToLlm?: (messages: Message[]) => Promise<any[]>;

  // ── 上下文变换 ──
  transformContext?: (messages: Message[], signal?: AbortSignal) => Promise<Message[]>;

  // ── 工具执行回调 ──
  beforeToolCall?: BeforeToolCallFn;
  afterToolCall?: AfterToolCallFn;
  toolExecution?: 'parallel' | 'sequential';

  // ── 轮次控制回调 ──
  shouldStopAfterTurn?: ShouldStopAfterTurnFn;
  onTurnComplete?: OnTurnCompleteFn;
  prepareNextTurn?: PrepareNextTurnFn;
  onError?: OnErrorFn;

  // ── 可观测性 ──
  observer?: LoopObserver;

  // ── 超时配置 ──
  modelCallIdleTimeoutMs?: number;
  modelCallAbsoluteTimeoutMs?: number;

  // ── 队列模式 ──
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
}

// ── Agent 类 ──

type EventListener = (event: AgentLoopEvent, signal: AbortSignal) => Promise<void> | void;

export class Agent {
  private _context: AgentContext;
  private _config: AgentLoopConfig;
  private _abortController?: AbortController;
  private _activeRun?: { promise: Promise<void>; resolve: () => void };
  private _listeners = new Set<EventListener>();

  // ── 消息队列 ──
  private _steeringQueue: PendingMessageQueue;
  private _followUpQueue: PendingMessageQueue;

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
      getSteeringMessages: async () => this._steeringQueue.drain(),
      getFollowUpMessages: async () => this._followUpQueue.drain(),
    };
    this._steeringQueue = new PendingMessageQueue(options.steeringMode ?? 'one-at-a-time');
    this._followUpQueue = new PendingMessageQueue(options.followUpMode ?? 'one-at-a-time');
  }

  // ── 状态 ──
  get context(): AgentContext { return this._context; }
  get messages(): Message[] { return this._context.messages; }
  get tools(): AgentTool[] { return this._context.tools ?? []; }
  get isRunning(): boolean { return !!this._activeRun; }
  get model(): ModelProvider { return this._config.model; }

  // ── 消息队列 API ──
  /** 注入 steering 消息（当前 turn 结束后立即注入） */
  steer(message: Message): void { this._steeringQueue.enqueue(message); }
  /** 注入 followUp 消息（agent 即将停止时注入） */
  followUp(message: Message): void { this._followUpQueue.enqueue(message); }
  /** 清空所有队列 */
  clearQueues(): void { this._steeringQueue.clear(); this._followUpQueue.clear(); }
  /** 是否有待处理的队列消息 */
  hasQueuedMessages(): boolean { return this._steeringQueue.hasItems() || this._followUpQueue.hasItems(); }

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

  // ── 运行 ──

  /**
   * 运行 Agent（需要新输入）
   *
   * @param input - 用户输入（字符串或消息数组）
   * @param signal - 外部中止信号
   * @yields AgentLoopEvent 事件流
   */
  async *run(input: string | Message[], signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
    if (this._activeRun) throw new Error('Agent is already running');

    // 将输入加入消息历史
    const newMessages: Message[] = typeof input === 'string'
      ? [{ role: 'user', content: input, timestamp: Date.now() }]
      : input;
    this._context.messages.push(...newMessages);

    yield* this._runLoop(signal);
  }

  /**
   * 从当前状态继续运行（不需要新输入）
   *
   * 最后一条消息必须是 user 或 tool（不能是 assistant）。
   * 用于：steering 后继续、断点续跑、多轮对话。
   */
  async *continue_(signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
    if (this._activeRun) throw new Error('Agent is already running');

    const lastMessage = this._context.messages[this._context.messages.length - 1];
    if (!lastMessage) throw new Error('No messages to continue from');
    if (lastMessage.role === 'assistant') {
      // 如果最后一条是 assistant，检查是否有排队消息
      const queuedSteering = this._steeringQueue.drain();
      if (queuedSteering.length > 0) {
        this._context.messages.push(...queuedSteering);
      } else {
        throw new Error('Cannot continue from assistant message. Use steer() to inject a message first.');
      }
    }

    yield* this._runLoop(signal);
  }

  /**
   * 内部循环运行器（run 和 continue_ 共享）
   */
  private async *_runLoop(signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
    const abortController = new AbortController();
    this._abortController = abortController;
    const effectiveSignal = signal
      ? AbortSignal.any([signal, abortController.signal])
      : abortController.signal;

    let resolvePromise = () => {};
    this._activeRun = {
      promise: new Promise<void>((resolve) => { resolvePromise = resolve; }),
      resolve: resolvePromise,
    };

    try {
      for await (const event of agentLoop(this._context, this._config, effectiveSignal)) {
        // 更新内部状态（assistant 消息已在 agentLoop 内部加入 context.messages）
        // 通知监听器
        for (const listener of this._listeners) {
          await listener(event, effectiveSignal);
        }
        yield event;
      }
    } catch (error) {
      // 错误恢复：确保 agent_end 事件被发出
      const errorEvent: AgentLoopEvent = {
        type: 'agent_end',
        reason: 'error',
        timestamp: Date.now(),
        error,
      };
      for (const listener of this._listeners) {
        await listener(errorEvent, effectiveSignal);
      }
      yield errorEvent;
    } finally {
      this._activeRun = undefined;
      this._abortController = undefined;
      resolvePromise();
    }
  }

  /** 中止当前运行 */
  abort(): void {
    this._abortController?.abort();
  }

  /** 等待当前运行完成 */
  waitForIdle(): Promise<void> {
    return this._activeRun?.promise ?? Promise.resolve();
  }

  /** 重置状态（不能在运行中调用） */
  reset(): void {
    if (this._activeRun) throw new Error('Cannot reset while running');
    this._context.messages = [];
    this.clearQueues();
  }

  /** 订阅事件 */
  subscribe(listener: EventListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }
}
