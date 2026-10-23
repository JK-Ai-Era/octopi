// @vitest-environment jsdom
/**
 * GitStatusPanel — 轮询 effect、快照身份键、竞态守卫的行为测试。
 * 只测纯逻辑与状态语义，不做 UI 快照。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { GitStatusPanel } from './GitStatusPanel';
import type { GitStatusView, OctopiClient } from '@octopi-agent/gateway/web/sdk/client';

/** 快照内容带 `repo:`/`file:` 前缀，避免与目录下拉选项文本重叠导致多义断言 */
function snapshotFor(path: string, overrides?: Partial<GitStatusView>): GitStatusView {
  return {
    path,
    isRepo: true,
    repoRoot: `repo:${path}`,
    branch: {
      oid: 'abc1234',
      head: 'main',
      detached: false,
      initial: false,
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
    },
    counts: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    entries: [{ kind: 'changed', group: 'staged', x: 'M', y: '.', path: `file:${path}/a.ts` }],
    truncated: false,
    skippedRecords: 0,
    generatedAt: '2026-10-23T00:00:00.000Z',
    ...overrides,
  };
}

function makeClient(options?: {
  roots?: string[];
  statusImpl?: (sessionId: string, path: string) => Promise<GitStatusView>;
}): { client: OctopiClient; status: ReturnType<typeof vi.fn> } {
  const roots = vi.fn(async (_sessionId: string) => ({
    sessionId: _sessionId,
    configuredRoots: options?.roots ?? ['/repo'],
    temporaryRoots: [],
    mode: 'workspace',
  }));
  const status = vi.fn(async (sessionId: string, path: string) =>
    options?.statusImpl ? options.statusImpl(sessionId, path) : snapshotFor(path),
  );
  const client = {
    getSessionEffectRoots: roots,
    getSessionGitStatus: status,
  } as unknown as OctopiClient;
  return { client, status };
}

describe('GitStatusPanel', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.useRealTimers();
    delete window.__OCTOPI_WEB__;
  });

  it('首拉渲染：repoRoot / 分支徽章 / 条目', async () => {
    const { client, status } = makeClient();
    render(<GitStatusPanel client={client} sessionId="s1" agentId="t1" />);
    expect(await screen.findByText('repo:/repo')).toBeTruthy();
    expect(screen.getByText('main → origin/main ↑1 ↓0')).toBeTruthy();
    expect(screen.getByText('file:/repo/a.ts')).toBeTruthy();
    expect(status).toHaveBeenCalledWith('s1', '/repo');
  });

  it('切目录：旧快照立即失效，新目录即拉取', async () => {
    const { client, status } = makeClient({ roots: ['/repoA', '/repoB'] });
    render(<GitStatusPanel client={client} sessionId="s1" agentId="t2" />);
    await screen.findByText('repo:/repoA');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/repoB' } });
    // 身份键：切目录瞬间旧快照不得继续展示
    expect(screen.queryByText('repo:/repoA')).toBeNull();
    expect(await screen.findByText('repo:/repoB')).toBeTruthy();
    expect(status).toHaveBeenCalledWith('s1', '/repoB');
  });

  it('pollSeconds=0：无周期轮询（只在选中时拉取）', async () => {
    vi.useFakeTimers();
    window.__OCTOPI_WEB__ = { gitStatusPollSeconds: 0 };
    const { client, status } = makeClient();
    render(<GitStatusPanel client={client} sessionId="s1" agentId="t3" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(status).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('pollSeconds=5：每 5s 轮询一次', async () => {
    vi.useFakeTimers();
    window.__OCTOPI_WEB__ = { gitStatusPollSeconds: 5 };
    const { client, status } = makeClient();
    render(<GitStatusPanel client={client} sessionId="s1" agentId="t4" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(status).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(status).toHaveBeenCalledTimes(4); // 首拉 + 3 个 tick
  });

  it('旧目录的慢响应不得覆盖新目录数据', async () => {
    const pending = new Map<
      string,
      { resolve: (v: GitStatusView) => void; promise: Promise<GitStatusView> }
    >();
    const { client, status } = makeClient({
      roots: ['/repoA', '/repoB'],
      statusImpl: (_sessionId, path) => {
        let resolve!: (v: GitStatusView) => void;
        const promise = new Promise<GitStatusView>((r) => {
          resolve = r;
        });
        pending.set(path, { resolve, promise });
        return promise;
      },
    });
    render(<GitStatusPanel client={client} sessionId="s1" agentId="t5" />);
    await waitFor(() => expect(status).toHaveBeenCalledWith('s1', '/repoA'));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/repoB' } });
    await waitFor(() => expect(status).toHaveBeenCalledWith('s1', '/repoB'));

    // 新目录先回、旧目录后回：旧响应必须被丢弃
    pending.get('/repoB')!.resolve(snapshotFor('/repoB'));
    expect(await screen.findByText('repo:/repoB')).toBeTruthy();
    pending.get('/repoA')!.resolve(snapshotFor('/repoA'));
    await act(async () => {});
    expect(screen.queryByText('repo:/repoA')).toBeNull();
    expect(screen.getByText('repo:/repoB')).toBeTruthy();
  });

  it('刷新失败：保留上次成功结果并显示错误横幅', async () => {
    let fail = false;
    const { client } = makeClient({
      statusImpl: async (_sessionId, path) => {
        if (fail) throw new Error('git_status_failed: boom');
        return snapshotFor(path);
      },
    });
    render(<GitStatusPanel client={client} sessionId="s1" agentId="t6" />);
    await screen.findByText('repo:/repo');

    fail = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByText(/刷新失败：git_status_failed: boom/);
    expect(screen.getByText('repo:/repo')).toBeTruthy();
  });
});
