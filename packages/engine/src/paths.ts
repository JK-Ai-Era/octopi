/**
 * Runtime home path helpers (OCTOPI_HOME).
 * Shared by gateway / suite so neither depends on the other for path resolution.
 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

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
