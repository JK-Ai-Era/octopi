/**
 * 跨平台运行时原语 — 路径解析与 shell 自动选择
 *
 * 文件/Shell 工具统一走这里，避免在各工具内手写 `startsWith('/')`
 * 或硬编码 `/bin/bash` 导致 Windows 行为分裂。
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  isPathUnderRoots,
  lexicalUnderRoots,
  realpathAllowMissing,
} from '../../../shared/paths/index.js';
import { matchesDenyPattern } from '../../../shared/paths/glob.js';

export { isPathUnderRoots };

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
 * Build containment options from a tool context.
 *
 * Every tool used to spell these fields out by hand, which is how a newly added
 * policy field gets silently dropped (the same failure that hid
 * `refuseFinalSymlink` from the tool surface). One constructor, one place to add
 * the next field.
 *
 * @param context - tool execution context
 * @returns options for {@link resolveToolPath}
 */
export function containmentOptions(
  context?: { pathRoots?: readonly string[]; pathContainment?: 'strict' | 'soft' | 'none'; pathDenylist?: readonly string[] } | null,
): ResolveToolPathOptions {
  return {
    allowRoots: context?.pathRoots,
    containment: context?.pathContainment,
    denyPatterns: context?.pathDenylist,
  };
}

/** L2 路径约束选项（由 {@link containmentOptions} 从工具上下文构造） */
export interface ResolveToolPathOptions {
  /** L2 允许根；containment 非 none 时必须落在其下 */
  allowRoots?: readonly string[];
  /** L2 级别；省略 = 不限制 */
  containment?: 'strict' | 'soft' | 'none';
  /**
   * L2 拒绝清单（glob，匹配允许根内相对路径与文件名）。
   *
   * 独立于 containment：声明即拒绝，任何级别都生效。默认空 = 不拒绝任何路径，
   * 因为「agent 读写自己 workspace 里的 `.env`」是合法且常见的用法。
   */
  denyPatterns?: readonly string[];
}

/**
 * Apply L2 path containment against real (symlink-resolved) paths.
 *
 * Both sides are resolved: comparing a resolved target against an unresolved
 * root would deny legitimate paths whenever the root is itself an alias
 * (macOS `/var` → `/private/var`). The resolved target is returned so callers
 * act on the same path that was checked; otherwise a link swapped between the
 * check and the following fs call would still escape.
 *
 * @param absPath - absolute, lexically normalized candidate
 * @param rawPath - original caller-supplied path, for error messages
 * @param options - containment level and allowed roots
 * @returns path to operate on
 */
function containPath(absPath: string, rawPath: string, options?: ResolveToolPathOptions): string {
  const containment = options?.containment ?? 'none';
  const denyPatterns = options?.denyPatterns ?? [];
  const roots = options?.allowRoots ?? [];

  // The denylist is an independent deny layer: if a deployment declares these
  // patterns forbidden, they are forbidden at every containment level. The
  // lexical spelling is checked first because it needs no syscalls.
  if (denyPatterns.length > 0) {
    denyPath(absPath, rawPath, options, denyPatterns);
  }

  // `none` stays syscall-free unless a denylist is declared: then the resolved
  // target must be checked too, or an innocuously named link reads a denied file.
  if (containment === 'none') {
    if (denyPatterns.length > 0) denyResolvedTarget(absPath, rawPath, options, denyPatterns);
    return absPath;
  }

  if (roots.length === 0) {
    // strict 无 root = fail-closed（与 isPathAllowed 一致）；soft 仅审计
    if (containment === 'strict') {
      throw new Error(`path_forbidden: "${rawPath}" effect roots not configured`);
    }
    if (denyPatterns.length > 0) denyResolvedTarget(absPath, rawPath, options, denyPatterns);
    return absPath;
  }

  const realRoots = roots
    .map((root) => realpathAllowMissing(resolve(root)))
    .filter((root): root is string => root !== null);
  const realTarget = realpathAllowMissing(absPath);

  // Re-check the resolved path *before* the root verdict: the caller's spelling
  // may be innocuous while the link target is denied, and that must also hold for
  // paths that end up escaping the roots (soft mode passes those through).
  if (denyPatterns.length > 0 && realTarget !== null && realTarget !== absPath) {
    denyPath(realTarget, rawPath, options, denyPatterns);
  }

  // An unresolvable target or a set of vanished roots is a denial, not a pass.
  // Both sides are already real here, so compare them lexically: re-resolving
  // them would only repeat the syscalls.
  if (realTarget === null || realRoots.length === 0 || !lexicalUnderRoots(realTarget, realRoots)) {
    if (containment === 'strict') {
      throw new Error(`path_forbidden: "${rawPath}" escapes effect roots`);
    }
    // soft：放行（审计由调用方/Observer 负责），保留词法答案以免改变既有语义
    return absPath;
  }

  return realTarget;
}

/**
 * Apply the denylist to the symlink-resolved target of a path.
 *
 * Only the resolved spelling is tested: the lexical one was already checked by
 * the caller, and this exists for the "harmless name → denied target" case.
 *
 * @param absPath - absolute, lexically normalized candidate
 * @param rawPath - caller spelling, for the error message
 * @param options - containment options (roots)
 * @param denyPatterns - denylist globs
 */
function denyResolvedTarget(
  absPath: string,
  rawPath: string,
  options: ResolveToolPathOptions | undefined,
  denyPatterns: readonly string[],
): void {
  const realTarget = realpathAllowMissing(absPath);
  if (realTarget !== null && realTarget !== absPath) denyPath(realTarget, rawPath, options, denyPatterns);
}

/**
 * Throw when the path matches the denylist.
 *
 * Matching happens against the path relative to the containing root, so a
 * pattern like `.git/**` means "inside a root", not "anywhere on the host".
 * When no root contains it the absolute path is used, which still catches
 * name-based patterns such as `*.pem`.
 *
 * @param absPath - absolute path to test
 * @param rawPath - caller spelling, for the error message
 * @param options - containment options (roots)
 * @param denyPatterns - denylist globs
 */
function denyPath(
  absPath: string,
  rawPath: string,
  options: ResolveToolPathOptions | undefined,
  denyPatterns: readonly string[],
): void {
  const roots = options?.allowRoots ?? [];
  const candidates: string[] = [];
  for (const root of roots) {
    const realRoot = realpathAllowMissing(resolve(root)) ?? resolve(root);
    if (lexicalUnderRoots(absPath, [realRoot])) {
      candidates.push(relative(realRoot, absPath).split(sep).join('/'));
    }
  }
  candidates.push(absPath.split(sep).join('/'));
  if (candidates.some((candidate) => matchesDenyPattern(candidate, denyPatterns))) {
    throw new Error(`path_forbidden: "${rawPath}" matches pathDenylist`);
  }
}

/**
 * 解析工具入参路径：绝对路径原样返回，相对路径相对 cwd
 *
 * 使用 path.isAbsolute，同时覆盖 POSIX /foo、Windows 盘符与 UNC。
 *
 * @param rawPath - 工具入参路径
 * @param cwd - 工具 cwd；缺省为 process.cwd()
 * @param options - L2 路径包含（ToolEffectPolicy）
 * @returns 规范化后的绝对路径；containment 生效时为符号链接解析后的真实路径
 */
export function resolveToolPath(
  rawPath: string,
  cwd?: string,
  options?: ResolveToolPathOptions,
): string {
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd ?? process.cwd(), rawPath);
  return containPath(abs, rawPath, options);
}

/**
 * 只读附件根内解析（OP-15）：相对名优先贴到 attachmentRoots
 *
 * @param rawPath - 工具入参路径
 * @param cwd - 工具 cwd
 * @param attachmentRoots - 只读会话附件根
 * @returns 规范化后的绝对路径
 */
export function resolveReadableToolPath(
  rawPath: string,
  cwd?: string,
  attachmentRoots?: string[],
  options?: ResolveToolPathOptions,
): string {
  const roots = attachmentRoots ?? [];
  // 绝对路径原样；相对路径先试 attachments 根（文件名直呼）
  if (!isAbsolute(rawPath) && roots.length > 0) {
    const cleaned = rawPath.replace(/^[/\\]+/, '');
    for (const root of roots) {
      const rootResolved = resolve(root);
      const candidate = resolve(rootResolved, cleaned);
      // Lexical guard against `cleaned` climbing out of the root; shares the
      // win32 case-folding rule with every other containment check.
      if (candidate !== rootResolved && !lexicalUnderRoots(candidate, [rootResolved])) continue;
      if (!existsSync(candidate)) continue;
      // Attachment roots sit outside the effect roots by design, so they carry
      // their own containment: a link planted in the attachment tree would
      // otherwise be a straight read out of the read-only sandbox.
      // Both sides are resolved here, so compare lexically rather than making
      // isPathUnderRoots resolve them a second time.
      const realRoot = realpathAllowMissing(rootResolved);
      const realCandidate = realpathAllowMissing(candidate);
      if (realRoot === null || realCandidate === null) continue;
      if (!lexicalUnderRoots(realCandidate, [realRoot])) continue;
      // Attachment roots are outside the effect roots, so they would otherwise
      // skip the denylist entirely: "read-only" is not "allowed to read".
      if (options?.denyPatterns && options.denyPatterns.length > 0) {
        denyPath(realCandidate, rawPath, options, options.denyPatterns);
      }
      return realCandidate;
    }
  }
  // attachments 命中后返回；其余走 L2
  return resolveToolPath(rawPath, cwd, options);
}

/**
 * 是否为会话附件根下的路径（写保护）
 *
 * @param path - 已 resolve 的路径
 * @param attachmentRoots - 只读根
 */
export function isUnderAttachmentRoot(path: string, attachmentRoots?: string[]): boolean {
  if (!attachmentRoots?.length) return false;
  // `path` now arrives resolved (`resolveToolPath` returns the real path), so a
  // purely lexical comparison against a configured root would report false
  // whenever the root is an alias (macOS /var, symlinked HOME) — turning a
  // write-protection guard into a fail-open. Resolve both sides.
  return isPathUnderRoots(path, attachmentRoots);
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
      // Prefer real PE via PATHEXT (.EXE/.COM) over extensionless shims and
      // .CMD/.BAT (Node ≥18.20 refuses spawn of .cmd/.bat — CVE-2024-27980).
      const ordered = hasOwnExt
        ? [name]
        : [
            ...pathExt.filter((e) => !/^\.(cmd|bat)$/i.test(e)).map((e) => name + e),
            ...pathExt.filter((e) => /^\.(cmd|bat)$/i.test(e)).map((e) => name + e),
            name,
          ];
      for (const candidate of ordered) {
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

/**
 * Resolve a Node-based CLI (npm / pnpm / yarn) to a spawnable argv head.
 *
 * Windows never spawns `.cmd`/`.bat` directly (Node ≥18.20 throws EINVAL,
 * CVE-2024-27980). Prefer `node <package-cli.js>` when the shim layout is
 * known; otherwise fall back to the resolved path only when it is a real PE.
 *
 * @param name - tool name (`npm` | `pnpm` | `yarn`)
 * @returns executable + prefix args inserted before user args
 */
export function resolveNodeToolCommand(name: string): {
  executable: string;
  prefixArgs: string[];
} {
  const found = findExecutable(name);
  if (!found) {
    throw new Error(
      `${name}_not_found: "${name}" is not on PATH. Install it on the host or use package_edit / file tools instead.`,
    );
  }
  const lower = found.toLowerCase();
  const isCmdShim = lower.endsWith('.cmd') || lower.endsWith('.bat');
  // Extensionless shims on Windows (e.g. the bash `npm` script) are not spawnable as PE.
  const looksLikeScript =
    process.platform === 'win32' && (isCmdShim || (!lower.endsWith('.exe') && !lower.endsWith('.com')));

  if (!looksLikeScript) {
    return { executable: found, prefixArgs: [] };
  }

  const dir = dirname(found);
  const node = findExecutable('node') ?? process.execPath;
  const jsCandidates = [
    join(dir, 'node_modules', name, 'bin', `${name}-cli.js`),
    join(dir, 'node_modules', name, 'bin', `${name}.js`),
    join(dir, 'node_modules', name, 'bin', `${name}.cjs`),
    join(dir, 'node_modules', name, 'lib', 'cli.js'),
    join(dir, '..', 'node_modules', name, 'bin', `${name}-cli.js`),
    join(dir, '..', 'lib', name, 'bin', `${name}-cli.js`),
  ];
  for (const candidate of jsCandidates) {
    if (existsSync(candidate)) {
      return { executable: node, prefixArgs: [candidate] };
    }
  }

  throw new Error(
    `${name}_windows_spawn_unsupported: cannot resolve "${found}" to a node JS entry (CVE-2024-27980 forbids spawning .cmd). Run the install manually on the host, or use a ${name} installed as a real PE.`,
  );
}

/**
 * Minimal platform env for child processes (allowlist-shaped; no secret inherit).
 * Only keys already accepted by `scrubEnv` are included.
 *
 * @returns env map with PATH plus OS essentials when present
 */
export function defaultChildEnv(): Record<string, string> {
  const keys = [
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'TMP',
    'TEMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'SHELL',
    'TERM',
    'COMSPEC',
    'PATHEXT',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'windir',
    'USER',
    'LOGNAME',
  ];
  const out: Record<string, string> = { PATH: defaultPathEnv() };
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
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

/**
 * True when `target` is the session undo ledger root or under it (D6-a).
 * Prefers real root comparison against injected `undoRoots`; falls back to an
 * exact `sessions/<id>/undo` path-shape match when the runner did not inject.
 *
 * @param target - absolute or relative path under consideration
 * @param undoRoots - resolveSessionUndoPaths roots (optional)
 * @returns whether the path is protected undo ledger
 */
export function isUnderSessionUndoRoot(target: string, undoRoots?: string[]): boolean {
  const roots = (undoRoots ?? []).map((r) => r?.trim()).filter(Boolean);
  // Same coordinate problem as isUnderAttachmentRoot: the target arrives as a
  // real path while the configured roots keep their lexical spelling.
  if (roots.length > 0) return isPathUnderRoots(target, roots);
  // No configured roots: recognise the default layout instead. Resolve first so
  // a symlinked sessions directory still matches the same rule.
  const resolved = realpathAllowMissing(resolve(target)) ?? resolve(target);
  const converted = resolved.replace(/\\/g, '/');
  const folded = process.platform === 'win32' ? converted.toLowerCase() : converted;
  return /\/sessions\/[^/]+\/undo(\/|$)/i.test(folded);
}
