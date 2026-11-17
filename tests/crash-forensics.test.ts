/**
 * 崩溃取证的**真实行为**验证。
 *
 * 通过注入 `writeLine` 捕获输出，不需要起子进程：`installCrashForensics` 的默认写入
 * 只是 `writeSync(2, ...)`，行为全部在 handler 里。
 *
 * 每条断言都对应 2026-11-17 两次 gateway 消失时缺失的那份证据：
 * - 未捕获异常 → `[FATAL]`（此前全仓无 handler：进程直接死、连栈都不留）
 * - 未处理 rejection → `[FATAL]`（Node 15+ 默认终止进程）
 * - 正常退出 → `[EXIT]`（**有没有这一行，就是"主动退出"与"被 TerminateProcess 硬杀"
 *   的判据**：硬杀不给进程任何执行机会，绝不会打印它）
 */

import { afterEach, describe, expect, it } from 'vitest';
import { installCrashForensics } from '../src/cli/crash-forensics.js';

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

/**
 * 装取证并返回输出收集器。
 *
 * @returns 已记录的日志行
 */
function capture(): string[] {
  const lines: string[] = [];
  uninstall = installCrashForensics((line) => lines.push(line));
  return lines;
}

/**
 * 触发已注册的 uncaughtException handler（不让 vitest 自己接管）。
 *
 * @param reason - 要投递的错误
 */
function raiseUncaught(reason: Error): void {
  const handler = process.listeners('uncaughtException').at(-1) as (e: unknown) => void;
  handler(reason);
}

describe('崩溃取证', () => {
  it('uncaughtException 留下 [FATAL] 与栈，并请求非零退出', () => {
    const lines = capture();
    let requested: number | undefined;
    const originalExit = process.exit;
    (process as unknown as { exit: (code?: number) => void }).exit = ((code?: number) => {
      requested = code;
    }) as never;
    try {
      raiseUncaught(new Error('boom-sync'));
    } finally {
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
    }
    const joined = lines.join('\n');
    expect(joined, `实际输出：${joined}`).toContain('[FATAL] uncaughtException');
    expect(joined).toContain('boom-sync');
    expect(requested).toBe(1);
  });

  it('unhandledRejection 留下 [FATAL]，而不是静默消失', () => {
    const lines = capture();
    const originalExit = process.exit;
    let requested: number | undefined;
    (process as unknown as { exit: (code?: number) => void }).exit = ((code?: number) => {
      requested = code;
    }) as never;
    try {
      const handler = process.listeners('unhandledRejection').at(-1) as (r: unknown) => void;
      handler(new Error('boom-async'));
    } finally {
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
    }
    const joined = lines.join('\n');
    expect(joined, `实际输出：${joined}`).toContain('[FATAL] unhandledRejection');
    expect(joined).toContain('boom-async');
    expect(requested).toBe(1);
  });

  it('exit 留下 [EXIT]（缺这一行即"被硬杀"的判据）', () => {
    const lines = capture();
    const handler = process.listeners('exit').at(-1) as (code: number) => void;
    handler(0);
    expect(lines.join('\n')).toContain('[EXIT] code=0');
  });

  it('信号留下 [SIGNAL]', () => {
    const lines = capture();
    process.emit('SIGTERM');
    expect(lines.join('\n')).toContain('[SIGNAL] SIGTERM');
  });
});
