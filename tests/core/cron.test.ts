import { describe, it, expect } from 'vitest';
import {
  parseCron,
  nextFireTime,
  intervalNext,
  formatHuman,
} from '../../src/core/primitives/cron.js';

/** 固定本地时间构造，避免时区对日历字段的干扰 */
function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

describe('parseCron', () => {
  it('rejects empty and wrong field count', () => {
    expect(parseCron('').ok).toBe(false);
    expect(parseCron('* * * *').ok).toBe(false);
    expect(parseCron('* * * * * *').ok).toBe(false);
  });

  it('parses star and step', () => {
    const r = parseCron('*/15 * * * *');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.minute.any).toBe(false);
    expect(r.spec.minute.values).toEqual([0, 15, 30, 45]);
    expect(r.spec.hour.any).toBe(true);
  });

  it('parses lists, ranges, and single values', () => {
    const r = parseCron('0,30 9-17 1 1-3 1-5');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.minute.values).toEqual([0, 30]);
    expect(r.spec.hour.values[0]).toBe(9);
    expect(r.spec.hour.values.at(-1)).toBe(17);
    expect(r.spec.dayOfMonth.values).toEqual([1]);
    expect(r.spec.month.values).toEqual([1, 2, 3]);
    expect(r.spec.dayOfWeek.values).toEqual([1, 2, 3, 4, 5]);
  });

  it('maps day-of-week 7 to Sunday (0)', () => {
    const r = parseCron('0 0 * * 7');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.dayOfWeek.values).toEqual([0]);
  });

  it('rejects out-of-range and bad syntax explicitly', () => {
    expect(parseCron('60 * * * *').ok).toBe(false);
    expect(parseCron('* 24 * * *').ok).toBe(false);
    expect(parseCron('*/0 * * * *').ok).toBe(false);
    expect(parseCron('5-1 * * * *').ok).toBe(false);
    expect(parseCron('abc * * * *').ok).toBe(false);
  });
});

describe('nextFireTime', () => {
  it('every-minute advances by one minute', () => {
    const parsed = parseCron('* * * * *');
    if (!parsed.ok) throw new Error(parsed.error);
    const from = at(2026, 9, 17, 10, 0);
    expect(nextFireTime(parsed.spec, from)).toBe(at(2026, 9, 17, 10, 1));
  });

  it('daily 09:00 jumps to next day when passed', () => {
    const parsed = parseCron('0 9 * * *');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const from = at(2026, 9, 17, 10, 0);
    expect(nextFireTime(parsed.spec, from)).toBe(at(2026, 9, 18, 9, 0));
  });

  it('daily 09:00 same day when before fire', () => {
    const parsed = parseCron('0 9 * * *');
    if (!parsed.ok) throw new Error(parsed.error);
    const from = at(2026, 9, 17, 8, 0);
    expect(nextFireTime(parsed.spec, from)).toBe(at(2026, 9, 17, 9, 0));
  });

  it('every 5 minutes from mid-slot', () => {
    const parsed = parseCron('*/5 * * * *');
    if (!parsed.ok) throw new Error(parsed.error);
    expect(nextFireTime(parsed.spec, at(2026, 9, 17, 10, 2))).toBe(at(2026, 9, 17, 10, 5));
  });

  it('weekday 09:00 skips Saturday → Monday', () => {
    // 2026-09-19 is Saturday
    const parsed = parseCron('0 9 * * 1-5');
    if (!parsed.ok) throw new Error(parsed.error);
    const from = at(2026, 9, 19, 10, 0);
    // 2026-09-21 is Monday
    expect(nextFireTime(parsed.spec, from)).toBe(at(2026, 9, 21, 9, 0));
  });

  it('hour rolls when minute slot already passed', () => {
    const parsed = parseCron('30 * * * *');
    if (!parsed.ok) throw new Error(parsed.error);
    expect(nextFireTime(parsed.spec, at(2026, 9, 17, 10, 45))).toBe(at(2026, 9, 17, 11, 30));
  });
});

describe('intervalNext', () => {
  it('adds ms', () => {
    expect(intervalNext(1000, 500)).toBe(1500);
  });

  it('rejects non-positive ms', () => {
    expect(() => intervalNext(0, 0)).toThrow();
    expect(() => intervalNext(0, -1)).toThrow();
  });
});

describe('formatHuman', () => {
  it('describes common patterns', () => {
    expect(formatHuman('* * * * *')).toBe('每分钟');
    expect(formatHuman('*/5 * * * *')).toBe('每 5 分钟');
    expect(formatHuman('0 9 * * *')).toBe('每天 09:00');
    expect(formatHuman('0 9 * * 1-5')).toBe('工作日 09:00');
  });

  it('falls back to raw on parse failure', () => {
    expect(formatHuman('not-a-cron')).toBe('not-a-cron');
  });
});
