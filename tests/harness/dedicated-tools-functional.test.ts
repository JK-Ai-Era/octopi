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
          cwd: dir,
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

describe.skipIf(!gitAvailable)('git_* pathspec 相对仓库 cwd 解析（不是会话 workspace）', () => {
  it('cwd=<repo> + 相对 path 落在仓库内，而不是 workspace 里', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'octopi-git-pathspec-'));
    const workspace = await mkdtemp(join(tmpdir(), 'octopi-git-ws-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await writeFile(join(repo, 'CHANGELOG.md'), '# log\n');

      const tools = createGitTools();
      const commit = tools.find((t) => t.definition.name === 'git_commit')!;
      // 会话 cwd 与仓库是两个不同目录：path spec 必须贴仓库解析
      const { ctx } = mockContext(workspace, { pathRoots: [workspace, repo] });
      const result = (await commit.handler(
        { cwd: repo, message: 'init', paths: ['CHANGELOG.md'] },
        ctx as never,
      )) as { exitCode: number; stderr: string };

      expect(result.stderr).not.toMatch(/outside repository/);
      expect(result.exitCode).toBe(0);
      const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' });
      expect(log).toContain('init');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('git_status paths 同样相对仓库 cwd 解析', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'octopi-git-status-'));
    const workspace = await mkdtemp(join(tmpdir(), 'octopi-git-status-ws-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
      await writeFile(join(repo, 'pending.txt'), 'x\n');

      const status = createGitTools().find((t) => t.definition.name === 'git_status')!;
      const { ctx } = mockContext(workspace, { pathRoots: [workspace, repo] });
      const result = (await status.handler(
        { cwd: repo, paths: ['pending.txt'] },
        ctx as never,
      )) as { exitCode: number; stdout: string };

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('pending.txt');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!gitAvailable)('git_commit stagedOnly：只提交索引内容，不碰工作区', () => {
  const initRepo = async (name: string) => {
    const repo = await mkdtemp(join(tmpdir(), name));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    return repo;
  };
  const commitTool = () =>
    createGitTools().find((t) => t.definition.name === 'git_commit')!;

  it('索引里只有部分暂存时，提交内容来自索引而不是工作区', async () => {
    const repo = await initRepo('octopi-stagedonly-');
    try {
      await writeFile(join(repo, 'f.txt'), 'a\nb\nc\n');
      execFileSync('git', ['add', 'f.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

      // 索引 = b→B；工作区再叠一个未暂存的 C-UNSTAGED
      await writeFile(join(repo, 'f.txt'), 'a\nB\nc\n');
      execFileSync('git', ['add', 'f.txt'], { cwd: repo });
      await writeFile(join(repo, 'f.txt'), 'a\nB\nC-UNSTAGED\n');

      const { ctx } = mockContext(repo);
      const result = (await commitTool().handler(
        { cwd: repo, message: 'index-only', stagedOnly: true, paths: ['f.txt'] },
        ctx as never,
      )) as { exitCode: number };

      expect(result.exitCode).toBe(0);
      // 关键断言：提交的是索引内容（不含 C-UNSTAGED）
      expect(execFileSync('git', ['show', 'HEAD:f.txt'], { cwd: repo, encoding: 'utf8' })).toBe(
        'a\nB\nc\n',
      );
      // 未暂存改动必须原样留在工作区
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain(
        'M f.txt',
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('paths 中某个文件没有暂存内容 → fail loud', async () => {
    const repo = await initRepo('octopi-stagedonly-miss-');
    try {
      await writeFile(join(repo, 'a.txt'), 'a\n');
      await writeFile(join(repo, 'b.txt'), 'b\n');
      execFileSync('git', ['add', 'a.txt'], { cwd: repo });

      const { ctx } = mockContext(repo);
      await expect(
        commitTool().handler(
          { cwd: repo, message: 'x', stagedOnly: true, paths: ['a.txt', 'b.txt'] },
          ctx as never,
        ),
      ).rejects.toThrow(/no staged content for b\.txt/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('索引里还有 paths 之外的暂存内容 → fail loud（不静默提交别人的暂存）', async () => {
    const repo = await initRepo('octopi-stagedonly-extra-');
    try {
      await writeFile(join(repo, 'a.txt'), 'a\n');
      await writeFile(join(repo, 'other.txt'), 'o\n');
      execFileSync('git', ['add', 'a.txt', 'other.txt'], { cwd: repo });

      const { ctx } = mockContext(repo);
      await expect(
        commitTool().handler(
          { cwd: repo, message: 'x', stagedOnly: true, paths: ['a.txt'] },
          ctx as never,
        ),
      ).rejects.toThrow(/outside paths: other\.txt/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('stagedOnly 与非兼容参数互斥', async () => {
    const repo = await initRepo('octopi-stagedonly-mutex-');
    try {
      await writeFile(join(repo, 'a.txt'), 'a\n');
      execFileSync('git', ['add', 'a.txt'], { cwd: repo });
      const { ctx } = mockContext(repo);
      await expect(
        commitTool().handler({ cwd: repo, message: 'x', stagedOnly: true, all: true }, ctx as never),
      ).rejects.toThrow(/mutually exclusive/);
      await expect(
        commitTool().handler(
          { cwd: repo, message: 'x', stagedOnly: true, amend: true },
          ctx as never,
        ),
      ).rejects.toThrow(/mutually exclusive/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('默认模式仍然整文件暂存（行为未变）', async () => {
    const repo = await initRepo('octopi-stagedonly-default-');
    try {
      await writeFile(join(repo, 'f.txt'), 'a\nb\n');
      execFileSync('git', ['add', 'f.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
      await writeFile(join(repo, 'f.txt'), 'a\nB-changed\n');

      const { ctx } = mockContext(repo);
      const result = (await commitTool().handler(
        { cwd: repo, message: 'whole-file', paths: ['f.txt'] },
        ctx as never,
      )) as { exitCode: number };
      expect(result.exitCode).toBe(0);
      expect(execFileSync('git', ['show', 'HEAD:f.txt'], { cwd: repo, encoding: 'utf8' })).toBe(
        'a\nB-changed\n',
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('package_edit：path 相对 cwd 解析（不是会话 workspace）', () => {
  it('cwd=<repo> + 默认 package.json 落在仓库内，而非 workspace', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'octopi-pkg-path-'));
    const workspace = await mkdtemp(join(tmpdir(), 'octopi-pkg-ws-'));
    try {
      await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'sub' }) + '\n');
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'ws' }) + '\n');

      const edit = createPackageTools().find((t) => t.definition.name === 'package_edit')!;
      // 会话 cwd 与项目目录是两个不同目录：编辑目标必须贴 cwd 解析
      const { ctx, writes } = mockContext(workspace, { pathRoots: [workspace, repo] });
      await edit.handler({ cwd: repo, set: { 'scripts.test': 'vitest run' } }, ctx as never);

      expect(writes.length).toBe(1);
      // containment 会把路径解析到真实路径（macOS /var → /private/var），断言同样取 realpath
      const { realpathSync } = await import('node:fs');
      expect(writes[0]!.path).toBe(realpathSync(join(repo, 'package.json')));
      const parsed = JSON.parse(writes[0]!.data) as { name: string; scripts: Record<string, string> };
      expect(parsed.name).toBe('sub');
      expect(parsed.scripts.test).toBe('vitest run');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
