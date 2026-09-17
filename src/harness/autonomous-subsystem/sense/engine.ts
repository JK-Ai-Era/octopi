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
  /** 该子系统持有的 EventBus 监听器（unregister 时拆除） */
  disposables: Disposable[];
  /** schedule 模式的轮询定时器 */
  scheduleTimer?: ReturnType<typeof setInterval>;
  /** 同一 entry 是否正在评估/触发（防止 await 期间并发穿透冷却） */
  inFlight?: boolean;
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
  /** condition/conditionRef 评估超时（毫秒），默认 30000；超时视为不触发并释放 inFlight */
  evaluatorTimeoutMs?: number;
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
  private evaluatorTimeoutMs: number;

  /** 已注册的子系统 */
  private subsystems = new Map<string, RegisteredSubsystem>();
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
    this.evaluatorTimeoutMs = config.evaluatorTimeoutMs ?? 30_000;

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
    // 同 id 覆盖注册时先拆旧监听/timer
    this.unregister(spec.id);

    const evaluator = this.compileEvaluator(spec.sense);
    const entry: RegisteredSubsystem = {
      spec,
      cooldown: { until: 0 },
      evaluator,
      disposables: [],
    };
    this.subsystems.set(spec.id, entry);

    // eventBus：按事件类型挂监听，unregister 时按 entry 拆除
    if (spec.sense.source === 'eventBus' && spec.sense.filter?.events) {
      for (const eventType of spec.sense.filter.events) {
        const disposable = this.events.on(eventType, (event) => {
          this.onEvent(spec.id, event, onTrigger);
        });
        entry.disposables.push(disposable);
      }
    }

    // schedule：interval 轮询；复用冷却/深度/condition/onTrigger
    if (spec.sense.source === 'schedule') {
      const intervalMs = spec.sense.interval;
      if (intervalMs && intervalMs > 0) {
        entry.scheduleTimer = setInterval(() => {
          void this.onScheduleTick(spec.id, onTrigger);
        }, intervalMs);
        if (typeof entry.scheduleTimer === 'object' && entry.scheduleTimer !== null && 'unref' in entry.scheduleTimer) {
          (entry.scheduleTimer as NodeJS.Timeout).unref?.();
        }
      }
    }
  }

  /**
   * 注销子系统：拆除其 EventBus 监听与 schedule 定时器
   */
  unregister(subsystemId: string): void {
    const entry = this.subsystems.get(subsystemId);
    if (!entry) return;

    for (const d of entry.disposables) {
      d.dispose();
    }
    entry.disposables = [];
    if (entry.scheduleTimer) {
      clearInterval(entry.scheduleTimer);
      entry.scheduleTimer = undefined;
    }
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
   * 依赖图边：listener → emitter（监听方会被产生方触发）。
   * `emits: ['*']` 按保守策略视为可能产生任意已监听事件。
   * 同一子系统同时 listen + emit 同一事件时记为自环。
   *
   * @param specs - 所有已注册的子系统规格
   * @returns 检测到的循环路径，空数组表示无循环；自环为 `[id, id]`
   */
  detectCycles(specs: SubsystemSpec[]): string[][] {
    const eventEmit = new Map<string, Set<string>>();
    const eventListen = new Map<string, Set<string>>();
    const wildcardEmitters = new Set<string>();

    for (const spec of specs) {
      const emits = spec.emits ?? spec.sense.filter?.emits ?? [];
      const listens = spec.sense.source === 'eventBus' ? (spec.sense.filter?.events ?? []) : [];

      if (emits.includes('*')) {
        wildcardEmitters.add(spec.id);
      }
      for (const evt of emits) {
        if (evt === '*') continue;
        if (!eventEmit.has(evt)) eventEmit.set(evt, new Set());
        eventEmit.get(evt)!.add(spec.id);
      }

      for (const evt of listens) {
        if (!eventListen.has(evt)) eventListen.set(evt, new Set());
        eventListen.get(evt)!.add(spec.id);
      }
    }

    // 通配符发射方：对所有已监听事件视为可能 emitter（保守）
    for (const listened of eventListen.keys()) {
      for (const id of wildcardEmitters) {
        if (!eventEmit.has(listened)) eventEmit.set(listened, new Set());
        eventEmit.get(listened)!.add(id);
      }
    }

    const cycles: string[][] = [];

    // 自环：listen ∩ 具体 emit 事件。
    // 注意：`emits: ['*']` 只参与多节点环的保守边，**不单独构成自环**（否则 LLM 监听型子系统无法注册）。
    for (const spec of specs) {
      const emits = spec.emits ?? spec.sense.filter?.emits ?? [];
      const listens = spec.sense.source === 'eventBus' ? (spec.sense.filter?.events ?? []) : [];
      if (listens.length === 0) continue;
      const selfLoop = listens.some((evt) => emits.includes(evt));
      if (selfLoop) {
        cycles.push([spec.id, spec.id]);
      }
    }

    // 多节点环：listener → emitter
    const adjacency = new Map<string, Set<string>>();
    for (const [evt, listeners] of eventListen) {
      const emitters = eventEmit.get(evt);
      if (!emitters) continue;
      for (const listener of listeners) {
        if (!adjacency.has(listener)) adjacency.set(listener, new Set());
        for (const emitter of emitters) {
          if (emitter === listener) continue;
          adjacency.get(listener)!.add(emitter);
        }
      }
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();

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
    for (const entry of this.subsystems.values()) {
      for (const d of entry.disposables) {
        d.dispose();
      }
      entry.disposables = [];
      if (entry.scheduleTimer) {
        clearInterval(entry.scheduleTimer);
        entry.scheduleTimer = undefined;
      }
    }
    if (this.depthResetTimer) {
      clearInterval(this.depthResetTimer);
      this.depthResetTimer = undefined;
    }
    this.subsystems.clear();
  }

  // ── 内部方法 ──

  /**
   * 条件评估（带超时）：仅在存在 evaluator 时调用
   * 挂起或超时返回 false，避免 inFlight 永久占用
   */
  private async evaluateCondition(
    entry: RegisteredSubsystem,
    ctx: SenseContext,
  ): Promise<boolean> {
    if (!entry.evaluator) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.evaluatorTimeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve(entry.evaluator(ctx)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

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

    const now = Date.now();
    if (now < entry.cooldown.until || entry.inFlight) {
      return;
    }

    if (this.depthTracker.depth >= this.maxDepth) {
      return;
    }

    const data = (event.data ?? {}) as Record<string, unknown>;
    const ctx: SenseContext = {
      eventData: event.data,
      metrics: this.metrics.snapshot(),
      agentId: event.agentId,
      sessionId: event.sessionId,
      // 从事件负载映射通用会话生命周期字段，供 declarative condition 直接引用
      sessionLifecycle: data.lifecycle as SenseContext['sessionLifecycle'],
      extractionStatus: data.extractionStatus as SenseContext['extractionStatus'],
      lastInteractionAt: data.lastInteractionAt as number | undefined,
      idleMs: typeof data.idleMs === 'number' ? data.idleMs : undefined,
    };

    entry.inFlight = true;
    try {
      // 无 condition 时保持同步触发；有 evaluator 才 await（含超时）
      if (entry.evaluator) {
        const ok = await this.evaluateCondition(entry, ctx);
        if (!ok) {
          return;
        }
      }

      this.depthTracker.depth++;
      entry.cooldown.until = Date.now() + this.defaultCooldownMs;

      try {
        onTrigger(ctx);
      } finally {
        this.depthTracker.depth--;
      }
    } finally {
      entry.inFlight = false;
    }
  }

  /**
   * schedule 模式到点：复用冷却期 / 深度 / condition，无 eventData
   */
  private async onScheduleTick(
    subsystemId: string,
    onTrigger: (ctx: SenseContext) => void,
  ): Promise<void> {
    const entry = this.subsystems.get(subsystemId);
    if (!entry) return;

    const now = Date.now();
    if (now < entry.cooldown.until || entry.inFlight) {
      return;
    }

    if (this.depthTracker.depth >= this.maxDepth) {
      return;
    }

    const ctx: SenseContext = {
      metrics: this.metrics.snapshot(),
    };

    entry.inFlight = true;
    try {
      if (entry.evaluator) {
        const ok = await this.evaluateCondition(entry, ctx);
        if (!ok) {
          return;
        }
      }

      this.depthTracker.depth++;
      entry.cooldown.until = Date.now() + this.defaultCooldownMs;

      try {
        onTrigger(ctx);
      } finally {
        this.depthTracker.depth--;
      }
    } finally {
      entry.inFlight = false;
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
   * 规则：
   * - 字符串字面量原样保留（不再把 `'recent'` 误识别为变量）
   * - SenseContext 顶层字段（sessionLifecycle / eventData / …）→ `ctx.<field>`
   * - `eventData.x` → `ctx.eventData.x`；`metrics.x` → `ctx.metrics['x']`
   * - 其余标识符 → `ctx.metrics['id']`（兼容 `turn.count` 等指标键）
   */
  private compileConditionExpression(expr: string): (ctx: SenseContext) => boolean {
    const body = rewriteConditionExpression(expr);

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

/** SenseContext 上可直接引用的字段（其余标识符按 metrics key 处理） */
const SENSE_CONTEXT_FIELDS = new Set([
  'eventData',
  'metrics',
  'agentId',
  'sessionId',
  'sessionLifecycle',
  'lastInteractionAt',
  'idleMs',
  'extractionStatus',
]);

/**
 * 将声明式 condition 表达式重写为可对 SenseContext 求值的 JS 表达式。
 * 导出供单测覆盖字符串字面量 / eventData 字段映射。
 */
export function rewriteConditionExpression(expr: string): string {
  const keywords = new Set(['true', 'false', 'null', 'undefined']);
  let body = '';
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i]!;

    // 字符串字面量：整段拷贝，内部标识符不替换
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      body += ch;
      i++;
      while (i < expr.length) {
        const c = expr[i]!;
        body += c;
        i++;
        if (c === '\\' && i < expr.length) {
          body += expr[i];
          i++;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }

    // 标识符
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j]!)) j++;
      const base = expr.slice(i, j);

      if (keywords.has(base)) {
        body += base;
        i = j;
        continue;
      }

      // SenseContext 字段：继续消费 .prop / ?.prop 属性链
      if (SENSE_CONTEXT_FIELDS.has(base)) {
        let rest = j;
        let suffix = '';
        while (rest < expr.length) {
          if (expr.startsWith('?.', rest)) {
            let k = rest + 2;
            let m = k;
            while (m < expr.length && /[a-zA-Z0-9_]/.test(expr[m]!)) m++;
            if (m === k) break;
            suffix += '?.' + expr.slice(k, m);
            rest = m;
            continue;
          }
          if (expr[rest] === '.' && /[a-zA-Z_]/.test(expr[rest + 1] ?? '')) {
            let k = rest + 1;
            let m = k;
            while (m < expr.length && /[a-zA-Z0-9_]/.test(expr[m]!)) m++;
            suffix += '.' + expr.slice(k, m);
            rest = m;
            continue;
          }
          break;
        }

        if (base === 'metrics') {
          const key = suffix.replace(/^[?.]+/, '');
          body += key ? `ctx.metrics[${JSON.stringify(key)}]` : 'ctx.metrics';
        } else {
          body += `ctx.${base}${suffix}`;
        }
        i = rest;
        continue;
      }

      // 其余标识符：整段 dotted name 作为 metrics key（turn.count）
      let name = base;
      let rest = j;
      while (
        rest < expr.length &&
        expr[rest] === '.' &&
        /[a-zA-Z_]/.test(expr[rest + 1] ?? '')
      ) {
        let k = rest + 1;
        let m = k;
        while (m < expr.length && /[a-zA-Z0-9_]/.test(expr[m]!)) m++;
        name += '.' + expr.slice(k, m);
        rest = m;
      }
      body += `ctx.metrics[${JSON.stringify(name)}]`;
      i = rest;
      continue;
    }

    body += ch;
    i++;
  }

  return body;
}
