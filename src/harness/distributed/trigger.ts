/**
 * Distributed Intelligence — Trigger Rules & TriggerEngine
 *
 * 四种触发规则：EventTrigger、ConditionTrigger、ThresholdTrigger、MessageTrigger。
 * TriggerEngine 监听 EventBus，评估触发规则，支持并发优先级排序。
 */

import type { EventBus, AgentEvent, Disposable } from '../../core/event-bus.js';
import type { TriggerContext } from './types.js';

// ── Trigger Rules ──

/**
 * 事件触发器
 *
 * 匹配 EventBus 上的特定事件类型。
 */
export interface EventTrigger {
  type: 'event';
  event: {
    /** 事件类型（如 'tool_call.risk_unknown'） */
    type: string;
    /** 事件数据过滤器 */
    filter?: (data: unknown) => boolean;
  };
}

/**
 * 条件触发器
 *
 * 当某个条件变为 true 时触发。
 * 支持事件驱动或轮询两种评估方式。
 */
export interface ConditionTrigger {
  type: 'condition';
  condition: {
    /** 条件检查函数 */
    check: (ctx: TriggerContext) => boolean;
    /**
     * 评估方式：
     * - 'event' 或省略：绑定到 EventBus 事件，每次事件到达时评估
     * - number > 0：轮询模式，每隔 N 毫秒评估一次
     */
    evaluateOn?: 'event' | number;
  };
}

/**
 * 阈值触发器
 *
 * 当某个指标超过阈值时触发。
 */
export interface ThresholdTrigger {
  type: 'threshold';
  threshold: {
    /** 指标名（如 'session.token_count'） */
    metric: string;
    /** 比较运算符 */
    operator: '>' | '<' | '>=' | '<=' | '==';
    /** 阈值 */
    value: number;
  };
}

/**
 * 消息触发器
 *
 * 收到特定类型的消息时触发。
 */
export interface MessageTrigger {
  type: 'message';
  message: {
    /** 消息类型 */
    type: string;
    /** 来源进程 ID */
    from?: string;
  };
}

/**
 * 触发规则联合类型
 */
export type TriggerRule = EventTrigger | ConditionTrigger | ThresholdTrigger | MessageTrigger;

// ── TriggerMatch ──

/**
 * 触发匹配结果
 */
export interface TriggerMatch {
  /** 匹配的规则索引 */
  ruleIndex: number;
  /** 匹配的规则 */
  rule: TriggerRule;
  /** 触发上下文 */
  context: TriggerContext;
}

// ── Priority ──

/**
 * OutputPolicy 模式优先级（数值越小优先级越高）
 */
const PRIORITY_MAP: Record<string, number> = {
  intercept: 0,
  replace_context: 1,
  inject_context: 2,
  notify: 3,
};

/**
 * 获取优先级数值
 */
export function getPriority(mode: string): number {
  return PRIORITY_MAP[mode] ?? 99;
}

// ── TriggerEngine ──

/** TriggerEngine 配置 */
export interface TriggerEngineConfig {
  /** EventBus 实例 */
  events: EventBus;
}

/**
 * TriggerEngine — 触发引擎
 *
 * 监听 EventBus，评估触发规则。
 * 维护 metrics 指标表（ThresholdTrigger 使用）。
 */
export class TriggerEngine {
  private events: EventBus;
  private disposables: Disposable[] = [];
  private metrics = new Map<string, number>();
  private pollTimers: ReturnType<typeof setInterval>[] = [];

  constructor(config: TriggerEngineConfig) {
    this.events = config.events;
  }

  /**
   * 更新指标值
   *
   * 主 Agent 的引擎在关键节点通过 EventBus 发射指标更新事件，
   * TriggerEngine 监听并更新 metrics。
   */
  updateMetric(key: string, value: number): void {
    this.metrics.set(key, value);
  }

  /**
   * 获取当前指标快照
   */
  getMetrics(): Record<string, number> {
    return Object.fromEntries(this.metrics);
  }

  /**
   * 评估单条触发规则
   *
   * @param rule - 触发规则
   * @param ctx - 触发上下文
   * @returns 是否触发
   */
  evaluateRule(rule: TriggerRule, ctx: TriggerContext): boolean {
    switch (rule.type) {
      case 'event':
        return this.evaluateEventTrigger(rule, ctx);
      case 'condition':
        return rule.condition.check(ctx);
      case 'threshold':
        return this.evaluateThresholdTrigger(rule, ctx);
      case 'message':
        return this.evaluateMessageTrigger(rule, ctx);
    }
  }

  /**
   * 批量评估触发规则，返回所有匹配的规则（按注册顺序）
   *
   * @param rules - 触发规则数组
   * @param ctx - 触发上下文
   * @param outputMode - OutputPolicy 模式（用于优先级排序）
   * @returns 匹配的规则索引数组（已按优先级排序）
   */
  evaluateRules(
    rules: TriggerRule[],
    ctx: TriggerContext,
    outputMode?: string,
  ): number[] {
    const matched: number[] = [];

    for (let i = 0; i < rules.length; i++) {
      if (this.evaluateRule(rules[i], ctx)) {
        matched.push(i);
      }
    }

    // 如果有 outputMode，按优先级排序
    if (outputMode !== undefined) {
      // 单个 agent 的规则按注册顺序，但整体优先级由 outputMode 决定
      // 这里返回索引，由调用方（AgentRuntime）做全局排序
    }

    return matched;
  }

  /**
   * 注册 ConditionTrigger 的轮询评估
   *
   * @param rule - 条件触发规则
   * @param onTrigger - 触发回调
   */
  registerConditionPolling(
    rule: ConditionTrigger,
    onTrigger: (ctx: TriggerContext) => void,
  ): void {
    const interval = rule.condition.evaluateOn;
    if (typeof interval !== 'number' || interval <= 0) return;

    const timer = setInterval(() => {
      const ctx: TriggerContext = {
        metrics: Object.fromEntries(this.metrics),
      };
      if (rule.condition.check(ctx)) {
        onTrigger(ctx);
      }
    }, interval);

    this.pollTimers.push(timer);
  }

  /**
   * 注册 EventBus 监听器
   *
   * @param eventType - 事件类型
   * @param handler - 事件处理器
   * @returns Disposable
   */
  onEvent(eventType: string, handler: (event: AgentEvent) => void): Disposable {
    const disposable = this.events.on(eventType, handler);
    this.disposables.push(disposable);
    return disposable;
  }

  /**
   * 监听所有事件（通配符）
   */
  onAllEvents(handler: (event: AgentEvent) => void): Disposable {
    const disposable = this.events.onAll(handler);
    this.disposables.push(disposable);
    return disposable;
  }

  /**
   * 清理所有监听器和定时器
   */
  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    for (const timer of this.pollTimers) {
      clearInterval(timer);
    }
    this.pollTimers = [];
  }

  // ── 内部评估方法 ──

  private evaluateEventTrigger(rule: EventTrigger, ctx: TriggerContext): boolean {
    // EventTrigger 的匹配逻辑：ctx.eventData 存在且 filter 通过
    if (ctx.eventData === undefined) return false;
    if (rule.event.filter && !rule.event.filter(ctx.eventData)) return false;
    return true;
  }

  private evaluateThresholdTrigger(rule: ThresholdTrigger, ctx: TriggerContext): boolean {
    const metrics = ctx.metrics ?? Object.fromEntries(this.metrics);
    const value = metrics[rule.threshold.metric];
    if (value === undefined) return false;

    const threshold = rule.threshold.value;
    switch (rule.threshold.operator) {
      case '>': return value > threshold;
      case '<': return value < threshold;
      case '>=': return value >= threshold;
      case '<=': return value <= threshold;
      case '==': return value === threshold;
    }
  }

  private evaluateMessageTrigger(rule: MessageTrigger, ctx: TriggerContext): boolean {
    // MessageTrigger 匹配：eventData 包含 type 字段
    if (!ctx.eventData || typeof ctx.eventData !== 'object') return false;
    const data = ctx.eventData as Record<string, unknown>;
    if (data.type !== rule.message.type) return false;
    if (rule.message.from && data.from !== rule.message.from) return false;
    return true;
  }
}
