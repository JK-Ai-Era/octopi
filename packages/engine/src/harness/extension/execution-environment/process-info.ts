/**
 * 进程只读诊断原语（ops P1，零权限放松）
 *
 * 引擎侧实现，**不经 shell 工具 / ProcessSandbox**：
 * - macOS 牢笼拒 exec setuid 的 `ps`（OS 不变量），笼内 shell 拿不到进程表；
 * - Linux bwrap 自带新 pidns，笼内 shell 物理看不到宿主进程。
 * 因此「看进程」只能由引擎进程自己（牢笼外）读 procfs / 调 `ps`。
 * 契约见 `arch/ops-privileged-mode.md` §5 P1。只读：不杀进程、不改任何状态。
 *
 * 所有 spawn 走异步 `execFile`（对齐 runGit 惯例）：daemon 单线程，同步 spawn
 * 会在 ps/powershell 挂起的最坏情形冻结 gateway 与全部并发 session。
 */

import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

/** 单个进程的只读快照 */
export interface ProcessInfoEntry {
  pid: number;
  /** 父 pid；来源给不出时为 null（如实反映，不猜） */
  ppid: number | null;
  /** 完整命令行（argv 空格连接）；给不出时退化为可执行名 */
  command: string | null;
  rssBytes: number | null;
  /**
   * 累计 CPU 时间（user+sys，毫秒）。
   * CPU 占用率需要采样语义，不混进本字段（一个字段一个含义）。
   */
  cpuTimeMs: number | null;
  threads: number | null;
}

/** 一次枚举的结果（含来源与诚实降级） */
export interface ProcessListResult {
  processes: ProcessInfoEntry[];
  source: 'procfs' | 'ps' | 'powershell';
  /** false = 来源整体取不到/明显不全（降级），不等于「成功但没有进程」 */
  complete: boolean;
  notes: string[];
}

/** 枚举选项（全部如实生效，不静默忽略） */
export interface ListProcessesOptions {
  /** 只保留这些 pid（扫描仍按来源读取，过滤在内存完成） */
  pids?: number[];
  /** 命令行子串过滤（ASCII 大小写不敏感） */
  nameContains?: string;
  /** 排序键：`pid` 升序 / `rss` 降序（并列按 pid 升序） */
  sort?: 'pid' | 'rss';
  /** 截断上限；被截断时 `truncated` 为 true */
  limit?: number;
}

/** 过滤/排序/截断的结果 */
export interface SelectedProcesses {
  selected: ProcessInfoEntry[];
  /** 过滤前条目数 */
  total: number;
  /** 过滤后、截断前条目数（与 `total` 并列，避免「被过滤」误读成「被吞」） */
  matched: number;
  truncated: boolean;
}

/** 祖先链查找结果 */
export interface AncestorChain {
  /** 从最远已知祖先到 `pid` 自身（含）；链尾恒为 `pid` */
  chain: number[];
  /** false = 中间有断链（来源缺 pid/ppid），链不完整 */
  complete: boolean;
  notes: string[];
}

/** 表解析结果：条目 + 被跳过的非空行数（诚实记账，禁止静默丢行） */
export interface TableParseResult {
  entries: ProcessInfoEntry[];
  /** 非空但不可解析的行数（warning / 截断 / 列错位）；>0 = 来源不全 */
  skipped: number;
}

/**
 * Pick the executable image out of `lsof -a -d txt -Fn` output.
 *
 * lsof prints one `n<name>` line per matching descriptor, in descriptor order.
 * The first `txt` entry is the executable itself; every later one is a
 * dyld/mmap'd library (`/usr/lib/dyld`, framework dylibs). Taking "the first n
 * line" is therefore the executable, not "any n line".
 *
 * @param output - raw stdout of `lsof -p <pid> -a -d txt -Fn`
 * @returns absolute executable path, or null when the output carries none
 */
export function firstExecutableFromLsof(output: string): string | null {
  for (const line of output.split('\n')) {
    if (!line.startsWith('n')) continue;
    const path = line.slice(1).trim();
    if (path) return path;
  }
  return null;
}

/**
 * Parse `ps` table output (`-o pid=,ppid=,rss=,time=,[thcount=,]command=`).
 *
 * `command` is the remainder of the line after the numeric columns, so argv
 * spacing inside it is preserved verbatim. Lines that do not parse are counted
 * in `skipped` (never dropped silently): a warning line and a corrupted data
 * line look the same to a regex, so any skip degrades `complete` upstream.
 *
 * @param output - raw stdout of the ps invocation
 * @param includeThreads - whether the table carried a `thcount` column
 * @returns parsed entries plus the count of skipped non-empty lines
 */
export function parsePsProcessTable(output: string, includeThreads: boolean): TableParseResult {
  const withThreads = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/;
  const withoutThreads = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;
  const entries: ProcessInfoEntry[] = [];
  let skipped = 0;
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const m = includeThreads ? withThreads.exec(line) : withoutThreads.exec(line);
    if (!m) {
      skipped += 1;
      continue;
    }
    const pid = parseInt(m[1]!, 10);
    const ppid = parseInt(m[2]!, 10);
    const rssKb = parseInt(m[3]!, 10);
    const threadsRaw = includeThreads ? parseInt(m[5]!, 10) : NaN;
    entries.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid >= 0 ? ppid : null,
      command: m[includeThreads ? 6 : 5]!.trim() || null,
      rssBytes: Number.isInteger(rssKb) && rssKb >= 0 ? rssKb * 1024 : null,
      cpuTimeMs: parseCpuTimeToMs(m[4]!),
      threads: Number.isInteger(threadsRaw) && threadsRaw >= 0 ? threadsRaw : null,
    });
  }
  return { entries, skipped };
}

/**
 * Parse a ps `time` cell (`[[dd-]hh:]mm:ss[.fraction]`, cumulative CPU).
 *
 * @param text - the raw cell
 * @returns cumulative CPU milliseconds, or null when the cell is unparseable
 */
export function parseCpuTimeToMs(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const minutes = parseInt(m[3]!, 10);
  const seconds = parseInt(m[4]!, 10);
  const fraction = m[5] ? parseInt(m[5], 10) / 10 ** m[5].length : 0;
  return Math.round(((days * 24 + hours) * 3600 + minutes * 60 + seconds + fraction) * 1000);
}

/**
 * Assemble one entry from `/proc/<pid>` file contents (pure; procfs I/O stays
 * in {@link listProcesses}).
 *
 * `stat` comm may contain spaces and parentheses, so it is taken between the
 * first `(` and the **last** `)` — never by splitting on whitespace. ppid comes
 * from `stat` field 4; `threads` deliberately comes from `status:Threads`
 * instead of `stat` field 20 (one less positional index to get wrong).
 *
 * @param pid - the pid these contents came from
 * @param stat - `/proc/<pid>/stat`
 * @param status - `/proc/<pid>/status`
 * @param cmdline - `/proc/<pid>/cmdline` (NUL-separated argv; empty for kernel threads)
 * @returns parsed entry
 */
export function parseProcPidEntry(
  pid: number,
  stat: string,
  status: string,
  cmdline: Buffer | string,
): ProcessInfoEntry {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  const comm = open >= 0 && close > open ? stat.slice(open + 1, close) : null;
  // After the comm field: state(3) ppid(4) ... utime(14) stime(15) ...
  const rest = close > 0 ? stat.slice(close + 2).split(' ') : [];
  const ppidRaw = rest[1] !== undefined ? parseInt(rest[1], 10) : NaN;
  const utime = rest[11] !== undefined ? parseInt(rest[11], 10) : NaN;
  const stime = rest[12] !== undefined ? parseInt(rest[12], 10) : NaN;

  const fields = new Map<string, string>();
  for (const line of status.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const vmRssRaw = fields.get('VmRSS');
  const rssMatch = vmRssRaw ? /^(\d+)\s*kB$/.exec(vmRssRaw) : null;
  const threadsRaw = fields.get('Threads');

  const cmdlineText = typeof cmdline === 'string' ? cmdline : cmdline.toString('utf8');
  // NUL 是 argv 分隔符也是「argv 末尾终止」；空实参因此不可还原（丢弃即已知局限）
  const argv = cmdlineText
    .split('\0')
    .filter((part) => part !== '')
    .join(' ');

  return {
    pid,
    ppid: Number.isInteger(ppidRaw) && ppidRaw >= 0 ? ppidRaw : null,
    command: argv || fields.get('Name') || comm,
    // VmRSS is reported in kB; kernel threads carry no VmRSS line at all
    rssBytes: rssMatch ? parseInt(rssMatch[1]!, 10) * 1024 : null,
    // Linux USER_HZ is 100 on every shipping kernel (10 ms per tick)
    cpuTimeMs: Number.isInteger(utime) && Number.isInteger(stime) ? (utime + stime) * 10 : null,
    threads: threadsRaw !== undefined && /^\d+$/.test(threadsRaw) ? parseInt(threadsRaw, 10) : null,
  };
}

/**
 * Parse the tab-separated `Get-CimInstance Win32_Process` table produced by
 * {@link listProcesses} on win32.
 *
 * Columns: pid, ppid, workingSet, kernelModeTime, userModeTime (100ns units),
 * threadCount, command. A command containing tabs keeps them (join back).
 * Unparseable lines are counted in `skipped`, never dropped silently.
 *
 * @param output - raw powershell stdout
 * @returns parsed entries plus the count of skipped non-empty lines
 */
export function parsePowerShellProcessTable(output: string): TableParseResult {
  const entries: ProcessInfoEntry[] = [];
  let skipped = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 7) {
      skipped += 1;
      continue;
    }
    const pid = parseInt(parts[0]!, 10);
    const ppid = parseInt(parts[1]!, 10);
    const ws = parseInt(parts[2]!, 10);
    const kernel100ns = parseInt(parts[3]!, 10);
    const user100ns = parseInt(parts[4]!, 10);
    const threads = parseInt(parts[5]!, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      skipped += 1;
      continue;
    }
    entries.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid >= 0 ? ppid : null,
      command: parts.slice(6).join('\t').trim() || null,
      rssBytes: Number.isInteger(ws) && ws >= 0 ? ws : null,
      cpuTimeMs:
        Number.isInteger(kernel100ns) && Number.isInteger(user100ns)
          ? Math.round((kernel100ns + user100ns) / 10_000)
          : null,
      threads: Number.isInteger(threads) && threads >= 0 ? threads : null,
    });
  }
  return { entries, skipped };
}

/**
 * Walk the ppid map from `pid` up to the topmost reachable ancestor (pure).
 *
 * @param ppidByPid - pid → parent pid (null = source reported unknown)
 * @param pid - starting pid (always included as the chain tail)
 * @returns chain (topmost ancestor first, `pid` last) and whether every link resolved
 */
export function buildAncestorChain(
  ppidByPid: ReadonlyMap<number, number | null>,
  pid: number,
): { chain: number[]; complete: boolean } {
  const upward: number[] = [pid];
  const seen = new Set<number>([pid]);
  let complete = true;
  let current = pid;
  for (;;) {
    const parent = ppidByPid.get(current);
    if (parent === undefined || parent === null) {
      complete = false;
      break;
    }
    if (parent <= 0) break;
    if (seen.has(parent)) {
      // ppid cycle (racy pid reuse): stop, the chain is already suspect
      complete = false;
      break;
    }
    seen.add(parent);
    upward.push(parent);
    current = parent;
  }
  return { chain: upward.reverse(), complete };
}

/**
 * Apply filters, sort and limit to an enumeration (pure; all options honored).
 *
 * @param processes - enumerated entries
 * @param options - filter/sort/limit options
 * @returns selection with totals (`total` = pre-filter, `matched` = post-filter)
 */
export function selectProcesses(
  processes: readonly ProcessInfoEntry[],
  options?: ListProcessesOptions,
): SelectedProcesses {
  let selected = processes;
  if (options?.pids) {
    const wanted = new Set(options.pids);
    selected = selected.filter((p) => wanted.has(p.pid));
  }
  if (options?.nameContains) {
    const needle = options.nameContains.toLowerCase();
    selected = selected.filter((p) => (p.command ?? '').toLowerCase().includes(needle));
  }
  const sorted = [...selected];
  if (options?.sort === 'rss') {
    sorted.sort((a, b) => (b.rssBytes ?? -1) - (a.rssBytes ?? -1) || a.pid - b.pid);
  } else {
    sorted.sort((a, b) => a.pid - b.pid);
  }
  const limit = options?.limit;
  if (limit !== undefined && sorted.length > limit) {
    return { selected: sorted.slice(0, limit), total: processes.length, matched: sorted.length, truncated: true };
  }
  return { selected: sorted, total: processes.length, matched: sorted.length, truncated: false };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a diagnostic binary without a shell (async; bounded output and time).
 *
 * @param file - executable
 * @param args - argv tail
 * @param timeoutMs - hard timeout
 * @param env - explicit environment (never `{...process.env}`)
 * @returns stdout on success, or the error text (callers decide degradation)
 */
function runCapture(
  file: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { ok: true; stdout: string } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = execFile(
        file,
        args,
        { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env },
        (err, stdout) => {
          if (err) done({ ok: false, error: errText(err) });
          else done({ ok: true, stdout });
        },
      );
      child.on('error', (err) => done({ ok: false, error: errText(err) }));
    } catch (err) {
      // uv_spawn 同步失败（如牢笼拒 exec setuid 的 EPERM）从这里抛出：
      // 吞成 { ok:false } 即诚实降级，绝不让「看进程」把调用方整个拒掉
      done({ ok: false, error: errText(err) });
    }
  });
}

/** ps 的最小环境：剔除 COLUMNS（会截断 command 列）与 PS_PERSONALITY（行为漂移） */
function psEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' };
}

/** ps `-o thcount` 能力探测缓存（macOS 的 ps 无此关键字，退列是常态路径） */
let psThcountSupported: boolean | null = null;

function tableResult(
  parsed: TableParseResult,
  source: ProcessListResult['source'],
  notes: string[],
): ProcessListResult {
  const all = [...notes];
  if (parsed.skipped > 0) {
    // 非空行被跳过 = warning 或坏数据，二者不可分辨 → 一律申报不完整
    all.push(`${parsed.skipped} unparseable ${source} line(s) skipped; listing is partial`);
    return { processes: parsed.entries, source, complete: false, notes: all };
  }
  return { processes: parsed.entries, source, complete: true, notes: all };
}

async function listProcessesProcfs(): Promise<ProcessListResult> {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch (err) {
    // procfs 读不到（非 Linux / 隐藏挂载）：整源降级，不返回空表冒充成功
    return { processes: [], source: 'procfs', complete: false, notes: [`/proc unreadable: ${errText(err)}`] };
  }
  const notes: string[] = [];
  const out: ProcessInfoEntry[] = [];
  let denied = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = parseInt(name, 10);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const cmdline = readFileSync(`/proc/${pid}/cmdline`);
      out.push(parseProcPidEntry(pid, stat, status, cmdline));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ESRCH') {
        // 扫描窗口内退出的进程：跳过即事实，不造条目
        continue;
      }
      denied += 1;
    }
  }
  if (denied > 0) {
    // hidepid=2 / 权限收紧：列出的是可见子集，必须申报不完整
    notes.push(`${denied} /proc entries unreadable (permission denied); listing is partial`);
    return { processes: out, source: 'procfs', complete: false, notes };
  }
  return { processes: out, source: 'procfs', complete: true, notes };
}

async function listProcessesPs(): Promise<ProcessListResult> {
  const colsWith = 'pid=,ppid=,rss=,time=,thcount=,command=';
  const colsWithout = 'pid=,ppid=,rss=,time=,command=';

  if (psThcountSupported !== false) {
    const first = await runCapture('ps', ['-ww', '-axo', colsWith], 10_000, psEnv());
    if (first.ok) {
      psThcountSupported = true;
      return tableResult(parsePsProcessTable(first.stdout, true), 'ps', []);
    }
  }
  // 无 thcount 形态（macOS 即常态）：threads 如实为 null。
  // 记忆只在退列成功时落 false——首跑失败也可能是 ps 整体不可用（EPERM），
  // 那不是「关键字不存在」的证据，不能污染能力探测结论。
  const second = await runCapture('ps', ['-ww', '-axo', colsWithout], 10_000, psEnv());
  if (second.ok) {
    psThcountSupported = false;
    return tableResult(parsePsProcessTable(second.stdout, false), 'ps', [
      'ps has no thcount column on this host; threads=null',
    ]);
  }
  // ps 整体不可用。注意 macOS 牢笼拒 exec setuid 的 ps（OS 不变量）——
  // 引擎进程在牢笼外时走不到这里；agent 侧测试跑在笼内会如实降级。
  return {
    processes: [],
    source: 'ps',
    complete: false,
    notes: [`ps unavailable: ${'error' in second ? second.error : ''}`],
  };
}

async function listProcessesPowerShell(): Promise<ProcessListResult> {
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { ' +
    '$c = $_.CommandLine; if (-not $c) { $c = $_.Name }; ' +
    '"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)`t$($_.KernelModeTime)`t$($_.UserModeTime)`t$($_.ThreadCount)`t$c" }';
  const out = await runCapture(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    20_000,
    { WINDIR: process.env.WINDIR ?? 'C:\\Windows', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
  );
  if (!out.ok) {
    return { processes: [], source: 'powershell', complete: false, notes: [`powershell unavailable: ${out.error}`] };
  }
  return tableResult(parsePowerShellProcessTable(out.stdout), 'powershell', []);
}

/**
 * Enumerate running processes (read-only, engine-side).
 *
 * Sources: Linux `/proc` (works on slim images without `ps`), other POSIX `ps`,
 * win32 `Get-CimInstance`. A source that cannot be read at all degrades
 * honestly (`complete: false` + notes) — never an empty success.
 *
 * @returns the enumeration with its source and degradation notes
 */
export function listProcesses(): Promise<ProcessListResult> {
  if (process.platform === 'linux') return listProcessesProcfs();
  if (process.platform === 'win32') return listProcessesPowerShell();
  return listProcessesPs();
}

/**
 * Find the ancestor chain of a pid (read-only).
 *
 * `process.ppid` is seeded for the caller's own pid so a degraded listing still
 * yields the one link Node already knows.
 *
 * @param pid - target pid
 * @param listed - a fresh enumeration to walk (reuse to avoid a second scan)
 * @returns chain (topmost first, `pid` last) with completeness and source notes
 */
export async function getAncestorPidChain(pid: number, listed?: ProcessListResult): Promise<AncestorChain> {
  const listing = listed ?? (await listProcesses());
  const map = new Map<number, number | null>();
  for (const entry of listing.processes) map.set(entry.pid, entry.ppid);
  if (pid === process.pid && !map.has(pid)) {
    map.set(pid, typeof process.ppid === 'number' && process.ppid > 0 ? process.ppid : null);
  }
  const built = buildAncestorChain(map, pid);
  return { ...built, notes: listing.notes };
}

/**
 * Resolve the executable image of a pid (read-only, best-effort).
 *
 * linux: `/proc/<pid>/exe` readlink (then `ps -o comm=`); darwin: `lsof` txt
 * (then `ps`; lsof is not setuid so it also works inside the Seatbelt jail);
 * win32: `tasklist` name (no path without elevation).
 *
 * @param pid - target pid
 * @returns image path (or bare name where paths are unavailable), null when unresolvable
 */
export async function resolveProcessImage(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === 'win32') {
    const out = await runCapture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 5000, psEnv());
    if (!out.ok) {
      // 进程可能已退出或无权限查询：名字是锦上添花，缺失不阻塞调用方
      return null;
    }
    const line = out.stdout.trim();
    if (!line || line.startsWith('INFO')) return null;
    return line.split(',')[0]?.replace(/^"|"$/g, '').trim() || null;
  }

  if (process.platform === 'linux') {
    try {
      const link = readlinkSync(`/proc/${pid}/exe`);
      if (link) return link;
    } catch {
      // 内核线程/已退出/无权限：落 ps 兜底
    }
  }

  if (process.platform === 'darwin') {
    const viaLsof = await runCapture(
      '/usr/sbin/lsof',
      ['-p', String(pid), '-a', '-d', 'txt', '-Fn'],
      5000,
      psEnv(),
    );
    if (viaLsof.ok) {
      const image = firstExecutableFromLsof(viaLsof.stdout);
      if (image) return image;
    }
    // lsof exits non-zero for a vanished pid or a process owned by another
    // user; fall through to ps
  }

  const viaPs = await runCapture('ps', ['-p', String(pid), '-o', 'comm='], 5000, psEnv());
  if (!viaPs.ok) {
    // 进程可能已退出或无权限查询：缺失是可接受降级，不猜
    return null;
  }
  return viaPs.stdout.trim() || null;
}
