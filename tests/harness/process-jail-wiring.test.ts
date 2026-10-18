/**
 * L4 execution wiring (D1–D6): jail roots/network, capability surface, undo roots.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

import {
  isUnderSessionUndoRoot,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';
import {
  isToolAllowedOnSurface,
} from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import {
  BUILTIN_TOOL_CAPABILITIES,
  deniesReducedSurface,
  resolveToolCapabilities,
} from '@octopi-agent/engine/harness/extension/execution-environment/tool-capabilities.js';
import {
  assessL4ProcessMinimum,
  supervisedSpawnProfile,
} from '@octopi-agent/engine/harness/extension/execution-environment/process-isolation.js';

describe('undo roots (D6-a)', () => {
  it('prefers real roots when injected', () => {
    const undo = resolve('/octopi/sessions/s1/undo');
    expect(isUnderSessionUndoRoot(resolve(undo, 'log.jsonl'), [undo])).toBe(true);
    expect(isUnderSessionUndoRoot(undo, [undo])).toBe(true);
    expect(isUnderSessionUndoRoot(resolve('/octopi/workspace/sessions/notes/undo/x'), [undo])).toBe(
      false,
    );
  });

  it('fallback matches exact sessions/<id>/undo shape only', () => {
    expect(isUnderSessionUndoRoot('/data/sessions/abc/undo/log.jsonl')).toBe(true);
    expect(isUnderSessionUndoRoot('/data/sessions/abc/undo')).toBe(true);
    expect(isUnderSessionUndoRoot('/data/sessions/abc/undo_backup/x')).toBe(false);
    expect(isUnderSessionUndoRoot('/data/my-sessions/abc/undo/x')).toBe(false);
    expect(isUnderSessionUndoRoot('/data/project/undo/notes.txt')).toBe(false);
  });
});

describe('capability surface (D5-a)', () => {
  it('builtins are tagged and map agrees with reduced policy', () => {
    expect(BUILTIN_TOOL_CAPABILITIES.shell).toEqual(['exec']);
    expect(deniesReducedSurface(['exec'])).toBe(true);
    expect(deniesReducedSurface(['fs-write'])).toBe(false);
    expect(resolveToolCapabilities('file_write')?.sort()).toEqual(['fs-write']);
  });

  it('unknown tools are rejected on reduced (unknown-reject)', () => {
    expect(isToolAllowedOnSurface('bash_command', 'reduced')).toBe(false);
    expect(isToolAllowedOnSurface('mcp_srv__tool', 'reduced')).toBe(false);
    expect(isToolAllowedOnSurface('bash_command', 'full')).toBe(true);
  });
});

describe('L4 honesty', () => {
  it('supervised spawn never meets the floor', () => {
    expect(assessL4ProcessMinimum(supervisedSpawnProfile()).ok).toBe(false);
  });
});

describe('D7 requireJail and network defaults', () => {
  it('untrusted_jail_failed when requireJail and no backend can apply', async () => {
    const { ProcessSandbox } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js'
    );
    const { supervisedSpawnProfile } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/process-isolation.js'
    );
    const sb = new ProcessSandbox({ profile: supervisedSpawnProfile() });
    await expect(
      sb.execute('echo hi', { requireJail: true, limits: { timeoutMs: 2000 } }),
    ).rejects.toThrow(/untrusted_jail_failed/);
  });

  it('registerToolCapabilities makes explicit [] authoritative', async () => {
    const {
      registerToolCapabilities,
      resolveToolCapabilities,
    } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/tool-capabilities.js'
    );
    registerToolCapabilities('plugin_safe', ['fs-read']);
    registerToolCapabilities('plugin_none', []);
    expect(resolveToolCapabilities('plugin_safe')).toEqual(['fs-read']);
    expect(resolveToolCapabilities('plugin_none')).toEqual([]);
    expect(isToolAllowedOnSurface('plugin_safe', 'reduced')).toBe(true);
    expect(isToolAllowedOnSurface('plugin_none', 'reduced')).toBe(true);
    expect(isToolAllowedOnSurface('plugin_unknown_xyz', 'reduced')).toBe(false);
  });
});

describe('1-B Seatbelt privilege ops-deny + 2 jail mounts', () => {
  it('generated seatbelt profile denies privilege-gaining execs and write-outside-roots', async () => {
    const { buildSeatbeltProfile } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js'
    );
    const sb = buildSeatbeltProfile(['/ws/project', '/tmp'], 'deny');
    expect(sb).toContain('(deny network*)');
    expect(sb).toContain('(deny process-exec (literal "/usr/bin/sudo"))');
    expect(sb).toContain('(deny file-write*)');
    expect(sb).toContain('(allow file-write* (subpath "/ws/project"))');
    expect(sb).toContain('(allow file-write* (subpath "/tmp"))');
  });

  it('network open omits network deny but keeps privilege denies', async () => {
    const { buildSeatbeltProfile } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js'
    );
    const sb = buildSeatbeltProfile(['/ws'], 'open');
    expect(sb).not.toContain('(deny network*)');
    expect(sb).toContain('(deny process-exec (literal "/usr/bin/sudo"))');
  });
});

describe('P1-2 residual: untagged registration blocks builtin name map', () => {
  it('untagged plugin shadowing a builtin name is rejected on reduced', async () => {
    const { registerToolCapabilities } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/tool-capabilities.js'
    );
    registerToolCapabilities('file_search', undefined);
    expect(isToolAllowedOnSurface('file_search', 'reduced')).toBe(false);
    // restore builtin registration for other tests
    registerToolCapabilities('file_search', ['fs-read']);
    expect(isToolAllowedOnSurface('file_search', 'reduced')).toBe(true);
  });
});

describe('Seatbelt stdio devices + canonical jail roots', () => {
  it('keeps stdio sinks writable while writes stay denied elsewhere', async () => {
    const { buildSeatbeltProfile } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js'
    );
    const sb = buildSeatbeltProfile(['/ws'], 'deny');
    expect(sb).toContain('(deny file-write*)');
    expect(sb).toContain('(allow file-write* (literal "/dev/null"))');
    expect(sb).toContain('(allow file-write* (literal "/dev/zero"))');
    expect(sb).toContain('(allow file-write* (literal "/dev/tty"))');
    expect(sb).toContain('(allow file-write* (literal "/dev/stdout"))');
    expect(sb).toContain('(allow file-write* (subpath "/dev/fd"))');
  });

  it.skipIf(process.platform === 'win32')(
    'emits lexical and canonical root forms so symlink aliases match',
    async () => {
      const { resolveJailRoots } = await import(
        '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js'
      );
      const { mkdir, mkdtemp, realpath, symlink } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join, resolve } = await import('node:path');

      const base = await mkdtemp(join(tmpdir(), 'octopi-roots-'));
      const real = join(base, 'real');
      await mkdir(real);
      const alias = join(base, 'alias');
      await symlink(real, alias);
      const stale = join(base, 'missing');

      const roots = await resolveJailRoots(alias, { allowRoots: [stale] });
      // lexical form of the alias root and its canonical twin both present
      expect(roots).toContain(resolve(alias));
      expect(roots).toContain(await realpath(real));
      // stale root keeps its lexical form (bind-try tolerates missing paths)
      expect(roots).toContain(resolve(stale));
    },
  );

  it('stale-only roots keep lexical forms without throwing', async () => {
    const { resolveJailRoots } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js'
    );
    const { resolve } = await import('node:path');
    const roots = await resolveJailRoots(resolve('/definitely/not/here-xyz'), {
      allowRoots: ['/also/missing-xyz'],
    });
    expect(roots).toContain(resolve('/definitely/not/here-xyz'));
    expect(roots).toContain(resolve('/also/missing-xyz'));
  });
});

describe('D7 jail wrapper failure detection', () => {
  const wrap = () =>
    import('@octopi-agent/engine/harness/extension/execution-environment/sandbox.js');

  it('recognizes wrapper-prefixed setup failures', async () => {
    const { isJailWrapperSetupFailure } = await wrap();
    expect(
      isJailWrapperSetupFailure(
        { exitCode: 71, stdout: '', stderr: 'sandbox-exec: sandbox_apply: Operation not permitted' },
        'sandbox-exec',
      ),
    ).toBe(true);
    expect(
      isJailWrapperSetupFailure(
        { exitCode: 2, stdout: '', stderr: 'bwrap: unshare: Operation not permitted' },
        'bwrap',
      ),
    ).toBe(true);
  });

  it('never treats a user-command error as wrapper failure', async () => {
    const { isJailWrapperSetupFailure } = await wrap();
    // A sandbox write denial of a real command emits exactly this wording —
    // re-running it unsandboxed would double-execute and escape the jail.
    expect(
      isJailWrapperSetupFailure(
        { exitCode: 1, stdout: '', stderr: '/bin/bash: /dev/null: Operation not permitted' },
        'sandbox-exec',
      ),
    ).toBe(false);
    expect(
      isJailWrapperSetupFailure(
        { exitCode: 1, stdout: '', stderr: 'cat: /etc/shadow: Operation not permitted' },
        'bwrap',
      ),
    ).toBe(false);
    // command produced output: it clearly ran inside the jail
    expect(
      isJailWrapperSetupFailure(
        { exitCode: 1, stdout: 'out', stderr: 'bwrap: unshare: Operation not permitted' },
        'bwrap',
      ),
    ).toBe(false);
  });

  it('matches unprefixed bwrap uid-map helper failures for bwrap only', async () => {
    const { isJailWrapperSetupFailure } = await wrap();
    const err = { exitCode: 1, stdout: '', stderr: 'newuidmap: write to uid_map failed' };
    expect(isJailWrapperSetupFailure(err, 'bwrap')).toBe(true);
    expect(isJailWrapperSetupFailure(err, 'sandbox-exec')).toBe(false);
  });
});

describe('review hardening: ordering, esc, detection semantics', () => {
  const wrap = () =>
    import('@octopi-agent/engine/harness/extension/execution-environment/sandbox.js');

  it('device allows come after the blanket deny (SBPL last-match wins)', async () => {
    const { buildSeatbeltProfile, SEATBELT_DEVICE_WRITE_ALLOW } = await wrap();
    const sb = buildSeatbeltProfile(['/ws'], 'deny');
    const denyAt = sb.indexOf('(deny file-write*)');
    expect(denyAt).toBeGreaterThanOrEqual(0);
    for (const dev of SEATBELT_DEVICE_WRITE_ALLOW) {
      expect(sb.indexOf(`(allow file-write* (literal "${dev}"))`)).toBeGreaterThan(denyAt);
    }
    expect(sb.indexOf('(allow file-write* (subpath "/dev/fd"))')).toBeGreaterThan(denyAt);
  });

  it('locks the full stdio device set and excludes /dev/ptmx', async () => {
    const { buildSeatbeltProfile, SEATBELT_DEVICE_WRITE_ALLOW } = await wrap();
    expect([...SEATBELT_DEVICE_WRITE_ALLOW]).toEqual([
      '/dev/null',
      '/dev/zero',
      '/dev/tty',
      '/dev/stdin',
      '/dev/stdout',
      '/dev/stderr',
    ]);
    const sb = buildSeatbeltProfile(['/ws'], 'deny');
    expect(sb).not.toContain('/dev/ptmx');
    expect(sb).toContain('(allow file-write* (literal "/dev/stdin"))');
    expect(sb).toContain('(allow file-write* (literal "/dev/stderr"))');
  });

  it('keeps () in paths intact and refuses newline paths', async () => {
    const { buildSeatbeltProfile } = await wrap();
    const sb = buildSeatbeltProfile(['/Users/x/My (Project)/ws'], 'deny');
    expect(sb).toContain('(allow file-write* (subpath "/Users/x/My (Project)/ws"))');
    expect(() => buildSeatbeltProfile(['/bad\npath'], 'deny')).toThrow(/seatbelt_path_invalid/);
    expect(() => buildSeatbeltProfile(['/bad\rpath'], 'deny')).toThrow(/seatbelt_path_invalid/);
  });

  it('terminated runs are never wrapper setup failures', async () => {
    const { isJailWrapperSetupFailure } = await wrap();
    expect(
      isJailWrapperSetupFailure(
        {
          exitCode: -1,
          stdout: '',
          stderr: 'sandbox-exec: sandbox_apply: Operation not permitted',
          terminated: true,
        },
        'sandbox-exec',
      ),
    ).toBe(false);
  });

  it('signature must start a line; mid-line text is user output', async () => {
    const { isJailWrapperSetupFailure } = await wrap();
    expect(
      isJailWrapperSetupFailure(
        { exitCode: 1, stdout: '', stderr: 'error: saw sandbox-exec: weird in output' },
        'sandbox-exec',
      ),
    ).toBe(false);
    expect(
      isJailWrapperSetupFailure(
        { exitCode: 1, stdout: '', stderr: 'unshared the namespace' },
        'bwrap',
      ),
    ).toBe(false);
  });

  it('relative roots resolve against the run cwd, names keep their spaces', async () => {
    const { resolveJailRoots } = await wrap();
    const { resolve } = await import('node:path');
    const roots = await resolveJailRoots('/base/cwd', { allowRoots: ['rel', ' padded '] });
    expect(roots).toContain(resolve('/base/cwd/rel'));
    expect(roots).toContain(resolve('/base/cwd', ' padded '));
    expect(roots).not.toContain(resolve('/base/cwd/padded'));
  });
});
