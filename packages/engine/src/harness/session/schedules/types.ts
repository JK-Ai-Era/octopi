/**
 * SessionSchedule — Agent 自发起跨回合作业
 *
 * 见 arch/session-schedules.md。与 SessionTask 词汇刻意分离，避免语义混用。
 *
 * @layer harness/session/schedules — 独立作业注册表（schedules.db），非 Discourse。
 */

/** 作业状态 */
export type SessionScheduleStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled'
  /** 不可恢复：无法计算下次点火 / 记账失败（瞬时 dispatch 错误只写 lastError，不进 failed） */
  | 'failed';

/** 时间形态 */
export type SessionScheduleKind = 'once' | 'interval' | 'cron';

/** 点火投递方式 */
export type ScheduleDelivery = 'wakeup' | 'notify';

/** 重启/暂停错过点火策略 */
export type ScheduleCatchUp = 'skip' | 'fire_once';

/** 到点要做的事 */
export interface SessionSchedulePayload {
  /** wakeup = 本会话完整 Run；notify = 只落消息 */
  delivery: ScheduleDelivery;
  /** 到点指令正文 */
  text: string;
  /** 可选关联 SessionTask */
  taskId?: string;
  /** 展示用短标题 */
  title?: string;
}

/** 作业记录 */
export interface SessionSchedule {
  id: string;
  sessionId: string;
  agentId: string;
  kind: SessionScheduleKind;
  /** once：绝对毫秒时间戳 */
  fireAt?: number;
  /** interval：间隔毫秒 */
  intervalMs?: number;
  /** cron：五字段表达式 */
  cron?: string;
  nextFireAt: number;
  maxRuns?: number;
  runCount: number;
  payload: SessionSchedulePayload;
  coalesceKey?: string;
  catchUp: ScheduleCatchUp;
  status: SessionScheduleStatus;
  createdBy: { runId?: string; at: number };
  lastFireAt?: number;
  lastFireId?: string;
  lastError?: string;
  updatedAt: number;
}

/** 创建入参 */
export interface SessionScheduleCreateInput {
  sessionId: string;
  agentId: string;
  kind: SessionScheduleKind;
  fireAt?: number;
  intervalMs?: number;
  cron?: string;
  maxRuns?: number;
  payload: SessionSchedulePayload;
  coalesceKey?: string;
  catchUp?: ScheduleCatchUp;
  createdByRunId?: string;
}

// ── 状态机（arch/session-schedules.md §4.1） ──

/** 合法迁移表；终态无出边 */
export const SCHEDULE_TRANSITIONS: Readonly<
  Record<SessionScheduleStatus, readonly SessionScheduleStatus[]>
> = {
  active: ['paused', 'completed', 'cancelled', 'failed'],
  paused: ['active', 'cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
};

/** 未闭合（注入与 list 默认） */
export const ACTIVE_SCHEDULE_STATUSES: readonly SessionScheduleStatus[] = [
  'active',
  'paused',
];

export const TERMINAL_SCHEDULE_STATUSES: readonly SessionScheduleStatus[] = [
  'completed',
  'cancelled',
  'failed',
];

/**
 * 是否允许 from → to
 *
 * @param from - 当前状态
 * @param to - 目标状态
 */
export function canTransition(
  from: SessionScheduleStatus,
  to: SessionScheduleStatus,
): boolean {
  return SCHEDULE_TRANSITIONS[from].includes(to);
}

/**
 * 校验迁移；非法则抛错（禁止静默 no-op）
 *
 * @param from - 当前状态
 * @param to - 目标状态
 * @param id - 作业 id（错误信息）
 */
export function assertTransition(
  from: SessionScheduleStatus,
  to: SessionScheduleStatus,
  id?: string,
): void {
  if (from === to) {
    return;
  }
  if (!canTransition(from, to)) {
    const allowed = SCHEDULE_TRANSITIONS[from].join(', ') || '(none)';
    throw new Error(
      `Illegal schedule transition: ${from} → ${to}${id ? ` (${id})` : ''}. Allowed: ${allowed}`,
    );
  }
}

/**
 * 是否未闭合
 *
 * @param status - 作业状态
 */
export function isScheduleActiveish(status: SessionScheduleStatus): boolean {
  return ACTIVE_SCHEDULE_STATUSES.includes(status);
}

// ── 时长解析（timer_wait / delay / every 共用） ──

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * 解析时长为毫秒。
 * 接受 `"30s" | "5m" | "2h" | "1d" | "500ms"`，或数字（按 **秒** 解释，与 timer_wait.seconds 一致）。
 *
 * @param input - 时长字符串或秒数
 * @returns 毫秒；非法输入抛错
 */
export function parseDurationMs(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Invalid duration seconds: ${input}`);
    }
    return Math.round(input * 1000);
  }
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error('Duration must not be empty');
  }
  // 纯数字字符串按秒
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    return Math.round(Number(raw) * 1000);
  }
  const m = DURATION_RE.exec(raw);
  if (!m) {
    throw new Error(
      `Invalid duration: ${input}. Use e.g. "30s", "5m", "2h", "1d", or seconds number`,
    );
  }
  const unit = m[2]!.toLowerCase();
  return Math.round(Number(m[1]) * UNIT_MS[unit]!);
}
