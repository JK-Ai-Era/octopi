/**
 * 归档保留任务调度对齐 + 注册表 meta —— 槽位语义（每日 04:30 本地）与补跑判定。
 *
 * - nextRetentionRunAt / lastRetentionSlotAt：严格「之后」/「已到」的槽位边界
 * - shouldRunRetention：跨槽漏跑补跑、同槽重复启动跳过（lastRun 落盘语义）
 * - ArchiveRegistry meta kv：retention.lastRun 的持久化面
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  nextRetentionRunAt,
  lastRetentionSlotAt,
  shouldRunRetention,
} from '@octopi-agent/engine/integration/storage/archives/retention-job.js';
import { ArchiveRegistry } from '@octopi-agent/engine/integration/storage/archives/registry.js';

/** 本地时间构造（与被测函数同为本地时区语义，任意 TZ 下自洽） */
function local(y: number, m: number, d: number, h: number, min: number): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

describe('retention-job 槽位计算', () => {
  it('nextRetentionRunAt：今日 04:30 前→今日；到点/之后→明日（严格晚于）', () => {
    expect(nextRetentionRunAt(local(2026, 11, 24, 3, 0))).toBe(local(2026, 11, 24, 4, 30));
    expect(nextRetentionRunAt(local(2026, 11, 24, 4, 30))).toBe(local(2026, 11, 25, 4, 30));
    expect(nextRetentionRunAt(local(2026, 11, 24, 23, 59))).toBe(local(2026, 11, 25, 4, 30));
    expect(nextRetentionRunAt(local(2026, 11, 30, 12, 0))).toBe(local(2026, 12, 1, 4, 30));
  });

  it('lastRetentionSlotAt：今日 04:30 前→昨日；到点/之后→今日', () => {
    expect(lastRetentionSlotAt(local(2026, 11, 24, 3, 0))).toBe(local(2026, 11, 23, 4, 30));
    expect(lastRetentionSlotAt(local(2026, 11, 24, 4, 30))).toBe(local(2026, 11, 24, 4, 30));
    expect(lastRetentionSlotAt(local(2026, 11, 24, 12, 0))).toBe(local(2026, 11, 24, 4, 30));
  });

  it('shouldRunRetention：未跑过必跑；同槽已跑跳过；跨槽漏跑补跑', () => {
    const slot = local(2026, 11, 24, 4, 30);
    const now = local(2026, 11, 24, 18, 0);
    // 从未跑过
    expect(shouldRunRetention(null, now)).toBe(true);
    // 本槽内已跑（04:30 后任意时刻）→ 跳过
    expect(shouldRunRetention(slot + 1, now)).toBe(false);
    expect(shouldRunRetention(local(2026, 11, 24, 9, 0), now)).toBe(false);
    // 上次跑在上一个槽之前（停机跨槽）→ 补跑
    expect(shouldRunRetention(local(2026, 11, 24, 3, 0), now)).toBe(true);
    expect(shouldRunRetention(local(2026, 11, 23, 4, 30), now)).toBe(true);
    // 凌晨场景：今天 04:30 未到，昨天 04:30 后跑过 → 跳过
    const early = local(2026, 11, 24, 3, 0);
    expect(shouldRunRetention(local(2026, 11, 23, 5, 0), early)).toBe(false);
    expect(shouldRunRetention(local(2026, 11, 23, 4, 0), early)).toBe(true);
  });
});

describe('ArchiveRegistry meta kv（retention.lastRun 落盘面）', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('getMeta/setMeta：缺省 null、写后可读、覆盖生效、关库重开仍在', () => {
    dir = mkdtempSync(join(tmpdir(), 'octopi-archive-meta-'));
    const dbPath = join(dir, 'archives.db');
    const reg = new ArchiveRegistry(dbPath);
    expect(reg.getMeta('retention.lastRun')).toBeNull();
    reg.setMeta('retention.lastRun', '111');
    expect(reg.getMeta('retention.lastRun')).toBe('111');
    reg.setMeta('retention.lastRun', '222');
    expect(reg.getMeta('retention.lastRun')).toBe('222');
    reg.close();
    const reopened = new ArchiveRegistry(dbPath);
    expect(reopened.getMeta('retention.lastRun')).toBe('222');
    reopened.close();
  });
});
