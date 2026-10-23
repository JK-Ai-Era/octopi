/**
 * Dedicated tool surface (workspace / untrusted without shell):
 * - ToolCapability vcs/runner
 * - reduced surface keeps vcs, strips runner
 * - gateEffect does not shellEscape-gate runner/vcs
 */
import { describe, it, expect } from 'vitest';

import {
  isToolAllowedOnSurface,
  gateEffect,
} from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import {
  REDUCED_DENIED_CAPABILITIES,
  BUILTIN_TOOL_CAPABILITIES as CAPS_MAP,
  deniesReducedSurface,
  resolveToolCapabilities,
} from '@octopi-agent/engine/harness/extension/execution-environment/tool-capabilities.js';
import { createGitTools } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/git-tools.js';
import { createPackageTools } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/package-tools.js';

describe('dedicated tool capabilities', () => {
  it('vcs is allowed on reduced; runner and egress are stripped', () => {
    expect(isToolAllowedOnSurface('git_status', 'reduced')).toBe(true);
    expect(isToolAllowedOnSurface('git_diff', 'reduced')).toBe(true);
    expect(isToolAllowedOnSurface('git_log', 'reduced')).toBe(true);
    expect(isToolAllowedOnSurface('git_commit', 'reduced')).toBe(true);
    expect(isToolAllowedOnSurface('git_branch', 'reduced')).toBe(true);
    expect(isToolAllowedOnSurface('git_restore', 'reduced')).toBe(true);
    expect(isToolAllowedOnSurface('package_edit', 'reduced')).toBe(true);

    expect(isToolAllowedOnSurface('project_run', 'reduced')).toBe(false);
    expect(isToolAllowedOnSurface('package_install', 'reduced')).toBe(false);
    expect(isToolAllowedOnSurface('shell', 'reduced')).toBe(false);
  });

  it('runner is on the reduced denylist; vcs is not', () => {
    expect(REDUCED_DENIED_CAPABILITIES).toContain('runner');
    expect(REDUCED_DENIED_CAPABILITIES).not.toContain('vcs');
    expect(deniesReducedSurface(['vcs'])).toBe(false);
    expect(deniesReducedSurface(['runner'])).toBe(true);
    expect(deniesReducedSurface(['egress', 'runner'])).toBe(true);
  });

  it('builtin capability map covers the new tools', () => {
    expect(CAPS_MAP.git_status).toEqual(['vcs', 'fs-read']);
    expect(CAPS_MAP.git_commit).toEqual(['vcs', 'fs-write']);
    expect(CAPS_MAP.project_run).toEqual(['runner']);
    expect(CAPS_MAP.package_install).toEqual(['egress', 'runner']);
    expect(CAPS_MAP.package_edit).toEqual(['fs-write', 'fs-read']);
    expect(resolveToolCapabilities('git_log')).toEqual(['vcs', 'fs-read']);
  });

  it('tool factories declare matching capabilities', () => {
    const git = createGitTools();
    expect(git.map((t) => t.definition.name).sort()).toEqual(
      ['git_branch', 'git_commit', 'git_diff', 'git_log', 'git_restore', 'git_show', 'git_status'].sort(),
    );
    for (const t of git) {
      expect(t.definition.capabilities).toContain('vcs');
    }
    const pkg = createPackageTools();
    expect(pkg.map((t) => t.definition.name).sort()).toEqual(
      ['package_edit', 'package_install', 'project_run'].sort(),
    );
    const projectRun = pkg.find((t) => t.definition.name === 'project_run')!;
    expect(projectRun.definition.capabilities).toEqual(['runner']);
  });
});

describe('gateEffect for runner/vcs', () => {
  it('does not apply shellEscape=deny to runner or vcs', async () => {
    await expect(
      gateEffect(
        { kind: 'runner', command: 'run test' },
        { effects: 'engine', shellEscape: 'deny' },
      ),
    ).resolves.toBeUndefined();
    await expect(
      gateEffect(
        { kind: 'vcs', operation: 'commit' },
        { effects: 'engine', shellEscape: 'deny' },
      ),
    ).resolves.toBeUndefined();
  });

  it('still rejects shell when shellEscape=deny', async () => {
    await expect(
      gateEffect({ kind: 'shell', command: 'ls' }, { effects: 'engine', shellEscape: 'deny' }),
    ).rejects.toThrow(/shell_denied/);
  });

  it('host-gate requires confirmEffect for runner', async () => {
    await expect(
      gateEffect(
        { kind: 'runner', command: 'run test' },
        { effects: 'host-gate', shellEscape: 'deny' },
      ),
    ).rejects.toThrow(/confirm_effect_missing/);
    await expect(
      gateEffect(
        { kind: 'runner', command: 'run test' },
        {
          effects: 'host-gate',
          shellEscape: 'deny',
          confirmEffect: async () => 'approve',
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('package_install network gate', () => {
  it('refuses when networkPolicy is deny and tells the user to install manually', async () => {
    const tools = createPackageTools();
    const install = tools.find((t) => t.definition.name === 'package_install')!;
    await expect(
      install.handler(
        { action: 'install' },
        {
          sessionId: 's',
          agentId: 'a',
          messages: [],
          cwd: process.cwd(),
          networkPolicy: 'deny',
          fileEffects: {
            writeFile: async () => {},
            appendFile: async () => {},
            recordDelete: async () => {},
            recordCreate: async () => {},
            recordRename: async () => {},
            recordOverwrite: async () => {},
            noteNotReversed: async () => {},
          },
          memoryEffects: {
            recordInsert: async () => {},
            recordUpdate: async () => {},
            recordDelete: async () => {},
          },
        },
      ),
    ).rejects.toThrow(/package_install_network_denied|install dependencies manually/i);
  });
});

describe('P0 hardening', () => {
  it('package_edit rejects prototype-polluting keys', async () => {
    const tools = createPackageTools();
    const edit = tools.find((t) => t.definition.name === 'package_edit')!;
    const base = {
      sessionId: 's',
      agentId: 'a',
      messages: [],
      cwd: process.cwd(),
      fileEffects: {
        writeFile: async () => {},
        appendFile: async () => {},
        recordDelete: async () => {},
        recordCreate: async () => {},
        recordRename: async () => {},
        recordOverwrite: async () => {},
        noteNotReversed: async () => {},
      },
      memoryEffects: {
        recordInsert: async () => {},
        recordUpdate: async () => {},
        recordDelete: async () => {},
      },
    } as never;
    await expect(
      edit.handler({ set: { '__proto__.polluted': true } }, base),
    ).rejects.toThrow(/package_edit_forbidden_key|prototype/);
    await expect(
      edit.handler({ set: { 'constructor.prototype.x': 1 } }, base),
    ).rejects.toThrow(/package_edit_forbidden_key|prototype/);
  });

  it('resolveNodeToolCommand never returns .cmd/.bat for spawn on Windows', async () => {
    const { resolveNodeToolCommand, findExecutable } = await import(
      '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js'
    );
    const npm = findExecutable('npm');
    if (!npm) return;
    if (process.platform === 'win32') {
      const cmd = resolveNodeToolCommand('npm');
      expect(cmd.executable.toLowerCase().endsWith('.cmd')).toBe(false);
      expect(cmd.executable.toLowerCase().endsWith('.bat')).toBe(false);
    } else {
      const cmd = resolveNodeToolCommand('npm');
      expect(cmd.prefixArgs.length).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Octopi review follow-ups', () => {
  it('git_diff rejects unknown mode', async () => {
    const tools = createGitTools();
    const diff = tools.find((t) => t.definition.name === 'git_diff')!;
    await expect(
      diff.handler(
        { mode: 'nope' },
        {
          sessionId: 's',
          agentId: 'a',
          messages: [],
          cwd: process.cwd(),
          fileEffects: {
            writeFile: async () => {},
            appendFile: async () => {},
            recordDelete: async () => {},
            recordCreate: async () => {},
            recordRename: async () => {},
            recordOverwrite: async () => {},
            noteNotReversed: async () => {},
          },
          memoryEffects: {
            recordInsert: async () => {},
            recordUpdate: async () => {},
            recordDelete: async () => {},
          },
        } as never,
      ),
    ).rejects.toThrow(/unsupported mode/);
  });

  it('git rejects cwd under attachment roots', async () => {
    const tools = createGitTools();
    const status = tools.find((t) => t.definition.name === 'git_status')!;
    await expect(
      status.handler(
        { cwd: '/att' },
        {
          sessionId: 's',
          agentId: 'a',
          messages: [],
          cwd: '/att',
          attachmentRoots: ['/att'],
          fileEffects: {
            writeFile: async () => {},
            appendFile: async () => {},
            recordDelete: async () => {},
            recordCreate: async () => {},
            recordRename: async () => {},
            recordOverwrite: async () => {},
            noteNotReversed: async () => {},
          },
          memoryEffects: {
            recordInsert: async () => {},
            recordUpdate: async () => {},
            recordDelete: async () => {},
          },
        } as never,
      ),
    ).rejects.toThrow(/attachments root|read-only/);
  });
});

describe('P2 follow-ups (EOL / pathspec / filters)', () => {
  const mockCtx = (cwd: string, extra?: Record<string, unknown>) => {
    const writes: Array<{ path: string; data: string }> = [];
    return {
      writes,
      ctx: {
        sessionId: 's',
        agentId: 'a',
        messages: [],
        cwd,
        pathRoots: [cwd],
        pathContainment: 'strict' as const,
        fileEffects: {
          writeFile: async (path: string, data: string | Uint8Array) => {
            writes.push({ path, data: typeof data === 'string' ? data : Buffer.from(data).toString('utf8') });
          },
          appendFile: async () => {},
          recordDelete: async () => {},
          recordCreate: async () => {},
          recordRename: async () => {},
          recordOverwrite: async () => {},
          noteNotReversed: async () => {},
        },
        memoryEffects: {
          recordInsert: async () => {},
          recordUpdate: async () => {},
          recordDelete: async () => {},
        },
        ...extra,
      },
    };
  };

  it('package_edit preserves CRLF and trailing newline', async () => {
    const { mkdtemp, writeFile, rm, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'octopi-eol-'));
    try {
      const pkgPath = join(dir, 'package.json');
      const original = '{\r\n  "name": "x",\r\n  "scripts": {\r\n    "test": "echo 1"\r\n  }\r\n}\r\n';
      await writeFile(pkgPath, original, 'utf8');
      const tools = createPackageTools();
      const edit = tools.find((t) => t.definition.name === 'package_edit')!;
      const { ctx, writes } = mockCtx(dir);
      await edit.handler({ set: { 'scripts.lint': 'eslint .' } }, ctx as never);
      expect(writes.length).toBe(1);
      const after = writes[0]!.data;
      expect(after.includes('\r\n')).toBe(true);
      expect(after.includes('\n') && !after.includes('\r\n')).toBe(false); // not LF-only
      expect(after.endsWith('\r\n')).toBe(true);
      expect(JSON.parse(after).scripts.lint).toBe('eslint .');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('package_edit preserves LF when source is LF', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'octopi-lf-'));
    try {
      const pkgPath = join(dir, 'package.json');
      await writeFile(pkgPath, '{\n  "name": "x"\n}\n', 'utf8');
      const tools = createPackageTools();
      const edit = tools.find((t) => t.definition.name === 'package_edit')!;
      const { ctx, writes } = mockCtx(dir);
      await edit.handler({ set: { 'scripts.test': 'vitest' } }, ctx as never);
      const after = writes[0]!.data;
      expect(after.includes('\r\n')).toBe(false);
      expect(after.endsWith('\n')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('glob pathspecs stay relative; .. and absolute globs are rejected', async () => {
    const tools = createGitTools();
    const diff = tools.find((t) => t.definition.name === 'git_diff')!;
    const { ctx } = mockCtx(process.cwd());
    await expect(
      diff.handler({ paths: ['../secrets/*'] }, ctx as never),
    ).rejects.toThrow(/pathspec_glob_forbidden|pathspec_glob_unsupported|\.\./);
    await expect(
      diff.handler({ paths: ['/etc/*'] }, ctx as never),
    ).rejects.toThrow(/pathspec_glob_unsupported|path_forbidden|forbidden/);
    // simple path still L2-ok inside cwd
    const status = tools.find((t) => t.definition.name === 'git_status')!;
    // should not throw on pathspec validation (may fail later if not a repo)
    await status.handler({ paths: ['package.json'] }, ctx as never).catch((e: Error) => {
      expect(e.message).not.toMatch(/pathspec_/);
    });
  });
});
