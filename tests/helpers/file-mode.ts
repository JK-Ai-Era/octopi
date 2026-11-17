/**
 * 文件权限断言的唯一出口。
 *
 * 为什么需要：`statSync(path).mode & 0o777` 在 Windows 上恒报 0666 形态（NTFS 无
 * POSIX 权限位语义，与 `writeFile` 的 `mode`/`chmodSync` 都无关），裸写
 * `expect(mode & 0o777).toBe(0o600)` 在 Windows 必然红。改成断言 0666 更糟——那是把
 * 不安全现状反锁成期望值。所以：POSIX 断言真实结果，Windows 断言"写入方请求了 0600"
 * 的意图（见各测试的 spy 写法），平台判断只在本文件与 engine 的 `file-mode.ts` 出现。
 */

import { statSync } from 'node:fs';
import { expect } from 'vitest';

import { POSIX_FILE_MODE } from '../../packages/engine/src/file-mode.js';

export { POSIX_FILE_MODE };

/**
 * 断言文件真实权限位为 0600（仅 POSIX 有意义）。
 *
 * 在没有 POSIX 权限位语义的平台上**主动抛错**而不是静默跳过：调用方漏了门控时
 * 应当立刻暴露，而不是得到一个永远通过的断言。
 *
 * @param path - 目标文件
 */
export function expectFileMode0600(path: string): void {
  if (!POSIX_FILE_MODE) {
    throw new Error(
      `expectFileMode0600 只支持 POSIX 平台（当前 ${process.platform} 无 POSIX 权限位语义）：` +
        '请用 it.skipIf(!POSIX_FILE_MODE) 门控，或改断言"写入方请求了 0600"的意图',
    );
  }
  expect(statSync(path).mode & 0o777).toBe(0o600);
}
