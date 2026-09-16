/**
 * ScheduleSource — 自有 interval/cron 薄定时器
 *
 * 禁止 import orchestration/TaskScheduler（arch/agent-runtime.md §7）。
 * emit 非阻塞：到点只产 Trigger，不 await dispatch。
 * 时间数学走 `core/primitives/cron.ts`；本文件只负责 arm/unarm 与产 Trigger。
 */

import { randomUUID } from 'node:crypto';
import { parseCron, nextFireTime } from '../../../core/primitives/cron.js';
import type { CronSpec } from '../../../core/primitives/cron.js';
import type { Trigger, TriggerPayload, TriggerSource } from '../types.js';

export interface ScheduleJob {
  id?: string;
  agentId: string;
  sessionId?: string;
  /** 毫秒间隔；与 cron 二选一 */
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

type Timer = ReturnType<typeof setTimeout>;

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
    for (const t of this.timers.values()) clearTimeout(t);
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
      queueMicrotask(fire);
    }

    if (job.intervalMs != null) {
      if (job.intervalMs <= 0) {
        console.warn(`[ScheduleSource] invalid intervalMs ${job.intervalMs}, job skipped`);
        return;
      }
      const timer = setInterval(fire, job.intervalMs) as unknown as Timer;
      this.unref(timer);
      this.timers.set(jobId, timer);
      return;
    }

    if (job.cron) {
      const parsed = parseCron(job.cron);
      if (!parsed.ok) {
        console.warn(`[ScheduleSource] invalid cron "${job.cron}": ${parsed.error}, job skipped`);
        return;
      }
      this.armCron(jobId, parsed.spec, fire);
    }
  }

  /** cron 链：到点 fire 后按 nextFireTime 再 arm；stop 时 clearTimeout */
  private armCron(jobId: string, spec: CronSpec, fire: () => void): void {
    const scheduleNext = (): void => {
      if (!this.running) return;
      const next = nextFireTime(spec, Date.now());
      const delay = Math.max(0, next - Date.now());
      const timer = setTimeout(() => {
        fire();
        scheduleNext();
      }, delay);
      this.unref(timer);
      this.timers.set(jobId, timer);
    };
    scheduleNext();
  }

  private unref(timer: Timer): void {
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref?.();
    }
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
