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
