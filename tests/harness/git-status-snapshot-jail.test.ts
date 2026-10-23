/**
 * readGitStatusSnapshot 的 jail 接线：requireJail / jailRoots 必须逐次传到 runGit
 * （rev-parse 与 status 两次调用都带上下文）。gateway 侧测试把引擎 mock 成 spy、
 * 只验「传了标志」；「引擎真的把它变成 jail 请求」这条链只能在这里锁。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runGitSpy } = vi.hoisted(() => ({ runGitSpy: vi.fn() }));

vi.mock(
  '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/git-runner.js',
  () => ({
    runGit: (...args: unknown[]) => runGitSpy(...args),
  }),
);

import { readGitStatusSnapshot } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/git-status-snapshot.js';

const ok = (stdout: string) => ({
  stdout,
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  truncated: false,
  rawStdoutLength: stdout.length,
  terminated: false,
  terminateReason: undefined,
  isolation: {},
});

describe('readGitStatusSnapshot 的 jail 上下文传递', () => {
  beforeEach(() => {
    runGitSpy.mockReset();
  });

  it('requireJail + jailRoots 传给每一次 runGit（rev-parse 与 status）', async () => {
    runGitSpy
      .mockResolvedValueOnce(ok('/repo\n'))
      .mockResolvedValueOnce(ok(''));
    const snap = await readGitStatusSnapshot('/repo', {
      requireJail: true,
      jailRoots: ['/repo', '/other'],
    });
    expect(snap.isRepo).toBe(true);
    expect(runGitSpy).toHaveBeenCalledTimes(2);
    for (const call of runGitSpy.mock.calls) {
      expect(call[0]).toEqual({ requireJail: true, pathRoots: ['/repo', '/other'] });
    }
  });

  it('无选项时上下文为空（context-free 读取不变）', async () => {
    runGitSpy
      .mockResolvedValueOnce(ok('/repo\n'))
      .mockResolvedValueOnce(ok(''));
    await readGitStatusSnapshot('/repo');
    expect(runGitSpy).toHaveBeenCalledTimes(2);
    for (const call of runGitSpy.mock.calls) {
      expect(call[0]).toBeUndefined();
    }
  });

  it('仅 jailRoots 时只带 pathRoots（fail-open 也要 jail 根可见性）', async () => {
    runGitSpy
      .mockResolvedValueOnce(ok('/repo\n'))
      .mockResolvedValueOnce(ok(''));
    await readGitStatusSnapshot('/repo', { jailRoots: ['/ws'] });
    for (const call of runGitSpy.mock.calls) {
      expect(call[0]).toEqual({ pathRoots: ['/ws'] });
    }
  });
});
