/**
 * Memory Extraction — PendingExtractor（断点续提）
 *
 * 职责：
 * - 定时扫描 ExtractorStore.listPending()
 * - 对 pending session 构建 bundle 并触发 memory extractor 子系统
 * - 避免重复触发（通过 ExtractorMeta.extractionStatus 标记 completed）
 *
 * 设计：
 * - 不改变子系统内核，仅作为 harness 层“恢复调度器”
 * - 与 MemoryExtractorBridge 互补：bridge 负责实时触发，PendingExtractor 负责重启后恢复
 *
 * @module harness/memory/extraction/pending-extractor
 */

import type { SubsystemRuntime } from '../../autonomous-subsystem/runtime.js';
import type { EventBus } from '../../../core/primitives/event-bus.js';
import type { ExtractorStore } from './extractor-store.js';
import { BackpressureController, type BackpressureOptions } from './backpressure.js';
import type { SessionExtractBundle } from './session-extractor.js';

export interface PendingExtractorOptions {
  /** 回压配置（可选） */
  backpressure?: BackpressureOptions;
  /** 默认 agentId（当未配置 agentConfigs 时使用） */
  agentId?: string;
  /** 多 agent 扫描配置（可选，配置后忽略 agentId） */
  agentConfigs?: Array<{
    agentId: string;
    scanIntervalMs?: number;
    baseRetryMs?: number;
    maxRetryMs?: number;
    maxRetries?: number;
    subsystemId?: string;
  }>;
  /** 扫描间隔（毫秒，默认 30_000） */
  scanIntervalMs?: number;
  /** 是否自动启动（默认 true） */
  autoStart?: boolean;
  /** 目标子系统 ID（默认 memory.extractor） */
  subsystemId?: string;
  /** 失败重试基础间隔（毫秒，默认 60_000） */
  baseRetryMs?: number;
  /** 最大重试间隔（毫秒，默认 10*60_000） */
  maxRetryMs?: number;
  /** 最大重试次数（超过后标记 error，默认 5） */
  maxRetries?: number;
}

interface RetryState {
  failures: number;
  nextRetryAt: number;
}

export class PendingExtractor {
  private events: EventBus;
  private runtime: SubsystemRuntime;
  private store: ExtractorStore;
  private options: PendingExtractorOptions;
  private timer?: ReturnType<typeof setInterval>;
  private agentId: string;
  private subsystemId: string;
  private retry = new Map<string, RetryState>();
  private agentTimers = new Map<string, ReturnType<typeof setInterval>>();
  private backpressure?: BackpressureController;

  private emit(type: string, data: Record<string, unknown>): void {
    this.events.emit({ type, timestamp: Date.now(), agentId: this.agentId, data });
  }


  constructor(
    events: EventBus,
    runtime: SubsystemRuntime,
    store: ExtractorStore,
    options?: PendingExtractorOptions,
  ) {
    this.events = events;
    this.runtime = runtime;
    this.store = store;
    this.options = options ?? {};
    this.agentId = options?.agentId ?? 'default';
    if (options?.backpressure) {
      this.backpressure = new BackpressureController(options.backpressure);
    }
    this.subsystemId = options?.subsystemId ?? 'memory.extractor';

    if (options?.autoStart ?? true) {
      this.start();
    }
  }

  /** 启动定时扫描（幂等） */
  start(): void {
    if (this.timer) return;

    // 启动后先做一次扫描
    this.scan().catch(() => {});

    this.timer = setInterval(() => {
      this.scan().catch(() => {});
    }, this.options.scanIntervalMs ?? 30_000);
  }

  /** 停止扫描 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stop();
  }

  /** 执行一次单 agent 扫描（多 agent 模式） */
  async scanAgent(cfg: NonNullable<PendingExtractorOptions['agentConfigs']>[number]): Promise<number> {
    const agentId = cfg.agentId;
    const subsystemId = cfg.subsystemId ?? this.options.subsystemId ?? 'memory.extractor';
    this.emit('memory.extractor.pending.scan.start', { agentId, pendingCount: 0 });
    const pendings = await this.store.listPending(agentId);
    let triggered = 0;
    this.emit('memory.extractor.pending.scan.start', { agentId, pendingCount: pendings.length });

    for (const meta of pendings) {
      const sessionId = meta.sessionId;
      if (!sessionId) continue;
      const key = `${agentId}:${sessionId}`;
      const r = this.retry.get(key);
      if (r && Date.now() < r.nextRetryAt) continue;

      let bundle: SessionExtractBundle | null = await this.store.loadBundle(agentId, sessionId);
      if (!bundle) {
        const events = await this.store.loadEvents(agentId, sessionId);
        bundle = {
          sessionId,
          agentId,
          startAt: Date.now(),
          events,
          condensedTurns: [],
          runSummary: { totalTurns: 0, totalToolCalls: 0, failureRate: 0, majorErrors: [], resolvedErrors: [] },
        };
      }

      this.events.emit({ type: 'memory.extractor.bundle.ready', timestamp: Date.now(), agentId, sessionId, data: { bundle } });
      this.runtime.setMainAgentContext({ messages: [], runConfig: { agentId, sessionId }, events: this.events });

      try {
        await this.runtime.trigger(subsystemId);
        this.retry.delete(key);
        await this.store.updateMeta(agentId, sessionId, { ...meta, extractionStatus: 'completed' });
        this.emit('memory.extractor.pending.scan.session.triggered', { agentId, sessionId });
        triggered += 1;
      } catch {
        const state = this.retry.get(key) ?? { failures: 0, nextRetryAt: 0 };
        state.failures += 1;
        const base = cfg.baseRetryMs ?? this.options.baseRetryMs ?? 60_000;
        const max = cfg.maxRetryMs ?? this.options.maxRetryMs ?? 10 * 60_000;
        const delay = Math.min(max, base * Math.pow(2, state.failures - 1));
        state.nextRetryAt = Date.now() + delay;
        this.retry.set(key, state);
        if (state.failures >= (cfg.maxRetries ?? this.options.maxRetries ?? 5)) {
          await this.store.updateMeta(agentId, sessionId, { ...meta, extractionStatus: 'error' });
          this.emit('memory.extractor.pending.scan.session.error', { agentId, sessionId, failures: state.failures });
          this.retry.delete(key);
        }
      }
    }

    this.emit('memory.extractor.pending.scan.complete', { agentId, triggered });
    return triggered;
  }

  /** 执行一次扫描（默认 agentId 模式） */
  async scan(): Promise<number> {
    this.emit('memory.extractor.pending.scan.start', { agentId: this.agentId, pendingCount: 0 });
    const pendings = await this.store.listPending(this.agentId);
    let triggered = 0;
    this.emit('memory.extractor.pending.scan.start', { agentId: this.agentId, pendingCount: pendings.length });

    for (const meta of pendings) {
      const sessionId = meta.sessionId;
      if (!sessionId) continue;

      // 退避期内跳过
      const r = this.retry.get(sessionId);
      if (r && Date.now() < r.nextRetryAt) continue;

      // 加载 bundle（优先）或 events（兜底构建空 bundle）
      let bundle: SessionExtractBundle | null = await this.store.loadBundle(this.agentId, sessionId);
      if (!bundle) {
        const events = await this.store.loadEvents(this.agentId, sessionId);
        bundle = {
          sessionId,
          agentId: this.agentId,
          startAt: Date.now(),
          events,
          condensedTurns: [],
          runSummary: { totalTurns: 0, totalToolCalls: 0, failureRate: 0, majorErrors: [], resolvedErrors: [] },
        };
      }

      // 发射 bundle.ready 并触发子系统
      this.events.emit({
        type: 'memory.extractor.bundle.ready',
        timestamp: Date.now(),
        agentId: this.agentId,
        sessionId,
        data: { bundle },
      });

      this.runtime.setMainAgentContext({
        messages: [],
        runConfig: { agentId: this.agentId, sessionId },
        events: this.events,
      });

      // 并发回压
      if (this.backpressure) {
        await this.backpressure.acquire();
      }
      try {
        await this.runtime.trigger(this.subsystemId);

        // 成功：清除重试状态并标记 completed
        this.retry.delete(sessionId);
        await this.store.updateMeta(this.agentId, sessionId, {
          ...meta,
          extractionStatus: 'completed',
        });

        this.emit('memory.extractor.pending.scan.session.triggered', { agentId: this.agentId, sessionId });
        triggered += 1;
      } catch {
        // 失败：退避重试
        const state = this.retry.get(sessionId) ?? { failures: 0, nextRetryAt: 0 };
        state.failures += 1;
        const base = this.options.baseRetryMs ?? 60_000;
        const max = this.options.maxRetryMs ?? 10 * 60_000;
        const delay = Math.min(max, base * Math.pow(2, state.failures - 1));
        state.nextRetryAt = Date.now() + delay;
        this.retry.set(sessionId, state);

        if (state.failures >= (this.options.maxRetries ?? 5)) {
          await this.store.updateMeta(this.agentId, sessionId, {
            ...meta,
            extractionStatus: 'error',
          });
          this.emit('memory.extractor.pending.scan.session.error', { agentId: this.agentId, sessionId, failures: state.failures });
          this.retry.delete(sessionId);
        }
      } finally {
        this.backpressure?.release();
      }
    }

    this.emit('memory.extractor.pending.scan.complete', { agentId: this.agentId, triggered });
    return triggered;
  }
}
