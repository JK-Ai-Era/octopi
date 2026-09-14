/**
 * 跨平台运行时原语 — 路径解析与 shell 自动选择
 *
 * 文件/Shell 工具统一走这里，避免在各工具内手写 `startsWith('/')`
 * 或硬编码 `/bin/bash` 导致 Windows 行为分裂。
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** 平台 shell 方言 */
export type ShellKind = 'bash' | 'powershell' | 'cmd';

/** 已解析的平台 shell */
export interface PlatformShell {
  kind: ShellKind;
  /** spawn 使用的可执行文件（绝对路径或可用命令名） */
  executable: string;
  /** 插在用户 command 前的固定参数 */
  args: string[];
  /** 人类可读描述（写入 tool description / 返回值） */
  label: string;
}

/**
 * 解析工具入参路径：绝对路径原样返回，相对路径相对 cwd
 *
 * 使用 `path.isAbsolute`，同时覆盖 POSIX `/foo`、Windows 盘符
 * `C:\` / `C:/` 与 UNC `\\server\share`。
 *
 * @param rawPath - 工具入参路径
 * @param cwd - 工作目录；缺省为 `process.cwd()`
 * @returns 规范化后的绝对路径
 */
export function resolveToolPath(rawPath: string, cwd?: string): string {
  if (isAbsolute(rawPath)) return resolve(rawPath);
  return resolve(cwd ?? process.cwd(), rawPath);
}

function isExecutableFile(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') {
      accessSync(filePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 PATH 上查找可执行文件
 *
 * Windows 按 `PATHEXT` 展开（`.COM;.EXE;.BAT;.CMD` 等）。
 *
 * @param name - 命令名或路径片段
 * @returns 完整路径；找不到返回 null
 */
export function findExecutable(name: string): string | null {
  if (isAbsolute(name) || (process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(name))) {
    return isExecutableFile(name) ? name : null;
  }

  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);

  if (process.platform === 'win32') {
    const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean);
    const lower = name.toLowerCase();
    const hasOwnExt = pathExt.some((e) => lower.endsWith(e.toLowerCase()));

    for (const dir of dirs) {
      const candidates = hasOwnExt ? [name] : [name, ...pathExt.map((e) => name + e)];
      for (const candidate of candidates) {
        const full = join(dir, candidate);
        if (isExecutableFile(full)) return full;
      }
    }
    return null;
  }

  for (const dir of dirs) {
    const full = join(dir, name);
    if (isExecutableFile(full)) return full;
  }
  return null;
}

/**
 * 判断命令是否在 PATH 上可用
 *
 * @param name - 命令名
 * @returns 是否存在可执行文件
 */
export function commandExists(name: string): boolean {
  return findExecutable(name) !== null;
}

function unixShell(): PlatformShell {
  for (const candidate of ['/bin/bash', 'bash']) {
    const found = candidate.startsWith('/')
      ? (existsSync(candidate) ? candidate : null)
      : findExecutable(candidate);
    if (found) {
      return { kind: 'bash', executable: found, args: ['-c'], label: `bash (${found})` };
    }
  }
  for (const candidate of ['/bin/sh', 'sh']) {
    const found = candidate.startsWith('/')
      ? (existsSync(candidate) ? candidate : null)
      : findExecutable(candidate);
    if (found) {
      return { kind: 'bash', executable: found, args: ['-c'], label: `sh (${found})` };
    }
  }
  return {
    kind: 'bash',
    executable: '/bin/bash',
    args: ['-c'],
    label: 'bash (fallback)',
  };
}

/**
 * 在 Windows 上定位可用的 bash
 *
 * 优先 Git Bash / MSYS2：启动快，且与 Unix 命令兼容性好。
 * 刻意跳过 `%SystemRoot%\System32\bash.exe`（WSL），其冷启动可达数秒，
 * 作为默认交互 shell 会拖垮工具超时与测试。
 */
function findWindowsBash(): string | null {
  const candidates = [
    `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\bin\\bash.exe`,
    `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\usr\\bin\\bash.exe`,
    `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Git\\bin\\bash.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`,
  ];
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) return candidate;
  }

  const systemRoot = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase();
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const full = join(dir, 'bash.exe');
    if (!isExecutableFile(full)) continue;
    // 跳过 WSL bash（System32）
    if (full.toLowerCase().startsWith(`${systemRoot}\\system32\\`)) continue;
    return full;
  }
  return null;
}

function windowsShell(): PlatformShell {
  // Git Bash / MSYS2：与 agent 常见 Unix 命令（ls/cat/grep）兼容性最好
  const bash = findWindowsBash();
  if (bash) {
    return { kind: 'bash', executable: bash, args: ['-c'], label: `bash (${bash})` };
  }

  const psArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];
  const pwsh = findExecutable('pwsh');
  if (pwsh) {
    return { kind: 'powershell', executable: pwsh, args: psArgs, label: `pwsh (${pwsh})` };
  }

  const powershell = findExecutable('powershell');
  if (powershell) {
    return {
      kind: 'powershell',
      executable: powershell,
      args: psArgs,
      label: `powershell (${powershell})`,
    };
  }

  // 最后才考虑 WSL bash（慢，但比 cmd 更接近 POSIX）
  const wslBash = findExecutable('bash');
  if (wslBash) {
    return { kind: 'bash', executable: wslBash, args: ['-c'], label: `bash (${wslBash})` };
  }

  const cmd = findExecutable('cmd') ?? 'cmd.exe';
  return {
    kind: 'cmd',
    executable: cmd,
    args: ['/d', '/s', '/c'],
    label: `cmd (${cmd})`,
  };
}

let cachedShell: PlatformShell | null = null;

/**
 * 解析当前平台应使用的 shell（结果缓存）
 *
 * 选择顺序：
 * - 非 Windows：`/bin/bash` → PATH `bash` → `/bin/sh` → PATH `sh`
 * - Windows：PATH `bash`（Git Bash）→ `pwsh` → `powershell` → `cmd.exe`
 *
 * @param options.refresh - 强制重新探测（测试用）
 * @returns 平台 shell 描述
 */
export function resolvePlatformShell(options?: { refresh?: boolean }): PlatformShell {
  if (cachedShell && !options?.refresh) return cachedShell;
  cachedShell = process.platform === 'win32' ? windowsShell() : unixShell();
  return cachedShell;
}

/** 仅测试用：清除 shell 缓存 */
export function resetPlatformShellCache(): void {
  cachedShell = null;
}

/**
 * 构造适合当前平台的 PATH 环境变量
 *
 * @returns PATH 字符串；缺失时给出平台相关的安全回退
 */
export function defaultPathEnv(): string {
  if (process.platform === 'win32') {
    return (
      process.env.PATH ??
      process.env.Path ??
      `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
    );
  }
  return process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
}
