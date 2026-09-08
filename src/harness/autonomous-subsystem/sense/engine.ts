/**
 * Autonomous Subsystem — SenseEngine
 *
 * 感知引擎，替代旧的 TriggerEngine。
 * 负责事件监听、条件评估、冷却期管理、循环防护。
 *
 * @module autonomous-subsystem/sense/engine
 */

import type { EventBus, AgentEvent, Disposable } from '../../../core/primitives/event-bus.js';
import type { SenseConfig, SenseContext, SubsystemSpec } from '../types.js';
import { MetricsStore } from './metrics.js';

// ── 冷却期管理 ──

/** 冷却期配置 */
interface CooldownEntry {
  /** 冷却期结束时间戳 */
  until: number;
}

// ── 传播深度追踪 ──

/** 事件触发链深度追踪 */
interface DepthTracker {
  /** 当前深度 */
  depth: number;
  /** 链起始时间 */
  chainStartTime: number;
}

// ── 注册的子系统 ──

interface RegisteredSubsystem {
  spec: SubsystemSpec;
  /** 冷却期配置 */
  cooldown: CooldownEntry;
  /** 评估函数（编译后的 condition 或 conditionRef） */
  evaluator?: (ctx: SenseContext) => boolean | Promise<boolean>;
}

// ── SenseEngine 配置 ──

export interface SenseEngineConfig {
  /** EventBus 实例 */
  events: EventBus;
  /** 全局冷却期（毫秒），默认 5000 */
  defaultCooldownMs?: number;
  /** 最大传播深度，默认 5 */
  maxDepth?: number;
  /** 深度重置间隔（毫秒），默认 60000 */
  depthResetIntervalMs?: number;
}

/**
 * SenseEngine — 感知引擎
 *
 * 职责：
 * 1. 监听 EventBus 事件
 * 2. 评估 condition 表达式 / conditionRef 函数
 * 3. 管理冷却期（EventBus 触发不可穿透，API 触发可穿透）
 * 4. 三层循环防护（静态分析 + 深度限制 + 冷却期）
 */
export class SenseEngine {
  private events: EventBus;
  private metrics: MetricsStore;
  private defaultCooldownMs: number;
  private maxDepth: number;
  private depthResetIntervalMs: number;

  /** 已注册的子系统 */
  private subsystems = new Map<string, RegisteredSubsystem>();
  /** EventBus 监听器 */
  private disposables: Disposable[] = [];
  /** 全局传播深度追踪 */
  private depthTracker: DepthTracker = { depth: 0, chainStartTime: Date.now() };
  /** 深度重置定时器 */
  private depthResetTimer?: ReturnType<typeof setInterval>;

  constructor(config: SenseEngineConfig) {
    this.events = config.events;
    this.metrics = new MetricsStore();
    this.defaultCooldownMs = config.defaultCooldownMs ?? 5000;
    this.maxDepth = config.maxDepth ?? 5;
    this.depthResetIntervalMs = config.depthResetIntervalMs ?? 60000;

    // 定期重置深度计数器（防止长期运行后深度累积）
    this.depthResetTimer = setInterval(() => {
      this.depthTracker = { depth: 0, chainStartTime: Date.now() };
    }, this.depthResetIntervalMs);
  }

  // ── 公共 API ──

  /** 获取指标存储（供主循环注入指标） */
  get metricsStore(): MetricsStore {
    return this.metrics;
  }

  /**
   * 注册子系统
   *
   * @param spec - 子系统规格
   * @param onTrigger - 触发回调
   */
  register(spec: SubsystemSpec, onTrigger: (ctx: SenseContext) => void): void {
    const evaluator = this.compileEvaluator(spec.sense);
    const entry: RegisteredSubsystem = {
      spec,
      cooldown: { until: 0 },
      evaluator,
    };
    this.subsystems.set(spec.id, entry);

    // 为 eventBus 来源的子系统注册事件监听
    if (spec.sense.source === 'eventBus' && spec.sense.filter?.events) {
      for (const eventType of spec.sense.filter.events) {
        const disposable = this.events.on(eventType, (event) => {
          this.onEvent(spec.id, event, onTrigger);
        });
        this.disposables.push(disposable);
      }
    }
  }

  /**
   * 注销子系统
   */
  unregister(subsystemId: string): void {
    this.subsystems.delete(subsystemId);
  }

  /**
   * 手动触发子系统（API 调用，可穿透冷却期）
   *
   * @param subsystemId - 子系统 ID
   * @param ctx - 触发上下文
   * @param onTrigger - 触发回调
   */
  trigger(subsystemId: string, ctx: SenseContext, onTrigger: (ctx: SenseContext) => void): boolean {
    const entry = this.subsystems.get(subsystemId);
    if (!entry) return false;

    // 检查并发深度
    if (this.depthTracker.depth >= this.maxDepth) {
      return false;
    }

    // API 触发穿透冷却期，但仍评估条件
    if (entry.evaluator && !entry.evaluator(ctx)) {
      return false;
    }

    this.depthTracker.depth++;
    try {
      onTrigger(ctx);
    } finally {
      this.depthTracker.depth--;
    }

    return true;
  }

  /**
   * 静态分析：检查子系统之间是否存在循环触发
   *
   * @param specs - 所有已注册的子系统规格
   * @returns 检测到的循环路径，空数组表示无循环
   */
  detectCycles(specs: SubsystemSpec[]): string[][] {
    // 构建事件产生 → 事件监听的依赖图
    // eventEmit[eventType] = Set<subsystemId>（产生该事件的子系统）
    // eventListen[eventType] = Set<subsystemId>（监听该事件的子系统）
    const eventEmit = new Map<string, Set<string>>();
    const eventListen = new Map<string, Set<string>>();

    for (const spec of specs) {
      const emits = spec.emits ?? spec.sense.filter?.emits ?? [];
      const normalizedEmits = emits.includes('*') ? ['*'] : emits;
      for (const evt of normalizedEmits) {
        if (!eventEmit.has(evt)) eventEmit.set(evt, new Set());
        eventEmit.get(evt)!.add(spec.id);
      }

      if (spec.sense.source === 'eventBus' && spec.sense.filter?.events) {
        for (const evt of spec.sense.filter.events) {
          if (!eventListen.has(evt)) eventListen.set(evt, new Set());
          eventListen.get(evt)!.add(spec.id);
        }
      }
    }

    const adjacency = new Map<string, Set<string>>();
    for (const [evt, listeners] of eventListen) {
      for (const listener of listeners) {
        if (!adjacency.has(listener)) adjacency.set(listener, new Set());
        const emitters = eventEmit.get(evt);
        if (!emitters) continue;
        for (const emitter of emitters) {
          if (emitter === listener) continue;
          adjacency.get(listener)!.add(emitter);
        }
      }
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (node: string, path: string[]): void => {
      visited.add(node);
      inStack.add(node);
      path.push(node);

      for (const neighbor of adjacency.get(node) ?? []) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, path);
        } else if (inStack.has(neighbor)) {
          const start = path.indexOf(neighbor);
          if (start >= 0) {
            cycles.push(path.slice(start).concat(neighbor));
          }
        }
      }

      path.pop();
      inStack.delete(node);
    };

    for (const node of adjacency.keys()) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return cycles;
  }

  /**
   * 清理所有资源
   */
  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    if (this.depthResetTimer) {
      clearInterval(this.depthResetTimer);
      this.depthResetTimer = undefined;
    }
    this.subsystems.clear();
  }

  // ── 内部方法 ──

  /**
   * EventBus 事件到达时的处理
   */
  private async onEvent(
    subsystemId: string,
    event: AgentEvent,
    onTrigger: (ctx: SenseContext) => void,
  ): Promise<void> {
    const entry = this.subsystems.get(subsystemId);
    if (!entry) return;

    // ── 第三层防护：冷却期 ──
    const now = Date.now();
    if (now < entry.cooldown.until) {
      return; // 冷却期内，不触发（EventBus 触发不可穿透）
    }

    // ── 第二层防护：传播深度 ──
    if (this.depthTracker.depth >= this.maxDepth) {
      return; // 超过最大深度，丢弃
    }

    // ── 条件评估 ──
    const ctx: SenseContext = {
      eventData: event.data,
      metrics: this.metrics.snapshot(),
      agentId: event.agentId,
      sessionId: event.sessionId,
    };

    if (entry.evaluator) {
      const ok = await entry.evaluator(ctx);
      if (!ok) {
        return; // 条件不满足
      }
    }

    // ── 检查并发限制 ──
    if (entry.spec.lifecycle?.maxConcurrent) {
      // 并发计数由 SubsystemRuntime 管理，这里只做触发
    }

    // ── 触发 ──
    this.depthTracker.depth++;
    entry.cooldown.until = now + this.defaultCooldownMs;

    try {
      onTrigger(ctx);
    } finally {
      this.depthTracker.depth--;
    }
  }

  /**
   * 编译 condition 表达式 / conditionRef 为评估函数
   */
  private compileEvaluator(sense: SenseConfig): ((ctx: SenseContext) => boolean | Promise<boolean>) | undefined {
    const condition = sense.filter?.condition;
    const conditionRefSpec = sense.filter?.conditionRef;

    if (!condition && !conditionRefSpec) {
      return undefined; // 无条件，总是匹配
    }

    if (condition && conditionRefSpec) {
      // 互斥已在 validator 校验；防御性直接返回不触发
      return () => false;
    }

    if (condition) {
      // 声明式表达式编译
      return this.compileConditionExpression(condition);
    }

    return this.buildConditionRefEvaluator(conditionRefSpec);
  }

  private buildConditionRefEvaluator(conditionRef?: string): ((ctx: SenseContext) => boolean | Promise<boolean>) | undefined {
    if (!conditionRef) {
      return undefined;
    }

    const sep = conditionRef.lastIndexOf(':');
    if (sep <= 0) {
      return () => false;
    }

    const modulePath = conditionRef.slice(0, sep);
    const exportName = conditionRef.slice(sep + 1);
    let cached: ((ctx: SenseContext) => boolean | Promise<boolean>) | undefined;

    return async (ctx: SenseContext) => {
      if (cached) {
        return cached(ctx);
      }

      try {
        const mod = await import(modulePath);
        const fn = mod[exportName];
        if (typeof fn !== 'function') {
          return false;
        }

        cached = fn as (ctx: SenseContext) => boolean | Promise<boolean>;
        return cached(ctx);
      } catch {
        return false;
      }
    };
  }

  /**
   * 编译声明式条件表达式
   *
   * 将 "turn.count % 10 === 0" 编译为 (ctx) => ctx.metrics['turn.count'] % 10 === 0
   * 变量名中的 "." 映射到 ctx.metrics 中的 key。
   */
  private compileConditionExpression(expr: string): (ctx: SenseContext) => boolean {
    // 提取表达式中的变量名（匹配 word.word 或 word 格式，排除数字和运算符）
    const variablePattern = /\b([a-zA-Z_][a-zA-Z0-9_.]*)\b/g;
    const variables = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = variablePattern.exec(expr)) !== null) {
      const name = match[1];
      // 排除 JS 关键字和内置值
      if (name !== 'true' && name !== 'false' && name !== 'null' && name !== 'undefined') {
        variables.add(name);
      }
    }

    // 构建函数体：将变量名替换为 ctx.metrics['变量名']
    let body = expr;
    for (const varName of variables) {
      // 按长度降序排列，避免短变量名误替换长变量名的前缀
      const sortedVars = Array.from(variables).sort((a, b) => b.length - a.length);
      for (const v of sortedVars) {
        body = body.replace(
          new RegExp(`\\b${v.replace(/\./g, '\\.')}\\b`, 'g'),
          `ctx.metrics['${v}']`,
        );
      }
      break; // 外层循环只用于排序，内层循环完成替换
    }

    // 实际替换所有变量（上面的循环结构需要修正）
    body = expr;
    const sortedVars = Array.from(variables).sort((a, b) => b.length - a.length);
    for (const v of sortedVars) {
      body = body.replace(
        new RegExp(`\\b${v.replace(/\./g, '\\.')}\\b`, 'g'),
        `ctx.metrics['${v}']`,
      );
    }

    try {
      // 使用 Function 构造器编译（比 eval 更安全的作用域）
      const fn = new Function('ctx', `"use strict"; return (${body});`) as (ctx: SenseContext) => boolean;
      return (ctx: SenseContext) => {
        try {
          return !!fn(ctx);
        } catch {
          return false; // 表达式执行出错，安全默认不触发
        }
      };
    } catch {
      // 编译失败，返回永不触发的函数
      return () => false;
    }
  }
}
