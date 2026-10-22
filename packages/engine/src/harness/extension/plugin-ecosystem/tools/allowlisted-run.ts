/**
 * Allowlisted argv runner — shared by dedicated tools (git / package).
 *
 * Not a shell: fixed executable + argv array, no interpolation. Spawns via
 * ProcessSandbox (L1 supervised; L4 jail when probed). Optional §5.6 shell
 * journal snapshot so write ops stay turn-undoable like the shell tool.
 */
import type { ToolExecutionContext } from '@octopi-agent/core/types.js';
import { defaultChildEnv, findExecutable } from './platform.js';

export interface AllowlistedRunOptions {
  /** Absolute executable path (from findExecutable) */
  executable: string;
  /** argv after the executable — caller builds a fixed allowlist */
  args: string[];
  cwd: string;
  context?: ToolExecutionContext;
  /** Extra env (merged over the scrubbed baseline) */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Journal write effects via shell-journal (default true for mutating tools) */
  journal?: boolean;
  /**
   * Apply the tool output gate (caps output toward model context). Default true.
   * Structured consumers (UI snapshots) pass false and cap on their own terms —
   * the gate cuts at a char budget and would slice parse records mid-stream.
   */
  applyOutputGate?: boolean;
}

export interface AllowlistedRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  rawStdoutLength: number;
  terminated: boolean;
  terminateReason?: string;
  isolation: import('../../execution-environment/types.js').SandboxResult['isolation'];
}

/** Resolve an executable or throw a typed error the model can act on. */
export function requireExecutable(name: string): string {
  const found = findExecutable(name);
  if (!found) {
    throw new Error(
      `${name}_not_found: "${name}" is not on PATH. Install it or use the dedicated file tools instead of shell.`,
    );
  }
  return found;
}

/**
 * Run a fixed argv vector through ProcessSandbox with journal + L1 output gate.
 *
 * @param options - executable/args/cwd/context
 * @returns capped stdout/stderr + honest isolation
 */
export async function runAllowlistedArgv(
  options: AllowlistedRunOptions,
): Promise<AllowlistedRunResult> {
  const { executable, args, cwd, context, timeoutMs = 60_000, journal = true } = options;

  const journalMode = context?.shellJournal ?? 'snapshot';
  const journalRoots = (context?.pathRoots ?? []).filter(Boolean);
  let shellBefore:
    | Awaited<ReturnType<typeof import('../../execution-environment/shell-journal.js').snapshotShellRoots>>
    | undefined;
  let notReversedPayload:
    | {
        reason: 'inventory_only' | 'budget_truncated' | 'no_roots' | 'shell_journal_off';
        created?: string[];
        modified?: string[];
        deleted?: string[];
      }
    | undefined;

  if (journal) {
    if (journalMode === 'snapshot') {
      if (journalRoots.length === 0) {
        notReversedPayload = { reason: 'no_roots' };
      } else {
        const sj = await import('../../execution-environment/shell-journal.js');
        shellBefore = await sj.snapshotShellRoots({
          roots: journalRoots,
          limit: context?.shellJournalLimit,
        });
      }
    } else {
      notReversedPayload = { reason: 'shell_journal_off' };
    }
  }

  const { createProcessSandbox } = await import('../../execution-environment/sandbox.js');
  // Force-include every key we explicitly set (GIT_*, npm_config_* sit outside
  // scrubEnv's allowlist and would silently vanish otherwise).
  const childEnv: Record<string, string> = {
    ...defaultChildEnv(),
    ...options.env,
  };
  const forceEnvKeys = Object.keys(childEnv);
  const sandbox = await createProcessSandbox({ forceEnvKeys });
  const sandboxResult = await sandbox.executeArgv([executable, ...args], {
    cwd,
    env: childEnv,
    allowRoots: [cwd, ...journalRoots],
    networkPolicy: context?.networkPolicy ?? 'deny',
    requireJail: context?.requireJail,
    homeWrite: context?.homeWrite,
    noteSecurityDegraded: context?.noteSecurityDegraded,
    signal: context?.abortSignal,
    limits: {
      timeoutMs,
      maxOutputBytes: 16 * 1024 * 1024,
    },
  });

  // Journal after-diff (same contract as shell tool §5.6)
  try {
    const sj = await import('../../execution-environment/shell-journal.js');
    const effects = context?.fileEffects;
    if (shellBefore && effects) {
      const afterCap = await sj.captureShellInventory({
        roots: journalRoots,
        limit: context?.shellJournalLimit,
      });
      const diff = await sj.journalShellDiff(
        effects,
        shellBefore.capture,
        afterCap,
        shellBefore.store,
      );
      if (shellBefore.capture.truncated || afterCap.truncated || diff.notInventable.length > 0) {
        await effects.noteNotReversed({
          reason: 'budget_truncated',
          created: diff.notInventable,
        });
      }
    } else if (notReversedPayload && effects && journal) {
      await effects.noteNotReversed(notReversedPayload);
    }
  } catch {
    // Journal failure must not drop the business result (matches shell tool).
  }

  if (options.applyOutputGate === false) {
    // Structured consumers cap on their own terms (parse, then slice). The only
    // stream cut left is the sandbox output cap, which kills the process *before*
    // appending the offending chunk — so length heuristics cannot see it; the
    // honest signal is the terminate reason (verified in sandbox.ts).
    return {
      stdout: sandboxResult.stdout,
      stderr: sandboxResult.stderr,
      exitCode: sandboxResult.exitCode,
      durationMs: sandboxResult.usage.elapsedMs,
      truncated: sandboxResult.terminated && sandboxResult.terminateReason === 'Output size limit exceeded',
      rawStdoutLength: sandboxResult.stdout.length,
      terminated: sandboxResult.terminated,
      terminateReason: sandboxResult.terminateReason,
      isolation: sandboxResult.isolation,
    };
  }

  try {
    const { applyToolOutputGate, resolveSupportBinding } = await import(
      '../../../context/capabilities/summary/index.js'
    );
    const binding = resolveSupportBinding('shell', undefined, 8000);
    const applied = await applyToolOutputGate({
      tool: 'shell',
      rawBody: sandboxResult.stdout,
      support: { binding },
      truncateHint: 'Re-run with a narrower command, or write large output to a file and file_read it.',
    });
    const stderrApplied = await applyToolOutputGate({
      tool: 'shell',
      rawBody: sandboxResult.stderr,
      support: { binding: { ...binding, maxReturnChars: Math.min(binding.maxReturnChars, 4000) } },
      truncateHint: 'stderr truncated.',
    });
    return {
      stdout: applied.body,
      stderr: stderrApplied.body,
      exitCode: sandboxResult.exitCode,
      durationMs: sandboxResult.usage.elapsedMs,
      truncated: applied.bodyTruncated || stderrApplied.bodyTruncated,
      rawStdoutLength: applied.rawLength,
      terminated: sandboxResult.terminated,
      terminateReason: sandboxResult.terminateReason,
      isolation: sandboxResult.isolation,
    };
  } catch {
    return {
      stdout: sandboxResult.stdout.slice(0, 8000),
      stderr: sandboxResult.stderr.slice(0, 4000),
      exitCode: sandboxResult.exitCode,
      durationMs: sandboxResult.usage.elapsedMs,
      truncated: sandboxResult.stdout.length > 8000 || sandboxResult.stderr.length > 4000,
      rawStdoutLength: sandboxResult.stdout.length,
      terminated: sandboxResult.terminated,
      terminateReason: sandboxResult.terminateReason,
      isolation: sandboxResult.isolation,
    };
  }
}

/** Safe git revision / branch token (no shell metacharacters, no leading dash). */
export const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:-]*$/;

/** Validate a git ref/branch token; throws on injection-shaped input. */
export function assertSafeRef(value: string, label: string): string {
  const t = value.trim();
  if (!t || !SAFE_REF_RE.test(t) || t.includes('..') || t.startsWith('-')) {
    throw new Error(`unsafe_${label}: "${value}" is not a safe git ref token`);
  }
  return t;
}
