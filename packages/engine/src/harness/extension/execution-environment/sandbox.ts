/**
 * Process sandbox — supervised spawn (L1) + optional OS jails (L4 process).
 *
 * Never claims isolation it does not enforce. `SupervisedSpawn` is process-tree
 * kill + env scrub + limits only; real jails are `linux-bwrap` / `mac-seatbelt`.
 * Public contract: `docs/process-isolation.md`.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
          `untrusted_jail_failed: no process jail backend (probe=${profile.backend}); refuse unsandboxed execute`,
        ),
      );
    }
    return this.runSupervised(file, args, config, profile, { cwd, env, timeoutMs, maxOutputBytes });
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
        if (stdout.length + data.length > opts.maxOutputBytes) {
          kill('Output size limit exceeded');
          return;
        }
        stdout += data.toString('utf8');
      });

      proc.stderr?.on('data', (data: Buffer) => {
        if (stderr.length + data.length > opts.maxOutputBytes) {
          kill('Output size limit exceeded');
          return;
        }
        stderr += data.toString('utf8');
      });

      const timer = setTimeout(() => {
        kill(`Execution timeout (${opts.timeoutMs}ms)`);
      }, opts.timeoutMs);

      proc.on('close', (exitCode, signal) => {
        const usage = this.usage(start, stdout, stderr);
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
        const usage = this.usage(start, stdout, stderr);
        const isJailWrapper =
          profile.backend === 'linux-bwrap' || profile.backend === 'mac-seatbelt';
        if (config?.requireJail && isJailWrapper) {
          fail(
            new Error(
              `untrusted_jail_failed: jail spawn failed: ${err.message} (requireJail=true; refuse unsandboxed execute)`,
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
        if (isJailWrapper) config?.noteSecurityDegraded?.(`jail_spawn_failed: ${err.message}`);
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
    if (!profilePath) {
      generatedPath = join(
        tmpdir(),
        `octopi-sb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sb`,
      );
      try {
        await writeFile(generatedPath, buildSeatbeltProfile(roots, network), { encoding: 'utf8', mode: 0o600 });
        profilePath = generatedPath;
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
      return result;
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
        new Error(`untrusted_jail_failed: ${reason} (requireJail=true; refuse unsandboxed execute)`),
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
    config?.noteSecurityDegraded?.(`jail_setup_failed: ${reason}`);
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
        new Error(`untrusted_jail_failed: ${reason} (requireJail=true; refuse unsandboxed execute)`),
      );
    }
    config?.noteSecurityDegraded?.(`jail_setup_failed: ${reason}`);
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

  private usage(start: number, stdout: string, stderr: string): ResourceUsage {
    return {
      elapsedMs: Date.now() - start,
      peakMemoryBytes: -1,
      cpuTimeMs: -1,
      outputBytes: Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8'),
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

/** Common privilege-gaining binaries denied inside Seatbelt (1-B). */
const DEFAULT_PRIVILEGE_DENY_EXEC = [
  '/usr/bin/sudo',
  '/bin/su',
  '/usr/bin/su',
  '/usr/sbin/chroot',
  '/usr/bin/login',
  '/usr/bin/newgrp',
  '/usr/bin/dscl',
];

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
