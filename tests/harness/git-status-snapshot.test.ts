/**
 * git-status-snapshot — porcelain v2 解析（纯函数）+ readGitStatusSnapshot 真实仓库冒烟。
 * 功能段在无 git 时跳过。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  parsePorcelainV2,
  readGitStatusSnapshot,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/git-status-snapshot.js';
import { findExecutable } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';

const gitAvailable = findExecutable('git') !== null;

const z = (records: string[]): string => records.join('\0') + '\0';

describe('parsePorcelainV2', () => {
  it('解析分支头（upstream + ahead/behind）与普通改动', () => {
    const s = parsePorcelainV2(
      z([
        '# branch.oid d681a2f000000000000000000000000000000000',
        '# branch.head feat/git-tab',
        '# branch.upstream origin/feat/git-tab',
        '# branch.ab +2 -0',
        '1 .M N. 100644 100644 100644 aaaaaaa bbbbbbb src/app.ts',
      ]),
    );
    expect(s.branch).toEqual({
      oid: 'd681a2f000000000000000000000000000000000',
      head: 'feat/git-tab',
      detached: false,
      initial: false,
      upstream: 'origin/feat/git-tab',
      ahead: 2,
      behind: 0,
    });
    expect(s.entries).toEqual([
      { kind: 'changed', group: 'unstaged', x: '.', y: 'M', path: 'src/app.ts' },
    ]);
    expect(s.counts).toEqual({ conflicted: 0, staged: 0, unstaged: 1, untracked: 0 });
  });

  it('识别 (initial) 与 (detached)', () => {
    const initial = parsePorcelainV2(z(['# branch.oid (initial)', '# branch.head main']));
    expect(initial.branch).toMatchObject({ oid: null, initial: true, head: 'main' });

    const detached = parsePorcelainV2(
      z(['# branch.oid abc1234', '# branch.head (detached)']),
    );
    expect(detached.branch).toMatchObject({ oid: 'abc1234', detached: true, head: null });
  });

  it('部分暂存 MM 按 git 语义出两行：暂存 + 未暂存，计数各 1', () => {
    const s = parsePorcelainV2(z(['1 MM N. 100644 100644 100644 a b file.txt']));
    expect(s.counts).toEqual({ conflicted: 0, staged: 1, unstaged: 1, untracked: 0 });
    expect(s.entries).toHaveLength(2);
    expect(s.entries.map((e) => e.group)).toEqual(['staged', 'unstaged']);
    expect(s.entries[0]).toMatchObject({ x: 'M', y: 'M', path: 'file.txt' });
    expect(s.entries[1]).toMatchObject({ x: 'M', y: 'M', path: 'file.txt' });
  });

  it('rename 记录消费独立的 origPath 字段', () => {
    const s = parsePorcelainV2(
      z([
        '2 R. N. 100644 100644 100644 a b R100 new-name.ts',
        'old-name.ts',
        '1 .D N. 100644 100644 100644 a b other.ts',
      ]),
    );
    expect(s.entries).toEqual([
      expect.objectContaining({
        kind: 'renamed',
        group: 'staged',
        path: 'new-name.ts',
        origPath: 'old-name.ts',
      }),
      expect.objectContaining({ kind: 'changed', group: 'unstaged', path: 'other.ts' }),
    ]);
  });

  it('冲突 u 记录与含空格的未跟踪路径', () => {
    const s = parsePorcelainV2(
      z([
        '? my file (copy).txt',
        'u UU N. 100644 100644 100644 100644 a b c conflict.txt',
      ]),
    );
    expect(s.counts).toEqual({ conflicted: 1, staged: 0, unstaged: 0, untracked: 1 });
    expect(s.entries.map((e) => e.path)).toEqual(['conflict.txt', 'my file (copy).txt']);
  });

  it('分组顺序固定：冲突 → 已暂存 → 未暂存 → 未跟踪', () => {
    const s = parsePorcelainV2(
      z([
        '? z-untracked.txt',
        '1 .M N. 100644 100644 100644 a b unstaged.txt',
        '1 M. N. 100644 100644 100644 a b staged.txt',
        'u UU N. 100644 100644 100644 100644 a b c conflicted.txt',
      ]),
    );
    expect(s.entries.map((e) => e.path)).toEqual([
      'conflicted.txt',
      'staged.txt',
      'unstaged.txt',
      'z-untracked.txt',
    ]);
  });

  it('entries 按 maxEntries 截断，counts 保持全量', () => {
    const s = parsePorcelainV2(z(['? a.txt', '? b.txt', '? c.txt']), { maxEntries: 2 });
    expect(s.truncated).toBe(true);
    expect(s.entries).toHaveLength(2);
    expect(s.counts.untracked).toBe(3);
  });

  it('格式漂移：解析失败的已知类型记录计入 skippedRecords，不静默吞掉', () => {
    const s = parsePorcelainV2(
      z(['1 BAD', 'x future-kind some payload', '1 M. N. 100644 100644 100644 a b ok.txt']),
    );
    expect(s.skippedRecords).toBe(2);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.path).toBe('ok.txt');
  });

  it('无 # 头时 branch 为 null（不是全 null 对象）', () => {
    const s = parsePorcelainV2(z(['? a.txt']));
    expect(s.branch).toBeNull();
    expect(s.skippedRecords).toBe(0);
  });
});

describe.skipIf(!gitAvailable)('readGitStatusSnapshot (functional)', () => {
  let base: string;
  let repo: string;

  const git = (cwd: string, args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
  };

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'octopi-gitsnap-'));
    repo = join(base, 'repo');
    await mkdir(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('未跟踪文件：isRepo=true 且 untracked 计数', async () => {
    await writeFile(join(repo, 'a.txt'), 'hello\n');
    const snap = await readGitStatusSnapshot(repo);
    expect(snap.isRepo).toBe(true);
    expect(snap.branch?.head).toBe('main');
    expect(snap.branch?.initial).toBe(true);
    expect(snap.counts.untracked).toBe(1);
    expect(snap.entries[0]).toMatchObject({ group: 'untracked', path: 'a.txt' });
  });

  it('提交后干净；改动未暂存；git add 后暂存', async () => {
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-m', 'init']);
    let snap = await readGitStatusSnapshot(repo);
    expect(snap.counts).toEqual({ conflicted: 0, staged: 0, unstaged: 0, untracked: 0 });
    expect(snap.branch?.initial).toBe(false);

    await writeFile(join(repo, 'a.txt'), 'changed\n');
    snap = await readGitStatusSnapshot(repo);
    expect(snap.counts.unstaged).toBe(1);

    git(repo, ['add', 'a.txt']);
    snap = await readGitStatusSnapshot(repo);
    expect(snap.counts.staged).toBe(1);
    expect(snap.counts.unstaged).toBe(0);
  });

  it('子目录读取：isRepo=true 且 repoRoot 指向仓库顶层', async () => {
    const sub = join(repo, 'sub');
    await mkdir(sub);
    const snap = await readGitStatusSnapshot(sub);
    expect(snap.isRepo).toBe(true);
    expect(await realpath(snap.repoRoot!)).toBe(await realpath(repo));
  });

  it('非仓库目录：isRepo=false 是状态不是错误', async () => {
    const plain = join(base, 'plain');
    await mkdir(plain);
    const snap = await readGitStatusSnapshot(plain);
    expect(snap.isRepo).toBe(false);
    expect(snap.repoRoot).toBeNull();
    expect(snap.entries).toEqual([]);
  });

  it('rename 记录带 origPath', async () => {
    git(repo, ['commit', '-m', 'staged', 'a.txt']);
    git(repo, ['mv', 'a.txt', 'renamed.txt']);
    const snap = await readGitStatusSnapshot(repo);
    const renamed = snap.entries.find((e) => e.kind === 'renamed');
    expect(renamed).toMatchObject({ path: 'renamed.txt', origPath: 'a.txt', group: 'staged' });
  });

  it('detached HEAD 与空仓库（initial）', async () => {
    git(repo, ['checkout', '--detach', 'HEAD']);
    let snap = await readGitStatusSnapshot(repo);
    expect(snap.branch?.detached).toBe(true);
    expect(snap.branch?.head).toBeNull();
    git(repo, ['checkout', 'main']);

    const empty = join(base, 'empty-repo');
    await mkdir(empty);
    git(empty, ['init', '-b', 'main']);
    snap = await readGitStatusSnapshot(empty);
    expect(snap.isRepo).toBe(true);
    expect(snap.branch?.initial).toBe(true);
    expect(snap.branch?.oid).toBeNull();
  });
});
