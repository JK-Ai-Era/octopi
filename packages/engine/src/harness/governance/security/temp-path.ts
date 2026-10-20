/**
 * temp-path — 临时目录路径分类（单一来源）
 *
 * @layer harness/governance/security
 *
 * 三处消费方（risk-evaluator / degradation / capability-enforcer）共用同一份
 * 临时目录清单与前缀匹配，防止各处手抄前缀清单再次漂移。
 *
 * 分类语义（纯字符串分类，不做 fs 探测）：
 * - POSIX 共享临时 `/tmp`、`/var/tmp` 及其 macOS 规范（realpath）双形态
 *   `/private/tmp`、`/private/var/tmp`——兼容性不押在 env 透传上（C4 拍板）
 * - `os.tmpdir()` 实际值（反映 TMPDIR/TEMP/TMP 生效值，macOS 为 `/var/folders/…`）
 * - 显式 `TMPDIR`/`TEMP`/`TMP`/`Tmp` 兜底
 * - Windows 静态临时区（`C:\Windows\Temp`、SystemRoot Temp、用户 AppData Temp）
 */

import { homedir, tmpdir } from 'node:os';

let cachedTempPrefixes: string[] | null = null;

/** 仅测试用：环境变量变更后清空临时目录缓存 */
export function resetTempPathCache(): void {
  cachedTempPrefixes = null;
}

/** Windows 风格路径：盘符或 UNC */
export function isWindowsStylePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[A-Za-z]:$/.test(p) || p.includes('\\') || p.startsWith('\\\\');
}

/** 去掉末尾分隔符（保留根 `/` 或 `C:\`） */
export function stripTrailingSep(p: string): string {
  if (p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))) {
    // `C:\` 保留
    if (/^[A-Za-z]:[\\/]$/.test(p)) return p;
    return p.slice(0, -1);
  }
  return p;
}

/** 绝对路径（POSIX + Windows 盘符/UNC），跨平台评估时用 */
export function isAbsolutePath(p: string): boolean {
  return (
    p.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(p) ||
    /^[A-Za-z]:$/.test(p) ||
    p.startsWith('\\\\')
  );
}

/** 补尾部分隔符（按路径自身风格选 `/` 或 `\`） */
export function ensureTrailingSep(p: string): string {
  if (!p) return p;
  const sepChar = isWindowsStylePath(p) ? '\\' : '/';
  return p.endsWith('/') || p.endsWith('\\') ? p : p + sepChar;
}

/**
 * 路径前缀匹配（路径段边界，拒绝 project 前缀绕过 project-evil）
 *
 * 要求 path === base 或 path 以 base + 分隔符 开头。
 * Windows 风格路径大小写不敏感、分隔符归一为 `\`。
 */
export function startsWithPathPrefix(path: string, prefix: string): boolean {
  const isWin = isWindowsStylePath(path) || isWindowsStylePath(prefix);
  if (isWin) {
    const p = stripTrailingSep(path.replace(/\//g, '\\')).toLowerCase();
    const b = stripTrailingSep(prefix.replace(/\//g, '\\')).toLowerCase();
    if (p === b) return true;
    return p.startsWith(b + '\\');
  }
  const p = stripTrailingSep(path);
  const b = stripTrailingSep(prefix);
  if (p === b) return true;
  return p.startsWith(b + '/');
}

/**
 * 临时目录前缀清单
 *
 * 必须在 PROTECTED 之前匹配：`C:\Windows\Temp` 虽在 `C:\Windows\` 下，
 * 但是可清空的临时区，应归 safe 而非 protected。
 */
export function getTempPrefixes(): string[] {
  if (cachedTempPrefixes) return cachedTempPrefixes;
  const prefixes = [
    // POSIX 共享临时：词法 + macOS 规范（realpath）双形态
    '/tmp/',
    '/private/tmp/',
    '/var/tmp/',
    '/private/var/tmp/',
  ];
  // os.tmpdir() 反映 TMPDIR/TEMP/TMP 生效值（macOS 为 /var/folders/…）
  const osTemp = tmpdir();
  if (osTemp) prefixes.push(ensureTrailingSep(osTemp));
  // 显式环境变量兜底（os.tmpdir() 之外的显式设定）
  for (const key of ['TEMP', 'TMP', 'Tmp', 'TMPDIR'] as const) {
    const v = process.env[key];
    if (v) prefixes.push(ensureTrailingSep(v));
  }
  // Windows 静态临时区
  prefixes.push('C:\\Windows\\Temp\\');
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (systemRoot) {
    prefixes.push(ensureTrailingSep(systemRoot) + 'Temp\\');
  }
  // 用户 AppData Temp（无 TEMP 环境变量时的静态路径）
  const userProfile = process.env.USERPROFILE ?? process.env.HOME;
  const home = userProfile ? userProfile.replace(/\//g, '\\') : homedir().replace(/\//g, '\\');
  if (home) {
    const base = home.endsWith('\\') ? home : home + '\\';
    prefixes.push(base + 'AppData\\Local\\Temp\\');
    prefixes.push(base + 'AppData\\Local\\Microsoft\\Windows\\Temp\\');
  }
  cachedTempPrefixes = prefixes;
  return prefixes;
}

/** 临时目录判定（路径段边界，防 `/tmpdir` 假命中） */
export function isTempPath(path: string): boolean {
  return getTempPrefixes().some((p) => startsWithPathPrefix(path, p));
}
