/**
 * Structured git working-tree snapshot for UI surfaces (WebUI Git tab).
 *
 * Read-only and context-free: runs `git rev-parse --show-toplevel` +
 * `git status --porcelain=v2 -z --branch` through the same hardened runner the
 * git_* dedicated tools use (git-runner.ts). Porcelain v2 is the machine
 * format: NUL-separated records (no path quoting), rename/copy carry both
 * paths, and `# branch.*` headers give oid/head/upstream/ahead-behind.
 */
import { runGit } from './git-runner.js';

/** How an entry is rendered/grouped in UI surfaces. */
export type GitStatusGroup = 'conflicted' | 'staged' | 'unstaged' | 'untracked';

/** Record kind behind an entry. */
export type GitStatusKind = 'changed' | 'renamed' | 'copied' | 'untracked' | 'conflicted';

/**
 * One display row. A partially-staged file (`1 MM …`) yields TWO rows — one in
 * `staged`, one in `unstaged` — matching `git status` section semantics; its
 * x/y pair is repeated on each row so the UI can show the real codes.
 */
export interface GitStatusEntry {
  kind: GitStatusKind;
  group: GitStatusGroup;
  /** Staged status char ('.' = unchanged in the index). */
  x: string;
  /** Unstaged status char ('.' = unchanged in the worktree). */
  y: string;
  path: string;
  /** Rename/copy source path (record type 2 only). */
  origPath?: string;
}

/** Branch header block from `# branch.*` records. */
export interface GitStatusBranch {
  /** HEAD oid; null before the first commit (`(initial)`). */
  oid: string | null;
  /** Branch name; null when detached (`(detached)`). */
  head: string | null;
  detached: boolean;
  /** True when the repo has no commits yet. */
  initial: boolean;
  /** Upstream ref name; null when no upstream is configured. */
  upstream: string | null;
  /** Commits ahead of upstream; null without upstream. */
  ahead: number | null;
  /** Commits behind upstream; null without upstream. */
  behind: number | null;
}

/** Full-precision counts (computed over all rows, not just returned entries). */
export interface GitStatusCounts {
  conflicted: number;
  staged: number;
  unstaged: number;
  untracked: number;
}

/** Parsed body of a status snapshot (no repo resolution). */
export interface GitStatusSnapshotBody {
  /** null when the stream carried no `# branch.*` headers at all. */
  branch: GitStatusBranch | null;
  counts: GitStatusCounts;
  entries: GitStatusEntry[];
  /** True when entries were capped by maxEntries; counts stay full. */
  truncated: boolean;
  /** Records that matched a known type but failed to parse (format drift). */
  skippedRecords: number;
}

/** Full snapshot for one directory. */
export interface GitStatusSnapshot extends GitStatusSnapshotBody {
  /** False when the directory is not inside any git work tree. */
  isRepo: boolean;
  /** Work-tree top level (`git rev-parse --show-toplevel`); null when not a repo. */
  repoRoot: string | null;
  /** ISO timestamp taken after the status read completed. */
  generatedAt: string;
}

export interface GitStatusSnapshotOptions {
  /** Max entries returned (counts stay full). Default 500. */
  maxEntries?: number;
  /**
   * Untracked granularity. 'normal' (default) collapses untracked directories,
   * 'all' lists every untracked file (parity with the git_status tool).
   */
  untracked?: 'normal' | 'all';
}

const DEFAULT_MAX_ENTRIES = 500;

const EMPTY_COUNTS = (): GitStatusCounts => ({
  conflicted: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
});

/** Group render order: conflicts first, then staged, unstaged, untracked. */
const GROUP_RANK: Record<GitStatusGroup, number> = {
  conflicted: 0,
  staged: 1,
  unstaged: 2,
  untracked: 3,
};

/**
 * Parse `git status --porcelain=v2 -z [--branch]` output.
 *
 * Record grammar (NUL-separated): `# key value` headers; `1 XY sub mH mI mW hH
 * hI path`; `2 XY sub mH mI mW hH hI Xscore path` + separate origPath field;
 * `u XY sub m1 m2 m3 mW h1 h2 h3 path`; `? path`; `! path` (skipped — we never
 * pass --ignored). Paths are raw bytes decoded as UTF-8; no quoting in -z mode.
 *
 * @param raw - NUL-separated porcelain v2 stream
 * @param options - maxEntries / untracked granularity (untracked only affects readers)
 * @returns branch block (null without headers), full counts, capped entries,
 *          skippedRecords for known-type records that failed to parse
 */
export function parsePorcelainV2(
  raw: string,
  options?: GitStatusSnapshotOptions,
): GitStatusSnapshotBody {
  const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const branch: GitStatusBranch = {
    oid: null,
    head: null,
    detached: false,
    initial: false,
    upstream: null,
    ahead: null,
    behind: null,
  };
  let sawBranchHeader = false;
  let skippedRecords = 0;
  const rows: Array<{ entry: GitStatusEntry; idx: number }> = [];
  const counts = EMPTY_COUNTS();

  const pushRow = (entry: GitStatusEntry, idx: number): void => {
    counts[entry.group] += 1;
    rows.push({ entry, idx });
  };

  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (!tok) continue;

    if (tok.startsWith('# ')) {
      sawBranchHeader = true;
      const rest = tok.slice(2);
      if (rest.startsWith('branch.oid ')) {
        const v = rest.slice('branch.oid '.length);
        branch.initial = v === '(initial)';
        branch.oid = branch.initial ? null : v;
      } else if (rest.startsWith('branch.head ')) {
        const v = rest.slice('branch.head '.length);
        branch.detached = v === '(detached)';
        branch.head = branch.detached ? null : v;
      } else if (rest.startsWith('branch.upstream ')) {
        branch.upstream = rest.slice('branch.upstream '.length);
      } else if (rest.startsWith('branch.ab ')) {
        const m = /^\+(-?\d+) -(-?\d+)$/.exec(rest.slice('branch.ab '.length));
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }

    const kindCh = tok[0];
    if (kindCh === '1') {
      const m = /^1 (\S)(\S) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) ([\s\S]*)$/.exec(tok);
      if (!m) {
        skippedRecords += 1;
        continue;
      }
      const base = { kind: 'changed' as const, x: m[1]!, y: m[2]!, path: m[9]! };
      if (base.x !== '.') pushRow({ ...base, group: 'staged' }, i);
      if (base.y !== '.' || base.x === '.') pushRow({ ...base, group: 'unstaged' }, i);
    } else if (kindCh === '2') {
      const m = /^2 (\S)(\S) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) ([A-Z][0-9]*) ([\s\S]*)$/.exec(tok);
      if (!m) {
        skippedRecords += 1;
        continue;
      }
      const origPath = tokens[i + 1] ?? '';
      if (origPath) i += 1;
      const base = {
        kind: (m[9]!.startsWith('R') ? 'renamed' : 'copied') as GitStatusKind,
        x: m[1]!,
        y: m[2]!,
        path: m[10]!,
        ...(origPath ? { origPath } : {}),
      };
      if (base.x !== '.') pushRow({ ...base, group: 'staged' }, i);
      if (base.y !== '.' || base.x === '.') pushRow({ ...base, group: 'unstaged' }, i);
    } else if (kindCh === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path> — sub + 7 modes/hashes
      const m = /^u (\S)(\S) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) ([\s\S]*)$/.exec(tok);
      if (!m) {
        skippedRecords += 1;
        continue;
      }
      pushRow(
        { kind: 'conflicted', group: 'conflicted', x: m[1]!, y: m[2]!, path: m[11]! },
        i,
      );
    } else if (kindCh === '?') {
      pushRow(
        { kind: 'untracked', group: 'untracked', x: '?', y: '?', path: tok.slice(2) },
        i,
      );
    } else if (kindCh !== '!') {
      // Unknown record type: count it so format drift never looks like "clean".
      skippedRecords += 1;
    }
    // '!' (ignored) records are skipped by design: readers never pass --ignored.
  }

  // Stable group order (conflicted → staged → unstaged → untracked); git's own
  // path order is preserved inside a group.
  const sorted = rows
    .sort((a, b) => GROUP_RANK[a.entry.group] - GROUP_RANK[b.entry.group] || a.idx - b.idx)
    .map((s) => s.entry);

  return {
    branch: sawBranchHeader ? branch : null,
    counts,
    entries: sorted.slice(0, maxEntries),
    truncated: sorted.length > maxEntries,
    skippedRecords,
  };
}

/**
 * Read a structured git status snapshot for `cwd`.
 *
 * @param cwd - repository (or subdirectory) path; caller has contained it
 * @param options - maxEntries / untracked granularity
 * @returns isRepo=false when cwd is not inside a git work tree (a state, not an
 *          error); throws `git_status_failed: …` on real git failures, on
 *          output-cap kills (never partial-as-success), and `git_not_found: …`
 *          when git is not on PATH
 */
export async function readGitStatusSnapshot(
  cwd: string,
  options?: GitStatusSnapshotOptions,
): Promise<GitStatusSnapshot> {
  const untracked = options?.untracked ?? 'normal';

  const top = await runGit(undefined, cwd, ['rev-parse', '--show-toplevel'], {
    journal: false,
    applyOutputGate: false,
    timeoutMs: 15_000,
  });
  if (top.exitCode !== 0) {
    if (/not a git repository/i.test(top.stderr)) {
      return {
        isRepo: false,
        repoRoot: null,
        branch: null,
        counts: EMPTY_COUNTS(),
        entries: [],
        truncated: false,
        skippedRecords: 0,
        generatedAt: new Date().toISOString(),
      };
    }
    throw new Error(
      `git_status_failed: ${top.stderr.trim().slice(0, 200) || `rev-parse exited ${top.exitCode}`}`,
    );
  }

  const st = await runGit(
    undefined,
    cwd,
    ['status', '--porcelain=v2', '-z', '--branch', `--untracked-files=${untracked}`],
    { journal: false, applyOutputGate: false, timeoutMs: 30_000 },
  );
  // A killed/truncated stream would parse as a partial record set — surface it
  // as a failure instead of a plausible-looking clean/partial status.
  if (st.exitCode !== 0 || st.truncated || st.terminated) {
    throw new Error(
      `git_status_failed: ${
        st.terminateReason ??
        st.stderr.trim().slice(0, 200) ??
        `status exited ${st.exitCode}`
      }`,
    );
  }

  return {
    isRepo: true,
    repoRoot: top.stdout.trim(),
    ...parsePorcelainV2(st.stdout, options),
    generatedAt: new Date().toISOString(),
  };
}
