/**
 * 事件循环停滞看门狗（宿主自检器官）
 *
 * 背景（2026-10-28 事故）：网关事件循环被同步阻塞整体冻结约 4.5 小时——两个 run 的
 * turn 同时停摆、HTTP accept 停止、SIGTERM handler 无法运行，最终被 `serve restart`
 * 的 SIGKILL 升级收尾。事后缺一份阻塞现场的栈采样，确切阻塞点永久失考。
 *
 * 机制：独立 worker 线程（不随主循环冻结）定期 ping 主线程；主线程 message handler
 * 回 pong 以证明事件循环存活。主循环冻结 → pong 静默超阈值 → worker 判定停滞：
 * 写 JSONL 报告 +（macOS）自动 `sample <pid>` 抓主线程栈。检测与取证全部发生在
 * worker 侧，不依赖已被冻结的事件循环。
 *
 * 第二道闸：进程 RSS 越过 `footprintThresholdMb` 即同样落报告 + 采栈。停滞检测
 * 只能证明「已经僵死」，内存失控则可能在冻死前给出一段可干预的窗口——2026-10-30
 * 网关膨胀到 30.5G 的进程在采样完成后几分钟就被系统收走。
 *
 * 设计约束：
 * - 观测 fail-open：看门狗自身的任何失败不得影响宿主（写盘/采样失败静默吞掉）。
 * - worker unref：不阻止进程退出；宿主应显式 `stop()` 收尾。
 * - 复发 runbook：报告文件给出停滞起点（lastPongAt），`.sample-*.txt` 给出阻塞栈；
 *   若自动采样失败，在杀进程前手动执行 `sample <pid> 5 -f /tmp/octopi-hang.txt`。
 *
 * @module integration/observability/loop-watchdog
 */

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { getOctopiHome } from '../../paths.js';

/** 看门狗配置 */
export interface LoopWatchdogOptions {
  /** 显式关闭（缺省开启；关闭态返回 no-op 句柄） */
  enabled?: boolean;
  /** 心跳间隔（毫秒，缺省 5_000） */
  intervalMs?: number;
  /** 主循环静默多久判停滞（毫秒，缺省 30_000） */
  stallThresholdMs?: number;
  /** 报告落盘路径（JSONL，每行一个事件；缺省 `<OCTOPI_HOME>/logs/loop-watchdog.jsonl`） */
  reportFile?: string;
  /** 停滞时自动 `sample` 抓主线程栈（macOS 专属；缺省 true，测试关闭） */
  captureSample?: boolean;
  /**
   * 进程 RSS 阈值（MB，缺省 4096；传 0 关闭）
   *
   * 越过阈值即写 `footprint` 事件并采栈——不必等事件循环冻死。用于在内存
   * 失控的早期抓住现场（滞回：跌回阈值的 80% 以下才复位，避免阈值附近反复采样）。
   */
  footprintThresholdMb?: number;
}

/** 看门狗句柄 */
export interface LoopWatchdog {
  /** 停止看门狗并回收 worker */
  stop(): void;
}

/**
 * worker 侧脚本（eval 载入；此处为字符串以规避 dist/源码双态下的模块解析差异）
 *
 * 职责：心跳 ping、停滞判定、报告落盘、栈采样。不得引用 worker_threads 之外的
 * 外部模块形态（eval worker 无 ESM import，只能 require）。
 */
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { appendFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { spawnSync } = require('node:child_process');

let lastPongAt = Date.now();
let stalledSince = undefined;
let footprintLatched = false;

const writeReport = (record) => {
  try {
    mkdirSync(dirname(workerData.reportFile), { recursive: true });
    appendFileSync(workerData.reportFile, JSON.stringify(record) + '\\n');
  } catch {
    // 观测 fail-open：报告写盘失败不得影响 worker 自身的监测
  }
};

const captureStack = (tag) => {
  if (!workerData.captureSample || process.platform !== 'darwin') return;
  const sampleFile = workerData.sampleFile.replace('{{ts}}', tag + '-' + Date.now());
  try {
    const r = spawnSync('sample', [String(process.pid), '3', '-f', sampleFile], {
      timeout: 15000,
      stdio: 'ignore',
    });
    // spawnSync 失败不抛（ENOENT 等走返回值）：必须按返回值如实留痕，
    // 否则「宣称采样成功」会把运维引向不存在的文件
    if (r.error == null && r.status === 0) {
      console.error('[LoopWatchdog] stack sample written: ' + sampleFile);
    } else {
      console.error('[LoopWatchdog] stack sample FAILED (' + (r.error ? r.error.message : 'exit ' + r.status) + '); run manually: sample ' + process.pid + ' 5 -f /tmp/octopi-hang.txt');
    }
  } catch (err) {
    console.error('[LoopWatchdog] stack sample FAILED: ' + String(err) + '; run manually: sample ' + process.pid + ' 5 -f /tmp/octopi-hang.txt');
  }
};

parentPort.on('message', (msg) => {
  if (msg && msg.type === 'pong') {
    lastPongAt = Date.now();
    if (stalledSince !== undefined) {
      writeReport({
        event: 'recovered',
        detectedAt: new Date().toISOString(),
        stalledForMs: Date.now() - stalledSince,
      });
      console.error('[LoopWatchdog] event loop recovered after ' + (Date.now() - stalledSince) + 'ms stall');
      stalledSince = undefined;
    }
  }
});

setInterval(() => {
  parentPort.postMessage({ type: 'ping' });
  const silentForMs = Date.now() - lastPongAt;
  if (stalledSince === undefined && silentForMs >= workerData.stallThresholdMs) {
    stalledSince = lastPongAt;
    writeReport({
      event: 'stall',
      detectedAt: new Date().toISOString(),
      silentForMs,
      lastPongAt,
      pid: process.pid,
    });
    console.error('[LoopWatchdog] event loop stalled: no heartbeat for ' + silentForMs + 'ms (pid ' + process.pid + ')');
    captureStack('stall');
  }

  // 内存足迹阈值：在撑爆前留出干预窗口。
  // 2026-10-30 事故里 footprint 涨到 30.5G 时主线程已被原生 h2 扩容循环吃满，
  // 等到心跳消失再采样只是事后取证——进程几分钟后就被系统收走，无从止损。
  // 滞回（跌回 80% 以下才复位）避免在阈值附近反复采样。
  const thresholdMb = workerData.footprintThresholdMb;
  if (thresholdMb > 0) {
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    if (!footprintLatched && rssMb >= thresholdMb) {
      footprintLatched = true;
      writeReport({
        event: 'footprint',
        detectedAt: new Date().toISOString(),
        rssMb,
        thresholdMb,
        pid: process.pid,
      });
      console.error('[LoopWatchdog] footprint ' + rssMb + 'MB >= threshold ' + thresholdMb + 'MB (pid ' + process.pid + ')');
      captureStack('footprint');
    } else if (footprintLatched && rssMb < thresholdMb * 0.8) {
      footprintLatched = false;
      writeReport({
        event: 'footprint_recovered',
        detectedAt: new Date().toISOString(),
        rssMb,
        thresholdMb,
      });
      console.error('[LoopWatchdog] footprint back under threshold: ' + rssMb + 'MB');
    }
  }
}, workerData.intervalMs);
`;

/**
 * 启动事件循环停滞看门狗
 *
 * @param options - 心跳间隔 / 停滞阈值 / 报告路径 / 是否自动栈采样
 * @returns 看门狗句柄（`stop()` 回收 worker）
 */
export function startLoopWatchdog(options: LoopWatchdogOptions = {}): LoopWatchdog {
  if (options.enabled === false) {
    return { stop: () => {} };
  }
  const reportFile = options.reportFile ?? join(getOctopiHome(), 'logs', 'loop-watchdog.jsonl');
  const worker = new Worker(WORKER_SRC, {
    eval: true,
    workerData: {
      intervalMs: options.intervalMs ?? 5_000,
      stallThresholdMs: options.stallThresholdMs ?? 30_000,
      reportFile,
      captureSample: options.captureSample ?? true,
      sampleFile: `${reportFile}.sample-{{ts}}.txt`,
      footprintThresholdMb: options.footprintThresholdMb ?? 4096,
    },
  });
  // 心跳应答（主循环冻结时此 handler 不再被调度——正是停滞信号）
  worker.on('message', (msg: unknown) => {
    if ((msg as { type?: string } | null)?.type === 'ping') {
      worker.postMessage({ type: 'pong' });
    }
  });
  worker.on('error', (err) => {
    // 观测 fail-open：worker 自身崩溃不得影响宿主；但必须留痕——否则自检能力
    // 整个进程生命周期无声缺席（eval worker 启动失败/平台差异）
    console.warn(`[LoopWatchdog] worker error, stall detection disabled: ${String(err)}`);
  });
  // 不阻止进程退出
  worker.unref();
  return {
    stop: () => {
      worker.terminate().catch(() => {
        // 关停竞态（worker 已退出）无害
      });
    },
  };
}
