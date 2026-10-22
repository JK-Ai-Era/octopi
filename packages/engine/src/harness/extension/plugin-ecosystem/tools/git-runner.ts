/**
 * Shared safe-git runner — the single hardened `git` execution path used by the
 * git_* dedicated tools and the UI git-status snapshot.
 *
 * Not a shell: fixed argv allowlist (never a command string). Isolation here:
 * nonexistent `core.hooksPath`, `--no-ext-diff`, command-line `-c` overrides
 * (diff.external/gpg/pager/ssh), `GIT_CONFIG_GLOBAL/SYSTEM` at NUL//dev/null,
 * and filter.* pinned to `cat`. Mutating callers add their own flags (e.g.
 * `--no-verify`/`--no-gpg-sign` on commit, in git-tools.ts).
 * User `-c`/alias flags are rejected. `--no-optional-locks` keeps polling
 * readers from fighting real git operations over the index lock.
 */
import type { ToolExecutionContext } from '@octopi-agent/core/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requireExecutable,
  runAllowlistedArgv,
  type AllowlistedRunResult,
} from './allowlisted-run.js';

/**
 * Nonexistent hooks dir (empty core.hooksPath is version-fragile: some gits
 * treat it as `./` and still run cwd hooks).
 */
function noHooksDir(): string {
  return join(tmpdir(), 'octopi-nohooks');
}

/**
 * Fixed git safety prefix. Command-line `-c` outranks local `.git/config`, so
 * these neutralize repo-config RCE vectors (diff.external, gpg.program, …).
 * `--no-optional-locks` avoids index lock fights. Never pass user `-c`.
 */
function gitSafePrefix(): string[] {
  const hooks = noHooksDir();
  return [
    '--no-optional-locks',
    '-c', `core.hooksPath=${hooks}`,
    '-c', 'core.fsmonitor=',
    '-c', 'core.pager=cat',
    '-c', 'diff.external=',
    '-c', 'diff.tool=',
    '-c', 'merge.tool=',
    '-c', 'merge.prompt=false',
    '-c', 'gpg.program=true',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.sshCommand=',
    '-c', 'core.askpass=',
    '-c', 'credential.helper=',
    '-c', 'core.attributesFile=',
    '-c', 'core.excludesFile=',
  ];
}

/**
 * Isolate global/system gitconfig. Local `.git/config` is still read; dangerous
 * keys there are overridden by the `-c` prefix above (command line wins).
 * On Windows use `NUL`, elsewhere `/dev/null` — a missing file is also fine.
 */
function gitIsolationEnv(): Record<string, string> {
  const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: nullPath,
    GIT_CONFIG_GLOBAL: nullPath,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  };
}

/**
 * Discover filter.* drivers from repo/user config and pin them to `cat`.
 * Command-line `-c` outranks local `.git/config`, so a malicious
 * .gitattributes cannot run clean/smudge/process during `git add` — nor while
 * `git status` re-hashes dirty stat entries through the clean filter.
 */
async function filterNeutralizers(
  context: ToolExecutionContext | undefined,
  cwd: string,
): Promise<string[]> {
  const git = requireExecutable('git');
  const res = await runAllowlistedArgv({
    executable: git,
    args: [...gitSafePrefix(), 'config', '--name-only', '--get-regexp', '^filter\\.'],
    cwd,
    context,
    env: gitIsolationEnv(),
    journal: false,
  });
  if (res.exitCode !== 0) return [];
  const names = new Set<string>();
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = /^filter\.(.+)\.(clean|smudge|process)$/.exec(line.trim());
    if (m && /^[A-Za-z0-9._-]+$/.test(m[1]!)) names.add(m[1]!);
  }
  const out: string[] = [];
  for (const n of names) {
    out.push(
      '-c', `filter.${n}.clean=cat`,
      '-c', `filter.${n}.smudge=cat`,
      '-c', `filter.${n}.process=cat`,
    );
  }
  return out;
}

export interface RunGitOptions {
  timeoutMs?: number;
  /** Journal write effects via shell-journal (default true for mutating tools) */
  journal?: boolean;
  /** Apply the tool output gate (default true). Structured consumers pass false. */
  applyOutputGate?: boolean;
}

/**
 * Run one fixed git argv vector through the hardened runner.
 *
 * @param context - tool context (optional; gates journalling/limits)
 * @param cwd - repository directory (caller has resolved/contained it)
 * @param args - git argv after the safety prefix
 * @param options - timeout / journal / output-gate controls
 * @returns capped stdout/stderr + honest isolation
 */
export async function runGit(
  context: ToolExecutionContext | undefined,
  cwd: string,
  args: string[],
  options?: RunGitOptions,
): Promise<AllowlistedRunResult> {
  const git = requireExecutable('git');
  return runAllowlistedArgv({
    executable: git,
    args: [...gitSafePrefix(), ...(await filterNeutralizers(context, cwd)), ...args],
    cwd,
    context,
    env: gitIsolationEnv(),
    timeoutMs: options?.timeoutMs ?? 60_000,
    journal: options?.journal ?? false,
    applyOutputGate: options?.applyOutputGate,
  });
}
