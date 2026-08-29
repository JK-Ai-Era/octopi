/**
 * TaskScheduler — 任务调度器
 *
 * 支持定时任务、延迟任务、循环任务。
 * 基于 Core AsyncTask 实现，通过 EventBus 发射事件。
 *
 * 设计要点：
 * - 不依赖外部 cron 库，纯 JS 实现
 * - 进程退出时自动清理所有任务
 * - 所有调度事件通过 EventBus 发射
 */

import { randomUUID } from 'node:crypto';
import { AsyncTask } from '../../../core/index.js';
import type { EventBus, EventBusAgentEvent as AgentEvent } from '../../../core/index.js';

// ── 任务类型 ──

/** 调度任务类型 */
export type ScheduleKind = 'once' | 'cron' | 'interval' | 'delay';

/** 调度任务 */
export interface ScheduledTask {
  /** 任务 ID */
  id: string;
  /** 任务名称 */
  name: string;
  /** 任务类型 */
  kind: ScheduleKind;
  /** 任务处理函数 */
  handler: () => Promise<void> | void;
  /** cron 表达式（kind=cron 时使用） */
  cron?: string;
  /** 间隔毫秒（kind=interval/delay 时使用） */
  intervalMs?: number;
  /** 执行时间戳（kind=once 时使用） */
  executeAt?: number;
  /** 是否启用 */
  enabled: boolean;
  /** 已执行次数 */
  runCount: number;
  /** 最大执行次数（0=不限） */
  maxRuns: number;
  /** 创建时间 */
  createdAt: number;
  /** 下次执行时间 */
  nextRunAt: number;
  /** 上次执行时间 */
  lastRunAt?: number;
  /** 最后一次 AsyncTask */
  _timer?: ReturnType<typeof setTimeout>;
  _intervalTimer?: ReturnType<typeof setInterval>;
}

// ── 事件类型 ──

export const SchedulerEvents = {
  TASK_ADDED: 'scheduler.task.added',
  TASK_REMOVED: 'scheduler.task.removed',
  TASK_STARTED: 'scheduler.task.started',
  TASK_COMPLETED: 'scheduler.task.completed',
  TASK_FAILED: 'scheduler.task.failed',
  TASK_SKIPPED: 'scheduler.task.skipped',
} as const;

// ── 配置 ──

export interface TaskSchedulerConfig {
  /** 检查间隔（毫秒，默认 1000） */
  checkIntervalMs?: number;
}

// ── TaskScheduler ──

/**
 * 任务调度器
 */
export class TaskScheduler {
  private _tasks = new Map<string, ScheduledTask>();
  private _events?: EventBus;
  private _checkTimer?: ReturnType<typeof setInterval>;
  private _checkIntervalMs: number;
  private _running = false;

  constructor(config?: TaskSchedulerConfig, events?: EventBus) {
    this._checkIntervalMs = config?.checkIntervalMs ?? 1000;
    this._events = events;
  }

  // ── 生命周期 ──

  /**
   * 启动调度器
   */
  start(): void {
    if (this._running) return;
    this._running = true;

    // 定期检查待执行任务
    this._checkTimer = setInterval(() => {
      this._tick();
    }, this._checkIntervalMs);
  }

  /**
   * 停止调度器
   */
  stop(): void {
    this._running = false;
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = undefined;
    }

    // 清理所有定时器
    for (const task of this._tasks.values()) {
      if (task._timer) clearTimeout(task._timer);
      if (task._intervalTimer) clearInterval(task._intervalTimer);
    }
  }

  /**
   * 调度器是否正在运行
   */
  get running(): boolean { return this._running; }

  /**
   * 任务数量
   */
  get taskCount(): number { return this._tasks.size; }

  // ── 添加任务 ──

  /**
   * 添加一次性延迟任务
   *
   * @param name - 任务名称
   * @param delayMs - 延迟毫秒
   * @param handler - 任务处理函数
   */
  scheduleOnce(name: string, delayMs: number, handler: () => Promise<void> | void): ScheduledTask {
    const task: ScheduledTask = {
      id: randomUUID(),
      name,
      kind: 'once',
      handler,
      intervalMs: delayMs,
      enabled: true,
      runCount: 0,
      maxRuns: 1,
      createdAt: Date.now(),
      nextRunAt: Date.now() + delayMs,
    };

    this._addTask(task);
    return task;
  }

  /**
   * 添加循环任务
   *
   * @param name - 任务名称
   * @param intervalMs - 间隔毫秒
   * @param handler - 任务处理函数
   * @param maxRuns - 最大执行次数（0=不限）
   */
  scheduleInterval(name: string, intervalMs: number, handler: () => Promise<void> | void, maxRuns = 0): ScheduledTask {
    const task: ScheduledTask = {
      id: randomUUID(),
      name,
      kind: 'interval',
      handler,
      intervalMs,
      enabled: true,
      runCount: 0,
      maxRuns,
      createdAt: Date.now(),
      nextRunAt: Date.now() + intervalMs,
    };

    this._addTask(task);
    return task;
  }

  /**
   * 添加 cron 任务
   *
   * @param name - 任务名称
   * @param cronExpr - cron 表达式（简化版：分 时 日 月 周）
   * @param handler - 任务处理函数
   */
  scheduleCron(name: string, cronExpr: string, handler: () => Promise<void> | void): ScheduledTask {
    const nextRun = this._parseCronNextRun(cronExpr);
    const task: ScheduledTask = {
      id: randomUUID(),
      name,
      kind: 'cron',
      handler,
      cron: cronExpr,
      enabled: true,
      runCount: 0,
      maxRuns: 0,
      createdAt: Date.now(),
      nextRunAt: nextRun,
    };

    this._addTask(task);
    return task;
  }

  /**
   * 添加定时任务（指定时间执行）
   *
   * @param name - 任务名称
   * @param executeAt - 执行时间戳
   * @param handler - 任务处理函数
   */
  scheduleAt(name: string, executeAt: number, handler: () => Promise<void> | void): ScheduledTask {
    const task: ScheduledTask = {
      id: randomUUID(),
      name,
      kind: 'once',
      handler,
      executeAt,
      enabled: true,
      runCount: 0,
      maxRuns: 1,
      createdAt: Date.now(),
      nextRunAt: executeAt,
    };

    this._addTask(task);
    return task;
  }

  // ── 管理任务 ──

  /**
   * 取消任务
   */
  cancel(taskId: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task) return false;

    task.enabled = false;
    if (task._timer) clearTimeout(task._timer);
    if (task._intervalTimer) clearInterval(task._intervalTimer);
    this._tasks.delete(taskId);
    this._emit(SchedulerEvents.TASK_REMOVED, { taskId, name: task.name });
    return true;
  }

  /**
   * 暂停任务
   */
  pause(taskId: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task) return false;
    task.enabled = false;
    return true;
  }

  /**
   * 恢复任务
   */
  resume(taskId: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task) return false;
    task.enabled = true;
    return true;
  }

  /**
   * 获取所有任务
   */
  list(): ScheduledTask[] {
    return Array.from(this._tasks.values()).map(t => ({
      ...t,
      _timer: undefined,
      _intervalTimer: undefined,
    }));
  }

  /**
   * 获取单个任务
   */
  get(taskId: string): ScheduledTask | undefined {
    const task = this._tasks.get(taskId);
    if (!task) return undefined;
    return { ...task, _timer: undefined, _intervalTimer: undefined };
  }

  // ── 内部方法 ──

  private _addTask(task: ScheduledTask): void {
    this._tasks.set(task.id, task);
    this._emit(SchedulerEvents.TASK_ADDED, { taskId: task.id, name: task.name, kind: task.kind });

    // 如果是一次性延迟任务且调度器未启动，直接用 setTimeout
    if (task.kind === 'once' && !this._running) {
      const delay = Math.max(0, task.nextRunAt - Date.now());
      task._timer = setTimeout(() => {
        this._executeTask(task);
      }, delay);
    }
  }

  private _tick(): void {
    const now = Date.now();
    for (const task of this._tasks.values()) {
      if (!task.enabled) continue;
      if (task.nextRunAt > now) continue;

      this._executeTask(task);
    }
  }

  private async _executeTask(task: ScheduledTask): Promise<void> {
    if (!task.enabled) return;
    if (task.maxRuns > 0 && task.runCount >= task.maxRuns) {
      this._emit(SchedulerEvents.TASK_SKIPPED, { taskId: task.id, reason: 'max runs reached' });
      this.cancel(task.id);
      return;
    }

    task.runCount++;
    task.lastRunAt = Date.now();
    this._emit(SchedulerEvents.TASK_STARTED, { taskId: task.id, name: task.name, runCount: task.runCount });

    try {
      await task.handler();
      this._emit(SchedulerEvents.TASK_COMPLETED, { taskId: task.id, name: task.name, runCount: task.runCount });
    } catch (err) {
      this._emit(SchedulerEvents.TASK_FAILED, {
        taskId: task.id,
        name: task.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 更新下次执行时间
    if (task.kind === 'interval' && task.intervalMs) {
      task.nextRunAt = Date.now() + task.intervalMs;
    } else if (task.kind === 'cron' && task.cron) {
      task.nextRunAt = this._parseCronNextRun(task.cron);
    } else {
      // once 任务执行完毕，删除
      this._tasks.delete(task.id);
    }
  }

  /**
   * 解析 cron 表达式，计算下次执行时间
   *
   * 简化版 cron：分 时 日 月 周
   * 示例：star/5 star star star star = 每5分钟
   */
  _parseCronNextRun(expr: string): number {
    const parts = expr.split(' ');
    if (parts.length !== 5) {
      // 格式错误，默认 1 分钟后
      return Date.now() + 60000;
    }

    const now = new Date();
    const [minExpr, hourExpr] = parts;

    let nextMin = this._parseCronField(minExpr, now.getMinutes(), 59);
    let nextHour = this._parseCronField(hourExpr, now.getHours(), 23);

    // 如果分钟已过，跳到下一小时
    if (nextMin <= now.getMinutes() && nextHour === now.getHours()) {
      nextMin = this._parseCronField(minExpr, 0, 59);
      nextHour = now.getHours() + 1;
      if (nextHour > 23) nextHour = 0;
    }

    const next = new Date(now);
    next.setHours(nextHour, nextMin, 0, 0);

    // 如果计算出的时间已过（同一天），加一天
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }

    return next.getTime();
  }

  private _parseCronField(expr: string, current: number, max: number): number {
    if (expr === '*') return current;
    if (expr.startsWith('*/')) {
      const step = parseInt(expr.slice(2), 10);
      if (isNaN(step) || step <= 0) return current;
      return Math.ceil((current + 1) / step) * step;
    }
    const val = parseInt(expr, 10);
    return isNaN(val) ? current : Math.min(val, max);
  }

  private _emit(type: string, data?: Record<string, unknown>): void {
    if (this._events) {
      this._events.emit({ type, timestamp: Date.now(), data });
    }
  }
}
