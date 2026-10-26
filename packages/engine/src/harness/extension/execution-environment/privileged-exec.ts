/**
 * 独立提权执行通道（ops P3，`arch/ops-privileged-mode.md` §5 P3 / §8）
 *
 * 设计要点（拍板 + 评审修复）：
 * - **提权走独立通道，不与牢笼抢轴**：引擎侧 `execFile` 执行完整 argv——不经 shell
 *   （无插值/无通配）、不包 jail、env 消毒、cwd 钉住（规则显式或 `/`，**不受 agent
 *   控制**）、超时 + 真树杀（detached 进程组）。
 * - **全等匹配**（effect-policy `matchEscalationRule`）：`cmd` 绝对路径 + `args` 逐项
 *   全等；执行即所配 argv，无任何隐式前缀。
 * - **二进制不可换（TOCTOU 护栏）**：对规则的**每一个有效目标**（`via: sudo` 形态下是
 *   sudo 之后的真实二进制，不只是 `cmd`）检查：不在 agent 可写面（含符号链接解析后）、
 *   文件与父目录链均不可被 agent uid / 组 / 世界写（可写目录 + rename 即可换二进制）。
 * - **启动期探测，拿不到即拒绝启动**（拍板 #5）：`via: sudo` 跑 `sudo -n true`（绝对
 *   路径）；`via: direct` 断言高权限（geteuid 0 / win32 `fsutil dirty query`）。
 *   探测证明「通道可用」，不证明「每条规则被 sudoers 授权」（文档如实声明）。
 */

import { spawn } from 'node:child_process';
import { statSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { killProcessTree, scrubEnv } from './process-isolation.js';

/** 白名单提权规则（§4） */
export interface EscalationRule {
  /** 稳定规则标识（审计关联）；缺省 `allow[<下标>]`（重排会断裂——显式 id 更好） */
  id?: string;
  /** 绝对路径（拒绝相对路径：PATH 解析 = 可换二进制） */
  cmd: string;
  /** 逐项全等的 argv 尾部；`via: sudo` 形态必须以 `-n` 开头 + 真实目标绝对路径 */
  args?: string[];
  /** true → 执行前走 HitlDecision 确认闸（缓存 key 含完整 argv） */
  confirm?: boolean;
  /** 提权进程的工作目录（绝对路径）；缺省 `/`——绝不取 agent 的 cwd */
  cwd?: string;
}

/** 提权策略（resolved） */
export interface EscalationPolicy {
  /**
   * `none`（缺省）| `allowlist`（cmd+args 全等）| `full`（全量档，P4）。
   * `full` 仅在 `jail: "none"` + `privilegedAck` + `mode: "host"` 下合法（§4.1）。
   */
  policy: 'none' | 'allowlist' | 'full';
  via: 'sudo' | 'direct';
  allow: EscalationRule[];
}

/** 提权执行输入 */
export interface PrivilegedExecOptions {
  /** 已通过全等匹配的 cmd（绝对路径） */
  cmd: string;
  args: string[];
  via: 'sudo' | 'direct';
  /** 特权进程 cwd（缺省 `/`；规则可显式指定） */
  cwd?: string;
  timeoutMs?: number;
  /** run 中止信号：触发即时树杀（与超时同一收回路径，不等 timeoutMs 兜底） */
  abortSignal?: AbortSignal;
}

/** 提权执行结果 */
export interface PrivilegedExecResult {
  /** false = 进程从未成功 spawn（区别于「执行了但非零退出」） */
  executed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** run 中止即时树杀所致（区别于 timedOut：外部中止，不是命令超时） */
  aborted?: boolean;
}

/** 启动探测结论 */
export type EscalationReadiness = { ok: true } | { ok: false; reason: string };

function envForExec(): NodeJS.ProcessEnv {
  // root 态下 PATH/HOME 都是注入面（per-user 配置、可写 PATH 目录）——钉死系统值。
  // 其余一律不透传（凭证/注入面收敛）。
  if (process.platform === 'win32') {
    return scrubEnv({
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      WINDIR: process.env.WINDIR ?? 'C:\\Windows',
      PATH: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`,
    });
  }
  return scrubEnv({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/', LANG: 'C' });
}

const OUTPUT_CAP = 128 * 1024;

function capOutput(text: string): string {
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n…[truncated ${text.length - OUTPUT_CAP} chars]` : text;
}

/**
 * 执行一条已匹配的提权命令（不经 shell、不包 jail、cwd 钉住）。
 *
 * @param options - cmd/args（完整 argv）、via、cwd、timeoutMs
 * @returns 执行结果（spawn 从未成功时 executed=false）
 */
export function runPrivilegedExec(options: PrivilegedExecOptions): Promise<PrivilegedExecResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolveP) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const done = (result: PrivilegedExecResult): void => {
      if (settled) return;
      settled = true;
      if (killer) clearTimeout(killer);
      if (onAbort) options.abortSignal?.removeEventListener('abort', onAbort);
      resolveP(result);
    };
    try {
      // spawn（不是 execFile）：detached 只有 spawn 才转发——独立进程组是真树杀的前提
      const child = spawn(options.cmd, options.args, {
        cwd: options.cwd ?? '/',
        env: envForExec(),
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length < OUTPUT_CAP * 2) stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < OUTPUT_CAP * 2) stderr += chunk;
      });
      killer = setTimeout(() => {
        timedOut = true;
        try {
          killProcessTree(child);
        } catch {
          // 树杀失败退化单杀：至少收回直接子进程，结果侧如实 timedOut
          try {
            child.kill('SIGKILL');
          } catch {
            // 进程已死：结果照常出
          }
        }
      }, timeoutMs);
      killer.unref?.();
      // run 中止即时树杀（与超时同一收回路径）：外部中止不等 timeoutMs 兜底
      onAbort = () => {
        aborted = true;
        try {
          killProcessTree(child);
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // 进程已死：结果照常出
          }
        }
      };
      if (options.abortSignal) {
        if (options.abortSignal.aborted) onAbort();
        else options.abortSignal.addEventListener('abort', onAbort, { once: true });
      }
      child.on('error', (err) => {
        // spawn 从未成功（ENOENT/EPERM…）= 未执行，区别于执行了但非零退出
        done({
          executed: false,
          exitCode: null,
          stdout: capOutput(stdout),
          stderr: capOutput(stderr || errText(err)),
          durationMs: Date.now() - started,
          timedOut,
          ...(aborted ? { aborted: true } : {}),
        });
      });
      // 收 `exit` 而非 `close`：后台子孙继承 stdio 管道时 close 会被吊住不返回
      child.on('exit', (code) => {
        // 命令结束即树杀（D1 同语义）：特权通道不留孤儿（后台 `&` 进程/孙进程）；
        // 守护型目标（systemctl 等）已 setsid 自立组，不受此杀
        try {
          killProcessTree(child);
        } catch {
          // 组已空或无权限：无孤儿可杀，照常出结果
        }
        done({
          executed: true,
          exitCode: code,
          stdout: capOutput(stdout),
          stderr: capOutput(stderr),
          durationMs: Date.now() - started,
          timedOut,
          ...(aborted ? { aborted: true } : {}),
        });
      });
    } catch (err) {
      // spawn 同步抛出：同「未执行」语义，绝不冒充执行结果
      done({
        executed: false,
        exitCode: null,
        stdout: '',
        stderr: errText(err),
        durationMs: Date.now() - started,
        timedOut,
      });
    }
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 列出规则的**有效提权目标**（TOCTOU 护栏逐个检查的对象）。
 *
 * `via: sudo` 形态的真正目标是 sudo 之后的二进制（`args[1]`）——只查 `cmd` 等于不查。
 *
 * @param rule - 白名单规则
 * @param via - 通道形态
 * @returns 目标路径列表；形态非法时 `invalid` 给出原因
 */
export function escalationRuleTargets(
  rule: EscalationRule,
  via: 'sudo' | 'direct',
): { targets: string[] } | { invalid: string } {
  const args = rule.args ?? [];
  if (via === 'sudo') {
    if (args[0] !== '-n') {
      return { invalid: `via=sudo rules must spell \`sudo -n\` explicitly (args[0] must be "-n"), got ${JSON.stringify(args[0])}` };
    }
    const target = args[1];
    if (target === undefined || !isAbsolute(target)) {
      return { invalid: `via=sudo rules need the real target as args[1] (absolute path), got ${JSON.stringify(target)}` };
    }
    return { targets: [rule.cmd, target] };
  }
  return { targets: [rule.cmd] };
}

/**
 * TOCTOU 护栏：目标二进制不可被换（agent 可写面 / 文件或父目录可写 → 拒绝）。
 *
 * 检查口径（评审修复）：
 * - 路径与其 `realpath` 都做可写面判定（符号链接穿透）；
 * - 文件本体 **与父目录链**都不可写（可写目录 + rename 即可替换 0555 文件）；
 * - 目标不存在（可后装）时仅当父目录链安全才放行。
 *
 * @param target - 目标二进制绝对路径
 * @param writableRoots - agent 可写根（workspace/home/tmp/transactionRoots/…）
 * @returns 违规原因；通过返回 null
 */
export function checkEscalationBinary(target: string, writableRoots: readonly string[]): string | null {
  if (!isAbsolute(target)) return `path must be absolute, got ${JSON.stringify(target)}`;
  const raw = resolve(target);
  const roots = writableRoots.map((r) => resolve(r));
  const underRoots = (p: string): string | null => {
    for (const root of roots) {
      if (p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)) {
        return `is inside agent-writable root ${root}`;
      }
    }
    return null;
  };
  const hit = underRoots(raw);
  if (hit) return `cmd ${raw} ${hit}`;

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  const checkParentChain = (p: string): string | null => {
    let dir = dirname(p);
    for (;;) {
      const parentHit = underRoots(dir);
      if (parentHit) return `parent dir ${dir} ${parentHit}`;
      if (dir === dirname(dir)) return null;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(dir);
      } catch {
        dir = dirname(dir);
        continue;
      }
      const writable = (st.mode & 0o222) !== 0;
      if (writable) {
        if (uid !== null && st.uid === uid) return `parent dir ${dir} is writable by the agent uid`;
        if ((st.mode & 0o022) !== 0) return `parent dir ${dir} is group/world-writable`;
      }
      dir = dirname(dir);
    }
  };

  // 目标不存在（可后装）：仅当父目录链不可换时放行；存在时连同 realpath 一并检查
  let real = raw;
  try {
    real = realpathSync(raw);
    const realHit = underRoots(real);
    if (realHit) return `cmd ${real} ${realHit} (symlink target)`;
  } catch {
    const parent = checkParentChain(raw);
    if (parent) return `cmd ${raw}: ${parent}`;
    return null;
  }

  const parent = checkParentChain(real) ?? checkParentChain(raw);
  if (parent) return `cmd ${raw}: ${parent}`;

  // Windows 无 POSIX mode 语义（读回恒 0666）：roots + 父目录链即全部口径（win32 边界）
  if (process.platform === 'win32') return null;

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(real);
  } catch {
    return `cmd ${real} unreadable`;
  }
  if ((st.mode & 0o222) === 0) return null;
  if (uid !== null && st.uid === uid) return `cmd ${real} is writable by the agent uid (${uid}) — replaceable binary`;
  if ((st.mode & 0o022) !== 0) return `cmd ${real} is group/world-writable — replaceable binary`;
  return null;
}

/**
 * 提权可写根的统一口径（daemon 启动探测与 resolve 校验共用，防两处漂移）。
 *
 * @param options.workspaces - agent workspace 集合
 * @param options.transactionRoots - 配置 transactionRoots
 * @returns 可写根列表（含 home/tmp/OCTOPI_HOME）
 */
export function escalationWritableRoots(options?: {
  workspaces?: readonly string[];
  transactionRoots?: readonly string[];
}): string[] {
  return [
    ...(options?.workspaces ?? []),
    ...(options?.transactionRoots ?? []),
    homedir(),
    tmpdir(),
    resolve(homedir(), '.octopi'),
  ];
}

/**
 * 启动期探测：声明了提权就必须真的拿得到（拍板 #5：拒绝启动，禁止降级静默）。
 *
 * @param config - 提权策略（配置形或 resolved 均可）
 * @param options.writableRoots - TOCTOU 护栏的可写根集合
 * @returns ok 或拒绝原因
 */
export async function probeEscalationReadiness(
  config:
    | EscalationPolicy
    | {
        policy?: 'none' | 'allowlist' | 'full';
        via?: 'sudo' | 'direct';
        allow?: EscalationRule[];
      }
    | undefined,
  options?: { writableRoots?: readonly string[] },
): Promise<EscalationReadiness> {
  const escalation: EscalationPolicy = {
    policy: config?.policy ?? 'none',
    via: config?.via ?? 'sudo',
    allow: config?.allow ?? [],
  };
  if (escalation.policy === 'none') return { ok: true };
  if (escalation.policy === 'full') {
    // 全量档（P4）没有 allowlist 面；带 allow 规则 = 配置死键（schema 已拒，库路径兜底）
    if (escalation.allow.length > 0) {
      return { ok: false, reason: 'escalation.policy=full takes no escalation.allow rules (exact-match list is an allowlist-only concept)' };
    }
  } else if (escalation.allow.length === 0) {
    return { ok: false, reason: 'escalation.policy=allowlist but effectPolicy.escalation.allow is empty' };
  }
  for (const rule of escalation.allow) {
    const targets = escalationRuleTargets(rule, escalation.via);
    if ('invalid' in targets) return { ok: false, reason: `allowlist rule rejected: ${targets.invalid}` };
    for (const target of targets.targets) {
      const bad = checkEscalationBinary(
        target,
        options?.writableRoots ?? escalationWritableRoots(),
      );
      if (bad) return { ok: false, reason: `allowlist rule rejected: ${bad}` };
    }
  }
  if (escalation.via === 'sudo') {
    // 绝对路径执行（裸名 sudo 可被 PATH 劫持）；探测≠规则被 sudoers 授权（文档如实声明）
    const probe = await runPrivilegedExec({
      cmd: '/usr/bin/sudo',
      args: ['-n', 'true'],
      via: 'sudo',
      timeoutMs: 5000,
    });
    if (probe.exitCode !== 0) {
      return {
        ok: false,
        reason: `escalation.via=sudo but ` + '`/usr/bin/sudo -n true`' + ` failed (exit=${probe.exitCode}): ${probe.stderr.trim()}`,
      };
    }
    return { ok: true };
  }
  // via: direct —— 进程自身必须已高权限（POSIX euid 0 / win32 fsutil 探测）
  if (process.platform === 'win32') {
    const fsutil = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\fsutil.exe`;
    const probe = await runPrivilegedExec({ cmd: fsutil, args: ['dirty', 'query', 'C:'], via: 'direct', timeoutMs: 5000 });
    if (probe.exitCode !== 0) {
      return { ok: false, reason: 'escalation.via=direct but process is not elevated (`fsutil dirty query` failed)' };
    }
    return { ok: true };
  }
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
  if (euid !== 0) {
    return { ok: false, reason: `escalation.via=direct but geteuid()=${euid} (need 0)` };
  }
  return { ok: true };
}

/**
 * 本进程是否已高权限（root / Windows elevated 管理员令牌）。
 *
 * POSIX 同步读 `geteuid()`；win32 走 `fsutil dirty query` 行为探测（与
 * `probeEscalationReadiness` 的 direct 分支同口径，不读配置位、不猜 token）。
 * 结果按进程生命期缓存（权限不可自行提升，探测一次即事实不变）。
 *
 * @returns true = 高权限进程
 */
export async function isProcessElevated(): Promise<boolean> {
  if (cachedElevated !== undefined) return cachedElevated;
  if (process.platform === 'win32') {
    const fsutil = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\fsutil.exe`;
    const probe = await runPrivilegedExec({
      cmd: fsutil,
      args: ['dirty', 'query', 'C:'],
      via: 'direct',
      timeoutMs: 5000,
    });
    cachedElevated = probe.exitCode === 0;
  } else {
    const euid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
    cachedElevated = euid === 0;
  }
  return cachedElevated;
}

let cachedElevated: boolean | undefined;

/** 同步口径的高权限猜测（POSIX 可判；win32 同步不可判时如实返回 false 交由异步探测补） */
export function isProcessElevatedSync(): boolean {
  if (process.platform === 'win32') return false;
  return typeof process.geteuid === 'function' ? process.geteuid() === 0 : false;
}

/**
 * root/elevated 部署的显式 privileged 声明断言（§5 P4 root 部署语义）。
 *
 * daemon 以 root 跑时没有 sudo，危险轴变成「笼不笼 × uid=0」——启动期高权限进程
 * 必须在 effectPolicy 里显式 `privilegedAck` 表态，拿不到声明就拒绝启动，
 * 不允许「root 就这么跑着」的静默特权态。
 *
 * @param params.elevated - 进程是否高权限（`isProcessElevated` 探测值）
 * @param params.privilegedAck - effectPolicy.privilegedAck（可缺省）
 * @param params.scope - 出错信息里的配置面标识（如 `<top>` / agent id）
 * @throws `privileged_declaration_required`（elevated 且无声明）
 */
export function assertPrivilegedDeclaration(params: {
  elevated: boolean;
  privilegedAck?: string;
  scope: string;
}): void {
  if (!params.elevated) return;
  if (params.privilegedAck?.trim()) return;
  throw new Error(
    `privileged_declaration_required (${params.scope}): process is elevated (root/admin) but ` +
      `effectPolicy.privilegedAck is missing — declare the privileged deployment explicitly or run unprivileged`,
  );
}
