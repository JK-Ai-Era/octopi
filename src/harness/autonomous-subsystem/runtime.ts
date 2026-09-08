/**
 * Autonomous Subsystem — SubsystemRuntime
 *
 * 核心运行时，管理子系统的注册、触发、执行和生命周期。
 * 替代旧的 AgentRuntime。
 *
 * @module autonomous-subsystem/runtime
 */

import type { EventBus, AgentEvent } from '../../core/primitives/event-bus.js';
import type { RegisteredTool, Message } from '../../core/types.js';
import { setTimeout as delay } from 'node:timers/promises';
import { SubsystemTimeoutError } from './errors.js';
import { TokenBudgetExceededError } from './think/executor.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { ErrorStrategy } from '../../core/interfaces/error-strategy.js';
import { randomUUID } from 'node:crypto';
import type {
  SubsystemSpec,
  SubsystemInput,
  SubsystemOutput,
  SubsystemRun,
  AgentContext,
  SenseContext,
  Signal,
  ActResult,
  ActMode,
  InjectedDependencies,
  SubsystemHandler,
} from './types.js';
import { SenseEngine } from './sense/engine.js';
import { MetricsStore } from './sense/metrics.js';
import { ThinkExecutor } from './think/executor.js';
import type { ThinkExecutorConfig } from './think/executor.js';
import { ModelResolver } from './think/model-resolver.js';
import type { ModelLevelMap } from './types.js';
import { SignalBus } from './signal/bus.js';
import { SubsystemSessionManager } from './session/manager.js';
import { AuditWriter } from './audit/writer.js';
import { validateSubsystemSpec } from './boundary/validator.js';
import { buildAgentInput } from './sense/input-builder.js';

// ── SharedDeps ──

export interface SharedDeps {
  model: ModelProvider;
  events: EventBus;
  errorStrategy: ErrorStrategy;
  mainTools: Map<string, RegisteredTool>;
  modelLevels?: ModelLevelMap;
  defaultModelProvider?: string;
  /** 依赖注入注册表：名称 → 实现实例，供 runtimeInject.requires 解析 */
  injectRegistry?: Map<string, unknown>;
}

// ── RegisteredSubsystem ──

interface RegisteredSubsystem {
  spec: SubsystemSpec;
  concurrency: number;
}

// ── SubsystemRuntimeConfig ──

export interface SubsystemRuntimeConfig {
  deps: SharedDeps;
  auditDir?: string;
  agentId?: string;
}

// ── SubsystemRuntime ──

export class SubsystemRuntime {
  private deps: SharedDeps;
  private senseEngine: SenseEngine;
  private thinkExecutor: ThinkExecutor;
  private signalBus: SignalBus;
  private sessionManager: SubsystemSessionManager;
  private auditWriter?: AuditWriter;
  private modelResolver: ModelResolver;
  private subsystems = new Map<string, RegisteredSubsystem>();
  private mainAgentContext?: AgentContext;
  private runPromises = new Map<string, { resolve: () => void; reject: (err: unknown) => void; promise: Promise<void> }>();
  private abortTimers: ReturnType<typeof setTimeout>[] = [];
  private activeTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: SubsystemRuntimeConfig) {
    this.deps = config.deps;

    this.senseEngine = new SenseEngine({
      events: config.deps.events,
    });

    this.modelResolver = new ModelResolver({
      levels: config.deps.modelLevels ?? {
        mini: { primary: 'default/mini' },
        standard: { primary: 'default/standard' },
        pro: { primary: 'default/pro' },
      },
      defaultProvider: config.deps.defaultModelProvider,
    });

    this.thinkExecutor = new ThinkExecutor({
      modelResolver: this.modelResolver,
      modelProvider: config.deps.model,
      errorStrategy: config.deps.errorStrategy,
    });

    this.signalBus = new SignalBus({ events: config.deps.events });
    this.sessionManager = new SubsystemSessionManager();
    config.deps.events.on('session.ended', (event) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const agentId = (event.agentId as string) ?? (data.agentId as string);
      const sessionId = (event.sessionId as string) ?? (data.sessionId as string);
      if (agentId && sessionId) {
        this.sessionManager.deleteBySessionId(agentId, sessionId);
      }
    });

    if (config.auditDir) {
      this.auditWriter = new AuditWriter({
        auditDir: config.auditDir,
        agentId: config.agentId,
      });
    }
  }

  private cancelPendingAbortTimers(): void {
    for (const timer of this.abortTimers) {
      clearTimeout(timer);
    }
    this.abortTimers.length = 0;
  }

  private createRunTracker(subsystemId: string): { resolve: () => void; reject: (err: unknown) => void; promise: Promise<void> } {
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const tracker = { resolve, reject, promise };
    this.runPromises.set(subsystemId, tracker);
    return tracker;
  }

  private completeRunTracker(subsystemId: string, tracker: { resolve: () => void; reject: (err: unknown) => void }): void {
    this.runPromises.delete(subsystemId);
    tracker.resolve();
  }

  private isTimeoutError(err: Error): boolean {
    return err instanceof SubsystemTimeoutError || err.name === 'SubsystemTimeoutError';
  }

  private isTokenBudgetError(err: Error): boolean {
    return err instanceof TokenBudgetExceededError || err.name === 'TokenBudgetExceededError';
  }

  private buildInterruptedOutput(status: 'timeout' | 'degraded' | 'success', degradeOn: 'timeout' | 'error' | 'both'): SubsystemOutput {
    const shouldDeliverSignal = status === 'timeout'
      ? degradeOn === 'error' || degradeOn === 'both'
      : true;

    const action = status === 'timeout' ? 'alert' : 'suggest';
    const reason = status === 'timeout'
      ? 'Subsystem execution timed out before completion.'
      : 'Subsystem execution interrupted due to token budget constraints.';

    if (!shouldDeliverSignal) {
      return { signals: [] };
    }

    return {
      signals: [
        {
          action,
          reason,
          confidence: 0,
          data: { status },
        },
      ],
    } satisfies SubsystemOutput;
  }

  // ── Public API ──

  /** 获取 MetricsStore（供主循环注入指标） */
  get metrics(): MetricsStore {
    return this.senseEngine.metricsStore;
  }

  /** 获取 SignalBus（供主循环消费信号） */
  get signals(): SignalBus {
    return this.signalBus;
  }

  /** 设置主 Agent 上下文引用 */
  setMainAgentContext(ctx: AgentContext): void {
    this.mainAgentContext = ctx;
  }

  /**
   * 注册子系统
   *
   * @returns 校验错误，空数组表示注册成功
   */
  register(spec: SubsystemSpec): string[] {
    // 校验
    const errors = validateSubsystemSpec(spec);
    if (errors.length > 0) {
      return errors.map((e) => `[${e.field}] ${e.message}`);
    }

    if (this.subsystems.has(spec.id)) {
      return [`Subsystem "${spec.id}" already registered`];
    }

    const entry: RegisteredSubsystem = { spec, concurrency: 0 };
    this.subsystems.set(spec.id, entry);

    // 注册到 SenseEngine
    this.senseEngine.register(spec, (ctx) => {
      this.onTrigger(spec.id, ctx);
    });

    this.deps.events.emit({
      type: 'subsystem.registered',
      timestamp: Date.now(),
      data: { subsystemId: spec.id, name: spec.name },
    });

    return [];
  }

  /**
   * 注册依赖到注入注册表
   *
   * @param name - 依赖名称
   * @param impl - 依赖实现实例
   */
  registerDependency(name: string, impl: unknown): void {
    if (!this.deps.injectRegistry) {
      this.deps.injectRegistry = new Map();
    }
    this.deps.injectRegistry.set(name, impl);
  }

  /**
   * 从注入注册表移除依赖
   */
  unregisterDependency(name: string): void {
    this.deps.injectRegistry?.delete(name);
  }

  /**
   * 注销子系统
   */
  unregister(subsystemId: string): void {
    this.subsystems.delete(subsystemId);
    this.senseEngine.unregister(subsystemId);
  }

  /**
   * 手动触发子系统（API 调用，穿透冷却期）
   */
  async trigger(subsystemId: string): Promise<void> {
    let runPromise: Promise<void> | undefined;
    const ctx: SenseContext = {
      metrics: this.metrics.snapshot(),
      agentId: this.mainAgentContext?.runConfig.agentId,
      sessionId: this.mainAgentContext?.runConfig.sessionId,
    };

    const triggered = this.senseEngine.trigger(subsystemId, ctx, (senseCtx) => {
      this.onTrigger(subsystemId, senseCtx);
      const tracked = this.runPromises.get(subsystemId);
      if (tracked) {
        runPromise = tracked.promise;
      }
    });

    if (!triggered || !runPromise) {
      return;
    }

    await runPromise;
  }

  /**
   * 应用待处理的上下文注入
   */
  applyPendingInjections(messages: Message[]): void {
    this.signalBus.applyPendingContext(messages);
  }

  /** 已注册的子系统数量 */
  get subsystemCount(): number {
    return this.subsystems.size;
  }

  /**
   * 清理所有资源
   */
  dispose(): void {
    this.cancelPendingAbortTimers();
    this.senseEngine.dispose();
    this.sessionManager.dispose();
    this.signalBus.clear();
  }

  // ── 内部方法 ──

  /**
   * 触发回调（由 SenseEngine 调用）
   */
  private async onTrigger(subsystemId: string, ctx: SenseContext): Promise<void> {
    const entry = this.subsystems.get(subsystemId);
    if (!entry) return;

    // 并发限制
    if (entry.spec.lifecycle?.maxConcurrent &&
        entry.concurrency >= entry.spec.lifecycle.maxConcurrent) {
      return;
    }

    // lifecycle.onTrigger 检查
    if (entry.spec.lifecycle?.onTrigger) {
      if (!entry.spec.lifecycle.onTrigger(ctx)) return;
    }

    entry.concurrency++;
    const startTime = Date.now();
    const runId = `run-${randomUUID().slice(0, 8)}`;

    // 构建输入
    const agentCtx = this.mainAgentContext ?? this.buildFallbackAgentContext();
    const input = buildAgentInput(entry.spec, agentCtx);

    // 通用：当 SenseContext.eventData 携带结构化 bundle 时，透传到 SubsystemInput.payload
    if (ctx.eventData && typeof ctx.eventData === 'object') {
      const eventDataObj = ctx.eventData as Record<string, unknown>;
      const bundle = eventDataObj.bundle;
      if (bundle && typeof bundle === 'object') {
        if (!input.payload) input.payload = {};
        (input.payload as Record<string, unknown>).sessionExtractBundle = bundle;
      }
    }

    // 获取会话
    const session = this.sessionManager.getOrCreate(
      subsystemId,
      entry.spec.session,
      agentCtx.runConfig.agentId,
      agentCtx.runConfig.sessionId,
    );

    // 发射开始事件
    this.deps.events.emit({
      type: 'subsystem.start',
      timestamp: Date.now(),
      data: { subsystemId, runId, trigger: ctx },
    });

    entry.spec.lifecycle?.onStart?.();

    const lifecycle = entry.spec.lifecycle;
    const maxDurationMs = lifecycle?.maxDurationMs;
    const existingTimer = this.activeTimeouts.get(subsystemId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.activeTimeouts.delete(subsystemId);
    }
    const maxTokens = lifecycle?.maxTokens;
    const degradeOn = lifecycle?.degradeOn ?? 'both';
    const abortController = new AbortController();
    const runTracker = this.createRunTracker(subsystemId);

    if (maxDurationMs && maxDurationMs > 0) {
      const timer = setTimeout(() => {
        abortController.abort(new SubsystemTimeoutError(`Subsystem ${subsystemId} timed out after ${maxDurationMs}ms`));
      }, maxDurationMs);
      this.abortTimers.push(timer);
      this.activeTimeouts.set(subsystemId, timer);
    }

    const run: SubsystemRun = {
      id: runId,
      subsystemId,
      trigger: { source: ctx.eventData ? 'eventBus' : 'manual', data: ctx.eventData, timestamp: startTime },
      input,
      signals: [],
      acts: [],
      durationMs: 0,
      status: 'success',
      timestamp: startTime,
      sessionKey: session.key,
    };

    try {
      const tools = this.resolveTools(entry.spec);

      let injectDeps: InjectedDependencies | undefined;
      if (entry.spec.runtimeInject) {
        const registry = this.deps.injectRegistry;
        injectDeps = {};
        if (registry) {
          for (const depName of entry.spec.runtimeInject.requires) {
            const impl = registry.get(depName);
            if (impl !== undefined) {
              injectDeps[depName] = impl;
            }
          }
        }
        if (entry.spec.metadata?.config && typeof entry.spec.metadata.config === 'object') {
          injectDeps['__subsystem_config__'] = entry.spec.metadata.config;
        }
        if (entry.spec.think.model) {
          const resolved = this.modelResolver.resolve(entry.spec.think.model);
          injectDeps['__resolved_model__'] = resolved.primary.model;
        }
      }

      const result = await this.thinkExecutor.execute(
        entry.spec.think,
        input,
        entry.spec.act.mode,
        tools,
        injectDeps,
        { abortSignal: abortController.signal, tokenBudget: maxTokens },
      );

      run.output = result.output;
      run.tokenUsage = result.tokenUsage ?? this.inferTokenUsage(run.tokenUsage, input, result.output);
      run.durationMs = Date.now() - startTime;

      const actResult = this.processAct(entry.spec.act.mode, result.output);
      if (actResult) {
        run.acts.push(actResult);
      }

      run.signals = result.output.signals;
      this.signalBus.deliver(subsystemId, result.output, entry.spec.signal);

      session.messages.push({
        role: 'user',
        content: JSON.stringify(input),
        timestamp: startTime,
      });
      session.messages.push({
        role: 'assistant',
        content: JSON.stringify(result.output),
        timestamp: Date.now(),
      });
      session.lastAccessAt = Date.now();

      entry.spec.lifecycle?.onComplete?.(result.output);

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (this.isTimeoutError(error)) {
        run.status = 'timeout';
        run.error = error.message;
        run.durationMs = Date.now() - startTime;
        run.output = this.buildInterruptedOutput('timeout', degradeOn);
        run.signals = run.output.signals;

        this.signalBus.deliver(subsystemId, run.output, entry.spec.signal);
      } else if (this.isTokenBudgetError(error)) {
        run.status = degradeOn === 'error' || degradeOn === 'both' ? 'degraded' : 'success';
        run.error = error.message;
        run.durationMs = Date.now() - startTime;
        run.output = this.buildInterruptedOutput(run.status, degradeOn);
        run.signals = run.output.signals;

        if (run.status === 'degraded') {
          this.signalBus.deliver(subsystemId, run.output, entry.spec.signal);
        }
      } else {
        run.status = 'failed';
        run.error = error.message;
        run.durationMs = Date.now() - startTime;

        this.deps.events.emit({
          type: 'subsystem.error',
          timestamp: Date.now(),
          data: { subsystemId, runId, error: error.message },
        });
      }

      entry.spec.lifecycle?.onError?.(error);

    } finally {
      entry.concurrency--;
      this.cancelPendingAbortTimers();
      const active = this.activeTimeouts.get(subsystemId);
      if (active) {
        clearTimeout(active);
        this.activeTimeouts.delete(subsystemId);
      }
      this.completeRunTracker(subsystemId, runTracker);

      this.auditWriter?.write(run);

      this.deps.events.emit({
        type: 'subsystem.complete',
        timestamp: Date.now(),
        data: { subsystemId, runId, status: run.status, durationMs: run.durationMs },
      });
    }
  }

  /**
   * 处理 Act
   */
  private inferTokenUsage(existing: SubsystemRun['tokenUsage'], input: SubsystemInput, output: SubsystemOutput): SubsystemRun['tokenUsage'] {
    if (existing) return existing;

    const promptChars = JSON.stringify(input).length;
    const completionChars = JSON.stringify(output).length;
    if (promptChars + completionChars === 0) return undefined;

    return {
      prompt: promptChars,
      completion: completionChars,
      total: promptChars + completionChars,
    } satisfies { prompt: number; completion: number; total: number };
  }

  private processAct(actMode: ActMode, output: SubsystemOutput): ActResult | undefined {
    if (actMode === 'none') {
      return undefined;
    }

    const blockSignal = output.signals.find((s) => s.action === 'block');
    const replaceSignal = output.signals.find((s) => s.action === 'replace');
    const injectSignals = output.signals.filter((s) => s.action === 'suggest' || s.action === 'alert');

    if (actMode === 'block') {
      return {
        mode: 'block',
        status: blockSignal ? 'success' : 'failed',
        proceed: blockSignal ? false : true,
        result: blockSignal ? { blocked: true, reason: blockSignal.reason } : undefined,
      };
    }

    if (actMode === 'modify') {
      return {
        mode: 'modify',
        status: replaceSignal ? 'success' : 'failed',
        messages: replaceSignal ? [{ role: 'system', content: replaceSignal.reason }] : undefined,
      };
    }

    if (actMode === 'inject') {
      return {
        mode: 'inject',
        status: injectSignals.length > 0 ? 'success' : 'failed',
        messages: injectSignals.map((s) => ({ role: 'system' as const, content: `[${s.action}] ${s.reason}` })),
      };
    }

    return undefined;
  }

  /**
   * 解析子系统的工具集
   */
  private resolveTools(spec: SubsystemSpec): Map<string, RegisteredTool> | undefined {
    switch (spec.tools.mode) {
      case 'none':
        return undefined;
      case 'full':
        return new Map(this.deps.mainTools);
      case 'subset': {
        const result = new Map<string, RegisteredTool>();
        for (const name of spec.tools.names ?? []) {
          const tool = this.deps.mainTools.get(name);
          if (tool) result.set(name, tool);
        }
        return result;
      }
      case 'custom':
        if (!spec.tools.definitions) return undefined;
        return new Map(spec.tools.definitions.map((t) => [t.definition.name, t]));
    }
  }

  private buildFallbackAgentContext(): AgentContext {
    return {
      messages: [],
      runConfig: { systemPrompt: '', agentId: 'main', sessionId: 'main' },
      events: this.deps.events,
    };
  }
}
