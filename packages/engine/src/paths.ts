/**
 * Runtime home path helpers (OCTOPI_HOME).
 * Shared by gateway / suite so neither depends on the other for path resolution.
 *
 * This module must stay zod-free: harness runtime code imports it for path
 * semantics without pulling in the config-schema layer.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * 展开 `~` 前缀为用户主目录（Windows/Linux/macOS 通用）。
 * 接受 `~`、`~/rest`、`~\rest`（Windows 形态，剩余分隔符归一为 `/` 后按平台 join）；
 * `~user/…` 等其他形态不展开（无跨平台语义）。已是绝对路径的原样返回（幂等）。
 *
 * @param p - 配置原文路径
 * @returns 展开后的路径
 */
export function expandHomePath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    // `~\a\b` 多段：把剩余的 `\` 归一为 `/`，避免 POSIX 上把 `\` 当文件名字符
    return join(homedir(), p.slice(2).replace(/\\/g, '/'));
  }
  return p;
}

/**
 * 配置路径合法形态：绝对路径，或 `~` / `~/…` / `~\…`。
 * win32 上「绝对」要求盘符（`C:\`/`C:/`）或 UNC（`\\server\share`）——
 * `\foo` 这类盘符相对路径会按当前盘隐式解析，属于要消灭的隐式行为。
 * 相对路径直接拒绝：被 resolve 到进程 cwd 属于隐式行为，加载即报错。
 *
 * @param p - 配置原文路径
 * @returns 形态合法与否
 */
export function isConfigPathShape(p: string): boolean {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return true;
  if (process.platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  }
  return isAbsolute(p);
}


/** 默认系统根目录 */
export const DEFAULT_OCTOPI_HOME = join(homedir(), '.octopi');

/** 环境变量名 */
export const OCTOPI_HOME_ENV = 'OCTOPI_HOME';

/**
 * 获取 Octopi 系统根目录
 *
 * 优先级：
 * 1. 环境变量 OCTOPI_HOME
 * 2. 默认值 ~/.octopi
 *
 * @returns 绝对路径
 */
export function getOctopiHome(): string {
  return resolve(process.env[OCTOPI_HOME_ENV] ?? DEFAULT_OCTOPI_HOME);
}
