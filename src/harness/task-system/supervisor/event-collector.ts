/**
 * EventCollector — 事件收集器
 *
 * 聚合来自多个来源的事件：
 * - EventBus（Core 层内部事件）
 * - EventSource（外部事件源：webhook、timer 等）
 * - 手动注入（用户消息等）
 *
 * 设计要点：
 * - 线程安全：多个来源可能同时产生事件
 * - 阻塞等待：没有事件时阻塞，有事件时立即返回
 * - 优先级：安全事件优先于普通事件
 */

import type { EventBus, EventBusAgentEvent as AgentEvent, Disposable } from '../../../core/index.js';
import type { EventSource, ExternalEvent } from '../../../core/interfaces/event-source.js';

// ── 等待者条目 ──

interface WaiterEntry {
  resolve: (events: AgentEvent[]) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// ── EventCollector ──

export class EventCollector {
  private _sources: EventSource[] = [];
  private _queue: AgentEvent[] = [];
  private _waiters: Array<WaiterEntry> = [];
  private _eventBusDispose?: Disposable;

  constructor(private readonly _events?: EventBus) {}

  /**
   * 添加外部事件源
   *
   * @param source - 事件源实例
   */
  addSource(source: EventSource): void {
    this._sources.push(source);

    // 启动事件源，将外部事件转换为 AgentEvent
    source.start((external: ExternalEvent) => {
      const event: AgentEvent = {
        type: external.type,
        timestamp: external.timestamp,
        data: {
          sourceId: external.sourceId,
          payload: external.payload,
          ...external.metadata,
        },
      };
      this._enqueue(event);
    }).catch(() => {
      // 事件源启动失败不阻塞 Collector
    });
  }

  /**
   * 订阅 EventBus 事件
   *
   * 将 Core 层的事件也纳入收集范围。
   */
  subscribeEventBus(): void {
    if (!this._events) return;

    this._eventBusDispose = this._events.onAll((event) => {
      this._enqueue({ ...event });
    }) as Disposable;
  }

  /**
   * 手动注入事件
   *
   * 用于用户消息等外部输入。
   */
  inject(event: AgentEvent): void {
    this._enqueue(event);
  }

  /**
   * 收集事件（阻塞等待）
   *
   * @param timeoutMs - 最大等待时间（毫秒）
   * @returns 收集到的事件列表
   */
  async collect(timeoutMs: number): Promise<AgentEvent[]> {
    // 如果队列中有事件，立即返回
    if (this._queue.length > 0) {
      const events = this._queue.splice(0);
      return this._sort(events);
    }

    // 否则等待事件到达或超时
    return new Promise<AgentEvent[]>((resolve) => {
      const entry: WaiterEntry = {
        resolve: (events: AgentEvent[]) => {
          if (entry.timer) clearTimeout(entry.timer);
          resolve(events);
        },
      };

      entry.timer = setTimeout(() => {
        // 超时，从等待队列移除，返回空
        const idx = this._waiters.indexOf(entry);
        if (idx >= 0) this._waiters.splice(idx, 1);
        resolve([]);
      }, timeoutMs);

      this._waiters.push(entry);
    });
  }

  /**
   * 当前队列中的事件数
   */
  get pendingCount(): number {
    return this._queue.length;
  }

  /**
   * 停止所有事件源
   */
  async stop(): Promise<void> {
    // 停止事件源
    for (const source of this._sources) {
      if (source.isRunning()) {
        await source.stop().catch(() => {});
      }
    }
    this._sources = [];

    // 取消 EventBus 订阅
    if (this._eventBusDispose) {
      this._eventBusDispose.dispose();
      this._eventBusDispose = undefined;
    }

    // 清空等待队列
    for (const waiter of this._waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this._waiters = [];
  }

  // ── 内部方法 ──

  private _enqueue(event: AgentEvent): void {
    // 如果有等待者，直接唤醒
    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift()!;
      waiter.resolve(this._sort([event]));
      return;
    }

    // 否则放入队列
    this._queue.push(event);
  }

  /**
   * 对事件排序：安全事件优先，然后按时间戳
   */
  private _sort(events: AgentEvent[]): AgentEvent[] {
    return events.sort((a, b) => {
      // 安全事件优先
      const aIsSecurity = a.type.startsWith('injection') || a.type.startsWith('policy') || a.type.startsWith('sensitive');
      const bIsSecurity = b.type.startsWith('injection') || b.type.startsWith('policy') || b.type.startsWith('sensitive');
      if (aIsSecurity && !bIsSecurity) return -1;
      if (!aIsSecurity && bIsSecurity) return 1;

      // 按时间戳排序
      return a.timestamp - b.timestamp;
    });
  }
}
