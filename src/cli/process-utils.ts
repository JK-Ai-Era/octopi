/**
 * CLI 跨平台进程原语
 *
 * Windows / macOS / Linux 共用：延时、端口探测、杀进程树、detached spawn。
 * 不要在 daemon/helpers 里再手写 lsof / sleep / .bin 路径。
 */

import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
  } catch {
    return false;
  }
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
  if (!isProcessAlive(pid)) return true;

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
      });
    } catch {
      // taskkill 对已退出进程会非零退出；以存活探测为准
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
 * @returns 子进程 PID；启动失败返回 null
 */
export function spawnDetached(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): number | null {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...options,
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

/**
 * 解析 Vite 可执行入口（优先直接走 node + vite.js，避开 Windows .cmd shim）
 *
 * @param webDir - web 项目根目录
 * @returns { command, args } 或 null（未安装 vite）
 */
export function resolveViteLaunch(
  webDir: string,
): { command: string; args: string[] } | null {
  const viteJs = join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (existsSync(viteJs)) {
    return { command: process.execPath, args: [viteJs] };
  }

  const binName = process.platform === 'win32' ? 'vite.cmd' : 'vite';
  const viteBin = join(webDir, 'node_modules', '.bin', binName);
  if (existsSync(viteBin)) {
    if (process.platform === 'win32') {
      const comSpec = process.env.ComSpec ?? 'cmd.exe';
      return { command: comSpec, args: ['/d', '/s', '/c', viteBin] };
    }
    return { command: viteBin, args: [] };
  }

  return null;
}
