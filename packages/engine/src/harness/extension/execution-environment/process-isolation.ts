/**
 * Process isolation capability contract (L4 process tier).
 *
 * A process jail is a capability profile, not a single OS API. Backends declare
 * what they actually enforce; consumers must trust the profile, never the name.
 * Public contract: `docs/process-isolation.md`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/** Kill semantics for the process tree */
export type ProcessTreeIsolation = 'supervised' | 'killable' | 'contained';

/** Filesystem confinement for writes */
export type FilesystemIsolation =
  | 'none'
  | 'cwd-pin'
  | 'write-jailed'
  | 'write-jailed-best-effort'
  | 'root-jailed';

/** Resource enforcement quality */
export type ResourceIsolation = 'none' | 'best-effort' | 'os-enforced';

/** Egress posture (not part of L4 process minimum) */
export type NetworkIsolation = 'open' | 'deny' | 'allowlist';

/**
 * Privilege of the child.
 * `dropped` = the jail **denies privilege-gaining OS operations**
 * (user namespace and/or Seatbelt `process-exec` denials for sudo/su/…).
 * This does **not** require a different uid — `notes` must record which
 * mechanism applies (`userns` vs `ops-denied`).
 */
export type PrivilegeIsolation = 'same' | 'dropped';

/** Whether host secrets can ride along in the environment */
export type EnvHygiene = 'inherit' | 'scrubbed';

/** Which backend produced the profile */
export type IsolationBackend =
  | 'supervised-spawn'
  | 'linux-bwrap'
  | 'mac-seatbelt'
  | 'win-job'
  | 'container';

/** Honest isolation report for one execute/probe */
export interface ProcessIsolationProfile {
  backend: IsolationBackend;
  processTree: ProcessTreeIsolation;
  filesystem: FilesystemIsolation;
  resources: ResourceIsolation;
  network: NetworkIsolation;
  privilege: PrivilegeIsolation;
  envHygiene: EnvHygiene;
  /** Free-form capability notes for operators (e.g. missing bwrap) */
  notes?: string[];
}

/**
 * L4 process minimum (network is intentionally NOT required).
 * `filesystem: write-jailed-best-effort` counts as meeting the floor (Windows).
 */
export const L4_PROCESS_MINIMUM = {
  processTree: ['killable', 'contained'] as ProcessTreeIsolation[],
  filesystem: [
    'write-jailed',
    'write-jailed-best-effort',
    'root-jailed',
  ] as FilesystemIsolation[],
  resources: ['best-effort', 'os-enforced'] as ResourceIsolation[],
  envHygiene: ['scrubbed'] as EnvHygiene[],
  privilege: ['dropped'] as PrivilegeIsolation[],
} as const;

export interface L4ProcessAssessment {
  ok: boolean;
  missing: Array<'processTree' | 'filesystem' | 'resources' | 'envHygiene' | 'privilege'>;
}

/** @param profile - isolation profile to assess */
export function assessL4ProcessMinimum(profile: ProcessIsolationProfile): L4ProcessAssessment {
  const missing: L4ProcessAssessment['missing'] = [];
  if (!L4_PROCESS_MINIMUM.processTree.includes(profile.processTree)) missing.push('processTree');
  if (!L4_PROCESS_MINIMUM.filesystem.includes(profile.filesystem)) missing.push('filesystem');
  if (!L4_PROCESS_MINIMUM.resources.includes(profile.resources)) missing.push('resources');
  if (profile.envHygiene !== 'scrubbed') missing.push('envHygiene');
  if (profile.privilege !== 'dropped') missing.push('privilege');
  return { ok: missing.length === 0, missing };
}

/**
 * Environment allowlist. Deny-by-default: only listed keys pass through.
 * Secrets (API keys, tokens) must never inherit via `...process.env`.
 *
 * @param extra - explicit env for this run (still filtered against allowlist unless force)
 * @param options - allow forcing extra keys (host responsibility)
 * @returns scrubbed environment
 */
export function scrubEnv(
  extra?: Record<string, string>,
  options?: { forceKeys?: string[] },
): Record<string, string> {
  const allow = new Set(
    [
      'PATH',
      'Path',
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
      'PWD',
      'OLDPWD',
      'NODE_ENV',
    ].map((k) => k.toLowerCase()),
  );
  for (const k of options?.forceKeys ?? []) allow.add(k.toLowerCase());

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (allow.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Best-effort process-tree kill. POSIX uses the process group; Windows uses taskkill /T.
 *
 * @param child - spawned child
 * @returns whether a kill signal was issued
 */
export function killProcessTree(child: ChildProcess): boolean {
  const pid = child.pid;
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      return true;
    }
    // Negative pid = process group (child spawned with detached/setpgid)
    try {
      process.kill(-pid, 'SIGKILL');
      return true;
    } catch {
      child.kill('SIGKILL');
      return true;
    }
  } catch {
    return false;
  }
}

async function canExecute(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function which(cmd: string): Promise<string | null> {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (await canExecute(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Probe the current host for the strongest available process backend.
 * Never invents isolation: if nothing is available, returns supervised-spawn.
 *
 * @returns isolation profile this process can offer
 */
let cachedProbe: ProcessIsolationProfile | null = null;

/** Reset probe cache (tests). */
export function resetProcessIsolationProbeCache(): void {
  cachedProbe = null;
}

/**
 * One-shot bwrap usability smoke (user namespaces may be disabled in containers).
 *
 * @returns true when bwrap can actually spawn a jailed no-op
 */
async function bwrapUsable(bwrap: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bwrap, ['--die-with-parent', '--unshare-all', '--ro-bind', '/', '/', '--', 'true'], {
      stdio: 'ignore',
      timeout: 2000,
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * One-shot Seatbelt usability smoke (`sandbox_apply` may be denied inside
 * another sandbox). Probe and execute must agree: when no profile can be
 * applied, the honest backend is supervised spawn from the start — never a
 * wrapper run that then has to "recover".
 *
 * @param sandboxExec - resolved path to sandbox-exec
 * @returns true when sandbox-exec can actually apply a profile
 */
async function sandboxExecUsable(sandboxExec: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(sandboxExec, ['-p', '(version 1)(allow default)', '--', '/usr/bin/true'], {
      stdio: 'pipe',
      timeout: 2000,
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export async function probeProcessIsolation(): Promise<ProcessIsolationProfile> {
  if (cachedProbe) return cachedProbe;
  const notes: string[] = [];

  if (process.platform === 'linux') {
    const bwrap = await which('bwrap');
    if (bwrap) {
      if (await bwrapUsable(bwrap)) {
        cachedProbe = {
          backend: 'linux-bwrap',
          processTree: 'contained',
          filesystem: 'root-jailed',
          resources: 'best-effort',
          // Default jail posture (D4-c); execute() honors SandboxConfig.networkPolicy
          network: 'deny',
          privilege: 'dropped',
          envHygiene: 'scrubbed',
          notes: [`bwrap=${bwrap}`, 'privilege=dropped (userns)'],
        };
        return cachedProbe;
      }
      notes.push(`bwrap=${bwrap} present but unusable (userns denied?); no process jail`);
      cachedProbe = {
        backend: 'supervised-spawn',
        processTree: 'killable',
        filesystem: 'cwd-pin',
        resources: 'best-effort',
        network: 'open',
        privilege: 'same',
        envHygiene: 'scrubbed',
        notes,
      };
      return cachedProbe;
    }
    notes.push('linux: bwrap not found; no process jail');
    cachedProbe = {
      backend: 'supervised-spawn',
      processTree: 'killable',
      filesystem: 'cwd-pin',
      resources: 'best-effort',
      network: 'open',
      privilege: 'same',
      envHygiene: 'scrubbed',
      notes,
    };
    return cachedProbe;
  }

  if (process.platform === 'darwin') {
    const sandboxExec = await which('sandbox-exec');
    if (sandboxExec && (await sandboxExecUsable(sandboxExec))) {
      // D3-b+: we generate a Seatbelt profile at execute time (allowRoots + network).
      // write-jailed is therefore honest without OCTOPI_SB_PROFILE.
      cachedProbe = {
        backend: 'mac-seatbelt',
        processTree: 'killable',
        filesystem: 'write-jailed',
        resources: 'best-effort',
        network: 'deny',
        privilege: 'dropped',
        envHygiene: 'scrubbed',
        notes: [
          `sandbox-exec=${sandboxExec}`,
          'privilege=dropped (ops-denied; uid unchanged)',
        ],
      };
      return cachedProbe;
    }
    if (sandboxExec) {
      notes.push(
        `sandbox-exec=${sandboxExec} present but sandbox_apply denied (nested sandbox?); no write jail`,
      );
    } else {
      notes.push('darwin: sandbox-exec not found; no write jail');
    }
    cachedProbe = {
      backend: 'supervised-spawn',
      processTree: 'killable',
      filesystem: 'cwd-pin',
      resources: 'best-effort',
      network: 'open',
      privilege: 'same',
      envHygiene: 'scrubbed',
      notes,
    };
    return cachedProbe;
  }

  if (process.platform === 'win32') {
    // Job Object / restricted token need a native helper (future). Pure Node = supervised.
    notes.push(
      'win32: Job Object + restricted token not bundled; processTree via taskkill /T only',
    );
    cachedProbe = {
      backend: 'supervised-spawn',
      processTree: 'killable',
      filesystem: 'cwd-pin',
      resources: 'best-effort',
      network: 'open',
      privilege: 'same',
      envHygiene: 'scrubbed',
      notes,
    };
    return cachedProbe;
  }

  notes.push(`${process.platform}: generic supervised spawn only`);
  cachedProbe = {
    backend: 'supervised-spawn',
    processTree: 'killable',
    filesystem: 'cwd-pin',
    resources: 'best-effort',
    network: 'open',
    privilege: 'same',
    envHygiene: 'scrubbed',
    notes,
  };
  return cachedProbe;
}

/**
 * Synthetic supervised profile (L1 only). Used when no probe has run yet.
 *
 * @returns baseline profile for supervised spawn
 */
export function supervisedSpawnProfile(): ProcessIsolationProfile {
  return {
    backend: 'supervised-spawn',
    processTree: 'killable',
    filesystem: 'cwd-pin',
    resources: 'best-effort',
    network: 'open',
    privilege: 'same',
    envHygiene: 'scrubbed',
  };
}
