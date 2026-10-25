/**
 * Process sandbox — supervised spawn (L1) + optional OS jails (L4 process).
 *
 * Never claims isolation it does not enforce. `SupervisedSpawn` is process-tree
 * kill + env scrub + limits only; real jails are `linux-bwrap` / `mac-seatbelt`.
 * Public contract: `docs/process-isolation.md`.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  SandboxProvider,
  SandboxConfig,
  SandboxResult,
  IsolationLevel,
  ResourceUsage,
} from './types.js';
import {
  assessL4ProcessMinimum,
  killProcessTree,
  probeProcessIsolation,
  scrubEnv,
  supervisedSpawnProfile,
  type ProcessIsolationProfile,
} from './process-isolation.js';

/**
 * Run 级失笼降级的归一码前缀（ops P0）：probe 缺笼与运行时失笼共用 `no_process_jail`
 * 前缀，消费面按前缀匹配即可覆盖全部失笼路径。
 *
 * @param detail - 失笼细节（jail_setup_failed / jail_spawn_failed / …）
 * @returns 归一后的 securityDegraded 代码
 */
export function jailDegradationCode(detail: string): string {
  return `no_process_jail: ${detail}`;
}

export interface ProcessSandboxOptions {
  /** Force a profile (tests). Otherwise probes on construct. */
  profile?: ProcessIsolationProfile;
  /** Allow listing PATH etc. Force-injected env keys beyond allowlist */
  forceEnvKeys?: string[];
}

/**
 * Supervised process runner: tree-killable spawn with scrubbed env.
 * This is NOT a filesystem jail — `isolation.filesystem` stays `cwd-pin`.
 */
export class ProcessSandbox implements SandboxProvider {
  readonly level: IsolationLevel = 'process';
  private cachedProfile: ProcessIsolationProfile | null;
  private readonly forceEnvKeys: string[] | undefined;

  constructor(options?: ProcessSandboxOptions) {
    this.cachedProfile = options?.profile ?? null;
    this.forceEnvKeys = options?.forceEnvKeys;
  }

  async probe(): Promise<ProcessIsolationProfile> {
    if (this.cachedProfile) return this.cachedProfile;
    this.cachedProfile = await probeProcessIsolation();
    return this.cachedProfile;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Execute a shell command line via the platform shell.
   *
   * @param command - shell command line
   * @param config - cwd / env / limits
   * @returns result with honest isolation profile
   */
  async execute(command: string, config?: SandboxConfig): Promise<SandboxResult> {
    const profile = await this.probe();
    const shell = resolveShell();
    return this.run(shell.executable, [...shell.args, command], config, profile);
  }

  /**
   * Execute an argv vector (preferred).
   *
   * @param argv - executable + args
   * @param config - cwd / env / limits
   * @returns result with honest isolation profile
   */
  async executeArgv(argv: string[], config?: SandboxConfig): Promise<SandboxResult> {
    const profile = await this.probe();
    if (argv.length === 0) {
      throw new Error('sandbox_argv_empty: executeArgv requires at least one token');
    }
    return this.run(argv[0]!, argv.slice(1), config, profile);
  }

  private run(
    file: string,
    args: string[],
    config: SandboxConfig | undefined,
    profile: ProcessIsolationProfile,
  ): Promise<SandboxResult> {
    const cwd = config?.cwd ?? process.cwd();
    const env = scrubEnv(config?.env, { forceKeys: this.forceEnvKeys });
    const timeoutMs = config?.limits?.timeoutMs ?? 60_000;
    const maxOutputBytes = config?.limits?.maxOutputBytes ?? 10 * 1024 * 1024;

    if (config?.disableJail && config?.requireJail) {
      // 库契约守卫：两个都设 = 配置矛盾，绝不静默取舍
      return Promise.reject(
        new Error('sandbox_config_conflict: disableJail and requireJail are mutually exclusive'),
      );
    }
    // 授权无笼（ops P0：jail=none + privilegedAck 已过配置闸）：显式注记，不是降级
    if (config?.disableJail) {
      return this.withExecDiagnostics(
        this.runSupervised(
          file,
          args,
          config,
          {
            ...profile,
            backend: 'supervised-spawn',
            processTree: 'killable',
            filesystem: 'cwd-pin',
            privilege: 'same',
            network: 'open',
            notes: [...(profile.notes ?? []), 'jail=disabled_by_config (privileged)'],
          },
          { cwd, env, timeoutMs, maxOutputBytes },
        ),
        cwd,
        [],
      );
    }

    // Jail backends wrap the spawn; fall back to supervised spawn.
    if (profile.backend === 'linux-bwrap' && process.platform === 'linux') {
      return this.runBwrap(file, args, config, profile, { cwd, env, timeoutMs, maxOutputBytes });
    }
    if (profile.backend === 'mac-seatbelt' && process.platform === 'darwin') {
      return this.runSeatbelt(file, args, config, profile, { cwd, env, timeoutMs, maxOutputBytes });
    }
    if (config?.requireJail) {
      return Promise.reject(
        new Error(
          `jail_required_unavailable: no process jail backend (probe=${profile.backend}); refuse unsandboxed execute`,
        ),
      );
    }
    // jail 意图落空（auto+degrade）：逐条命令如实注记；run 级 securityDegraded
    // 已由 resolveEffectiveEffectPolicy 记 `no_process_jail`（probe 期缺笼）
    return this.withExecDiagnostics(
      this.runSupervised(
        file,
        args,
        config,
        {
          ...profile,
          notes: [...(profile.notes ?? []), 'jail=unavailable (supervised-spawn); running unsandboxed'],
        },
        { cwd, env, timeoutMs, maxOutputBytes },
      ),
      cwd,
      [],
    );
  }

  /**
   * Attribute a setuid/privilege exec denial on the caller's channels.
   *
   * A jail that does not apply (nested sandbox, wrapper missing) still refuses
   * setuid exec when an **enclosing** jail is in force, so attribution cannot
   * live only in `runSeatbelt`. `denyExec` stays empty there: without proof we
   * own the profile, claiming a specific deny-list entry would be a guess.
   *
   * @param pending - result promise from whichever backend ran
   * @param cwd - run cwd, used to resolve bare command names
   * @param denyExec - deny list we know is in force (empty when unknown)
   * @returns result, with one explanation attached when stderr was attributable
   */
  private withExecDiagnostics(
    pending: SandboxResult | Promise<SandboxResult>,
    cwd: string,
    denyExec: readonly string[],
  ): Promise<SandboxResult> {
    if (process.platform !== 'darwin') return Promise.resolve(pending);
    return Promise.resolve(pending).then(async (result) => {
      const denial = await explainSeatbeltExecDenial({ stderr: result.stderr, cwd, denyExec });
      if (!denial) return result;
      return {
        ...result,
        isolation: {
          ...result.isolation,
          notes: [...(result.isolation.notes ?? []), denial.note],
        },
        diagnostics: { hints: [denial.hint] },
      };
    });
  }

  private runSupervised(
    file: string,
    args: string[],
    config: SandboxConfig | undefined,
    profile: ProcessIsolationProfile,
    opts: {
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<SandboxResult> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let stdout = '';
      let stderr = '';
      // 输出上限按原始字节计（stdout/stderr 各自独立计）：字符数远小于字节数，
      // 旧口径会让上限推迟触发、放走 ~3x 字节。计数含被丢弃块，故已捕获文本恒 ≤
      // 上限；usage().outputBytes 只计已捕获字节（`captured*`，见下方 usage 调用）。
      let stdoutBytes = 0;
      let stderrBytes = 0;
      // 已捕获原始字节：usage 的唯一口径。不能用 byteLength(文本) 代替——被切断的
      // 多字节字符解码后是 3 字节的 U+FFFD，按文本重算会虚高（也说明必须用
      // StringDecoder 跨块解码，逐块 toString 会让 stdout/stderr 文本本身被污染）。
      let stdoutCaptured = 0;
      let stderrCaptured = 0;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let decodersFlushed = false;
      /** 冲刷解码器尾部：未收尾的多字节字符在此输出（截断流输出 U+FFFD 是正确结果）。 */
      const flushDecoders = (): void => {
        if (decodersFlushed) return;
        decodersFlushed = true;
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      };
      let terminated = false;
      let terminateReason = '';
      let settled = false;

      const spawnOpts: SpawnOptions = {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: own process group so we can kill the tree
        ...(process.platform === 'win32' ? {} : { detached: true }),
      };

      const proc = spawn(file, args, spawnOpts);

      const finish = (result: SandboxResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        config?.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      /** Refusal path (requireJail contract: throw, never resolve-as-success). */
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        config?.signal?.removeEventListener('abort', onAbort);
        reject(err);
      };

      const kill = (reason: string) => {
        terminated = true;
        terminateReason = reason;
        killProcessTree(proc);
      };

      const onAbort = () => kill('Aborted');
      config?.signal?.addEventListener('abort', onAbort, { once: true });

      proc.stdout?.on('data', (data: Buffer) => {
        stdoutBytes += data.length;
        if (stdoutBytes > opts.maxOutputBytes) {
          kill('Output size limit exceeded');
          return;
        }
        stdoutCaptured += data.length;
        stdout += stdoutDecoder.write(data);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderrBytes += data.length;
        if (stderrBytes > opts.maxOutputBytes) {
          kill('Output size limit exceeded');
          return;
        }
        stderrCaptured += data.length;
        stderr += stderrDecoder.write(data);
      });

      const timer = setTimeout(() => {
        kill(`Execution timeout (${opts.timeoutMs}ms)`);
      }, opts.timeoutMs);

      proc.on('close', (exitCode, signal) => {
        flushDecoders();
        const usage = this.usage(start, stdoutCaptured, stderrCaptured);
        // null exitCode = signal death; never report that as success (exit 0)
        const code = typeof exitCode === 'number' ? exitCode : -1;
        finish({
          exitCode: code,
          stdout,
          stderr: signal && !terminated ? `${stderr}\n[signal ${signal}]`.trim() : stderr,
          terminated: terminated || signal != null,
          terminateReason:
            terminated
              ? terminateReason
              : signal
                ? `signal ${signal}`
                : undefined,
          usage,
          isolation: profile,
        });
      });

      proc.on('error', (err) => {
        flushDecoders();
        const usage = this.usage(start, stdoutCaptured, stderrCaptured);
        const isJailWrapper =
          profile.backend === 'linux-bwrap' || profile.backend === 'mac-seatbelt';
        if (config?.requireJail && isJailWrapper) {
          fail(
            new Error(
              `jail_required_unavailable: jail spawn failed: ${err.message} (requireJail=true; refuse unsandboxed execute)`,
            ),
          );
          return;
        }
        const honest: ProcessIsolationProfile = isJailWrapper
          ? {
              ...profile,
              filesystem: 'cwd-pin',
              privilege: 'same',
              notes: [...(profile.notes ?? []), `jail spawn failed: ${err.message}`],
            }
          : profile;
        // 归一码 no_process_jail（与 jailSetupFailed/jailWrapperRuntimeFailure 同前缀）
        if (isJailWrapper) {
          config?.noteSecurityDegraded?.(jailDegradationCode(`jail_spawn_failed: ${err.message}`));
        }
        finish({
          exitCode: -1,
          stdout,
          stderr: err.message,
          terminated: true,
          terminateReason: `Process error: ${err.message}`,
          usage,
          isolation: honest,
        });
      });
    });
  }

  private async runBwrap(
    file: string,
    args: string[],
    config: SandboxConfig | undefined,
    profile: ProcessIsolationProfile,
    opts: {
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<SandboxResult> {
    // D4-c: bind every allowRoot; default network deny (--unshare-all).
    const roots = await resolveJailRoots(opts.cwd, config);
    const network = resolveNetworkPolicy(config);
    const bwrapArgs = [
      '--die-with-parent',
      '--unshare-all',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/bin',
      '/bin',
      '--ro-bind',
      '/lib',
      '/lib',
      '--ro-bind-try',
      '/lib64',
      '/lib64',
      '--ro-bind-try',
      '/etc',
      '/etc',
    ];
    if (network === 'open') {
      bwrapArgs.push('--share-net');
    }
    for (const root of roots) {
      // --bind-try: stale pathRoots must not abort the whole command
      bwrapArgs.push('--bind-try', root, root);
    }
    bwrapArgs.push('--chdir', opts.cwd, '--', file, ...args);

    const applied: ProcessIsolationProfile = {
      ...profile,
      network,
      privilege: 'dropped',
      notes: [
        ...(profile.notes ?? []),
        `bwrap roots=${roots.join(',')}`,
        networkPolicyNote(config, network),
        'privilege=dropped (userns)',
      ],
    };
    const result = await this.runSupervised('bwrap', bwrapArgs, config, applied, opts);
    // D7 runtime case (post-execution): the wrapper failed to establish the
    // jail even though the probe passed. Never re-execute the user command.
    if (isJailWrapperSetupFailure(result, 'bwrap')) {
      return this.jailWrapperRuntimeFailure(
        result,
        config,
        profile,
        `bwrap setup failed (exit=${result.exitCode}): ${result.stderr.slice(0, 200)}`,
      );
    }
    return result;
  }

  private async runSeatbelt(
    file: string,
    args: string[],
    config: SandboxConfig | undefined,
    profile: ProcessIsolationProfile,
    opts: {
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<SandboxResult> {
    const roots = await resolveJailRoots(opts.cwd, config);
    const network = resolveNetworkPolicy(config);

    // Host override wins; otherwise generate a profile covering allowRoots (D3-b+).
    let profilePath = process.env.OCTOPI_SB_PROFILE;
    let generatedPath: string | undefined;
    /** Deny list in force, or null when an external profile owns it (unknown). */
    let denyExec: readonly string[] | null = null;
    if (!profilePath) {
      generatedPath = join(
        tmpdir(),
        `octopi-sb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sb`,
      );
      try {
        await writeFile(generatedPath, buildSeatbeltProfile(roots, network), { encoding: 'utf8', mode: 0o600 });
        profilePath = generatedPath;
        denyExec = DEFAULT_PRIVILEGE_DENY_EXEC;
      } catch (err) {
        return this.jailSetupFailed(
          file,
          args,
          config,
          profile,
          opts,
          `seatbelt profile generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const applied: ProcessIsolationProfile = {
      ...profile,
      filesystem: 'write-jailed',
      privilege: 'dropped',
      network,
      notes: [
        ...(profile.notes ?? []),
        `seatbelt profile=${profilePath}`,
        `roots=${roots.join(',')}`,
        networkPolicyNote(config, network),
        'privilege=dropped (ops-denied; uid unchanged)',
        'tmp writes not journaled (notReversed)',
      ],
    };

    try {
      const result = await this.runSupervised(
        'sandbox-exec',
        ['-f', profilePath, '--', file, ...args],
        config,
        applied,
        opts,
      );
      // D7 runtime case (post-execution): the wrapper failed to apply the
      // jail even though the probe passed. Never re-execute the user command.
      if (isJailWrapperSetupFailure(result, 'sandbox-exec')) {
        return await this.jailWrapperRuntimeFailure(
          result,
          config,
          profile,
          `seatbelt apply failed (exit=${result.exitCode}): ${result.stderr.slice(0, 200)}`,
        );
      }
      // A real command may have printed EPERM for reasons the caller cannot see
      // from inside the jail (setuid exec is an OS invariant; privileged
      // helpers are denied by the profile). Attribute it once, on the honest
      // channels: isolation notes (what the jail did) + diagnostics (next step).
      return this.withExecDiagnostics(result, opts.cwd, denyExec ?? []);
    } finally {
      if (generatedPath) {
        await unlink(generatedPath).catch(() => undefined);
      }
    }
  }

  /**
   * D7: jail was selected but cannot be applied.
   * requireJail (untrusted) throws; otherwise supervised fallback of the real command + run-level note.
   */
  private jailSetupFailed(
    file: string,
    args: string[],
    config: SandboxConfig | undefined,
    profile: ProcessIsolationProfile,
    opts: {
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      maxOutputBytes: number;
    },
    reason: string,
  ): Promise<SandboxResult> {
    if (config?.requireJail) {
      return Promise.reject(
        new Error(`jail_required_unavailable: ${reason} (requireJail=true; refuse unsandboxed execute)`),
      );
    }
    const degraded: ProcessIsolationProfile = {
      ...profile,
      backend: 'supervised-spawn',
      processTree: 'killable',
      filesystem: 'cwd-pin',
      privilege: 'same',
      network: 'open',
      notes: [...(profile.notes ?? []), `jail_setup_failed: ${reason}; supervised fallback`],
    };
    // 归一码 no_process_jail：消费面按前缀匹配即可覆盖 probe 缺笼与运行时建笼失败两类路径
    config?.noteSecurityDegraded?.(jailDegradationCode(`jail_setup_failed: ${reason}`));
    return this.runSupervised(file, args, config, degraded, opts);
  }

  /**
   * D7 runtime case (after the wrapper has run): a jail setup failure is
   * suspected. The user command is **never re-executed** — a forged wrapper
   * error must not buy a second, unsandboxed run. `requireJail` refuses;
   * other modes report the wrapper outcome with downgraded isolation and the
   * run-level `securityDegraded` note (under-claiming is the safe direction).
   *
   * @param result - the wrapper's own outcome (command not re-run)
   * @param config - execute config (requireJail / degradation hook)
   * @param profile - probed isolation profile
   * @param reason - wrapper failure summary for notes
   * @returns the wrapper outcome with honestly downgraded isolation
   */
  private jailWrapperRuntimeFailure(
    result: SandboxResult,
    config: SandboxConfig | undefined,
    profile: ProcessIsolationProfile,
    reason: string,
  ): Promise<SandboxResult> {
    if (config?.requireJail) {
      return Promise.reject(
        new Error(`jail_required_unavailable: ${reason} (requireJail=true; refuse unsandboxed execute)`),
      );
    }
    // 归一码 no_process_jail（同 jailSetupFailed）
    config?.noteSecurityDegraded?.(jailDegradationCode(`jail_setup_failed: ${reason}`));
    return Promise.resolve({
      ...result,
      isolation: {
        ...profile,
        backend: 'supervised-spawn',
        processTree: 'killable',
        filesystem: 'cwd-pin',
        privilege: 'same',
        network: 'open',
        notes: [
          ...(profile.notes ?? []),
          `jail_setup_failed: ${reason}; command not re-executed`,
        ],
      },
    });
  }

  private usage(start: number, stdoutCaptured: number, stderrCaptured: number): ResourceUsage {
    return {
      elapsedMs: Date.now() - start,
      peakMemoryBytes: -1,
      cpuTimeMs: -1,
      outputBytes: stdoutCaptured + stderrCaptured,
    };
  }
}



/** Network posture for this run (D4-c: default deny; allowlist enforced as deny). */
function resolveNetworkPolicy(config: SandboxConfig | undefined): 'open' | 'deny' {
  const policy = config?.networkPolicy ?? 'deny';
  return policy === 'open' ? 'open' : 'deny';
}

/**
 * Heuristic: the jail wrapper failed to establish the jail — the user command
 * never ran. Detection only feeds refusal (`requireJail`) or an honest
 * isolation downgrade; the user command is **never re-executed** on it, so a
 * forged stderr cannot buy an unsandboxed run. Wrapper diagnostics carry the
 * argv0 prefix at **line start** (bwrap's uid-map helpers report as
 * `newuidmap:` / `newgidmap:`); bare substrings are not matched, and neither
 * is "operation not permitted": a sandbox write denial of a real user command
 * emits exactly that wording. A terminated run (timeout/abort) is never a
 * setup failure.
 *
 * @param result - wrapper run result
 * @param wrapper - which jail wrapper produced the result
 * @returns true when the jail itself failed to apply
 */
export function isJailWrapperSetupFailure(
  result: { exitCode: number; stdout: string; stderr: string; terminated?: boolean },
  wrapper: 'bwrap' | 'sandbox-exec',
): boolean {
  if (result.terminated) return false;
  if (result.exitCode === 0) return false;
  if (result.stdout.length > 0) return false;
  const prefixes =
    wrapper === 'bwrap' ? ['bwrap:', 'newuidmap:', 'newgidmap:'] : ['sandbox-exec:'];
  return result.stderr.split('\n').some((line) => prefixes.some((p) => line.startsWith(p)));
}

/** Extra note when caller asked for allowlist (interface-only). */
function networkPolicyNote(config: SandboxConfig | undefined, applied: 'open' | 'deny'): string {
  const requested = config?.networkPolicy;
  if (requested === 'allowlist') {
    return `network=${applied} (allowlist requested; interface-only, enforced as deny)`;
  }
  return `network=${applied}`;
}

/**
 * Jail write mounts (2a/2b): allowRoots ∪ cwd ∪ tmpdir ∪ shared tmp on POSIX
 * (`/tmp`, `/var/tmp` — always) ∪ home when `config.homeWrite` (project/host).
 * tmp is not journaled (2c).
 *
 * Each root is emitted in its lexical form **and**, when resolvable, its
 * canonical (`realpath`) form: jail backends match canonical paths, so a root
 * given through a symlink alias (macOS `/var` → `/private/var`, `/tmp` →
 * `/private/tmp`) must appear canonicalized or its subpath rule never matches.
 * Roots that fail to resolve keep the lexical form only (stale allowRoots must
 * not abort the command; bwrap uses `--bind-try`).
 *
 * @param cwd - working directory (always a root; also the relative base for root paths)
 * @param config - sandbox config (allowRoots / homeWrite)
 * @returns absolute, deduped root paths (lexical + canonical variants)
 */
export async function resolveJailRoots(
  cwd: string,
  config: SandboxConfig | undefined,
): Promise<string[]> {
  const raw = [cwd, ...(config?.allowRoots ?? []), tmpdir()];
  if (process.platform !== 'win32') {
    // Tools that hardcode /tmp or /var/tmp (ignoring TMPDIR) must keep working
    // inside the jail; the canonical twins (/private/tmp, /private/var/tmp) are
    // emitted by the lexical+realpath loop below. Shared tmp writes stay
    // notReversed (2c) like tmpdir().
    raw.push('/tmp', '/var/tmp');
  }
  if (config?.homeWrite) {
    raw.push(homedir());
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string): void => {
    // Relative roots resolve against the run cwd, not the host process cwd.
    const s = resolve(cwd, candidate);
    if (!s || s === '.') return;
    const key = process.platform === 'win32' ? s.toLowerCase() : s;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const p of raw) {
    if (!p || p.trim() === '') continue;
    push(p);
    const canonical = await realpathSafe(resolve(cwd, p));
    if (canonical) push(canonical);
  }
  return out.length > 0 ? out : [resolve(cwd), resolve(tmpdir())];
}

/**
 * Canonicalize a path; null when it cannot be resolved (e.g. stale root).
 *
 * @param p - path to canonicalize
 * @returns realpath or null
 */
async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await realpath(resolve(p));
  } catch {
    // Missing/unreadable root: keep the lexical form (bind-try tolerates).
    return null;
  }
}

/**
 * Seatbelt profile: default allow, deny writes outside roots (stdio devices
 * excepted), deny network unless open, and deny common privilege-gaining
 * execs (1-B: privilege=dropped means ops-denied, uid unchanged).
 * Paths are quote-escaped for the sb DSL.
 */
export function buildSeatbeltProfile(
  roots: string[],
  network: 'open' | 'deny',
  extra?: { privilegeDenyExec?: string[] },
): string {
  const esc = (p: string): string => {
    // A newline would break out of the profile's string literal; refuse loudly
    // instead of silently deleting characters from a real path.
    if (p.includes('\n') || p.includes('\r')) {
      throw new Error(`seatbelt_path_invalid: path contains newline: ${JSON.stringify(p)}`);
    }
    // Quote-escape only. () and spaces are inert inside SBPL strings; stripping
    // them would point subpath rules at a different directory.
    return p.split('\\').join('\\\\').split('"').join('\\"');
  };
  const lines: string[] = ['(version 1)', '(allow default)'];
  if (network === 'deny') {
    lines.push('(deny network*)');
  }
  // 1-B: deny privilege-gaining helpers (path list is a best-effort allow-deny)
  for (const bin of extra?.privilegeDenyExec ?? DEFAULT_PRIVILEGE_DENY_EXEC) {
    lines.push(`(deny process-exec (literal "${esc(bin)}"))`);
  }
  lines.push('(deny file-write*)');
  for (const root of roots) {
    lines.push(`(allow file-write* (subpath "${esc(root)}"))`);
  }
  // stdio sinks must stay writable or basic tooling dies (git opens
  // /dev/null O_RDWR; shells redirect > /dev/null). /dev/fd covers dup'd
  // stdio paths (/dev/std{in,out,err} resolve there). Deliberately excludes
  // /dev/ptmx — no TTY allocation inside the jail.
  for (const dev of SEATBELT_DEVICE_WRITE_ALLOW) {
    lines.push(`(allow file-write* (literal "${esc(dev)}"))`);
  }
  lines.push('(allow file-write* (subpath "/dev/fd"))');
  return lines.join('\n') + '\n';
}

/**
 * POSIX stdio devices the jail must keep writable (macOS Seatbelt only;
 * bwrap supplies its own /dev). Character sinks cannot escape the jail.
 */
export const SEATBELT_DEVICE_WRITE_ALLOW = [
  '/dev/null',
  '/dev/zero',
  '/dev/tty',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
] as const;

/**
 * Privilege-gaining binaries, grouped by the capability they grant.
 *
 * This is a **cross-platform superset on purpose**, not a survey of the host
 * running it. Two reasons:
 *  - Seatbelt's `(literal ...)` matches a path string exactly; it does not
 *    normalise `/bin` vs `/usr/bin` or `sbin` vs `bin`. Distributions disagree
 *    on all of them (`su` is `/bin/su` on Debian, `/usr/bin/su` on macOS;
 *    `chroot` lives under `/usr/sbin` on macOS and additionally under
 *    `/usr/bin` / `/sbin` elsewhere). A missing spelling is an open door.
 *  - A deny line for a path that does not exist on this host never matches and
 *    costs nothing: no error, no runtime penalty. So the asymmetry is one-way —
 *    dead entries are free, missing entries are a hole.
 *
 * **Do not trim this list by inspecting one machine.** Every entry that looks
 * dead on macOS is live on some Linux distribution. New privilege-gaining
 * helpers (`pkexec`, `doas`, `run0`, `sudoedit`) are inherited by every jail
 * backend that shares this table, so the risk of a stale entry is the cheaper
 * side of the trade.
 */
export const PRIVILEGE_DENY_EXEC_GROUPS = {
  /** Full privilege switch to any user. */
  su: ['/bin/su', '/usr/bin/su', '/sbin/su'],
  /** Run a command as another user (sudo family). */
  sudo: ['/usr/bin/sudo', '/bin/sudo', '/usr/local/bin/sudo'],
  /** Edit a file as root through sudo. */
  sudoedit: ['/usr/bin/sudoedit', '/bin/sudoedit'],
  /** Polkit-mediated privilege escalation (desktop Linux). */
  pkexec: ['/usr/bin/pkexec', '/usr/local/bin/pkexec'],
  /** Minimal sudo replacement (OpenBSD, Alpine, some Linux). */
  doas: ['/usr/bin/doas', '/usr/local/bin/doas', '/usr/local/sbin/doas'],
  /** systemd-run privilege escalation (systemd >= 256). */
  run0: ['/usr/bin/run0'],
  /** Replace the session, bypassing the caller's credentials. */
  login: ['/usr/bin/login', '/bin/login'],
  /** Change the process group ID without a password. */
  newgrp: ['/usr/bin/newgrp', '/bin/newgrp', '/usr/bin/sg', '/bin/sg'],
  /** Start a process in a different root / namespace. */
  chroot: ['/usr/sbin/chroot', '/usr/bin/chroot', '/sbin/chroot', '/bin/chroot'],
  /** Read or modify the local directory service (macOS account DB). */
  dscl: ['/usr/bin/dscl', '/usr/sbin/dscl'],
} as const;

/**
 * Flat deny list in force unless the host overrides it.
 *
 * Derived from {@link PRIVILEGE_DENY_EXEC_GROUPS} so the grouped table stays
 * the single source of truth.
 */
export const DEFAULT_PRIVILEGE_DENY_EXEC: readonly string[] = Object.values(
  PRIVILEGE_DENY_EXEC_GROUPS,
).flat();

/**
 * One denial the jail produced, attributed to the mechanism that caused it.
 *
 * Two mechanisms print `Operation not permitted`, and they need **different**
 * advice:
 *  - `setuid-exec` — the OS refuses `execve` of a setuid binary inside
 *    Seatbelt. This is a kernel invariant: no profile edit can allow it. `ps`
 *    and `top` are setuid on macOS, which is why process listing dies there.
 *  - `privilege-deny` — an explicit `(deny process-exec ...)` line written by
 *    `buildSeatbeltProfile` for privileged helpers that are **not** setuid
 *    (`chroot`, `dscl`); the implicit setuid rule does not cover them.
 *
 * Write and network denials print the same EPERM wording but are left
 * unattributed on purpose — blaming them on exec would misdirect the caller.
 */
export interface SeatbeltExecDenial {
  /** Absolute path of the denied binary (PATH-resolved when reported bare). */
  target: string;
  /** Which mechanism refused the exec. */
  kind: 'setuid-exec' | 'privilege-deny';
  /** Factual one-liner for the isolation notes (what the jail did). */
  note: string;
  /** Actionable one-liner for the caller (what to do instead). */
  hint: string;
}

/** POSIX binary directories searched for a bare command name. */
const EXEC_LOOKUP_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'];

/** Setuid file mode bit. */
const SETUID_BIT = 0o4000;

/** Cap on distinct paths probed from one stderr, to bound `stat` cost. */
const EXEC_DENIAL_PROBE_LIMIT = 8;

/**
 * Locate a binary the shell named in an EPERM line.
 *
 * @param token - absolute path or bare command name from stderr
 * @param cwd - base for relative paths
 * @returns resolved absolute path with its mode, or null when nothing exists
 */
async function resolveExecutable(
  token: string,
  cwd: string,
): Promise<{ path: string; mode: number } | null> {
  const candidates = token.includes('/')
    ? [resolve(cwd, token)]
    : EXEC_LOOKUP_DIRS.map((dir) => join(dir, token));
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return { path: candidate, mode: info.mode };
    } catch {
      // Not in this directory — try the next candidate.
    }
  }
  return null;
}

/**
 * Extract the subject of each EPERM line.
 *
 * Shells disagree on where the path sits:
 *  - bash/sh: `bash: line 1: /usr/bin/top: Operation not permitted`
 *  - zsh:     `zsh:1: operation not permitted: /usr/bin/top`
 *
 * Deduped and capped: a pathological command can emit thousands of EPERM lines
 * and each candidate costs up to one `stat` per lookup dir.
 *
 * @param stderr - captured stderr
 * @returns distinct paths in emission order
 */
function extractDeniedTargets(stderr: string): string[] {
  const targets = new Set<string>();
  for (const raw of stderr.split('\n')) {
    if (targets.size >= EXEC_DENIAL_PROBE_LIMIT) break;
    const line = raw.trim();
    if (!/operation not permitted/i.test(line)) continue;
    const trailing = /(?:^|:)\s*([^\s:][^:\n]*?):\s*operation not permitted$/i.exec(line);
    if (trailing?.[1]) {
      targets.add(trailing[1].trim());
      continue;
    }
    const leading = /operation not permitted:\s*(\S.*)$/i.exec(line);
    if (leading?.[1]) targets.add(leading[1].trim());
  }
  return [...targets];
}

/**
 * Attribute an exec denial inside the macOS jail so the caller can correct
 * itself without re-discovering the sandbox's invariants by trial and error.
 *
 * @param args - captured stderr, run cwd, and the deny list written into the profile
 * @returns the first attributable denial, or null when EPERM had another cause
 */
export async function explainSeatbeltExecDenial(args: {
  stderr: string;
  cwd: string;
  /** Deny list actually emitted into the profile; defaults to the built-in one. */
  denyExec?: readonly string[];
}): Promise<SeatbeltExecDenial | null> {
  const deny = new Set(args.denyExec ?? DEFAULT_PRIVILEGE_DENY_EXEC);
  for (const token of extractDeniedTargets(args.stderr)) {
    const found = await resolveExecutable(token, args.cwd);
    if (!found) continue;
    if (deny.has(found.path)) {
      return {
        target: found.path,
        kind: 'privilege-deny',
        note: `exec_denied: ${found.path} is on the jail privilege deny list`,
        hint:
          `exec_denied: ${found.path} is on the sandbox privilege deny list (buildSeatbeltProfile) — ` +
          `privileged helpers are blocked by design inside the jail; do not retry, find an unprivileged route.`,
      };
    }
    if ((found.mode & SETUID_BIT) !== 0) {
      return {
        target: found.path,
        kind: 'setuid-exec',
        note: `exec_denied: ${found.path} is setuid; seatbelt refuses setuid exec (macOS invariant)`,
        hint:
          `exec_denied: ${found.path} is setuid and seatbelt refuses setuid exec — a macOS invariant, ` +
          `not configurable by the profile. Do not retry it; read the same state without exec'ing a ` +
          `setuid binary (e.g. pgrep -fl, lsof, vm_stat, or libproc proc_pidinfo).`,
      };
    }
  }
  return null;
}

function resolveShell(): { executable: string; args: string[]; kind: 'bash' | 'powershell' | 'cmd' } {
  if (process.platform === 'win32') {
    const comspec = process.env.COMSPEC || 'cmd.exe';
    return { executable: comspec, args: ['/d', '/s', '/c'], kind: 'cmd' };
  }
  return { executable: '/bin/sh', args: ['-c'], kind: 'bash' };
}

/**
 * Create the best process sandbox this host can offer.
 *
 * @param options - profile override / force env keys
 * @returns sandbox provider with probed isolation
 */
export async function createProcessSandbox(
  options?: ProcessSandboxOptions,
): Promise<ProcessSandbox> {
  const sandbox = new ProcessSandbox(options);
  await sandbox.probe();
  return sandbox;
}

/**
 * Does this profile meet the L4 process floor?
 *
 * @param profile - isolation profile
 * @returns assessment
 */
export { assessL4ProcessMinimum, supervisedSpawnProfile };
