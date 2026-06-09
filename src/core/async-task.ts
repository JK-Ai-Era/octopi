/**
 * AsyncTask — 异步任务原语
 *
 * 这是 Agent 异步能力的最小单元。
 * 不是任务调度系统，是 Promise 的内核级扩展：
 * - 提交异步执行单元
 * - 等待结果（带超时）
 * - 取消
 * - 完成回调
 * - 状态查询
 *
 * 设计原则：
 * - 纯机制：不关心任务内容，只管理生命周期
 * - 可组合：支持父子任务关系
 * - 可观测：所有状态变更通过 EventBus 发射事件
 * - 可持久化：通过 TaskStore 接口持久化（可选）
 */

import { randomUUID } from 'node:crypto';
import type { EventBus, AgentEvent } from './event-bus.js';
import type { TaskStore, TaskRecord, TaskStatus, TaskPriority } from './interfaces/task-store.js';

// ── 任务状态机 ──

/** AsyncTask 事件 */
export const TaskEvents = {
  CREATED: 'task.created',
  STARTED: 'task.started',
  COMPLETED: 'task.completed',
  FAILED: 'task.failed',
  CANCELLED: 'task.cancelled',
  TIMEOUT: 'task.timeout',
  CHILD_SPAWNED: 'task.child.spawned',
} as const;

// ── 配置 ──

/** AsyncTask 创建选项 */
export interface TaskOptions {
  /** 任务类型（用于路由和日志） */
  type: string;
  /** 任务输入 */
  input?: unknown;
  /** 优先级 */
  priority?: TaskPriority;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 父任务 ID */
  parentId?: string;
  /** 所属 Agent ID */
  agentId?: string;
  /** 所属 Session ID */
  sessionId?: string;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/** 任务执行函数类型 */
export type TaskExecutor<T = unknown> = (
  input: unknown,
  signal: AbortSignal,
) => Promise<T>;

// ── AsyncTask ──

/**
 * AsyncTask — 异步任务
 *
 * 封装一个异步执行单元，提供生命周期管理。
 */
export class AsyncTask<T = unknown> {
  readonly id: string;
  readonly type: string;
  readonly priority: TaskPriority;
  readonly parentId?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly createdAt: number;

  private _status: TaskStatus = 'pending';
  private _output?: T;
  private _error?: string;
  private _startedAt?: number;
  private _completedAt?: number;
  private _retryCount = 0;
  private readonly _maxRetries: number;
  private readonly _timeoutMs?: number;
  private readonly _metadata?: Record<string, unknown>;
  private readonly _input: unknown;

  private _abortController: AbortController;
  private _resolvePromise!: (value: T) => void;
  private _rejectPromise!: (reason: Error) => void;
  private _promise: Promise<T>;
  private _timeoutHandle?: ReturnType<typeof setTimeout>;

  // 外部依赖
  private readonly _events?: EventBus;
  private readonly _store?: TaskStore;

  private _settled = false;

  constructor(options: TaskOptions, events?: EventBus, store?: TaskStore) {
    this.id = randomUUID();
    this.type = options.type;
    this.priority = options.priority ?? 'normal';
    this.parentId = options.parentId;
    this.agentId = options.agentId;
    this.sessionId = options.sessionId;
    this.createdAt = Date.now();
    this._input = options.input;
    this._maxRetries = options.maxRetries ?? 0;
    this._timeoutMs = options.timeoutMs;
    this._metadata = options.metadata;
    this._abortController = new AbortController();
    this._events = events;
    this._store = store;

    this._promise = new Promise<T>((resolve, reject) => {
      this._resolvePromise = resolve;
      this._rejectPromise = reject;
    });
    // 不再静默吞掉 unhandled rejection。
    // 调用方应通过 task.promise.catch()、task.wait() 或 spawnTask() 处理错误。
    // 如果 promise 被 reject 且无人 observe，触发 unhandledRejection 事件通知。

    // 持久化创建事件
    this._persistAndEmit(TaskEvents.CREATED);
  }

  // ── 状态访问器 ──

  /** 当前状态 */
  get status(): TaskStatus { return this._status; }

  /** 任务输出（完成后有值） */
  get output(): T | undefined { return this._output; }

  /** 错误信息（失败时有值） */
  get error(): string | undefined { return this._error; }

  /** 重试次数 */
  get retryCount(): number { return this._retryCount; }

  /** 是否已完成（成功、失败或取消） */
  get isDone(): boolean {
    return this._status === 'completed'
      || this._status === 'failed'
      || this._status === 'cancelled';
  }

  /** AbortSignal，用于取消传递 */
  get signal(): AbortSignal { return this._abortController.signal; }

  /** 等待结果的 Promise */
  get promise(): Promise<T> { return this._promise; }

  // ── 生命周期方法 ──

  /**
   * 启动任务执行
   *
   * @param executor - 任务执行函数
   * @returns 任务结果
   *
   * 内部方法，由 TaskRunner 或直接调用方触发。
   */
  async run(executor: TaskExecutor<T>): Promise<T> {
    if (this._status !== 'pending') {
      throw new Error(`Task ${this.id} is not pending (status: ${this._status})`);
    }

    this._status = 'running';
    this._startedAt = Date.now();
    this._persistAndEmit(TaskEvents.STARTED);

    // 设置超时
    if (this._timeoutMs && this._timeoutMs > 0) {
      this._timeoutHandle = setTimeout(() => {
        if (this._status === 'running') {
          this._handleTimeout();
        }
      }, this._timeoutMs);
    }

    try {
      const result = await executor(this._input, this._abortController.signal);

      // 已经被 timeout/cancel 处理过了，抛出原错误让调用方感知
      if (this._settled) {
        const settledStatus = this._status as string;
        if (settledStatus === 'failed' && this._error?.includes('timed out')) {
          throw new TaskTimeoutError(this.id, this._timeoutMs!);
        }
        if (settledStatus === 'cancelled') {
          throw new TaskCancelledError(this.id, this._error);
        }
        throw new Error(this._error ?? 'Task was settled externally');
      }

      this._complete(result);
      return result;
    } catch (err) {
      // 已经被 timeout/cancel 处理过了，直接抛出原错误
      if (this._settled) throw err;

      const error = err instanceof Error ? err : new Error(String(err));

      // cancel() 会 abort signal，此时不重试
      if (this._abortController.signal.aborted) {
        this._fail(error.message);
        throw error;
      }

      // 重试逻辑
      if (this._retryCount < this._maxRetries) {
        this._retryCount++;
        this._abortController = new AbortController();
        this._status = 'pending'; // 重置状态以允许重新 run
        return this.run(executor);
      }

      this._fail(error.message);
      throw error;
    } finally {
      if (this._timeoutHandle) {
        clearTimeout(this._timeoutHandle);
      }
    }
  }

  /**
   * 取消任务
   *
   * @param reason - 取消原因
   */
  cancel(reason?: string): void {
    if (this.isDone || this._settled) return;

    this._settled = true;
    this._status = 'cancelled';
    this._completedAt = Date.now();
    this._error = reason ?? 'cancelled';
    this._abortController.abort();
    this._persistAndEmit(TaskEvents.CANCELLED);
    this._rejectPromise(new TaskCancelledError(this.id, reason));
  }

  /**
   * 等待任务完成（带超时）
   *
   * @param timeoutMs - 超时时间（毫秒），不传则无限等待
   * @returns 任务结果
   * @throws TaskTimeoutError | TaskCancelledError | Error
   */
  async wait(timeoutMs?: number): Promise<T> {
    if (this.isDone) {
      if (this._status === 'cancelled') throw new TaskCancelledError(this.id, this._error);
      if (this._status === 'failed') throw new Error(this._error ?? 'Task failed');
      return this._output as T;
    }

    if (timeoutMs === undefined) return this._promise;

    return Promise.race([
      this._promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new TaskTimeoutError(this.id, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  }

  // ── 内部方法 ──

  private _complete(output: T): void {
    this._status = 'completed';
    this._output = output;
    this._completedAt = Date.now();
    this._persistAndEmit(TaskEvents.COMPLETED);
    this._resolvePromise(output);
  }

  private _fail(error: string): void {
    this._status = 'failed';
    this._error = error;
    this._completedAt = Date.now();
    this._persistAndEmit(TaskEvents.FAILED);
    this._rejectPromise(new Error(error));
  }

  private _handleTimeout(): void {
    if (this._settled) return;
    this._settled = true;
    this._status = 'failed';
    this._error = `Task timed out after ${this._timeoutMs}ms`;
    this._completedAt = Date.now();
    this._abortController.abort();
    this._persistAndEmit(TaskEvents.TIMEOUT);
    this._rejectPromise(new TaskTimeoutError(this.id, this._timeoutMs!));
  }

  private async _persistAndEmit(eventType: string): Promise<void> {
    const record: TaskRecord = {
      id: this.id,
      agentId: this.agentId ?? 'unknown',
      sessionId: this.sessionId,
      type: this.type,
      status: this._status,
      priority: this.priority,
      input: this._input,
      output: this._output,
      error: this._error,
      createdAt: this.createdAt,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
      retryCount: this._retryCount,
      maxRetries: this._maxRetries,
      timeoutMs: this._timeoutMs,
      parentId: this.parentId,
      metadata: this._metadata,
    };

    // 持久化（可选）
    if (this._store) {
      try {
        if (eventType === TaskEvents.CREATED) {
          await this._store.create(record);
        } else {
          await this._store.update(this.id, record);
        }
      } catch {
        // 持久化失败不应阻塞任务执行
      }
    }

    // 发射事件
    if (this._events) {
      const event: AgentEvent = {
        type: eventType,
        timestamp: Date.now(),
        agentId: this.agentId,
        sessionId: this.sessionId,
        data: { taskId: this.id, taskType: this.type, status: this._status },
      };
      this._events.emit(event);
    }
  }

  // ── 序列化 ──

  /** 转换为 TaskRecord（用于快照/调试） */
  toRecord(): TaskRecord {
    return {
      id: this.id,
      agentId: this.agentId ?? 'unknown',
      sessionId: this.sessionId,
      type: this.type,
      status: this._status,
      priority: this.priority,
      input: this._input,
      output: this._output,
      error: this._error,
      createdAt: this.createdAt,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
      retryCount: this._retryCount,
      maxRetries: this._maxRetries,
      timeoutMs: this._timeoutMs,
      parentId: this.parentId,
      metadata: this._metadata,
    };
  }
}

// ── 错误类型 ──

/** 任务超时错误 */
export class TaskTimeoutError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Task ${taskId} timed out after ${timeoutMs}ms`);
    this.name = 'TaskTimeoutError';
  }
}

/** 任务取消错误 */
export class TaskCancelledError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly reason?: string,
  ) {
    super(`Task ${taskId} was cancelled${reason ? `: ${reason}` : ''}`);
    this.name = 'TaskCancelledError';
  }
}

// ── 工具函数 ──

/**
 * 创建并立即启动一个 AsyncTask
 *
 * 便捷方法，适用于"发射后不管"的场景。
 * 错误通过 task.promise 和 EventBus 传播，不会被静默吞掉。
 */
export function spawnTask<T = unknown>(
  options: TaskOptions,
  executor: TaskExecutor<T>,
  events?: EventBus,
  store?: TaskStore,
): AsyncTask<T> {
  const task = new AsyncTask<T>(options, events, store);
  // fire-and-forget：错误在 task 内部处理（状态更新 + 事件发射）
  // 调用方应通过 task.wait() 或 task.promise 获取结果/错误
  task.run(executor).catch(() => { /* 错误已在 task 内部记录为 failed 状态 */ });
  return task;
}
