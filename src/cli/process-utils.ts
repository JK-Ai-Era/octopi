/**
 * CLI 跨平台进程原语
 *
 * Windows / macOS / Linux 共用：延时、端口探测、杀进程树、detached spawn。
 * 不要在 daemon/helpers 里再手写 lsof / sleep / .bin 路径。
 */

import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAncestorPidChain,
  resolveProcessImage,
} from '@octopi-agent/engine/harness/extension/execution-environment/process-info.js';

/** Promise 化延时，替代 Unix `sleep` 命令 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 进程是否仍存活（pid 0 探测） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Windows 上对「存在但无权限」的进程会抛 EPERM：不能当成已退出
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EPERM';
  }
}

/** 进程祖先链缓存（单次 CLI 调用内足够；缓存 Promise 兼作单飞） */
let ancestorChainCache: Promise<Set<number>> | null = null;

function getAncestorPidSet(): Promise<Set<number>> {
  if (ancestorChainCache) return ancestorChainCache;
  ancestorChainCache = (async () => {
    const chain = new Set<number>([process.pid]);
    if (typeof process.ppid === 'number' && process.ppid > 0) chain.add(process.ppid);
    // v0.93.4：祖先链走引擎侧 process-info（/proc 或 ps 整表 + 内存行走链），
    // 替换原先逐级 `ps -o ppid=`（牢笼内 exec 被拒，退化成「仅 self + ppid」）。
    // 上面两行种子保留为行为下限：来源整体不可读时仍保住 self + ppid。
    for (const pid of (await getAncestorPidChain(process.pid)).chain) chain.add(pid);
    return chain;
  })();
  return ancestorChainCache;
}

/**
 * pid 是否为当前进程或其祖先
 *
 * Windows `taskkill /T` 杀的是整棵进程树；若误把 CLI 的父进程（工具 shell）
 * 当成目标，会话会被连带干掉。杀进程前必须用本函数拦截。
 *
 * @param pid - 目标 PID
 * @returns true = 拒杀（自身/祖先/非法 pid）
 */
export async function isSelfOrAncestorPid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  return (await getAncestorPidSet()).has(pid);
}

function findPidOnPortUnix(port: number): number | null {
  try {
    const result = execFileSync(
      'lsof',
      ['-nP', '-sTCP:LISTEN', `-iTCP:${port}`],
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (!result) return null;
    const lines = result.split('\n').slice(1);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const pid = parseInt(parts[1] ?? '', 10);
      if (pid > 0 && pid !== process.pid) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

function findPidOnPortWindows(port: number): number | null {
  try {
    const result = execFileSync('netstat', ['-ano'], {
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of result.split(/\r?\n/)) {
      // TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    1234
      // TCP    [::]:3000       [::]:0       LISTENING    1234
      const m = line.match(
        /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i,
      );
      if (!m) continue;
      if (parseInt(m[1]!, 10) !== port) continue;
      const pid = parseInt(m[2]!, 10);
      if (pid > 0 && pid !== process.pid) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

/** 查找监听指定 TCP 端口的进程 PID（排除自身） */
export function findPidOnPort(port: number): number | null {
  if (!Number.isInteger(port) || port <= 0) return null;
  return process.platform === 'win32'
    ? findPidOnPortWindows(port)
    : findPidOnPortUnix(port);
}

/**
 * 尽力获取进程可执行映像（Windows: tasklist 名；macOS: lsof → ps；
 * Linux: /proc/<pid>/exe → ps）。失败返回 null
 *
 * v0.93.4：实现收敛到引擎侧 `resolveProcessImage`（ops P1 单一真相源，
 * 同时供 process_list 工具使用）。**Linux 侧有意变更**：由 `ps comm`（短名）
 * 变为 `/proc/<pid>/exe`（全路径），与 macOS 行为对称；调用方仅用于展示文案。
 *
 * @param pid - 目标 PID
 * @returns 映像路径（拿不到路径的平台退化为进程名），不可解析时 null
 */
export function getProcessName(pid: number): Promise<string | null> {
  return resolveProcessImage(pid);
}

/**
 * 终结进程（Windows 用 taskkill 杀进程树，避免 vite/cmd 残留子进程）
 *
 * @param pid - 目标 PID
 * @param options.timeoutMs - 等待优雅退出的最长时间
 * @returns 是否已确认进程退出
 */
export async function killProcess(
  pid: number,
  options?: { timeoutMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 3000;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  // 绝不杀自己/祖先：taskkill /T 会把 agent shell 一并带走
  if (await isSelfOrAncestorPid(pid)) {
    console.warn(`⚠️  Refusing to kill PID ${pid} (self/ancestor of current CLI process)`);
    return false;
  }
  if (!isProcessAlive(pid)) return true;

  if (process.platform === 'win32') {
    // 1) 软关：taskkill 不带 /F（发 WM_CLOSE）；无窗口控制台进程常失败，属预期
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
      });
    } catch {
      // already exiting / no window / access denied
    }

    const softDeadline = Date.now() + Math.min(timeoutMs, 3000);
    while (Date.now() < softDeadline) {
      if (!isProcessAlive(pid)) return true;
      await delay(100);
    }

    // 2) 强杀进程树
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
      });
    } catch {
      // taskkill 对已退出/无权限进程会非零退出；以存活探测为准
    }
    await delay(100);
    return !isProcessAlive(pid);
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isProcessAlive(pid);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(200);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already exited
  }
  return !isProcessAlive(pid);
}

/** 终结占用指定端口的进程 */
export async function killProcessOnPort(port: number): Promise<boolean> {
  const pid = findPidOnPort(port);
  if (!pid || pid === process.pid) return false;
  return killProcess(pid);
}

/**
 * 启动后台子进程（detached + windowsHide）
 *
 * Windows：优先 `powershell Start-Process`。Node `spawn({detached:true})`
 * 在工具/Job Object 环境下常与父进程绑在同一 Job，父进程退出或外层清理时
 * 会连带杀掉整棵 shell（表现为 CLI 一 start 会话就消失）。
 *
 * @returns 子进程 PID；启动失败返回 null
 */
export function spawnDetached(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): number | null {
  if (process.platform === 'win32') {
    return spawnDetachedWindows(command, args, options);
  }
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...options,
    });
    child.on('error', () => {
      /* 子进程启动失败不拖垮 CLI；上层靠 pid 探测 */
    });
    if (child.pid) {
      child.unref();
      return child.pid;
    }
    return null;
  } catch {
    return null;
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 按 CommandLineToArgvW 规则给单个参数加双引号。
 *
 * `Start-Process -ArgumentList` 会把数组元素按空格拼接且不补引号，
 * 不预先 quoting 的话，含空格/引号的参数（长 -e 脚本、带空格的用户路径）
 * 传到子进程会被拆碎。
 */
function winQuoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

function spawnDetachedWindows(
  command: string,
  args: string[],
  options: SpawnOptions,
): number | null {
  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : undefined;
  const argArray = args.map((a) => psQuote(winQuoteArg(a))).join(', ');
  const workDir = cwd ? ` -WorkingDirectory ${psQuote(cwd)}` : '';
  const script =
    `$p = Start-Process -FilePath ${psQuote(command)} -ArgumentList @(${argArray})${workDir} -WindowStyle Hidden -PassThru; ` +
    `if ($p) { Write-Output $p.Id }`;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf-8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const pid = parseInt(lines[lines.length - 1] ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    // PowerShell Start-Process 失败时退回 Node spawn（可能仍受 Job 限制）
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...options,
      });
      child.on('error', () => undefined);
      if (child.pid) {
        child.unref();
        return child.pid;
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * 解析 Vite 可执行入口（优先直接走 node + vite.js，避开 Windows .cmd shim）
 *
 * @param webDir - web 项目根目录
 * @param options.hostArg - 传给 Vite 的 `--host` 值（如 `localhost` / `0.0.0.0`）
 * @returns { command, args } 或 null（未安装 vite）
 */
export function resolveViteLaunch(
  webDir: string,
  options?: { hostArg?: string },
): { command: string; args: string[] } | null {
  const hostArgs = options?.hostArg ? ['--host', options.hostArg] : [];
  const viteJs = join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (existsSync(viteJs)) {
    return { command: process.execPath, args: [viteJs, ...hostArgs] };
  }

  const binName = process.platform === 'win32' ? 'vite.cmd' : 'vite';
  const viteBin = join(webDir, 'node_modules', '.bin', binName);
  if (existsSync(viteBin)) {
    if (process.platform === 'win32') {
      const comSpec = process.env.ComSpec ?? 'cmd.exe';
      return { command: comSpec, args: ['/d', '/s', '/c', viteBin, ...hostArgs] };
    }
    return { command: viteBin, args: hostArgs };
  }

  return null;
}
