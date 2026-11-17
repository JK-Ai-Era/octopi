/**
 * 秘密文件/目录权限断言的唯一出口（测试侧）。
 *
 * 为什么不能只断 `mode`：Windows 上 `statSync().mode & 0o777` 恒报 `0666` 形态，与
 * `writeFile` 的 `mode`、`chmod` 都无关；那里的真实保护面是 NTFS ACL。所以同一个
 * 「仅当前用户可访问」的语义在两种平台上要用不同手段**真断**，而不是在 Windows 上跳过：
 *
 * - POSIX：`stat` 的权限位。
 * - Windows：`icacls` 的访问控制条目（ACE 里的主体名与权限标志不随系统语言变化；
 *   只有尾部的「已成功处理 N 个文件」会本地化，所以不能整行匹配）。
 *
 * 两个平台的断言都在**实际产物**上做（不是断言"调用方请求了 0600"），因此删掉生产侧
 * 的真实收紧会让它们变红。`secret-file-mode-intent.test.ts` 另外锁"请求"这一层，
 * 用于那些无法在测试里复刻真实写入路径的场景。
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { expect } from 'vitest';

import { POSIX_FILE_MODE } from '../../packages/engine/src/file-mode.js';

export { POSIX_FILE_MODE };

/**
 * 读取目标上的 ACE 列表（仅 Windows；POSIX 平台调用即抛错，避免被误用成假绿）。
 *
 * @param target - 文件或目录
 * @returns 形如 `DOMAIN\user:(F)` 的条目
 */
export function readWindowsAces(target: string): string[] {
  if (POSIX_FILE_MODE) {
    throw new Error('readWindowsAces 只在无 POSIX 权限位的平台有意义（不要用它绕过平台分支）');
  }
  const out = execFileSync('icacls', [target], { encoding: 'utf8', windowsHide: true });
  return out
    .split(/\r?\n/)
    .flatMap((line) => line.match(/[^\s()]+(?::\([^)]*\))+/g) ?? [])
    .map((s) => s.trim());
}

/**
 * 该 ACE 的权限标志里是否带「允许」语义（显式 `(F)`/`(M)`/`(RX)` 或继承 `(I)(F)`）。
 *
 * 拒绝型 ACE（`(DENY)`）不算暴露，故排除。
 *
 * @param ace - 单条 ACE 文本
 * @returns 是否授予访问
 */
function isGrantAce(ace: string): boolean {
  return !/\(DENY\)/i.test(ace);
}

/**
 * 断言目标只有当前用户可访问（跨平台，两平台都真跑）。
 *
 * Windows 侧不断「ACE 恰好 1 条」：带完整性标签的进程创建的文件会多打印
 * `Mandatory Label\…`，那会变成假红。改为断言更强的性质——**没有任何非本人的授予型 ACE**。
 *
 * @param target - 文件或目录
 * @param kind - `dir` 期望 POSIX 0700 / `file` 期望 0600（仅影响 POSIX 分支）
 */
export function expectRestrictedToOwner(target: string, kind: 'file' | 'dir'): void {
  if (POSIX_FILE_MODE) {
    expect(statSync(target).mode & 0o777).toBe(kind === 'dir' ? 0o700 : 0o600);
    return;
  }
  const granted = readWindowsAces(target).filter(isGrantAce);
  // 主体名含当前账户名即视为本人（域/工作组/AAD 形式都能命中；SID 形式的 ACE 会由
  // icacls 解析成名字输出）。其余任何授予型主体都是暴露面。
  const username = process.env.USERNAME ?? '';
  const foreign = granted.filter((ace) => !username || !ace.toLowerCase().includes(username.toLowerCase()));
  expect(
    foreign,
    `存在非本人的授予型 ACE：${foreign.join(' | ')}（全部：${granted.join(' | ')}）`,
  ).toEqual([]);
  expect(granted.length, `应至少有一条本人 ACE：${granted.join(' | ')}`).toBeGreaterThan(0);
}

/**
 * 断言目标**不**是仅当前用户可访问 —— 用于对照组：证明上面的断言确实在检查暴露面。
 *
 * 注意这断言的是"本机该位置/该写法的现状"，不是代码属性：若某台机器把 `%TEMP%` 加固成
 * 仅本人可访问，对照组会变红——那时应重新评估修复前提，而不是删掉这条。
 *
 * @param target - 文件或目录
 */
export function expectNotOwnerOnly(target: string): void {
  if (POSIX_FILE_MODE) {
    expect(statSync(target).mode & 0o077).not.toBe(0);
    return;
  }
  const username = process.env.USERNAME ?? '';
  const foreign = readWindowsAces(target)
    .filter(isGrantAce)
    .filter((ace) => !username || !ace.toLowerCase().includes(username.toLowerCase()));
  expect(foreign.length, '该位置已是 owner-only；修复前提需重新评估').toBeGreaterThan(0);
}
