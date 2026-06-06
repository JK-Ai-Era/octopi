/**
 * ProcessModel — Agent 进程模型
 *
 * 这是 Agent 进程生命周期的最小抽象。
 * 类比 Erlang OTP 的 process：有状态、可通信、可监控。
 *
 * 状态机：
 *   born → running → sleeping → running → ... → dead
 *                    ↓                     ↑
 *                  waiting → running ──────┘
 *
 * 设计原则：
 * - 进程有独立的生命周期，不绑定到单次对话
 * - 父子进程关系：父进程可以 spawn 子进程
 * - 进程间通信：通过 MessageChannel
 * - 状态持久化：通过 ProcessStore（可选）
 * - 可观测：所有状态变更通过 EventBus
 */

import { randomUUID } from 'node:crypto';
import type { EventBus, AgentEvent } from './event-bus.js';
import type { MessageChannel, ProcessMessage } from './interfaces/message-channel.js';

// ── 进程状态 ──

/** 进程状态 */
export type ProcessState = 'born' | 'running' | 'sleeping' | 'waiting' | 'dead';

/** 进程退出原因 */
export type ExitReason = 'normal' | 'killed' | 'error' | 'timeout' | 'parent_exit';

/** 进程退出信息 */
export interface ExitInfo {
  reason: ExitReason;
  error?: string;
  timestamp: number;
}

// ── 进程事件 ──

export const ProcessEvents = {
  SPAWNED: 'process.spawned',
  RUNNING: 'process.running',
  SLEEPING: 'process.sleeping',
  WAITING: 'process.waiting',
  MESSAGE_SENT: 'process.message.sent',
  MESSAGE_RECEIVED: 'process.message.received',
  EXITED: 'process.exited',
  CHILD_SPAWNED: 'process.child.spawned',
  CHILD_EXITED: 'process.child.exited',
} as const;

// ── 配置 ──

/** ProcessModel 创建选项 */
export interface ProcessOptions {
  /** 进程 ID（不传则自动生成） */
  id?: string;
  /** 进程名称（用于日志和调试） */
  name?: string;
  /** 所属 Agent ID */
  agentId?: string;
  /** 父进程 ID */
  parentId?: string;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/** 进程执行函数 */
export type ProcessBody = (
  ctx: ProcessContext,
) => Promise<void>;

/** 进程执行上下文 — 传给进程体的控制接口 */
export interface ProcessContext {
  /** 进程 ID */
  readonly id: string;
  /** 进程名称 */
  readonly name: string;
  /** 进程当前状态 */
  readonly state: ProcessState;
  /** AbortSignal，进程被 kill 时触发 */
  readonly signal: AbortSignal;

  /** 发送消息给其他进程 */
  send(to: string, type: string, payload: unknown): Promise<void>;

  /** 等待特定类型的消息 */
  receive(type: string, timeoutMs?: number): Promise<ProcessMessage>;

  /** 休眠指定时间 */
  sleep(ms: number): Promise<void>;

  /** spawn 子进程 */
  spawn(body: ProcessBody, options?: ProcessOptions): ProcessModel;

  /** 等待子进程完成 */
  waitChild(childId: string, timeoutMs?: number): Promise<ExitInfo>;

  /** 主动退出 */
  exit(reason?: ExitReason, error?: string): void;
}

// ── ProcessModel ──

/**
 * ProcessModel — Agent 进程
 *
 * 封装一个可运行、可通信、可监控的 Agent 进程。
 */
export class ProcessModel {
  readonly id: string;
  readonly name: string;
  readonly agentId?: string;
  readonly parentId?: string;
  readonly createdAt: number;

  private _state: ProcessState = 'born';
  private _exitInfo?: ExitInfo;
  private _abortController = new AbortController();
  private _children = new Map<string, ProcessModel>();
  private _messageHandlers = new Map<string, Array<(msg: ProcessMessage) => void>>();
  private _pendingReceives = new Map<string, Array<{
    type: string;
    resolve: (msg: ProcessMessage) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>>();
  private _parent?: ProcessModel;
  private _body?: ProcessBody;
  private _runPromise?: Promise<void>;

  // 外部依赖
  private readonly _events?: EventBus;
  private readonly _channel?: MessageChannel;

  constructor(options: ProcessOptions, events?: EventBus, channel?: MessageChannel) {
    this.id = options.id ?? randomUUID();
    this.name = options.name ?? `process-${this.id.slice(0, 8)}`;
    this.agentId = options.agentId;
    this.parentId = options.parentId;
    this.createdAt = Date.now();
    this._events = events;
    this._channel = channel;
  }

  // ── 状态访问器 ──

  /** 当前状态 */
  get state(): ProcessState { return this._state; }

  /** 是否存活 */
  get alive(): boolean { return this._state !== 'dead'; }

  /** 退出信息（退出后有值） */
  get exitInfo(): ExitInfo | undefined { return this._exitInfo; }

  /** 子进程列表 */
  get children(): readonly ProcessModel[] { return Array.from(this._children.values()); }

  /** AbortSignal */
  get signal(): AbortSignal { return this._abortController.signal; }

  // ── 生命周期 ──

  /**
   * 启动进程
   *
   * @param body - 进程执行函数
   * @returns 进程退出时 resolve 的 Promise
   */
  async run(body: ProcessBody): Promise<void> {
    if (this._state !== 'born') {
      throw new Error(`Process ${this.id} already running (state: ${this._state})`);
    }

    this._body = body;
    this._state = 'running';
    this._emit(ProcessEvents.RUNNING);

    const ctx = this._createContext();

    this._runPromise = (async () => {
      try {
        await body(ctx);
        this._exit('normal');
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this._exit('error', error);
      }
    })();

    await this._runPromise;
  }

  /**
   * 终止进程
   *
   * @param reason - 终止原因
   * @param error - 错误信息
   */
  kill(reason: ExitReason = 'killed', error?: string): void {
    if (this._state === 'dead') return;

    this._abortController.abort();
    this._exit(reason, error);

    // 同时终止所有子进程
    for (const child of this._children.values()) {
      if (child.alive) {
        child.kill('parent_exit', `Parent ${this.id} exited`);
      }
    }
  }

  /**
   * 休眠进程
   *
   * 休眠期间不处理消息，但可以被 kill 唤醒。
   */
  async sleep(ms: number): Promise<void> {
    if (this._state !== 'running') {
      throw new Error(`Process ${this.id} cannot sleep (state: ${this._state})`);
    }

    this._state = 'sleeping';
    this._emit(ProcessEvents.SLEEPING);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this._state === 'sleeping') {
          this._state = 'running';
          this._emit(ProcessEvents.RUNNING);
        }
        resolve();
      }, ms);

      // 被 kill 时也要 resolve
      this._abortController.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  // ── 进程间通信 ──

  /**
   * 注册消息处理器
   */
  onMessage(type: string, handler: (msg: ProcessMessage) => void): { dispose(): void } {
    if (!this._messageHandlers.has(type)) {
      this._messageHandlers.set(type, []);
    }
    this._messageHandlers.get(type)!.push(handler);
    return {
      dispose: () => {
        const handlers = this._messageHandlers.get(type);
        if (handlers) {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        }
      },
    };
  }

  /**
   * 投递消息到此进程
   *
   * @internal 由 MessageChannel 或父进程调用
   */
  deliverMessage(message: ProcessMessage): void {
    if (this._state === 'dead') return;

    this._emit(ProcessEvents.MESSAGE_RECEIVED, { from: message.from, type: message.type });

    // 检查是否有等待中的 receive
    const pending = this._pendingReceives.get(message.type);
    if (pending && pending.length > 0) {
      const waiter = pending.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }

    // 通配符等待
    const wildcardPending = this._pendingReceives.get('*');
    if (wildcardPending && wildcardPending.length > 0) {
      const waiter = wildcardPending.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }

    // 触发注册的处理器
    const handlers = this._messageHandlers.get(message.type)
      ?? this._messageHandlers.get('*');
    if (handlers) {
      for (const handler of handlers) {
        try { handler(message); } catch { /* 不阻塞 */ }
      }
    }
  }

  // ── 内部方法 ──

  private _createContext(): ProcessContext {
    return {
      id: this.id,
      name: this.name,
      state: this._state,
      signal: this._abortController.signal,

      send: async (to, type, payload) => {
        const message: Omit<ProcessMessage, 'id' | 'timestamp'> = {
          from: this.id,
          to,
          type,
          payload,
        };

        if (this._channel) {
          await this._channel.send(message);
        } else {
          // 尝试直接投递给目标进程（同一进程树内）
          const target = this._findChild(to) ?? this._parent;
          if (target && target.id === to) {
            target.deliverMessage({
              ...message,
              id: randomUUID(),
              timestamp: Date.now(),
            });
          }
        }

        this._emit(ProcessEvents.MESSAGE_SENT, { to, type });
      },

      receive: (type, timeoutMs) => {
        return new Promise<ProcessMessage>((resolve, reject) => {
          const entry = { type, resolve } as {
            type: string;
            resolve: (msg: ProcessMessage) => void;
            timer?: ReturnType<typeof setTimeout>;
          };

          if (timeoutMs && timeoutMs > 0) {
            entry.timer = setTimeout(() => {
              // 从等待队列移除
              const arr = this._pendingReceives.get(type);
              if (arr) {
                const idx = arr.indexOf(entry);
                if (idx >= 0) arr.splice(idx, 1);
              }
              reject(new Error(`Receive timeout after ${timeoutMs}ms`));
            }, timeoutMs);
          }

          if (!this._pendingReceives.has(type)) {
            this._pendingReceives.set(type, []);
          }
          this._pendingReceives.get(type)!.push(entry);
        });
      },

      sleep: (ms) => this.sleep(ms),

      spawn: (body, opts) => {
        const child = this._spawnChild(body, opts);
        return child;
      },

      waitChild: (childId, timeoutMs) => {
        const child = this._children.get(childId);
        if (!child) return Promise.resolve({ reason: 'normal' as ExitReason, timestamp: Date.now() });

        if (child._state === 'dead' && child._exitInfo) {
          return Promise.resolve(child._exitInfo);
        }

        return new Promise<ExitInfo>((resolve) => {
          const check = () => {
            if (child._state === 'dead' && child._exitInfo) {
              resolve(child._exitInfo);
            }
          };

          // 监听退出事件
          const sub = this._events?.on(ProcessEvents.EXITED, (event) => {
            if (event.data?.childId === childId) {
              sub?.dispose();
              resolve(child._exitInfo!);
            }
          });

          if (timeoutMs && timeoutMs > 0) {
            setTimeout(() => {
              sub?.dispose();
              resolve({ reason: 'timeout', timestamp: Date.now() });
            }, timeoutMs);
          }

          // 兜底检查
          check();
        });
      },

      exit: (reason, error) => {
        this._exit(reason ?? 'normal', error);
      },
    };
  }

  private _spawnChild(body: ProcessBody, options?: ProcessOptions): ProcessModel {
    const child = new ProcessModel(
      {
        ...options,
        parentId: this.id,
        agentId: options?.agentId ?? this.agentId,
      },
      this._events,
      this._channel,
    );
    child._parent = this;
    this._children.set(child.id, child);

    this._emit(ProcessEvents.CHILD_SPAWNED, { childId: child.id, childName: child.name });

    // 子进程异步运行，不阻塞父进程
    child.run(body).catch(() => {}).finally(() => {
      this._children.delete(child.id);
      this._emit(ProcessEvents.CHILD_EXITED, {
        childId: child.id,
        reason: child._exitInfo?.reason,
      });
    });

    return child;
  }

  private _exit(reason: ExitReason, error?: string): void {
    if (this._state === 'dead') return;

    this._state = 'dead';
    this._exitInfo = { reason, error, timestamp: Date.now() };

    if (!this._abortController.signal.aborted) {
      this._abortController.abort();
    }

    // 先发射退出事件（让 waitChild 等监听者收到通知）
    this._emit(ProcessEvents.EXITED, { reason, error, childId: this.id });

    // 再清理等待中的 receive
    for (const [, waiters] of this._pendingReceives) {
      for (const waiter of waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
      }
    }
    this._pendingReceives.clear();
  }

  private _findChild(id: string): ProcessModel | undefined {
    const direct = this._children.get(id);
    if (direct) return direct;
    for (const child of this._children.values()) {
      const found = child._findChild(id);
      if (found) return found;
    }
    return undefined;
  }

  private _emit(type: string, data?: Record<string, unknown>): void {
    if (this._events) {
      const event: AgentEvent = {
        type,
        timestamp: Date.now(),
        agentId: this.agentId,
        sessionId: this.id,
        data,
      };
      this._events.emit(event);
    }
  }
}

// ── 工具函数 ──

/**
 * 创建并启动一个进程
 *
 * 便捷方法。
 */
export function spawnProcess(
  body: ProcessBody,
  options?: ProcessOptions,
  events?: EventBus,
  channel?: MessageChannel,
): ProcessModel {
  const process = new ProcessModel(options ?? {}, events, channel);
  process.run(body).catch(() => {});
  return process;
}
