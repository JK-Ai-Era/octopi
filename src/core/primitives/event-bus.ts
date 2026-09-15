/**
 * EventBus — 事件总线（Core 机制）
 *
 * Core 只保留**开放信封 + 广播机制**。
 * 规范产品词表（AgentEventMap / AgentEvents）在 harness/events/，
 * 由 Harness / Integration 消费；Core 不钉产品目录。
 *
 * 两套事件系统：
 * 1) yield：Loop 协议（agentLoop → 调用方），不进本总线（除 Runner 显式桥接）
 * 2) emit：EventBus 一对多广播（基础设施 / 策略 / 桥接产物）
 */

// ── 事件信封 ──

/** 开放事件信封 */
export interface AgentEvent {
  type: string;
  timestamp: number;
  agentId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

/** 事件处理器 */
export type EventHandler = (event: AgentEvent) => void | Promise<void>;

/** Disposable（取消订阅） */
export interface Disposable {
  dispose(): void;
}

// ── 接口 ──

/** EventBus 接口（开放 type；强类型词表见 harness/events） */
export interface EventBus {
  emit(event: AgentEvent): void;
  on(eventType: string, handler: EventHandler): Disposable;
  onAll(handler: EventHandler): Disposable;
}

// ── 默认实现 ──

/** DefaultEventBus 选项 */
export interface DefaultEventBusOptions {
  /** 启用 debug 模式：处理器异常会 console.warn 而非静默吞掉 */
  debug?: boolean;
}

/**
 * 默认 EventBus 实现（进程内、零环境 I/O）
 *
 * emit 为同步分发；异步 handler 的 rejection 不会进入 try/catch。
 */
export class DefaultEventBus implements EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private allHandlers = new Set<EventHandler>();
  private debug: boolean;

  constructor(options?: DefaultEventBusOptions) {
    this.debug = options?.debug ?? false;
  }

  emit(event: AgentEvent): void {
    const timestamped = { ...event, timestamp: event.timestamp ?? Date.now() };

    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(timestamped);
        } catch (err) {
          if (this.debug) {
            console.warn(`[EventBus] handler error for "${event.type}":`, err);
          }
        }
      }
    }

    for (const handler of this.allHandlers) {
      try {
        handler(timestamped);
      } catch (err) {
        if (this.debug) {
          console.warn(`[EventBus] wildcard handler error for "${event.type}":`, err);
        }
      }
    }
  }

  on(eventType: string, handler: EventHandler): Disposable {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    return {
      dispose: () => {
        this.handlers.get(eventType)?.delete(handler);
      },
    };
  }

  onAll(handler: EventHandler): Disposable {
    this.allHandlers.add(handler);
    return {
      dispose: () => {
        this.allHandlers.delete(handler);
      },
    };
  }
}

/**
 * No-op EventBus
 *
 * 不发射任何事件。用于不需要可观测性的场景。零开销。
 */
export class NoopEventBus implements EventBus {
  emit(_event: AgentEvent): void {}
  on(_eventType: string, _handler: EventHandler): Disposable {
    return { dispose: () => {} };
  }
  onAll(_handler: EventHandler): Disposable {
    return { dispose: () => {} };
  }
}

// ── 节流 EventBus ──

/** 节流配置 */
export interface ThrottleConfig {
  /** 事件类型的节流间隔（毫秒）。未列出的类型不节流。 */
  intervals?: Record<string, number>;
  /** 默认节流间隔（毫秒） */
  defaultIntervalMs?: number;
}

/**
 * ThrottledEventBus — trailing-edge 合并
 *
 * 窗口内只保留最后一次，窗口结束时补发。
 */
export class ThrottledEventBus implements EventBus {
  private inner: EventBus;
  private intervals: Map<string, number>;
  private defaultIntervalMs: number;
  private lastEmit = new Map<string, number>();
  private pending = new Map<string, AgentEvent>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(inner: EventBus, config?: ThrottleConfig) {
    this.inner = inner;
    this.intervals = new Map(Object.entries(config?.intervals ?? {}));
    this.defaultIntervalMs = config?.defaultIntervalMs ?? 0;
  }

  emit(event: AgentEvent): void {
    const interval = this.intervals.get(event.type) ?? this.defaultIntervalMs;
    if (interval <= 0) {
      this.inner.emit(event);
      return;
    }

    const now = Date.now();
    const last = this.lastEmit.get(event.type) ?? 0;
    if (now - last >= interval) {
      this.lastEmit.set(event.type, now);
      this.pending.delete(event.type);
      this.inner.emit(event);
      return;
    }

    this.pending.set(event.type, event);
    if (!this.timers.has(event.type)) {
      const wait = Math.max(0, interval - (now - last));
      const timer = setTimeout(() => {
        this.timers.delete(event.type);
        const p = this.pending.get(event.type);
        if (p) {
          this.pending.delete(event.type);
          this.lastEmit.set(event.type, Date.now());
          this.inner.emit(p);
        }
      }, wait);
      this.timers.set(event.type, timer);
    }
  }

  on(eventType: string, handler: EventHandler): Disposable {
    return this.inner.on(eventType, handler);
  }

  onAll(handler: EventHandler): Disposable {
    return this.inner.onAll(handler);
  }

  /** 清理未触发的 trailing timer */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pending.clear();
  }
}
