/**
 * ScheduleSource — 自有 interval/cron 薄定时器
 *
 * 禁止 import orchestration/TaskScheduler（arch/agent-runtime.md §7）。
 * emit 非阻塞：到点只产 Trigger，不 await dispatch。
 */

import { randomUUID } from 'node:crypto';
import type { Trigger, TriggerPayload, TriggerSource } from '../types.js';

export interface ScheduleJob {
  id?: string;
  agentId: string;
  sessionId?: string;
  /** 毫秒间隔；与 cron 二选一（v1 先 interval） */
  intervalMs?: number;
  /** 简化 cron：分 时 日 月 周；与 interval 二选一 */
  cron?: string;
  payload: TriggerPayload;
  coalesceKey?: string;
  metadata?: Trigger['metadata'];
  /** 是否立即先跑一次 */
  runOnStart?: boolean;
}

export interface ScheduleSourceConfig {
  id?: string;
  jobs: ScheduleJob[];
}

type Timer = ReturnType<typeof setInterval>;

export class ScheduleSource implements TriggerSource {
  readonly id: string;
  readonly type = 'schedule' as const;
  private timers = new Map<string, Timer>();
  private running = false;
  private emitFn?: (t: Trigger) => void;

  constructor(private readonly config: ScheduleSourceConfig) {
    this.id = config.id ?? `schedule-${randomUUID().slice(0, 8)}`;
  }

  async start(emit: (t: Trigger) => void): Promise<void> {
    this.running = true;
    this.emitFn = emit;
    for (const job of this.config.jobs) {
      this.armJob(job, emit);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  private armJob(job: ScheduleJob, emit: (t: Trigger) => void): void {
    const jobId = job.id ?? randomUUID();
    const fire = (): void => {
      if (!this.running) return;
      emit(this.toTrigger(job, jobId));
    };

    if (job.runOnStart) {
      // 非阻塞；遵守 §5.1
      queueMicrotask(fire);
    }

    const intervalMs = job.intervalMs ?? parseCronIntervalMs(job.cron);
    if (intervalMs <= 0) return;

    const timer = setInterval(fire, intervalMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref?.();
    }
    this.timers.set(jobId, timer);
  }

  private toTrigger(job: ScheduleJob, jobId: string): Trigger {
    return {
      id: `trg-${randomUUID().slice(0, 12)}`,
      type: 'schedule',
      agentId: job.agentId,
      sessionId: job.sessionId,
      payload: job.payload,
      coalesceKey: job.coalesceKey,
      metadata: {
        source: this.id,
        reason: `schedule:${jobId}`,
        ...job.metadata,
      },
    };
  }
}

// 简化 cron：支持 star-slash-N（每 N 分钟）与 star（每分钟）；非法表达式返回 0（不调度）
function parseCronIntervalMs(cron?: string): number {
  if (!cron) return 0;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    console.warn(`[ScheduleSource] invalid cron "${cron}", job skipped`);
    return 0;
  }
  const minute = parts[0]!;
  if (minute === '*') return 60_000;
  const star = minute.match(/^\*\/(\d+)$/);
  if (star) {
    const n = Number(star[1]);
    if (n > 0) return n * 60_000;
  }
  console.warn(`[ScheduleSource] unsupported cron minute field "${minute}", job skipped`);
  return 0;
}
