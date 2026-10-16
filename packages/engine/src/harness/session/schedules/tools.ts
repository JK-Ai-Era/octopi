/**
 * schedule_* / timer_* 工具
 *
 * - timer_*：回合内阻塞等待（arch/session-schedules.md §5.1）
 * - schedule_*：登记跨回合作业，立刻返回（§5.2）
 * 写入唯一入口是 SessionScheduleService；工具不直接碰 Store。
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import type { SessionSchedule, SessionScheduleStatus } from './types.js';
import { parseDurationMs } from './types.js';
import type { SessionScheduleService } from './service.js';

/** timer_wait 默认上限 10 分钟；硬顶 30 分钟（可经 options 覆盖） */
export interface TimerWaitToolOptions {
  /** 默认 10 * 60_000 */
  maxDurationMs?: number;
  /** 默认 30 * 60_000 */
  hardMaxDurationMs?: number;
}

const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
const DEFAULT_HARD_MAX_WAIT_MS = 30 * 60_000;

/** 每会话协作取消源集合（timer_cancel 全部 abort） */
const sessionWaits = new Map<string, Set<AbortController>>();

function trackWait(sessionId: string, controller: AbortController): void {
  let set = sessionWaits.get(sessionId);
  if (!set) {
    set = new Set();
    sessionWaits.set(sessionId, set);
  }
  set.add(controller);
}

function untrackWait(sessionId: string, controller: AbortController): void {
  const set = sessionWaits.get(sessionId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) sessionWaits.delete(sessionId);
}

function scheduleSummary(s: SessionSchedule) {
  return {
    id: s.id,
    session_id: s.sessionId,
    kind: s.kind,
    status: s.status,
    next_fire_at: s.nextFireAt,
    fire_at: s.fireAt,
    interval_ms: s.intervalMs,
    cron: s.cron,
    run_count: s.runCount,
    max_runs: s.maxRuns,
    delivery: s.payload.delivery,
    title: s.payload.title,
    prompt: s.payload.text,
    task_id: s.payload.taskId,
    catch_up: s.catchUp,
    coalesce_key: s.coalesceKey,
    created_at: s.createdBy.at,
    last_fire_at: s.lastFireAt,
    last_error: s.lastError,
    updated_at: s.updatedAt,
  };
}

function resolveDuration(args: Record<string, unknown>): number {
  if (args.duration !== undefined && args.duration !== null && String(args.duration).trim() !== '') {
    return parseDurationMs(args.duration as string | number);
  }
  if (args.seconds !== undefined && args.seconds !== null && String(args.seconds).trim() !== '') {
    return parseDurationMs(Number(args.seconds));
  }
  if (args.every !== undefined && args.every !== null && String(args.every).trim() !== '') {
    return parseDurationMs(args.every as string | number);
  }
  if (args.delay !== undefined && args.delay !== null && String(args.delay).trim() !== '') {
    return parseDurationMs(args.delay as string | number);
  }
  throw new Error('Missing duration; provide duration (e.g. "45s") or seconds');
}

/**
 * 创建 timer_* + schedule_* 工具集
 *
 * @param service - SessionScheduleService（须已 open）
 * @param timerOptions - timer_wait 上限
 */
export function createSessionScheduleTools(
  service: SessionScheduleService,
  timerOptions?: TimerWaitToolOptions,
): RegisteredTool[] {
  return [
    createTimerWaitTool(timerOptions),
    createTimerCancelTool(),
    createScheduleSetTool(service),
    createScheduleUpdateTool(service),
    createScheduleListTool(service),
    createScheduleCancelTool(service),
    createSchedulePauseTool(service),
    createScheduleResumeTool(service),
  ];
}

/** timer_wait — 回合内阻塞 */
export function createTimerWaitTool(options?: TimerWaitToolOptions): RegisteredTool {
  const maxMs = options?.maxDurationMs ?? DEFAULT_MAX_WAIT_MS;
  const hardMaxMs = options?.hardMaxDurationMs ?? DEFAULT_HARD_MAX_WAIT_MS;
  return {
    definition: {
      name: 'timer_wait',
      capabilities: [],
      description:
        'Block the current turn and wait for a short duration (seconds~minutes), then continue. ' +
        'For waking later after the turn ends, use schedule_set instead. ' +
        `Max ${Math.round(maxMs / 60000)} minutes (hard cap ${Math.round(hardMaxMs / 60000)}).`,
      timeoutMs: hardMaxMs + 5_000,
      parameters: {
        duration: {
          type: 'string',
          description: 'Wait duration: "30s", "5m", "2h", or a number of seconds',
        },
        seconds: {
          type: 'number',
          description: 'Wait duration in seconds (alternative to duration)',
          minimum: 0,
        },
      },
    },
    handler: async (args, context) => {
      const ms = resolveDuration(args);
      if (ms > hardMaxMs) {
        throw new Error(
          `timer_wait duration ${ms}ms exceeds hard max ${hardMaxMs}ms. ` +
            'Use schedule_set to leave this turn and continue later.',
        );
      }
      if (ms > maxMs) {
        throw new Error(
          `timer_wait duration ${ms}ms exceeds max ${maxMs}ms. ` +
            'Use schedule_set to leave this turn and continue later.',
        );
      }

      const startedAt = Date.now();
      const controller = new AbortController();
      const onParentAbort = (): void => controller.abort();
      if (context.abortSignal) {
        if (context.abortSignal.aborted) {
          throw new Error('timer_wait aborted before start');
        }
        context.abortSignal.addEventListener('abort', onParentAbort, { once: true });
      }
      trackWait(context.sessionId, controller);

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(new Error('timer_wait cancelled'));
          };
          if (controller.signal.aborted) {
            clearTimeout(timer);
            reject(new Error('timer_wait cancelled'));
            return;
          }
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
      } finally {
        context.abortSignal?.removeEventListener('abort', onParentAbort);
        untrackWait(context.sessionId, controller);
      }

      const endedAt = Date.now();
      return {
        waited_ms: endedAt - startedAt,
        started_at: startedAt,
        ended_at: endedAt,
      };
    },
  };
}

/** timer_cancel — 取消本会话在途 timer_wait */
export function createTimerCancelTool(): RegisteredTool {
  return {
    definition: {
      name: 'timer_cancel',
      capabilities: [],
      description: 'Cancel an in-flight timer_wait in this session.',
      parameters: {},
    },
    handler: async (_args, context) => {
      const set = sessionWaits.get(context.sessionId);
      if (!set || set.size === 0) {
        return { cancelled: false, reason: 'no_active_wait' };
      }
      const n = set.size;
      for (const controller of set) {
        controller.abort();
      }
      sessionWaits.delete(context.sessionId);
      return { cancelled: true, aborted: n };
    },
  };
}

/** schedule_set */
export function createScheduleSetTool(service: SessionScheduleService): RegisteredTool {
  return {
    definition: {
      name: 'schedule_set',
      capabilities: ['send'],
      description:
        'Register a non-blocking schedule that wakes this session LATER (or periodically) and runs a full agent turn THEN. ' +
        'CRITICAL: Do NOT execute the prompt now and do NOT start the work in this turn. ' +
        'After schedule_set returns, end your turn immediately and wait for the scheduled wake. ' +
        'Exactly one of delay / at / every / cron. ' +
        'Use timer_wait instead only if you must stay blocked in this turn.',
      parameters: {
        prompt: {
          type: 'string',
          description:
            'What to do WHEN THE SCHEDULE FIRES (not now). Keep it self-contained for a later turn.',
          required: true,
        },
        title: {
          type: 'string',
          description: 'Short display title',
        },
        delay: {
          type: 'string',
          description: 'One-shot relative delay, e.g. "2h", "30m", or seconds',
        },
        at: {
          type: 'string',
          description:
            'One-shot absolute future time (ISO 8601 with timezone, or epoch ms). Must be in the future.',
        },
        every: {
          type: 'string',
          description: 'Recurring interval, e.g. "30m"',
        },
        cron: {
          type: 'string',
          description: 'Recurring cron: "分 时 日 月 周", e.g. "0 9 * * 1-5"',
        },
        max_runs: {
          type: 'number',
          description: 'Stop after N successful fires (recurring)',
          minimum: 1,
        },
        delivery: {
          type: 'string',
          description: 'wakeup = full agent run (default); notify = message only',
          enum: ['wakeup', 'notify'],
        },
        task_id: {
          type: 'string',
          description: 'Optional SessionTask id to link',
        },
        coalesce_key: {
          type: 'string',
          description: 'Merge rapid fires with the same key',
        },
        catch_up: {
          type: 'string',
          description: 'Missed fire policy after pause/restart',
          enum: ['skip', 'fire_once'],
        },
      },
    },
    handler: async (args, context) => {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) {
        throw new Error('prompt must not be empty');
      }
      const delivery =
        args.delivery === 'notify' ? ('notify' as const) : ('wakeup' as const);
      const schedule = await service.set({
        sessionId: context.sessionId,
        agentId: context.agentId,
        payload: {
          delivery,
          text: prompt,
          ...(args.title ? { title: String(args.title) } : {}),
          ...(args.task_id ? { taskId: String(args.task_id) } : {}),
        },
        ...(context.runId ? { createdByRunId: context.runId } : {}),
        ...(args.delay !== undefined ? { delay: args.delay as string | number } : {}),
        ...(args.at !== undefined ? { at: args.at as string | number } : {}),
        ...(args.every !== undefined ? { every: args.every as string | number } : {}),
        ...(args.cron !== undefined ? { cron: String(args.cron) } : {}),
        ...(args.max_runs !== undefined ? { maxRuns: Number(args.max_runs) } : {}),
        ...(args.coalesce_key
          ? { coalesceKey: String(args.coalesce_key) }
          : {}),
        ...(args.catch_up === 'fire_once' || args.catch_up === 'skip'
          ? { catchUp: args.catch_up }
          : {}),
      });
      return {
        ...scheduleSummary(schedule),
        note:
          'SCHEDULE REGISTERED — DO NOT run the prompt now. End this turn. ' +
          'The platform will wake this session at next_fire_at and then you execute the prompt.',
        do_not_run_now: true,
      };
    },
  };
}

/** schedule_update */
export function createScheduleUpdateTool(service: SessionScheduleService): RegisteredTool {
  return {
    definition: {
      name: 'schedule_update',
      capabilities: ['send'],
      description:
        'Update an existing schedule (prompt, title, max_runs, catch_up, or time). ' +
        'Only active/paused schedules can be updated. Changing time re-arms the job.',
      parameters: {
        id: { type: 'string', description: 'Schedule id', required: true },
        prompt: { type: 'string', description: 'New prompt (what to do when fired)' },
        title: { type: 'string', description: 'New display title' },
        max_runs: { type: 'number', description: 'New max fire count', minimum: 1 },
        catch_up: {
          type: 'string',
          description: 'Missed fire policy',
          enum: ['skip', 'fire_once'],
        },
        delay: { type: 'string', description: 'Replace time with relative delay' },
        at: { type: 'string', description: 'Replace time with absolute future time' },
        every: { type: 'string', description: 'Replace time with interval' },
        cron: { type: 'string', description: 'Replace time with cron' },
      },
    },
    handler: async (args, context) => {
      const id = String(args.id ?? '');
      const existing = service.get(id);
      if (!existing || existing.sessionId !== context.sessionId) {
        throw new Error(`Schedule not found in this session: ${id}`);
      }
      const hasTime = ['delay', 'at', 'every', 'cron'].some(
        (k) => args[k] !== undefined && String(args[k]).trim() !== '',
      );
      const timeSpec = hasTime
        ? {
            ...(args.delay !== undefined && String(args.delay).trim() !== ''
              ? { delay: args.delay as string | number }
              : {}),
            ...(args.at !== undefined && String(args.at).trim() !== ''
              ? { at: args.at as string | number }
              : {}),
            ...(args.every !== undefined && String(args.every).trim() !== ''
              ? { every: args.every as string | number }
              : {}),
            ...(args.cron !== undefined && String(args.cron).trim() !== ''
              ? { cron: String(args.cron) }
              : {}),
          }
        : undefined;

      const schedule = service.update(id, {
        ...(args.prompt !== undefined ? { prompt: String(args.prompt) } : {}),
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.max_runs !== undefined ? { maxRuns: Number(args.max_runs) } : {}),
        ...(args.catch_up === 'skip' || args.catch_up === 'fire_once'
          ? { catchUp: args.catch_up }
          : {}),
        ...(timeSpec ? { time: timeSpec } : {}),
      });
      return scheduleSummary(schedule);
    },
  };
}

/** schedule_list */
export function createScheduleListTool(service: SessionScheduleService): RegisteredTool {
  return {
    definition: {
      name: 'schedule_list',
      capabilities: ['fs-read'],
      description: 'List schedules in this session (default: open active/paused).',
      parameters: {
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['active', 'paused', 'completed', 'cancelled', 'failed'],
        },
        active_only: {
          type: 'boolean',
          description: 'Only active and paused (default true)',
        },
      },
    },
    handler: async (args, context) => {
      const activeOnly = args.active_only !== false;
      const status = args.status as SessionScheduleStatus | undefined;
      const items = service.list(context.sessionId, {
        activeOnly: status ? false : activeOnly,
        ...(status ? { status } : {}),
      });
      return {
        schedules: items.map(scheduleSummary),
        total: items.length,
      };
    },
  };
}

/** schedule_cancel */
export function createScheduleCancelTool(service: SessionScheduleService): RegisteredTool {
  return {
    definition: {
      name: 'schedule_cancel',
      capabilities: ['send'],
      description: 'Cancel a schedule by id. Settled schedules cannot be cancelled.',
      parameters: {
        id: { type: 'string', description: 'Schedule id', required: true },
        reason: { type: 'string', description: 'Optional reason' },
      },
    },
    handler: async (args, context) => {
      const id = String(args.id ?? '');
      const reason = args.reason ? String(args.reason) : undefined;
      // 仅允许取消本会话作业，避免跨会话误操作
      const existing = service.get(id);
      if (!existing || existing.sessionId !== context.sessionId) {
        throw new Error(`Schedule not found in this session: ${id}`);
      }
      const schedule = service.cancel(id, reason);
      return scheduleSummary(schedule);
    },
  };
}

/** schedule_pause */
export function createSchedulePauseTool(service: SessionScheduleService): RegisteredTool {
  return {
    definition: {
      name: 'schedule_pause',
      capabilities: ['send'],
      description: 'Pause an active schedule (no fire until resume).',
      parameters: {
        id: { type: 'string', description: 'Schedule id', required: true },
      },
    },
    handler: async (args, context) => {
      const id = String(args.id ?? '');
      const existing = service.get(id);
      if (!existing || existing.sessionId !== context.sessionId) {
        throw new Error(`Schedule not found in this session: ${id}`);
      }
      return scheduleSummary(service.pause(id));
    },
  };
}

/** schedule_resume */
export function createScheduleResumeTool(service: SessionScheduleService): RegisteredTool {
  return {
    definition: {
      name: 'schedule_resume',
      capabilities: ['send'],
      description: 'Resume a paused schedule (applies catch_up policy if overdue).',
      parameters: {
        id: { type: 'string', description: 'Schedule id', required: true },
      },
    },
    handler: async (args, context) => {
      const id = String(args.id ?? '');
      const existing = service.get(id);
      if (!existing || existing.sessionId !== context.sessionId) {
        throw new Error(`Schedule not found in this session: ${id}`);
      }
      return scheduleSummary(service.resume(id));
    },
  };
}
