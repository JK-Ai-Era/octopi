/**
 * 进程级崩溃取证（gateway 进程唯一注册点）。
 *
 * ## 为什么存在
 *
 * 2026-11-17，gateway 进程两次"无声消失"：日志停在 `[Runner] run end ... reason=completed`，
 * 没有崩溃栈、没有 Windows WER 报告、System 事件日志为空、pid 文件残留（说明没走正常
 * 退出路径）。**当时无法回答"进程为什么死的"** —— 因为全仓没有任何进程级异常 handler，
 * 也没有心跳，"进程不存在了"这件事本身不留任何痕迹。
 *
 * ## 三样证据
 *
 * 1. `uncaughtException` / `unhandledRejection` → 写栈后 `exit(1)`。
 *    必须显式退出：注册 handler 会**覆盖** Node 默认的"直接终止"，若只记日志就把它悄悄
 *    变成"带病继续跑"，那比崩溃更糟。
 * 2. `exit` 与信号 → `[EXIT]` / `[SIGNAL]` 行。
 *    **没有 `[EXIT]` 行本身就是硬证据**：`TerminateProcess`（`taskkill /F`、Job Object
 *    关闭、安全软件终止）不给进程任何机会执行代码，那正是"日志干净地断掉"的形态。
 * 3. 每分钟心跳，带 RSS。心跳停在哪里死亡就在哪里；RSS 单调上升即内存问题。
 *
 * ## 为什么用 writeSync
 *
 * 进程退出时 stream 缓冲会丢，所以取证不能走 `console.*`。这里同步写 fd 2
 * （daemon 把 fd 1/2 都指向 gateway.log）。
 *
 * @module cli/crash-forensics
 */

import { writeSync } from 'node:fs';

/** 心跳间隔（毫秒）。心跳本身就是"进程是否还活着"的唯一客观证据。 */
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * 安装崩溃取证。幂等：重复调用只装一次。
 *
 * @param writeLine - 单行写入函数（默认同步写 fd 2）；测试可注入以捕获输出
 * @returns 卸载函数（主要供测试使用）
 */
export function installCrashForensics(
  writeLine: (line: string) => void = (line) => {
    try {
      writeSync(2, `${line}\n`);
    } catch {
      /* 日志 fd 不可写时无处可记；取证本身绝不能打断进程 */
    }
  },
): () => void {
  if (installed) return uninstallCurrent;
  installed = true;

  const startedAt = Date.now();
  const uptime = (): string => `${Math.round((Date.now() - startedAt) / 1000)}s`;

  const onUncaught = (err: Error): void => {
    writeLine(`[FATAL] uncaughtException after ${uptime()}\n${err?.stack ?? String(err)}`);
    process.exit(1);
  };
  const onRejection = (reason: unknown): void => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    writeLine(`[FATAL] unhandledRejection after ${uptime()}\n${detail}`);
    process.exit(1);
  };
  const onExit = (code: number): void => {
    writeLine(`[EXIT] code=${String(code)} uptime=${uptime()}`);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;
  const onSignal = (signal: NodeJS.Signals): void => {
    writeLine(`[SIGNAL] ${signal} received after ${uptime()}`);
  };
  const onHeartbeat = (): void => {
    const rssMb = Math.round(process.memoryUsage().rss / 1_048_576);
    writeLine(`[heartbeat] uptime=${uptime()} rss=${rssMb}MB`);
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  process.on('exit', onExit);
  for (const signal of signals) process.on(signal, () => onSignal(signal));
  const heartbeat = setInterval(onHeartbeat, HEARTBEAT_INTERVAL_MS);
  // 不要让心跳成为"该退出时退不掉"的理由
  heartbeat.unref();

  uninstallCurrent = (): void => {
    installed = false;
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
    process.off('exit', onExit);
    for (const signal of signals) process.removeAllListeners(signal);
    clearInterval(heartbeat);
  };
  return uninstallCurrent;
}

let installed = false;
let uninstallCurrent: () => void = () => undefined;
