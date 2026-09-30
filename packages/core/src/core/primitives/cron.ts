/**
 * Cron — 时间数学原语（Core 机制）
 *
 * 纯函数：解析表达式、算下次点火、interval 对齐、人读展示。
 * **不是**中心 Scheduler：谁点火、点了干什么，留在各 Harness 域。
 *
 * 语法子集 v1（arch/schedule.md §3.2）：
 * - 五字段：分 时 日 月 周（无秒、无 L/W/#、无时区）
 * - 支持：星号、星号-step（N 分钟）、单值、范围 a-b、逗号列表；范围-step 亦支持
 * - 非法表达式显式报错，禁止静默「1 分钟后再跑」
 */

// ── 类型 ──

/** 单字段：any 或有序去重取值集合 */
export interface CronFieldSpec {
  /** 字段为全匹配或 step 覆盖全域时为 true */
  any: boolean;
  /** 有序去重合法值；`any` 且 values 为空表示全域 */
  values: number[];
}

/** 解析后的 cron 规格 */
export interface CronSpec {
  /** 0–59 */
  minute: CronFieldSpec;
  /** 0–23 */
  hour: CronFieldSpec;
  /** 1–31 */
  dayOfMonth: CronFieldSpec;
  /** 1–12 */
  month: CronFieldSpec;
  /** 0–6（0=周日；亦接受 7 作周日） */
  dayOfWeek: CronFieldSpec;
  /** 原始表达式（展示/日志） */
  raw: string;
}

/** 解析失败 */
export interface CronParseError {
  ok: false;
  error: string;
}

/** 解析成功 */
export interface CronParseOk {
  ok: true;
  spec: CronSpec;
}

export type CronParseResult = CronParseOk | CronParseError;

interface FieldRange {
  min: number;
  max: number;
  label: string;
}

const FIELD_RANGES: Record<'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek', FieldRange> = {
  minute: { min: 0, max: 59, label: 'minute' },
  hour: { min: 0, max: 23, label: 'hour' },
  dayOfMonth: { min: 1, max: 31, label: 'day-of-month' },
  month: { min: 1, max: 12, label: 'month' },
  dayOfWeek: { min: 0, max: 6, label: 'day-of-week' },
};

/** nextFireTime 搜索上限（约 5 年，覆盖合法年周期） */
const SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * 60 * 1000;

// ── 解析 ──

/**
 * 解析简化 cron 表达式
 *
 * @param expr 五字段表达式，如 `0 9 * * 1-5`
 * @returns 成功返回 `{ ok: true, spec }`；失败返回 `{ ok: false, error }`，不抛异常
 */
export function parseCron(expr: string): CronParseResult {
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'empty cron expression' };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `expected 5 fields (minute hour day month weekday), got ${parts.length}`,
    };
  }

  const keys = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'] as const;
  const spec: CronSpec = {
    minute: { any: false, values: [] },
    hour: { any: false, values: [] },
    dayOfMonth: { any: false, values: [] },
    month: { any: false, values: [] },
    dayOfWeek: { any: false, values: [] },
    raw: trimmed,
  };

  for (let i = 0; i < 5; i++) {
    const key = keys[i]!;
    const range = FIELD_RANGES[key];
    const parsed = parseField(parts[i]!, range);
    if (!parsed.ok) {
      return { ok: false, error: `${range.label}: ${parsed.error}` };
    }
    // day-of-week：7 → 0（周日）
    if (key === 'dayOfWeek') {
      const values = parsed.field.values.map((v) => (v === 7 ? 0 : v));
      const unique = [...new Set(values)].sort((a, b) => a - b);
      spec.dayOfWeek = { any: parsed.field.any, values: unique };
    } else {
      spec[key] = parsed.field;
    }
  }

  return { ok: true, spec };
}

type FieldParseResult = { ok: true; field: CronFieldSpec } | { ok: false; error: string };

function parseField(raw: string, range: FieldRange): FieldParseResult {
  if (raw === '*') {
    return { ok: true, field: { any: true, values: [] } };
  }

  const values = new Set<number>();
  let sawAnyStep = false;

  for (const part of raw.split(',')) {
    if (part.length === 0) {
      return { ok: false, error: 'empty list item' };
    }
    const stepResult = parseFieldPart(part, range);
    if (!stepResult.ok) return stepResult;
    if (stepResult.field.any) {
      sawAnyStep = true;
      for (let v = range.min; v <= range.max; v++) values.add(v);
    } else {
      for (const v of stepResult.field.values) values.add(v);
    }
  }

  if (values.size === 0 && !sawAnyStep) {
    return { ok: false, error: `no values in "${raw}"` };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const any = sawAnyStep || (sorted.length === range.max - range.min + 1 && sorted[0] === range.min);
  return { ok: true, field: { any, values: sorted } };
}

function parseFieldPart(part: string, range: FieldRange): FieldParseResult {
  // star-step、range-step；单值带 step 拒绝
  const slash = part.indexOf('/');
  let body = part;
  let step = 1;
  if (slash >= 0) {
    body = part.slice(0, slash);
    const stepStr = part.slice(slash + 1);
    step = Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) {
      return { ok: false, error: `invalid step "${stepStr}"` };
    }
  }

  if (body === '*') {
    if (slash < 0) return { ok: true, field: { any: true, values: [] } };
    const values: number[] = [];
    for (let v = range.min; v <= range.max; v += step) values.push(v);
    const full = step === 1;
    return { ok: true, field: { any: full, values } };
  }

  // 单值
  if (!body.includes('-')) {
    const n = Number(body);
    if (!Number.isInteger(n)) {
      return { ok: false, error: `invalid value "${body}"` };
    }
    // day-of-week 允许 7
    const max = range.label === 'day-of-week' ? 7 : range.max;
    if (n < range.min || n > max) {
      return { ok: false, error: `value ${n} out of range ${range.min}-${max}` };
    }
    if (slash >= 0) {
      // N/M 无意义；按单值处理更直观，但语法上拒绝以免歧义
      return { ok: false, error: `step not allowed on single value "${part}"` };
    }
    return { ok: true, field: { any: false, values: [n] } };
  }

  // 范围 a-b
  const dash = body.indexOf('-');
  // 负数不支持；cron 字段均非负
  const startStr = body.slice(0, dash);
  const endStr = body.slice(dash + 1);
  const start = Number(startStr);
  const end = Number(endStr);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, error: `invalid range "${body}"` };
  }
  const max = range.label === 'day-of-week' ? 7 : range.max;
  if (start < range.min || start > max || end < range.min || end > max) {
    return { ok: false, error: `range "${body}" out of ${range.min}-${max}` };
  }
  if (start > end) {
    return { ok: false, error: `range start > end in "${body}"` };
  }
  const values: number[] = [];
  for (let v = start; v <= end; v += step) values.push(v);
  return { ok: true, field: { any: false, values } };
}

// ── 下次点火 ──

/**
 * 计算下一次点火时间（严格晚于 `from`，对齐到分钟）
 *
 * @param spec 已解析规格
 * @param from 起点毫秒时间戳
 * @returns 下次点火的毫秒时间戳；5 年内无匹配时抛错
 */
export function nextFireTime(spec: CronSpec, from: number): number {
  const fromDate = new Date(from);
  // 从下一整分钟开始
  let t = new Date(
    fromDate.getFullYear(),
    fromDate.getMonth(),
    fromDate.getDate(),
    fromDate.getHours(),
    fromDate.getMinutes() + 1,
    0,
    0,
  );
  const limit = from + SEARCH_LIMIT_MS;

  while (t.getTime() <= limit) {
    if (!fieldMatches(spec.month, t.getMonth() + 1)) {
      t = new Date(t.getFullYear(), t.getMonth() + 1, 1, 0, 0, 0, 0);
      continue;
    }

    if (!dayMatches(spec, t)) {
      t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, 0, 0, 0);
      continue;
    }

    if (!fieldMatches(spec.hour, t.getHours())) {
      const nextH = nextValue(spec.hour, t.getHours());
      if (nextH === null) {
        t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, 0, 0, 0);
        continue;
      }
      t = new Date(t.getFullYear(), t.getMonth(), t.getDate(), nextH, 0, 0, 0);
      continue;
    }

    if (!fieldMatches(spec.minute, t.getMinutes())) {
      const nextM = nextValue(spec.minute, t.getMinutes());
      if (nextM === null) {
        t = new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours() + 1, 0, 0, 0);
        continue;
      }
      t = new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), nextM, 0, 0);
      continue;
    }

    return t.getTime();
  }

  throw new Error(`cron "${spec.raw}" has no fire time within 5 years`);
}

/**
 * interval 型下次点火：`from + ms`，并对齐到毫秒粒度（无隐藏策略）
 *
 * @param from 起点毫秒时间戳
 * @param ms 间隔毫秒（必须 > 0）
 * @returns 下次时间戳
 */
export function intervalNext(from: number, ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`intervalNext: ms must be > 0, got ${ms}`);
  }
  return from + ms;
}

/**
 * 将 cron 表达式转为简短中文描述（UI 展示）
 *
 * @param expr cron 表达式或已解析 spec 的 raw
 * @returns 人读描述；无法解析时回退为原表达式
 */
export function formatHuman(expr: string): string {
  const parsed = parseCron(expr);
  if (!parsed.ok) return expr;
  const { minute, hour, dayOfMonth, month, dayOfWeek, raw } = parsed.spec;

  const minLabel = describeField(minute, '分');
  const hourLabel = describeField(hour, '时');
  const domLabel = describeField(dayOfMonth, '日');
  const monthLabel = describeField(month, '月');
  const dowLabel = describeDayOfWeek(dayOfWeek);

  // 常见模式优先
  if (minute.any && hour.any && dayOfMonth.any && month.any && dayOfWeek.any) {
    return '每分钟';
  }
  if (!minute.any && isStepEvery(minute) && hour.any && dayOfMonth.any && month.any && dayOfWeek.any) {
    const n = stepOf(minute);
    if (n !== null) return `每 ${n} 分钟`;
  }
  if (isSingle(minute) && isSingle(hour) && dayOfMonth.any && month.any && dayOfWeek.any) {
    return `每天 ${pad2(hour.values[0]!)}:${pad2(minute.values[0]!)}`;
  }
  if (isSingle(minute) && isSingle(hour) && dayOfMonth.any && month.any && !dayOfWeek.any) {
    return `${dowLabel} ${pad2(hour.values[0]!)}:${pad2(minute.values[0]!)}`;
  }

  // 通用拼接
  const parts: string[] = [];
  if (!month.any) parts.push(monthLabel);
  if (!dayOfMonth.any) parts.push(domLabel);
  if (!dayOfWeek.any) parts.push(dowLabel);
  if (!hour.any || !minute.any) {
    parts.push(`${hourLabel}:${minLabel}`);
  } else if (parts.length === 0) {
    return raw;
  }
  return parts.join(' ');
}

function fieldMatches(field: CronFieldSpec, value: number): boolean {
  if (field.any) return true;
  return field.values.includes(value);
}

function nextValue(field: CronFieldSpec, current: number): number | null {
  if (field.any) return current;
  for (const v of field.values) {
    if (v > current) return v;
  }
  return null;
}

/** Vixie cron：dom 与 dow 同时受限时 OR；任一为 * 则只看另一侧 */
function dayMatches(spec: CronSpec, date: Date): boolean {
  const domAny = spec.dayOfMonth.any;
  const dowAny = spec.dayOfWeek.any;
  const domOk = fieldMatches(spec.dayOfMonth, date.getDate());
  // getDay(): 0=周日
  const dowOk = fieldMatches(spec.dayOfWeek, date.getDay());

  if (domAny && dowAny) return true;
  if (domAny) return dowOk;
  if (dowAny) return domOk;
  return domOk || dowOk;
}

function isSingle(field: CronFieldSpec): boolean {
  return !field.any && field.values.length === 1;
}

function isStepEvery(field: CronFieldSpec): boolean {
  if (field.values.length < 2) return false;
  const step = field.values[1]! - field.values[0]!;
  if (step <= 1) return false;
  for (let i = 1; i < field.values.length; i++) {
    if (field.values[i]! - field.values[i - 1]! !== step) return false;
  }
  return field.values[0] === 0 || field.values[0] === 1;
}

function stepOf(field: CronFieldSpec): number | null {
  if (field.values.length < 2) return null;
  return field.values[1]! - field.values[0]!;
}

function describeField(field: CronFieldSpec, unit: string): string {
  if (field.any) return `每${unit}`;
  if (isSingle(field)) return String(field.values[0]);
  const n = stepOf(field);
  if (n !== null && isStepEvery(field)) return `每 ${n} ${unit}`;
  return field.values.join(',');
}

function describeDayOfWeek(field: CronFieldSpec): string {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  if (field.any) return '每天';
  if (field.values.length === 5 && field.values.join(',') === '1,2,3,4,5') {
    return '工作日';
  }
  if (field.values.length === 2 && field.values.join(',') === '0,6') {
    return '周末';
  }
  return `周${field.values.map((v) => names[v] ?? String(v)).join('、')}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
