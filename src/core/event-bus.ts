/**
 * EventBus — 事件总线（Core 内置）
 *
 * Agent 循环中的所有关键节点都会发射事件。
 * Harness 层和 Integration 层通过订阅事件实现审计、监控、调试。
 *
 * 设计要点：
 * - 同步发射，不阻塞 Agent 循环
 * - 支持通配符订阅（'*' 匹配所有事件）
 * - Disposable 模式，方便取消订阅
 * - NoopEventBus 的开销为零
 */

// ── 事件类型 ──

/** Agent 事件 */
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

// ── 内置事件类型 ──

/** 标准事件类型常量 */
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
  SENSITIVE_DATA_DETECTED: 'sensitive_data.detected',

  // 资源
  BUDGET_EXCEEDED: 'budget.exceeded',
  CONTEXT_OVERFLOW: 'context.overflow',

  // 质量
  QUALITY_ANOMALY: 'quality.anomaly',
} as const;

// ── 接口定义 ──

/** EventBus 接口 */
export interface EventBus {
  /** 发射事件 */
  emit(event: AgentEvent): void;
  /** 订阅特定类型的事件 */
  on(eventType: string, handler: EventHandler): Disposable;
  /** 订阅所有事件 */
  onAll(handler: EventHandler): Disposable;
}

// ── 默认实现 ──

/** DefaultEventBus 选项 */
export interface DefaultEventBusOptions {
  /** 启用 debug 模式：处理器异常会 console.warn 而非静默吞掉 */
  debug?: boolean;
}

/**
 * 默认 EventBus 实现
 *
 * 基于 Map 的事件订阅，支持同步和异步处理器。
 * debug 模式下，处理器异常会输出警告（不中断 Agent 循环）。
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

    // 特定类型的处理器
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

    // 通配符处理器
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
 * 不发射任何事件。用于不需要可观测性的场景。
 * 零开销。
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
  /** 默认节流间隔（毫秒），应用于所有未在 intervals 中指定的类型 */
  defaultIntervalMs?: number;
}

/**
 * ThrottledEventBus — 节流事件总线
 *
 * 包装一个 EventBus，对高频事件（如 llm_stream_delta）按类型进行节流。
 * 非节流类型的事件直接透传，零额外开销。
 *
 * 适用场景：
 * - 流式输出的 delta 事件（每 token 一次 → 每 50ms 一次）
 * - 高频迭代事件
 */
export class ThrottledEventBus implements EventBus {
  private inner: EventBus;
  private intervals: Map<string, number>;
  private defaultIntervalMs: number;
  private lastEmit = new Map<string, number>();

  constructor(inner: EventBus, config?: ThrottleConfig) {
    this.inner = inner;
    this.intervals = new Map(Object.entries(config?.intervals ?? {}));
    this.defaultIntervalMs = config?.defaultIntervalMs ?? 0;
  }

  emit(event: AgentEvent): void {
    const interval = this.intervals.get(event.type) ?? this.defaultIntervalMs;
    if (interval <= 0) {
      // 不节流，直接透传
      this.inner.emit(event);
      return;
    }

    const now = Date.now();
    const last = this.lastEmit.get(event.type) ?? 0;
    if (now - last >= interval) {
      this.lastEmit.set(event.type, now);
      this.inner.emit(event);
    }
    // 否则丢弃此事件
  }

  on(eventType: string, handler: EventHandler): Disposable {
    return this.inner.on(eventType, handler);
  }

  onAll(handler: EventHandler): Disposable {
    return this.inner.onAll(handler);
  }
}
