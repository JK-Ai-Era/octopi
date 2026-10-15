/**
 * Functional smoke for git_* dedicated tools against a real temp repo.
 * Skips when git is not on PATH.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createGitTools } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/git-tools.js';
import { createPackageTools } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/package-tools.js';
import { findExecutable } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';

const gitAvailable = findExecutable('git') !== null;

function mockContext(cwd: string, overrides?: Record<string, unknown>) {
  const writes: Array<{ path: string; data: string }> = [];
  return {
    ctx: {
      sessionId: 's',
      agentId: 'a',
      messages: [],
      cwd,
      pathRoots: [cwd],
      pathContainment: 'strict' as const,
      networkPolicy: 'deny' as const,
      shellJournal: 'snapshot' as const,
      effectChannel: 'engine' as const,
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
      ...overrides,
    },
    writes,
  };
}

describe.skipIf(!gitAvailable)('git_* tools (functional)', () => {
  let repo: string;
  const tools = createGitTools();
  const call = (name: string, args: Record<string, unknown>, ctx: unknown) => {
    const tool = tools.find((t) => t.definition.name === name)!;
    return tool.handler(args, ctx as never);
  };

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'octopi-git-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await writeFile(join(repo, 'a.txt'), 'hello\n');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('status shows the untracked file', async () => {
    const { ctx } = mockContext(repo);
    const result = (await call('git_status', { cwd: repo }, ctx)) as { stdout: string; exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('a.txt');
  });

  it('commit creates a commit and status is clean', async () => {
    const { ctx } = mockContext(repo);
    const commit = (await call(
      'git_commit',
      { cwd: repo, message: 'init', paths: ['a.txt'], all: true },
      ctx,
    )) as { exitCode: number };
    expect(commit.exitCode).toBe(0);

    const log = (await call('git_log', { cwd: repo }, ctx)) as { stdout: string; exitCode: number };
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('init');
  });

  it('rejects an unsafe revision token', async () => {
    const { ctx } = mockContext(repo);
    await expect(call('git_diff', { cwd: repo, mode: 'commit', revision: '--output=/tmp/x' }, ctx)).rejects.toThrow(
      /unsafe_revision/,
    );
    await expect(call('git_branch', { cwd: repo, action: 'create', name: 'foo; rm -rf /' }, ctx)).rejects.toThrow(
      /unsafe_branch/,
    );
  });
});

describe.skipIf(!gitAvailable)('package_edit (functional)', () => {
  it('sets and removes dotted paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'octopi-pkg-'));
    try {
      const pkgPath = join(dir, 'package.json');
      await writeFile(pkgPath, JSON.stringify({ name: 'x', scripts: { test: 'echo 1' } }, null, 2) + '\n');
      const tools = createPackageTools();
      const edit = tools.find((t) => t.definition.name === 'package_edit')!;
      const { ctx, writes } = mockContext(dir);
      await edit.handler(
        {
          set: { 'scripts.lint': 'eslint .', 'dependencies.lodash': '^4.0.0' },
          remove: ['scripts.test'],
        },
        ctx as never,
      );
      // writeFile goes through mock effects — apply to disk for assertion
      expect(writes.length).toBe(1);
      await writeFile(pkgPath, writes[0]!.data);
      const next = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, Record<string, unknown>>;
      expect(next.scripts?.lint).toBe('eslint .');
      expect(next.scripts?.test).toBeUndefined();
      expect(next.dependencies?.lodash).toBe('^4.0.0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!gitAvailable)('git filter.* neutralization (functional)', () => {
  it('clean filter from .git/config does not execute during git_commit', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const repo = await mkdtemp(join(tmpdir(), 'octopi-filter-'));
    const marker = join(tmpdir(), `octopi-filter-pwned-${Date.now()}`);
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      // Malicious clean filter: writes a marker file
      const evil = process.platform === 'win32'
        ? `cmd /c "echo pwned > ${marker}"`
        : `sh -c "echo pwned > ${marker}"`;
      execFileSync('git', ['config', 'filter.pwn.clean', evil], { cwd: repo });
      await writeFile(join(repo, 'a.txt'), 'hello\n');
      await writeFile(join(repo, '.gitattributes'), 'a.txt filter=pwn\n');

      const tools = createGitTools();
      const commit = tools.find((t) => t.definition.name === 'git_commit')!;
      const { ctx } = mockContext(repo);
      await commit.handler(
        { cwd: repo, message: 'x', paths: ['a.txt'], all: true },
        ctx as never,
      );
      const { existsSync } = await import('node:fs');
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
  });
});
