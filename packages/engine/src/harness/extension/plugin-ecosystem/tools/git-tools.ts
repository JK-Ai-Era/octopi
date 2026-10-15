/**
 * git_* dedicated tools 鈥?local VCS porcelain without a shell.
 *
 * Spawn `git` with a fixed argv allowlist (never a command string). Isolation:
 * nonexistent `core.hooksPath`, `--no-verify`/`--no-gpg-sign` on commit,
 * `--no-ext-diff`, command-line `-c` overrides (diff.external/gpg/pager/ssh),
 * `GIT_CONFIG_GLOBAL/SYSTEM` at NUL//dev/null, and filter.* pinned to `cat`.
 * User `-c`/alias flags are rejected. Capability tag is `vcs` (allowed on reduced surface) so
 * workspace/untrusted agents can still status/diff/commit without `shell`.
 */
import type { RegisteredTool, ToolExecutionContext } from '@octopi-agent/core/types.js';
import { gateEffect } from '../../execution-environment/effect-policy.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveToolPath, isUnderAttachmentRoot, isUnderSessionUndoRoot } from './platform.js';
import {
  assertSafeRef,
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

function resolveCwd(context: ToolExecutionContext | undefined, raw?: string): string {
  const cwd = raw ?? context?.cwd ?? process.cwd();
  const abs = resolveToolPath(cwd, context?.cwd, {
    allowRoots: context?.pathRoots,
    containment: context?.pathContainment,
  });
  if (isUnderAttachmentRoot(abs, context?.attachmentRoots)) {
    throw new Error('session attachments are read-only; cannot run git under attachments root');
  }
  if (isUnderSessionUndoRoot(abs, context?.undoRoots)) {
    throw new Error('session undo ledger is protected; cannot run git under sessions undo dir');
  }
  return abs;
}

function assertPathSafe(
  raw: string,
  context: ToolExecutionContext | undefined,
  label: string,
): string {
  const abs = resolveToolPath(raw, context?.cwd, {
    allowRoots: context?.pathRoots,
    containment: context?.pathContainment,
  });
  if (isUnderAttachmentRoot(abs, context?.attachmentRoots)) {
    throw new Error(`session attachments are read-only; cannot ${label} under attachments root`);
  }
  if (isUnderSessionUndoRoot(abs, context?.undoRoots)) {
    throw new Error(`session undo ledger is protected; cannot ${label} under sessions undo dir`);
  }
﻿  return abs;
}

/**
 * Pathspec for git porcelain.
 *
 * Simple paths are L2-resolved (absolute + roots-checked). Glob/magic specs
 * (src/*.ts, :(exclude)...) must stay relative - absolute-resolving them
 * turns the pattern into a literal path and silently matches nothing. Those
 * pass through after a .. / absolute / NUL ban; cwd is already L2-contained.
 */
function toGitPathspec(
  raw: string,
  context: ToolExecutionContext | undefined,
  label: string,
): string {
  const isMagic = raw.startsWith(':(') || /[*?\[]/.test(raw);
  if (!isMagic) {
    return assertPathSafe(raw, context, label);
  }
  if (
    raw.startsWith('/') ||
    raw.startsWith('\\\\') ||
    (process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(raw))
  ) {
    throw new Error(
      `pathspec_glob_unsupported: absolute glob "${raw}" is not supported; use a relative glob (e.g. src/*.ts)`,
    );
  }
  if (raw.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error(
      `pathspec_glob_forbidden: ".." is not allowed in glob pathspec "${raw}"`,
    );
  }
  if (raw.includes('\0')) {
    throw new Error(`pathspec_invalid: "${raw}" contains a NUL byte`);
  }
  return raw;
}

﻿/**
 * Discover filter.* drivers from repo/user config and pin them to `cat`.
 * Command-line `-c` outranks local `.git/config`, so a malicious
 * .gitattributes cannot run clean/smudge/process during `git add`.
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

async function runGit(

  context: ToolExecutionContext | undefined,
  cwd: string,
  args: string[],
  options?: { timeoutMs?: number; journal?: boolean },
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
  });
}

function toText(result: AllowlistedRunResult): Record<string, unknown> {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    terminated: result.terminated,
    terminateReason: result.terminateReason,
    isolation: result.isolation,
  };
}

/** git_status 鈥?porcelain working tree status */
export function createGitStatusTool(): RegisteredTool {
  return {
    definition: {
      name: 'git_status',
      capabilities: ['vcs', 'fs-read'],
      description:
        'Show git working tree status (porcelain v1 + branch header). Prefer this over shell git status. Read-only.',
      parameters: {
        cwd: { type: 'string', description: 'Repository path (defaults to workspace cwd)' },
        paths: {
          type: 'array',
          description: 'Optional pathspecs to limit the status',
          items: { type: 'string', description: 'Path or pathspec' },
        },
      },
    },
    handler: async (args, context) => {
      const cwd = resolveCwd(context, args.cwd as string | undefined);
      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      const pathArgs = paths.length > 0 ? ['--', ...paths.map((p) => toGitPathspec(p, context, 'status'))] : [];
      const result = await runGit(context, cwd, [
        'status',
        '--porcelain=v1',
        '--branch',
        '--untracked-files=all',
        ...pathArgs,
      ]);
      return { ...toText(result), cwd };
    },
  };
}

/** git_diff 鈥?unstaged / staged / vs-ref diff */
export function createGitDiffTool(): RegisteredTool {
  return {
    definition: {
      name: 'git_diff',
      capabilities: ['vcs', 'fs-read'],
      description:
        'Show a git diff. mode: unstaged (default) | staged | commit (vs a revision). Prefer this over shell git diff. Read-only.',
      parameters: {
        cwd: { type: 'string', description: 'Repository path' },
        mode: {
          type: 'string',
          description: 'Diff mode',
          enum: ['unstaged', 'staged', 'commit'],
          default: 'unstaged',
        },
        revision: {
          type: 'string',
          description: 'Revision for mode=commit (e.g. HEAD~1, main)',
        },
        stat: { type: 'boolean', description: 'Show diffstat instead of full patch' },
        paths: {
          type: 'array',
          description: 'Optional pathspecs',
          items: { type: 'string', description: 'Path or pathspec' },
        },
      },
    },
    handler: async (args, context) => {
      const cwd = resolveCwd(context, args.cwd as string | undefined);
      const modeRaw = (args.mode as string) ?? 'unstaged';
      if (!['unstaged', 'staged', 'commit'].includes(modeRaw)) {
        throw new Error(`git_diff: unsupported mode "${modeRaw}" (use unstaged|staged|commit)`);
      }
      const mode = modeRaw;
      const gitArgs = ['diff', '--no-color', '--no-ext-diff'];
      if (mode === 'staged') gitArgs.push('--cached');
      if (mode === 'commit') {
        const rev = assertSafeRef(String(args.revision ?? 'HEAD'), 'revision');
        gitArgs.push(rev);
      }
      if (args.stat === true) gitArgs.push('--stat');
      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      if (paths.length > 0) {
        gitArgs.push('--', ...paths.map((p) => toGitPathspec(p, context, 'diff')));
      }
      const result = await runGit(context, cwd, gitArgs, { timeoutMs: 120_000 });
      return { ...toText(result), cwd, mode };
    },
  };
}

/** git_log 鈥?commit history */
export function createGitLogTool(): RegisteredTool {
  return {
    definition: {
      name: 'git_log',
      capabilities: ['vcs', 'fs-read'],
      description: 'Show commit history (oneline by default). Prefer this over shell git log. Read-only.',
      parameters: {
        cwd: { type: 'string', description: 'Repository path' },
        limit: {
          type: 'number',
          description: 'Max commits (default 20, max 200)',
          minimum: 1,
          maximum: 200,
        },
        revision: { type: 'string', description: 'Starting revision (default HEAD)' },
        oneline: { type: 'boolean', description: 'Compact one-line format (default true)' },
        paths: {
          type: 'array',
          description: 'Optional pathspecs',
          items: { type: 'string', description: 'Path or pathspec' },
        },
      },
    },
    handler: async (args, context) => {
      const cwd = resolveCwd(context, args.cwd as string | undefined);
      const rawLimit = Number(args.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 20;
      const rev = assertSafeRef(String(args.revision ?? 'HEAD'), 'revision');
      const oneline = args.oneline !== false;
      const gitArgs = ['log', '--no-ext-diff', `--max-count=${limit}`];
      if (oneline) gitArgs.push('--oneline', '--decorate');
      gitArgs.push(rev);
      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      if (paths.length > 0) {
        gitArgs.push('--', ...paths.map((p) => toGitPathspec(p, context, 'log')));
      }
      const result = await runGit(context, cwd, gitArgs);
      return { ...toText(result), cwd, limit, revision: rev };
    },
  };
}

/** git_show 鈥?show a commit / tree / blob */
export function createGitShowTool(): RegisteredTool {
  return {
    definition: {
      name: 'git_show',
      capabilities: ['vcs', 'fs-read'],
      description: 'Show a git object (commit, tag, or tree). Read-only.',
      parameters: {
        cwd: { type: 'string', description: 'Repository path' },
        revision: { type: 'string', description: 'Revision to show (default HEAD)', default: 'HEAD' },
        stat: { type: 'boolean', description: 'Show diffstat instead of full patch' },
      },
    },
    handler: async (args, context) => {
      const cwd = resolveCwd(context, args.cwd as string | undefined);
      const rev = assertSafeRef(String(args.revision ?? 'HEAD'), 'revision');
      const gitArgs = ['show', '--no-color', '--no-ext-diff'];
      if (args.stat === true) gitArgs.push('--stat');
      gitArgs.push(rev);
      const result = await runGit(context, cwd, gitArgs, { timeoutMs: 120_000 });
      return { ...toText(result), cwd, revision: rev };
    },
  };
}

/** git_commit 鈥?add paths + commit (hooks disabled) */
export function createGitCommitTool(): RegisteredTool {
  return {
    definition: {
      name: 'git_commit',
      capabilities: ['vcs', 'fs-write'],
      description:
        'Stage paths and create a commit. Hooks and gpg signing disabled (--no-verify --no-gpg-sign); filters neutralized. Prefer this over shell git commit.',
      parameters: {
        cwd: { type: 'string', description: 'Repository path' },
        message: { type: 'string', description: 'Commit message', required: true },
        paths: {
          type: 'array',
          description: 'Paths to stage and commit (omit to commit already-staged changes)',
          items: { type: 'string', description: 'Path' },
        },
        all: {
          type: 'boolean',
          description: 'Stage all tracked modifications (git add -A on given paths or repo)',
        },
        amend: { type: 'boolean', description: 'Amend the previous commit' },
      },
    },
    handler: async (args, context) => {
      const cwd = resolveCwd(context, args.cwd as string | undefined);
      const message = String(args.message ?? '').trim();
      if (!message) throw new Error('git_commit: message is required');

      await gateEffect(
        {
          kind: 'vcs',
          operation: 'commit',
          cwd,
          description: `git commit: ${message.slice(0, 80)}`,
        },
        {
          effects: context?.effectChannel ?? 'engine',
          confirmEffect: context?.confirmEffect,
          sessionId: context?.sessionId,
          agentId: context?.agentId,
        },
      );

      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      const resolvedPaths = paths.map((p) => toGitPathspec(p, context, 'commit'));
      const useAll = args.all === true;

      if (resolvedPaths.length > 0 || useAll) {
        const addArgs = ['add'];
        if (useAll) addArgs.push('-A');
        if (resolvedPaths.length > 0) addArgs.push('--', ...resolvedPaths);
        const addResult = await runGit(context, cwd, addArgs, { journal: true });
        if (addResult.exitCode !== 0) {
          return { ...toText(addResult), stage: 'add', cwd };
        }
      }

      const commitArgs = ['commit', '--no-verify', '--no-gpg-sign', '-m', message];
      if (args.amend === true) commitArgs.push('--amend');
      if (resolvedPaths.length > 0) {
        // Limit the commit to the given paths (working-tree state).
        commitArgs.push('--', ...resolvedPaths);
      }
      const result = await runGit(context, cwd, commitArgs, {
        journal: true,
        timeoutMs: 60_000,
      });
      return { ...toText(result), stage: 'commit', cwd, message };
    },
  };
}

/** git_branch 鈥?list / create / switch / delete */
export function createGitBranchTool(): RegisteredTool {
  return {
    definition: {
      name: 'git_branch',
      capabilities: ['vcs', 'fs-write'],
      description:
        'List, create, switch, or delete local branches. action: list (default) | create | switch | delete.',
      parameters: {
        cwd: { type: 'string', description: 'Repository path' },
        action: {
          type: 'string',
          description: 'Branch action',
          enum: ['list', 'create', 'switch', 'delete'],
          default: 'list',
        },
        name: {
          type: 'string',
          description: 'Branch name (required for create/switch/delete)',
        },
        startPoint: {
          type: 'string',
          description: 'Start point for create (e.g. HEAD~1)',
        },
      },
    },
    handler: async (args, context) => {
      const cwd = resolveCwd(context, args.cwd as string | undefined);
      const action = (args.action as string) ?? 'list';
      const name = args.name !== undefined ? assertSafeRef(String(args.name), 'branch') : undefined;

      if (action === 'list') {
        const result = await runGit(context, cwd, ['branch', '--list', '--verbose']);
        return { ...toText(result), cwd, action };
      }
      if (!name) throw new Error(`git_branch: name is required for action=${action}`);

      await gateEffect(
        {
          kind: 'vcs',
          operation: `branch.${action}`,
          cwd,
          description: `git branch ${action} ${name}`,
        },
        {
          effects: context?.effectChannel ?? 'engine',
          confirmEffect: context?.confirmEffect,
          sessionId: context?.sessionId,
          agentId: context?.agentId,
        },
      );

      let gitArgs: string[];
      if (action === 'create') {
        gitArgs = ['branch', name];
        if (args.startPoint !== undefined) {
          gitArgs.push(assertSafeRef(String(args.startPoint), 'startPoint'));
        }
      } else if (action === 'switch') {
        gitArgs = ['switch', name];
      } else if (action === 'delete') {
        gitArgs = ['branch', '-d', name];
      } else {
        throw new Error(`git_branch: unsupported action "${action}"`);
      }

      const result = await runGit(context, cwd, gitArgs, { journal: true });
      return { ...toText(result), cwd, action, name };
    },
  };
}

/** git_restore 鈥?restore working tree / index paths */
export function createGitRestoreTool(): RegisteredTool {
  return {
    definition: {
      name: 'git_restore',
      capabilities: ['vcs', 'fs-write'],
      description:
        'Restore files from a source revision (or unstage them). Prefer this over shell git checkout/restore.',
      parameters: {
        cwd: { type: 'string', description: 'Repository path' },
        paths: {
          type: 'array',
          description: 'Paths to restore',
          items: { type: 'string', description: 'Path' },
          required: true,
        },
        source: {
          type: 'string',
          description: 'Source revision (default: keep current index/worktree rules)',
        },
        staged: { type: 'boolean', description: 'Unstage paths (restore index only)' },
        worktree: { type: 'boolean', description: 'Restore working tree (default true when not staged-only)' },
      },
    },
    handler: async (args, context) => {
      const cwd = resolveCwd(context, args.cwd as string | undefined);
      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      if (paths.length === 0) throw new Error('git_restore: paths is required');
      const resolvedPaths = paths.map((p) => toGitPathspec(p, context, 'restore'));

      await gateEffect(
        {
          kind: 'vcs',
          operation: 'restore',
          cwd,
          description: `git restore ${resolvedPaths.join(' ')}`,
        },
        {
          effects: context?.effectChannel ?? 'engine',
          confirmEffect: context?.confirmEffect,
          sessionId: context?.sessionId,
          agentId: context?.agentId,
        },
      );

      const gitArgs = ['restore'];
      if (args.staged === true) gitArgs.push('--staged');
      if (args.worktree !== false && args.staged !== true) gitArgs.push('--worktree');
      if (args.staged === true && args.worktree === true) gitArgs.push('--worktree');
      if (args.source !== undefined) {
        gitArgs.push(`--source=${assertSafeRef(String(args.source), 'source')}`);
      }
      gitArgs.push('--', ...resolvedPaths);

      const result = await runGit(context, cwd, gitArgs, { journal: true });
      return { ...toText(result), cwd, paths: resolvedPaths };
    },
  };
}

/** All git_* tools (read + write). */
export function createGitTools(): RegisteredTool[] {
  return [
    createGitStatusTool(),
    createGitDiffTool(),
    createGitLogTool(),
    createGitShowTool(),
    createGitCommitTool(),
    createGitBranchTool(),
    createGitRestoreTool(),
  ];
}
