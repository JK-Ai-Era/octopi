/**
 * Process sandbox — supervised spawn (L1) + optional OS jails (L4 process).
 *
 * Never claims isolation it does not enforce. `SupervisedSpawn` is process-tree
 * kill + env scrub + limits only; real jails are `linux-bwrap` / `mac-seatbelt`.
 * Public contract: `docs/process-isolation.md`.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
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
    return new Promise((resolve) => {
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
          finish({
            exitCode: -1,
            stdout,
            stderr: err.message,
            terminated: true,
            terminateReason: `untrusted_jail_failed: ${err.message}`,
            usage,
            isolation: {
              ...profile,
              filesystem: 'cwd-pin',
              privilege: 'same',
              notes: [...(profile.notes ?? []), `jail spawn failed: ${err.message}`],
            },
          });
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
    const roots = resolveJailRoots(opts.cwd, config);
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
    // bwrap spawn OK but jail setup failed (e.g. userns disabled) — D7 fork
    if (result.exitCode !== 0 && isJailWrapperSetupFailure(result)) {
      return this.jailSetupFailed(
        file,
        args,
        config,
        profile,
        opts,
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
    const roots = resolveJailRoots(opts.cwd, config);
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
      return await this.runSupervised(
        'sandbox-exec',
        ['-f', profilePath, '--', file, ...args],
        config,
        applied,
        opts,
      );
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
 * Heuristic: wrapper failed to establish the jail (not the user command).
 * bwrap typically exits 2 with unshare/EPERM messages and empty stdout.
 */
function isJailWrapperSetupFailure(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): boolean {
  if (result.stdout.length > 0) return false;
  const err = result.stderr.toLowerCase();
  return (
    err.includes('unshare') ||
    err.includes('operation not permitted') ||
    (err.includes('no such file or directory') && err.includes('bwrap')) ||
    err.includes('newuidmap') ||
    err.includes('setting up uid map')
  );
}

/** Extra note when caller asked for allowlist (interface-only). */
function networkPolicyNote(config: SandboxConfig | undefined, applied: 'open' | 'deny'): string {
  const requested = config?.networkPolicy;
  if (requested === 'allowlist') {
    return `network=${applied} (allowlist requested; interface-only, enforced as deny)`;
  }
  return `network=${applied}`;
}

/** Jail roots: allowRoots ∪ {cwd}, absolute, deduped. */
/**
 * Jail write mounts (2a/2b): allowRoots ∪ cwd ∪ tmpdir (always) ∪ home
 * when `config.homeWrite` (project/host). tmp is not journaled (2c).
 */
function resolveJailRoots(cwd: string, config: SandboxConfig | undefined): string[] {
  const raw = [cwd, ...(config?.allowRoots ?? []), tmpdir()];
  if (config?.homeWrite) {
    raw.push(homedir());
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    const s = resolve(p?.trim() ?? '');
    if (!s || s === '.') continue;
    const key = process.platform === 'win32' ? s.toLowerCase() : s;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.length > 0 ? out : [resolve(cwd), resolve(tmpdir())];
}

/**
 * Seatbelt profile: default allow, deny writes outside allowRoots.
 * Network deny unless policy is open. Paths are quote-escaped for the sb DSL.
 */
/**
 * Seatbelt profile: default allow, deny writes outside roots, deny network,
 * and deny common privilege-gaining execs (1-B: privilege=dropped means
 * ops-denied, uid unchanged).
 */
export function buildSeatbeltProfile(
  roots: string[],
  network: 'open' | 'deny',
  extra?: { privilegeDenyExec?: string[] },
): string {
  const esc = (p: string) =>
    p.replace(/\\/g, '/').replace(/"/g, '\\"').replace(/[\r\n()]/g, '');
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
  return lines.join('\n') + '\n';
}

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
