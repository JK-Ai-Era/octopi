/**
 * 事件循环停滞看门狗（2026-10-28 事故的自检器官回归）
 *
 * 不变式：
 * - 主循环静默超阈值 → worker 检出停滞并落报告（不依赖已冻结的事件循环）
 * - 主循环恢复 → 落 recovered 报告
 * - 主循环正常响应 → 不误报
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoopWatchdog } from '@octopi-agent/engine/integration/observability/loop-watchdog.js';

const dirs: string[] = [];
const watchdogs: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const w of watchdogs.splice(0)) w.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), 'octopi-loopwatch-'));
  dirs.push(dir);
  return join(dir, 'watchdog.jsonl');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 同步占满主线程：事件循环在该窗口内完全冻结（accept/timer/handler 全停） */
function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy-wait：故意不用 await，确保事件循环被物理占住
  }
}

function readEvents(reportFile: string): Array<Record<string, unknown>> {
  if (!existsSync(reportFile)) return [];
  return readFileSync(reportFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('loop watchdog', () => {
  it('主循环冻结被检出并落停滞报告，恢复后落 recovered', async () => {
    const reportFile = setup();
    const watchdog = startLoopWatchdog({
      intervalMs: 50,
      stallThresholdMs: 200,
      reportFile,
      captureSample: false,
    });
    watchdogs.push(watchdog);

    // 先让心跳建立基线，再冻结主循环 700ms（远超 200ms 阈值）
    await sleep(120);
    blockEventLoop(700);
    await sleep(400);

    const events = readEvents(reportFile);
    const stall = events.find((e) => e.event === 'stall');
    expect(stall).toBeDefined();
    expect(Number(stall!.silentForMs)).toBeGreaterThanOrEqual(200);
    expect(Number(stall!.lastPongAt)).toBeGreaterThan(0);

    await sleep(300);
    const recovered = readEvents(reportFile).find((e) => e.event === 'recovered');
    expect(recovered).toBeDefined();
    expect(Number(recovered!.stalledForMs)).toBeGreaterThanOrEqual(600);
  });

  it('主循环正常响应时不误报', async () => {
    const reportFile = setup();
    const watchdog = startLoopWatchdog({
      intervalMs: 50,
      stallThresholdMs: 250,
      reportFile,
      captureSample: false,
    });
    watchdogs.push(watchdog);

    await sleep(600);
    const events = readEvents(reportFile);
    expect(events.filter((e) => e.event === 'stall')).toHaveLength(0);
  });

  it('报告目录不存在时自动建目录并落盘（serve fg 无 logs/ 的场景）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-loopwatch-nodir-'));
    dirs.push(dir);
    // 目标目录不存在
    const reportFile = join(dir, 'nested', 'logs', 'watchdog.jsonl');
    const watchdog = startLoopWatchdog({
      intervalMs: 50,
      stallThresholdMs: 200,
      reportFile,
      captureSample: false,
    });
    watchdogs.push(watchdog);

    await sleep(120);
    blockEventLoop(500);
    await sleep(400);

    const events = readEvents(reportFile);
    expect(events.find((e) => e.event === 'stall')).toBeDefined();
  });

  it('RSS 越过 footprint 阈值即落报告，滞回期内只报一次（不刷屏）', async () => {
    const reportFile = setup();
    const watchdog = startLoopWatchdog({
      intervalMs: 50,
      stallThresholdMs: 5_000,
      reportFile,
      captureSample: false,
      // 进程 RSS 必然 > 1MB：无需真的分配几个 G，等价验证「越阈值即触发」
      footprintThresholdMb: 1,
    });
    watchdogs.push(watchdog);

    await sleep(400);

    const events = readEvents(reportFile);
    const footprint = events.filter((e) => e.event === 'footprint');
    expect(footprint).toHaveLength(1);
    expect(Number(footprint[0]!.rssMb)).toBeGreaterThanOrEqual(1);
    expect(Number(footprint[0]!.thresholdMb)).toBe(1);
    // 未冻死主循环：内存阈值与停滞检测互不干扰
    expect(events.filter((e) => e.event === 'stall')).toHaveLength(0);
    // 无降回 80% 以下 → 不应出现恢复事件
    expect(events.filter((e) => e.event === 'footprint_recovered')).toHaveLength(0);
  });

  it('footprintThresholdMb=0 关闭内存阈值检测', async () => {
    const reportFile = setup();
    const watchdog = startLoopWatchdog({
      intervalMs: 50,
      stallThresholdMs: 5_000,
      reportFile,
      captureSample: false,
      footprintThresholdMb: 0,
    });
    watchdogs.push(watchdog);

    await sleep(300);
    expect(readEvents(reportFile).filter((e) => e.event === 'footprint')).toHaveLength(0);
  });
});
