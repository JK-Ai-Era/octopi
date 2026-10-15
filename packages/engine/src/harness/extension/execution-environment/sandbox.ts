/**
 * Process sandbox — supervised spawn (L1) + optional OS jails (L4 process).
 *
 * Never claims isolation it does not enforce. `SupervisedSpawn` is process-tree
 * kill + env scrub + limits only; real jails are `linux-bwrap` / `mac-seatbelt`.
 * Public contract: `docs/process-isolation.md`.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
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
    const timeoutMs = config?.limits?.timeoutMs ?? 30_000;
    const maxOutputBytes = config?.limits?.maxOutputBytes ?? 10 * 1024 * 1024;

    // Jail backends wrap the spawn; fall back to supervised spawn.
    if (profile.backend === 'linux-bwrap' && process.platform === 'linux') {
      return this.runBwrap(file, args, config, profile, { cwd, env, timeoutMs, maxOutputBytes });
    }
    if (profile.backend === 'mac-seatbelt' && process.platform === 'darwin') {
      return this.runSeatbelt(file, args, config, profile, { cwd, env, timeoutMs, maxOutputBytes });
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

      proc.on('close', (exitCode) => {
        const usage = this.usage(start, stdout, stderr);
        finish({
          exitCode: exitCode ?? (terminated ? -1 : 0),
          stdout,
          stderr,
          terminated,
          terminateReason: terminated ? terminateReason : undefined,
          usage,
          isolation: profile,
        });
      });

      proc.on('error', (err) => {
        const usage = this.usage(start, stdout, stderr);
        finish({
          exitCode: -1,
          stdout,
          stderr: err.message,
          terminated: true,
          terminateReason: `Process error: ${err.message}`,
          usage,
          isolation: profile,
        });
      });
    });
  }

  private runBwrap(
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
    // Minimal bubblewrap: ro system, bind cwd, die-with-parent, scrubbed env already applied.
    const bind = opts.cwd;
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
      '--bind',
      bind,
      bind,
      '--chdir',
      opts.cwd,
      '--',
      file,
      ...args,
    ];
    return this.runSupervised('bwrap', bwrapArgs, config, profile, opts);
  }

  private runSeatbelt(
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
    // Seatbelt: allow default, deny writes outside cwd. Profile is generated inline.
    const sb = `(version 1)\n(allow default)\n(deny file-write* (subpath "${opts.cwd}"))\n(allow file-write* (subpath "${opts.cwd}"))\n`;
    // sandbox-exec -f <(profile) is awkward; use /tmp-free approach via -f with a here-doc is not portable.
    // Pass via sandbox-exec's -n? Actually: `sandbox-exec -f profile.sb -- cmd` needs a file.
    // Use `sandbox-exec -f -` is not supported. Write is avoided: use seatbelt string via posix spawn of
    // a generated argv with `sandbox-exec` and profile on stdin is unsupported — fall back to
    // supervised + note, unless OCTOPI_SB_PROFILE path is set by the host.
    const profilePath = process.env.OCTOPI_SB_PROFILE;
    if (!profilePath) {
      const degraded: ProcessIsolationProfile = {
        ...profile,
        filesystem: 'cwd-pin',
        notes: [...(profile.notes ?? []), 'seatbelt profile file not provided (OCTOPI_SB_PROFILE)'],
      };
      return this.runSupervised(file, args, config, degraded, opts);
    }
    void sb;
    return this.runSupervised(
      'sandbox-exec',
      ['-f', profilePath, '--', file, ...args],
      config,
      profile,
      opts,
    );
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
