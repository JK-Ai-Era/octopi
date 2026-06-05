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

/**
 * 默认 EventBus 实现
 *
 * 基于 Map 的事件订阅，支持同步和异步处理器。
 */
export class DefaultEventBus implements EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private allHandlers = new Set<EventHandler>();

  emit(event: AgentEvent): void {
    const timestamped = { ...event, timestamp: event.timestamp ?? Date.now() };

    // 特定类型的处理器
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(timestamped);
        } catch {
          // 事件处理器的错误不应中断 Agent 循环
        }
      }
    }

    // 通配符处理器
    for (const handler of this.allHandlers) {
      try {
        handler(timestamped);
      } catch {
        // 同上
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
