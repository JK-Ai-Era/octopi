/**
 * git_* dedicated tools — local VCS porcelain without a shell.
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
import {
  containmentOptions,
  isUnderAttachmentRoot,
  isUnderSessionUndoRoot,
  resolveToolPath,
} from './platform.js';
import { detectEol, toEol } from './eol.js';
import { assertSafeRef, type AllowlistedRunResult } from './allowlisted-run.js';
import { matchesDenyPattern } from '../../../shared/paths/glob.js';
import { runGit } from './git-runner.js';

function resolveCwd(context: ToolExecutionContext | undefined, raw?: string): string {
  const cwd = raw ?? context?.cwd ?? process.cwd();
  const abs = resolveToolPath(cwd, context?.cwd, containmentOptions(context));
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
  const abs = resolveToolPath(raw, context?.cwd, containmentOptions(context));
  if (isUnderAttachmentRoot(abs, context?.attachmentRoots)) {
    throw new Error(`session attachments are read-only; cannot ${label} under attachments root`);
  }
  if (isUnderSessionUndoRoot(abs, context?.undoRoots)) {
    throw new Error(`session undo ledger is protected; cannot ${label} under sessions undo dir`);
  }
  return abs;
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
  const denylist = context?.pathDenylist ?? [];
  // A glob pathspec is matched by git, not by us, so we cannot prove it excludes
  // denied paths. Fail closed instead of shipping an unverifiable allow.
  if (denylist.length > 0) {
    throw new Error(
      `pathspec_glob_forbidden: glob pathspec "${raw}" cannot be checked against pathDenylist; pass explicit paths`,
    );
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

/**
 * Decode a git-quoted path (`"a\tb"`) into its literal spelling.
 *
 * @param token - path token straight from git output
 * @returns the path git meant, without the a/ or b/ side prefix
 */
function unquoteGitPath(token: string): string {
  const body = token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1).replace(/\\(.)/g, '$1')
    : token;
  return body.replace(/^[ab]\//, '');
}

/**
 * Split the arguments of a `diff --git a/<path> b/<path>` header.
 *
 * @param rest - header text after `diff --git `
 * @returns path tokens, still quoted when git quoted them
 */
function splitDiffHeader(rest: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < rest.length) {
    if (rest[index] === ' ') {
      index += 1;
      continue;
    }
    let token = '';
    while (index < rest.length && rest[index] !== ' ') {
      if (rest[index] === '"') {
        token += '"';
        index += 1;
        while (index < rest.length) {
          if (rest[index] === '\\' && index + 1 < rest.length) {
            token += rest[index] + rest[index + 1];
            index += 2;
            continue;
          }
          token += rest[index];
          if (rest[index] === '"') {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      token += rest[index];
      index += 1;
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * Drop git output that names or contains denied paths.
 *
 * `git_diff` / `git_show` emit file *contents* keyed by section headers, and
 * `git_status` emits bare paths, so path arguments alone are not enough: a
 * deployment that denies `.env*` must not get that content back through VCS.
 * Truncated diffs cannot be verified section by section, so they are refused
 * rather than returned unverified.
 *
 * @param text - raw git stdout
 * @param truncated - whether the runner cut the output
 * @param patterns - denylist globs
 * @param kind - output shape
 * @returns filtered stdout
 */
function filterGitOutput(
  text: string,
  truncated: boolean,
  patterns: readonly string[],
  kind: 'diff' | 'status',
): string {
  if (patterns.length === 0) return text;
  const lines = text.split('\n');
  if (kind === 'status') {
    return lines
      .filter((line) => {
        if (line.startsWith('##') || line.length < 4) return true;
        const raw = line.slice(3);
        const target = raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw;
        return !matchesDenyPattern(unquoteGitPath(target.trim()), patterns);
      })
      .join('\n');
  }
  if (truncated) {
    throw new Error(
      'path_forbidden: git output was truncated, so pathDenylist could not be verified; narrow the request',
    );
  }
  let dropping = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const paths = splitDiffHeader(line.slice('diff --git '.length)).map(unquoteGitPath);
      dropping = paths.some((path) => matchesDenyPattern(path, patterns));
    } else if (/^ .+?\s+\|\s+\d+/.test(line)) {
      // `--stat` rows are single lines, not sections; test the named path.
      const path = unquoteGitPath(line.trim().split(/\s+\|\s+/)[0]!.trim());
      if (matchesDenyPattern(path, patterns)) continue;
    }
    if (!dropping) kept.push(line);
  }
  return kept.join('\n');
}

function toText(
  result: AllowlistedRunResult,
  context?: ToolExecutionContext,
  contentKind?: 'diff' | 'status',
): Record<string, unknown> {
  const stdout = contentKind
    ? filterGitOutput(result.stdout, result.truncated, context?.pathDenylist ?? [], contentKind)
    : result.stdout;
  return {
    stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    terminated: result.terminated,
    terminateReason: result.terminateReason,
    isolation: result.isolation,
  };
}

/** git_status — porcelain working tree status */
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
      return { ...toText(result, context, 'status'), cwd };
    },
  };
}

/** git_diff — unstaged / staged / vs-ref diff */
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
      return { ...toText(result, context, 'diff'), cwd, mode };
    },
  };
}

/** git_log — commit history */
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

/** git_show — show a commit / tree / blob */
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
      return { ...toText(result, context, 'diff'), cwd, revision: rev };
    },
  };
}

/** git_commit — add paths + commit (hooks disabled) */
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
        eol: {
          type: 'string',
          description:
            'EOL handling for staged text files: "normalize" (default; rewrite each staged file to the EOL convention of its HEAD blob before commit, avoiding whole-file line-ending churn) | "keep" (commit bytes as-is)',
          enum: ['normalize', 'keep'],
        },
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

      // EOL 归一：工具 git 隔离全局配置（autocrlf 不可见），worktree 的 CRLF 会被
      // 原样入库，与 HEAD blob 的行尾约定相悖时产生整文件 churn。跟随 HEAD blob 的
      // 行尾约定重写已暂存文本文件（新文件 / 删除 / 二进制 / 非 UTF-8 不动）。
      const eolNormalized: string[] = [];
      if (args.eol !== 'keep') {
        const staged = await runGit(context, cwd, ['diff', '--cached', '--name-only', '-z', 'HEAD']);
        if (staged.exitCode === 0) {
          const { readFile, writeFile } = await import('node:fs/promises');
          const { join: joinPath } = await import('node:path');
          for (const rel of staged.stdout.split('\0').map((s) => s.trim()).filter(Boolean)) {
            const abs = joinPath(cwd, rel);
            const workBuf = await readFile(abs).catch(() => undefined);
            if (!workBuf || workBuf.includes(0)) continue;
            let workText: string;
            try {
              workText = new TextDecoder('utf-8', { fatal: true }).decode(workBuf);
            } catch {
              continue;
            }
            const head = await runGit(context, cwd, ['show', `HEAD:${rel}`]);
            if (head.exitCode !== 0) continue;
            const normalized = toEol(workText, detectEol(head.stdout));
            if (normalized === workText) continue;
            await writeFile(abs, normalized);
            await runGit(context, cwd, ['add', '--', rel]);
            eolNormalized.push(rel);
          }
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
      return { ...toText(result), stage: 'commit', cwd, message, eolNormalized };
    },
  };
}

/** git_branch — list / create / switch / delete */
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

/** git_restore — restore working tree / index paths */
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
    // 覆写工作树文件（index）：所在 tool_call 批次整体串行，防与同路径写交错
    executionMode: 'sequential',
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
