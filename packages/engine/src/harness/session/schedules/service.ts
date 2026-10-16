/**
 * SessionScheduleService — 会话日程唯一写入口
 *
 * 职责：
 * - schedules.db 读写与状态机校验
 * - 薄 timer 臂（own setTimeout；禁止 import orchestration TaskScheduler）
 * - 到点先记账再 dispatch Trigger（at-most-once）
 *
 * 见 arch/session-schedules.md。
 */

import { randomUUID } from 'node:crypto';
import { intervalNext, nextFireTime, parseCron } from '@octopi-agent/core/primitives/cron.js';
import type { EventBus, AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type { Trigger } from '../../activation/types.js';
import {
  assertTransition,
  isScheduleActiveish,
  parseDurationMs,
  type ScheduleCatchUp,
  type SessionSchedule,
  type SessionScheduleCreateInput,
  type SessionScheduleStatus,
} from './types.js';
import {
  SessionScheduleStore,
  buildScheduleRecord,
  type SessionScheduleStoreOptions,
} from './store.js';

type Timer = ReturnType<typeof setTimeout>;

/** Node setTimeout 最大 delay（2^31-1）；超过会钳成 ~1ms 立刻点火 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** 点火回调：宿主接 AgentRuntime.dispatch；emit 非阻塞 */
export type SessionScheduleWakeup = (trigger: Trigger, schedule: SessionSchedule) => void;

/** notify 投递：只落会话消息，不跑模型 */
export type SessionScheduleNotify = (input: {
  schedule: SessionSchedule;
  content: string;
}) => void | Promise<void>;

export interface SessionScheduleServiceOptions extends SessionScheduleStoreOptions {
  events?: EventBus;
  /** 默认 50；0 = 不限制 */
  maxOpenPerSession?: number;
  /** 每小时 wakeup 上限；0 = 不限（默认 120） */
  maxWakesPerHour?: number;
  /** 兜底扫描间隔；0 = 关闭（默认 60s） */
  tickIntervalMs?: number;
  /** 同 coalesceKey 合并窗口；默认 500ms */
  coalesceWindowMs?: number;
  /** 点火后由宿主 dispatch（gateway 挂 AgentRuntime） */
  wakeup?: SessionScheduleWakeup;
  /** delivery=notify 时由宿主写入会话消息 */
  notify?: SessionScheduleNotify;
}

/** schedule_set 时间参数（四选一） */
export interface ScheduleTimeSpec {
  /** 相对延后，如 "2h" / 秒数 */
  delay?: string | number;
  /** 绝对 ISO 时间戳或毫秒 */
  at?: string | number;
  /** 固定间隔，如 "30m" */
  every?: string | number;
  /** 五字段 cron */
  cron?: string;
}

function now(): number {
  return Date.now();
}

function unrefTimer(timer: Timer): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
}

/**
 * 解析绝对时间
 *
 * @param at - ISO 字符串或毫秒时间戳；较小的数字按 Unix 秒解释
 */
export function parseFireAt(at: string | number): number {
  if (typeof at === 'number') {
    if (!Number.isFinite(at) || at <= 0) {
      throw new Error(`Invalid at timestamp: ${at}`);
    }
    // Unix 秒（~1.7e9）vs 毫秒（~1.7e12）：小于 1e11 视为秒
    const ms = at < 1e11 ? Math.floor(at * 1000) : Math.floor(at);
    return ms;
  }
  const raw = String(at).trim();
  // 纯数字字符串：与 number 相同规则
  if (/^\d+$/.test(raw)) {
    return parseFireAt(Number(raw));
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new Error(`Invalid at time: ${at}. Use ISO 8601 or epoch ms`);
  }
  return t;
}

/**
 * SessionScheduleService
 */
export class SessionScheduleService {
  private timers = new Map<string, Timer>();
  private firing = new Set<string>();
  private opened = false;
  private wakeup?: SessionScheduleWakeup;
  private notify?: SessionScheduleNotify;
  private store?: SessionScheduleStore;
  private tickTimer?: Timer;
  /** 滑动窗口：近 1h wakeup 点火时间戳 */
  private wakeStamps: number[] = [];
  /** coalesceKey → 上次 dispatch 时间 */
  private coalesceSeen = new Map<string, number>();

  constructor(private readonly options: SessionScheduleServiceOptions = {}) {
    this.wakeup = options.wakeup;
    this.notify = options.notify;
  }

  /**
   * 打开/建库并重臂 active 作业。幂等。
   */
  async open(): Promise<void> {
    if (this.opened) return;
    this.store = await SessionScheduleStore.create(this.options);
    this.opened = true;
    this.rearmAll();
    this.startTick();
  }

  /** 兜底扫描：防 timer 丢失（P1） */
  private startTick(): void {
    const interval = this.options.tickIntervalMs ?? 60_000;
    if (interval <= 0) return;
    this.tickTimer = setInterval(() => {
      if (!this.opened) return;
      try {
        const store = this.requireStore();
        const at = now();
        for (const s of store.listActiveDue()) {
          if (s.nextFireAt <= at && !this.timers.has(s.id) && !this.firing.has(s.id)) {
            this.arm(s);
          }
        }
      } catch {
        // 兜底 tick 失败不中断主路径
      }
    }, interval);
    unrefTimer(this.tickTimer);
  }

  /**
   * 注入点火宿主（gateway 绑 AgentRuntime.dispatch）
   *
   * @param fn - 非阻塞 dispatch
   */
  setWakeup(fn: SessionScheduleWakeup): void {
    this.wakeup = fn;
  }

  /**
   * 注入 notify 宿主（只写会话消息）
   *
   * @param fn - 写入回调
   */
  setNotify(fn: SessionScheduleNotify): void {
    this.notify = fn;
  }

  /** 拆光 timer 并关库（gateway.stop） */
  dispose(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.firing.clear();
    this.wakeStamps = [];
    this.coalesceSeen.clear();
    this.opened = false;
    this.store?.close();
    this.store = undefined;
  }

  private requireStore(): SessionScheduleStore {
    if (!this.store) {
      throw new Error('SessionScheduleService not opened; call open() first');
    }
    return this.store;
  }

  private emitEvent(type: string, schedule: SessionSchedule, extra?: Record<string, unknown>): void {
    const events = this.options.events;
    if (!events) return;
    const event: AgentEvent = {
      type,
      timestamp: now(),
      agentId: schedule.agentId,
      sessionId: schedule.sessionId,
      data: { schedule: { ...schedule }, ...extra },
    };
    events.emit(event);
  }

  // ── 时间规格 ──

  private resolveSpec(spec: ScheduleTimeSpec): {
    kind: SessionSchedule['kind'];
    fireAt?: number;
    intervalMs?: number;
    cron?: string;
    nextFireAt: number;
  } {
    const provided = [spec.delay, spec.at, spec.every, spec.cron].filter(
      (v) => v !== undefined && v !== null && String(v).trim() !== '',
    );
    if (provided.length !== 1) {
      throw new Error(
        'schedule time requires exactly one of: delay, at, every, cron',
      );
    }
    const from = now();
    if (spec.delay !== undefined && String(spec.delay).trim() !== '') {
      const ms = parseDurationMs(spec.delay);
      if (ms <= 0) throw new Error('delay must be > 0');
      const fireAt = from + ms;
      return { kind: 'once', fireAt, nextFireAt: fireAt };
    }
    if (spec.at !== undefined && String(spec.at).trim() !== '') {
      const fireAt = parseFireAt(spec.at);
      // 必须在未来：过去的 at 会变成 setTimeout(0) 立刻点火
      if (fireAt <= from) {
        throw new Error(
          `at time must be in the future (got ${new Date(fireAt).toISOString()}, now ${new Date(from).toISOString()})`,
        );
      }
      return { kind: 'once', fireAt, nextFireAt: fireAt };
    }
    if (spec.every !== undefined && String(spec.every).trim() !== '') {
      const intervalMs = parseDurationMs(spec.every);
      if (intervalMs < 1000) {
        throw new Error('every interval must be >= 1s');
      }
      return {
        kind: 'interval',
        intervalMs,
        nextFireAt: intervalNext(from, intervalMs),
      };
    }
    const cron = String(spec.cron ?? '').trim();
    const parsed = parseCron(cron);
    if (!parsed.ok) {
      throw new Error(`Invalid cron: ${parsed.error}`);
    }
    return {
      kind: 'cron',
      cron,
      nextFireAt: nextFireTime(parsed.spec, from),
    };
  }

  private computeNextFireAt(schedule: SessionSchedule, from: number): number {
    if (schedule.kind === 'interval' && schedule.intervalMs) {
      return intervalNext(from, schedule.intervalMs);
    }
    if (schedule.kind === 'cron' && schedule.cron) {
      const parsed = parseCron(schedule.cron);
      if (!parsed.ok) {
        throw new Error(`Invalid cron on schedule ${schedule.id}: ${parsed.error}`);
      }
      return nextFireTime(parsed.spec, from);
    }
    // once 不再点火
    return Number.POSITIVE_INFINITY;
  }

  // ── 查询 ──

  /**
   * 列出作业
   *
   * @param sessionId - 会话 id
   * @param filter - status / activeOnly
   */
  list(
    sessionId: string,
    filter?: { status?: SessionScheduleStatus; activeOnly?: boolean },
  ): SessionSchedule[] {
    if (!this.store) return [];
    const store = this.store;
    const statuses = filter?.activeOnly
      ? (['active', 'paused'] as SessionScheduleStatus[])
      : filter?.status
        ? [filter.status]
        : undefined;
    return store.list({ sessionId, ...(statuses ? { statuses } : {}) });
  }

  /**
   * 按 id 取作业
   *
   * @param id - ScheduleId
   */
  get(id: string): SessionSchedule | null {
    return this.requireStore().get(id);
  }

  // ── 变更 ──

  /**
   * 登记作业并 arm
   *
   * @param input - 创建入参 + 时间四选一
   */
  async set(
    input: {
      sessionId: string;
      agentId: string;
      payload: SessionScheduleCreateInput['payload'];
      maxRuns?: number;
      coalesceKey?: string;
      catchUp?: ScheduleCatchUp;
      createdByRunId?: string;
    } & ScheduleTimeSpec,
  ): Promise<SessionSchedule> {
    const store = this.requireStore();
    const resolved = this.resolveSpec(input);
    const maxOpen = this.options.maxOpenPerSession ?? 50;
    if (maxOpen > 0 && store.countOpen(input.sessionId) >= maxOpen) {
      throw new Error(
        `Too many open schedules for session ${input.sessionId} (max ${maxOpen}); cancel some first`,
      );
    }

    const id = `sch_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const record = buildScheduleRecord(
      id,
      {
        sessionId: input.sessionId,
        agentId: input.agentId,
        kind: resolved.kind,
        ...(resolved.fireAt !== undefined ? { fireAt: resolved.fireAt } : {}),
        ...(resolved.intervalMs !== undefined ? { intervalMs: resolved.intervalMs } : {}),
        ...(resolved.cron !== undefined ? { cron: resolved.cron } : {}),
        ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
        payload: input.payload,
        ...(input.coalesceKey !== undefined ? { coalesceKey: input.coalesceKey } : {}),
        catchUp: input.catchUp ?? 'skip',
        ...(input.createdByRunId ? { createdByRunId: input.createdByRunId } : {}),
      },
      resolved.nextFireAt,
      now(),
    );
    if (record.maxRuns !== undefined && record.maxRuns < 1) {
      throw new Error('max_runs must be >= 1');
    }

    store.insert(record);
    this.arm(record);
    this.emitEvent('session.schedule.created', record);
    return { ...record };
  }

  /**
   * 取消作业
   *
   * @param id - ScheduleId
   */
  cancel(id: string, _reason?: string): SessionSchedule {
    const store = this.requireStore();
    const schedule = store.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }
    if (schedule.status === 'cancelled') {
      return { ...schedule };
    }
    if (schedule.status === 'completed' || schedule.status === 'failed') {
      throw new Error(`Schedule already settled (${schedule.status}): ${id}`);
    }
    assertTransition(schedule.status, 'cancelled', id);
    this.disarm(id);
    const updatedAt = now();
    store.update(id, { status: 'cancelled', updatedAt });
    const next = { ...schedule, status: 'cancelled' as const, updatedAt };
    this.emitEvent('session.schedule.cancelled', next);
    return next;
  }

  /**
   * 暂停
   *
   * @param id - ScheduleId
   */
  pause(id: string): SessionSchedule {
    const store = this.requireStore();
    const schedule = store.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }
    if (schedule.status === 'paused') return { ...schedule };
    assertTransition(schedule.status, 'paused', id);
    this.disarm(id);
    const updatedAt = now();
    store.update(id, { status: 'paused', updatedAt });
    const next = { ...schedule, status: 'paused' as const, updatedAt };
    this.emitEvent('session.schedule.paused', next);
    return next;
  }

  /**
   * 恢复（re-arm 时套用 catchUp）
   *
   * @param id - ScheduleId
   */
  resume(id: string): SessionSchedule {
    const store = this.requireStore();
    const schedule = store.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }
    if (schedule.status === 'active') return { ...schedule };
    assertTransition(schedule.status, 'active', id);

    const at = now();
    let nextFireAt = schedule.nextFireAt;
    if (nextFireAt < at) {
      if (schedule.catchUp === 'fire_once') {
        // 补一枪：保持 nextFireAt 为过去，arm 立即 fire
        nextFireAt = at;
      } else {
        nextFireAt = this.computeNextFireAt(schedule, at);
        if (!Number.isFinite(nextFireAt)) {
          // once 已过期且 skip：直接完成
          store.update(id, { status: 'completed', updatedAt: at });
          const done = { ...schedule, status: 'completed' as const, updatedAt: at };
          this.emitEvent('session.schedule.completed', done);
          return done;
        }
      }
    }

    store.update(id, { status: 'active', nextFireAt, updatedAt: at });
    const next = {
      ...schedule,
      status: 'active' as const,
      nextFireAt,
      updatedAt: at,
    };
    this.arm(next);
    this.emitEvent('session.schedule.resumed', next);
    return next;
  }

  /**
   * 修改作业（prompt / title / max_runs / 时间 / catch_up）
   * 仅 active|paused；改时间后重算 nextFireAt 并 re-arm。
   *
   * @param id - ScheduleId
   * @param patch - 可选字段
   */
  update(
    id: string,
    patch: {
      prompt?: string;
      title?: string;
      maxRuns?: number | null;
      catchUp?: ScheduleCatchUp;
      time?: ScheduleTimeSpec;
    },
  ): SessionSchedule {
    const store = this.requireStore();
    const schedule = store.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }
    if (schedule.status !== 'active' && schedule.status !== 'paused') {
      throw new Error(`Cannot update schedule in status ${schedule.status}: ${id}`);
    }

    const at = now();
    const payload = { ...schedule.payload };
    if (patch.prompt !== undefined) {
      const text = String(patch.prompt).trim();
      if (!text) throw new Error('prompt must not be empty');
      payload.text = text;
    }
    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (title) payload.title = title;
      else delete payload.title;
    }

    const updatePatch: Parameters<SessionScheduleStore['update']>[1] = {
      payload,
      updatedAt: at,
    };
    if (patch.maxRuns !== undefined) {
      if (patch.maxRuns !== null && patch.maxRuns < 1) {
        throw new Error('max_runs must be >= 1');
      }
      updatePatch.maxRuns = patch.maxRuns;
    }
    if (patch.catchUp !== undefined) {
      updatePatch.catchUp = patch.catchUp;
    }

    let next: SessionSchedule = {
      ...schedule,
      payload,
      updatedAt: at,
      ...(patch.maxRuns !== undefined
        ? { maxRuns: patch.maxRuns ?? undefined }
        : {}),
      ...(patch.catchUp !== undefined ? { catchUp: patch.catchUp } : {}),
    };

    if (patch.time) {
      const resolved = this.resolveSpec(patch.time);
      updatePatch.kind = resolved.kind;
      updatePatch.fireAt = resolved.fireAt ?? null;
      updatePatch.intervalMs = resolved.intervalMs ?? null;
      updatePatch.cron = resolved.cron ?? null;
      updatePatch.nextFireAt = resolved.nextFireAt;
      next = {
        ...next,
        kind: resolved.kind,
        nextFireAt: resolved.nextFireAt,
        ...(resolved.fireAt !== undefined ? { fireAt: resolved.fireAt } : { fireAt: undefined }),
        ...(resolved.intervalMs !== undefined
          ? { intervalMs: resolved.intervalMs }
          : { intervalMs: undefined }),
        ...(resolved.cron !== undefined ? { cron: resolved.cron } : { cron: undefined }),
      };
    }

    store.update(id, updatePatch);
    if (next.status === 'active') {
      this.arm(next);
    }
    this.emitEvent('session.schedule.updated', next);
    return { ...next };
  }

  /**
   * 会话删除清理
   *
   * @param sessionId - 会话 id
   */
  purgeSession(sessionId: string): number {
    const store = this.requireStore();
    for (const s of store.list({ sessionId })) {
      this.disarm(s.id);
    }
    return store.deleteBySession(sessionId);
  }

  // ── timer 臂 ──

  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    this.firing.delete(id);
  }

  private arm(schedule: SessionSchedule): void {
    if (schedule.status !== 'active') return;
    this.disarm(schedule.id);
    const fireAt = schedule.nextFireAt;
    const delay = Math.max(0, fireAt - now());
    // 超过 2^31-1 时 Node 会把 delay 钳成 1ms → 假「立刻点火」；必须分段 arm
    const slice = Math.min(delay, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      this.timers.delete(schedule.id);
      if (now() < fireAt) {
        // 到点前的 sleeper 片段：继续排下一段
        this.arm(schedule);
        return;
      }
      void this.onDue(schedule.id).catch((err) => {
        // setTimeout 路径禁止冒泡 unhandledRejection；错误已写 lastError
        console.error(
          `[SessionScheduleService] onDue failed for ${schedule.id}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }, slice);
    unrefTimer(timer);
    this.timers.set(schedule.id, timer);
  }

  private rearmAll(): void {
    const store = this.requireStore();
    const at = now();
    for (const schedule of store.listActiveDue()) {
      if (schedule.nextFireAt < at) {
        if (schedule.catchUp === 'fire_once') {
          // 保持过去时间戳，arm(0) 立即补一枪
          this.arm(schedule);
          continue;
        }
        const next = this.computeNextFireAt(schedule, at);
        if (!Number.isFinite(next)) {
          store.update(schedule.id, {
            status: 'completed',
            updatedAt: at,
          });
          continue;
        }
        store.update(schedule.id, { nextFireAt: next, updatedAt: at });
        this.arm({ ...schedule, nextFireAt: next });
        continue;
      }
      this.arm(schedule);
    }
  }

  /** 测试/手动触发（穿冷却语义：仅 active） */
  async runNow(id: string): Promise<void> {
    await this.onDue(id);
  }

  private async onDue(id: string): Promise<void> {
    const store = this.requireStore();
    if (this.firing.has(id)) return;
    this.firing.add(id);
    let rearm: SessionSchedule | null = null;
    try {
      const schedule = store.get(id);
      if (!schedule || schedule.status !== 'active') return;

      const at = now();
      const fireId = randomUUID();
      const runCount = schedule.runCount + 1;
      const exhausted =
        schedule.kind === 'once' ||
        (schedule.maxRuns !== undefined && runCount >= schedule.maxRuns);

      // 3. 先记账（at-most-once）；记账/算点失败 = 不可恢复 → failed
      let nextFireAt: number;
      try {
        nextFireAt = exhausted
          ? schedule.nextFireAt
          : this.computeNextFireAt(schedule, at);
        const status: SessionScheduleStatus = exhausted ? 'completed' : 'active';
        if (exhausted) {
          assertTransition(schedule.status, 'completed', id);
        }
        store.transaction(() => {
          store.update(id, {
            runCount,
            lastFireAt: at,
            lastFireId: fireId,
            updatedAt: at,
            ...(exhausted
              ? { status: 'completed' as SessionScheduleStatus }
              : { nextFireAt }),
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          store.update(id, {
            status: 'failed',
            lastError: message,
            updatedAt: now(),
          });
        } catch {
          // 库已不可写；错误由 arm().catch 日志兜底
        }
        this.emitEvent('session.schedule.failed', {
          ...schedule,
          status: 'failed',
          lastError: message,
        });
        return;
      }

      const settled: SessionSchedule = {
        ...schedule,
        runCount,
        lastFireAt: at,
        lastFireId: fireId,
        updatedAt: at,
        status: exhausted ? 'completed' : 'active',
        ...(exhausted ? {} : { nextFireAt }),
      };
      if (!exhausted && settled.status === 'active') {
        rearm = settled;
      }

      // 4. 再点火（失败记 lastError，不阻断周期 re-arm）
      try {
        const trigger = this.toTrigger(settled, fireId);
        const skipDispatch = this.shouldCoalesce(settled, at) || this.wakeLimitExceeded(settled);
        if (skipDispatch) {
          this.emitEvent('session.schedule.fire_skipped', settled, {
            fireId,
            reason: this.wakeLimitExceeded(settled) ? 'wake_budget' : 'coalesced',
          });
        } else if (settled.payload.delivery === 'wakeup') {
          this.noteWake(at);
          this.noteCoalesce(settled, at);
          this.wakeup?.(trigger, settled);
        } else {
          // notify：只落消息，不跑模型（arch §6）
          this.noteCoalesce(settled, at);
          const content =
            trigger.payload.kind === 'system_note' || trigger.payload.kind === 'user_message'
              ? trigger.payload.content
              : settled.payload.text;
          void Promise.resolve(this.notify?.({ schedule: settled, content })).catch(
            (err) => {
              store.update(id, {
                lastError: err instanceof Error ? err.message : String(err),
                updatedAt: now(),
              });
            },
          );
        }
        this.emitEvent('session.schedule.fired', settled, { fireId, triggerId: trigger.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.update(id, { lastError: message, updatedAt: now() });
        this.emitEvent('session.schedule.fire_error', {
          ...settled,
          lastError: message,
        });
      }
    } finally {
      this.firing.delete(id);
      // 周期作业必须在此 re-arm；throw 会跳过外层 arm
      if (rearm) {
        try {
          this.arm(rearm);
        } catch {
          // arm 失败留给 rearmAll/重启兜底
        }
      }
    }
  }

  private shouldCoalesce(schedule: SessionSchedule, at: number): boolean {
    const key = schedule.coalesceKey;
    if (!key) return false;
    const last = this.coalesceSeen.get(key);
    const window = this.options.coalesceWindowMs ?? 500;
    return last !== undefined && at - last < window;
  }

  private noteCoalesce(schedule: SessionSchedule, at: number): void {
    if (schedule.coalesceKey) {
      this.coalesceSeen.set(schedule.coalesceKey, at);
    }
  }

  private wakeLimitExceeded(schedule: SessionSchedule): boolean {
    if (schedule.payload.delivery !== 'wakeup') return false;
    const max = this.options.maxWakesPerHour ?? 120;
    if (max <= 0) return false;
    return this.wakeStamps.length >= max;
  }

  private noteWake(at: number): void {
    const hourAgo = at - 3_600_000;
    this.wakeStamps = this.wakeStamps.filter((t) => t > hourAgo);
    this.wakeStamps.push(at);
  }

  private toTrigger(schedule: SessionSchedule, fireId: string): Trigger {
    const occurrence = schedule.runCount;
    const title = schedule.payload.title
      ? ` title="${schedule.payload.title}"`
      : '';
    const content = [
      `<schedule_wake id="${schedule.id}"${title} occurrence="${occurrence}">`,
      '这是你此前安排的定时唤醒。请执行下列事项；若仍需周期执行请保持 schedule 不变，已结束请调用 schedule_cancel。',
      '',
      '事项：',
      schedule.payload.text,
      '</schedule_wake>',
    ].join('\n');

    return {
      id: `trg_${fireId.slice(0, 12)}`,
      type: 'schedule',
      agentId: schedule.agentId,
      sessionId: schedule.sessionId,
      timestamp: now(),
      payload: {
        kind: 'system_note',
        content,
      },
      ...(schedule.coalesceKey ? { coalesceKey: schedule.coalesceKey } : {}),
      metadata: {
        source: 'session_schedule',
        reason: `schedule:${schedule.id}`,
      },
    };
  }
}

/** 未闭合判断（list/注入用） */
export function scheduleIsOpen(status: SessionScheduleStatus): boolean {
  return isScheduleActiveish(status);
}

export type { ScheduleCatchUp };
