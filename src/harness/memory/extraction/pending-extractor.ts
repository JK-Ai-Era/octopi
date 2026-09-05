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
import type { SessionExtractBundle } from './session-extractor.js';

export interface PendingExtractorOptions {
  /** agentId（默认 'default'） */
  agentId?: string;
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

  /** 执行一次扫描 */
  async scan(): Promise<number> {
    const pendings = await this.store.listPending(this.agentId);
    let triggered = 0;

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

      try {
        await this.runtime.trigger(this.subsystemId);

        // 成功：清除重试状态并标记 completed
        this.retry.delete(sessionId);
        await this.store.updateMeta(this.agentId, sessionId, {
          ...meta,
          extractionStatus: 'completed',
        });

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
          this.retry.delete(sessionId);
        }
      }
    }

    return triggered;
  }
}
