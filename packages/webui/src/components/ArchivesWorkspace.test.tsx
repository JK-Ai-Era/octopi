// @vitest-environment jsdom
/**
 * ArchivesWorkspace — 归档/回收站双 Tab 行为（§5.2–5.4）。
 *
 * 只替换 SDK client 出口（组件自己 new 出来，无法注入），i18n 走真实实现。
 * 覆盖：组徽标/展开、倒计时警示、空态、强确认（影响面/Esc 取消/自解释按钮）、
 * 清空回收站确认流、移到回收站+撤销、恢复+打开。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import type { ArchiveEntryInfoDto } from '@octopi-agent/gateway/web/sdk/client';
import {
  ArchivesWorkspace,
  toGroups,
  formatBytes,
  remainingDays,
} from './ArchivesWorkspace';

const h = vi.hoisted(() => ({
  /** listArchives 投影（测试用例逐例设置） */
  entries: [] as ArchiveEntryInfoDto[],
  /** 调用账本 */
  calls: [] as Array<{ kind: string; arg?: string }>,
}));

vi.mock('@octopi-agent/gateway/web/sdk/client', () => ({
  OctopiClient: class {
    async listArchives(): Promise<ArchiveEntryInfoDto[]> {
      h.calls.push({ kind: 'listArchives' });
      return h.entries;
    }
    async restoreArchive(id: string): Promise<{ restored: string[]; warnings: string[] }> {
      h.calls.push({ kind: 'restoreArchive', arg: id });
      return { restored: [id], warnings: [] };
    }
    async deleteSession(id: string): Promise<{ sealed: number; purgeAt: number | null }> {
      h.calls.push({ kind: 'deleteSession', arg: id });
      return { sealed: 1, purgeAt: Date.now() + 30 * 86400000 };
    }
    async purgeArchive(id: string): Promise<{ purged: string[]; warnings: string[] }> {
      h.calls.push({ kind: 'purgeArchive', arg: id });
      return { purged: [id], warnings: [] };
    }
    async emptyTrash(): Promise<{ purged: string[]; bytes: number; warnings: string[] }> {
      h.calls.push({ kind: 'emptyTrash' });
      return { purged: ['s2'], bytes: 1024, warnings: [] };
    }
  },
}));

function entry(over: Partial<ArchiveEntryInfoDto> = {}): ArchiveEntryInfoDto {
  return {
    sessionId: 's1',
    groupSealId: 's1',
    parentSessionId: null,
    state: 'archived',
    phase: 'ready',
    sealedBy: 'manual',
    title: '会话一',
    agentId: 'default',
    tenantId: 't1',
    createdAt: 1,
    endedAt: 2,
    sealedAt: Date.now() - 86400000,
    purgeAt: null,
    bytes: 1024 * 1024,
    messageCount: 12,
    attachmentCount: 3,
    ...over,
  };
}

describe('ArchivesWorkspace', () => {
  beforeEach(() => {
    localStorage.setItem('octopi.lang', 'zh');
    h.entries = [];
    h.calls = [];
  });
  afterEach(cleanup);

  it('归档 Tab：组徽标/自动归档徽标/行元信息；组徽标展开子会话', async () => {
    h.entries = [
      entry({ sessionId: 'p', groupSealId: 'p', title: '父会话', sealedBy: 'auto', purgeAt: Date.now() + 10 * 86400000 }),
      entry({
        sessionId: 'c1',
        groupSealId: 'p',
        parentSessionId: 'p',
        title: '子会话一',
        sealedBy: 'auto',
        purgeAt: Date.now() + 10 * 86400000,
      }),
      entry({ sessionId: 's2', groupSealId: 's2', title: '单会话', sealedAt: Date.now() - 2 * 86400000 }),
    ];
    render(<ArchivesWorkspace onOpenSession={() => {}} />);
    await screen.findByText('父会话');
    // 组徽标（含 1 个子会话）+ 自动归档徽标
    expect(screen.getByText('含 1 个子会话')).toBeTruthy();
    expect(screen.getByText(/自动归档/)).toBeTruthy();
    // 手动归档徽标（单会话行）
    expect(screen.getByText(/手动归档/)).toBeTruthy();
    // 行内消息数/大小元信息
    expect(screen.getAllByText(/12 条消息/).length).toBeGreaterThan(0);
    // 组徽标点击展开子会话
    fireEvent.click(screen.getByText('含 1 个子会话'));
    expect(screen.getByText('子会话一')).toBeTruthy();
  });

  it('回收站 Tab：剩余天数升序 + ≤7 天警示文案；空态', async () => {
    h.entries = [
      entry({
        sessionId: 's2',
        groupSealId: 's2',
        state: 'trashed',
        title: '紧急会话',
        sealedBy: 'trash',
        purgeAt: Date.now() + 2 * 86400000,
      }),
      entry({
        sessionId: 's3',
        groupSealId: 's3',
        state: 'trashed',
        title: '不急会话',
        sealedBy: 'trash',
        purgeAt: Date.now() + 20 * 86400000,
      }),
    ];
    render(<ArchivesWorkspace onOpenSession={() => {}} />);
    fireEvent.click(screen.getByText('回收站'));
    await screen.findByText('紧急会话');
    // 警示文案（≤7 天）
    expect(screen.getByText(/即将自动清除/)).toBeTruthy();
    // 升序：紧急在前
    const rows = document.querySelectorAll('.archive-row');
    expect(rows[0]?.textContent).toContain('紧急会话');
    expect(rows[1]?.textContent).toContain('不急会话');
  });

  it('回收站空态文案', async () => {
    render(<ArchivesWorkspace onOpenSession={() => {}} />);
    fireEvent.click(screen.getByText('回收站'));
    await screen.findByText(/回收站为空/);
  });

  it('强确认：影响面量化 + 自解释按钮；Esc 取消不执行；确认后 purgeArchive', async () => {
    h.entries = [
      entry({ sessionId: 'p', groupSealId: 'p', title: '父会话' }),
      entry({ sessionId: 'c1', groupSealId: 'p', parentSessionId: 'p', title: '子会话一' }),
    ];
    render(<ArchivesWorkspace onOpenSession={() => {}} />);
    await screen.findByText('父会话');
    fireEvent.click(screen.getAllByRole('button', { name: '永久删除' })[0]);
    const dialog = await screen.findByRole('dialog');
    // 影响面：2 个会话（含 1 个子会话）· 附件合计
    expect(dialog.textContent).toContain('2 个会话');
    expect(dialog.textContent).toContain('1 个子会话');
    expect(dialog.textContent).toContain('无法恢复');
    // 按钮文案自解释（不是「确定」）
    expect(within(dialog).getByRole('button', { name: '永久删除' })).toBeTruthy();
    // Esc 取消 → 不执行
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.calls.some((c) => c.kind === 'purgeArchive')).toBe(false);
    // 重新打开并确认
    fireEvent.click(screen.getAllByRole('button', { name: '永久删除' })[0]);
    const dialog2 = await screen.findByRole('dialog');
    fireEvent.click(within(dialog2).getByRole('button', { name: '永久删除' }));
    await waitFor(() =>
      expect(h.calls.some((c) => c.kind === 'purgeArchive' && c.arg === 'p')).toBe(true),
    );
  });

  it('清空回收站：强确认列总数；确认后 emptyTrash', async () => {
    h.entries = [
      entry({ sessionId: 's2', groupSealId: 's2', state: 'trashed', title: 't1', sealedBy: 'trash', purgeAt: Date.now() + 86400000 }),
      entry({ sessionId: 's3', groupSealId: 's3', state: 'trashed', title: 't2', sealedBy: 'trash', purgeAt: Date.now() + 86400000 }),
    ];
    render(<ArchivesWorkspace onOpenSession={() => {}} />);
    fireEvent.click(screen.getByText('回收站'));
    await screen.findByText('t1');
    fireEvent.click(screen.getByRole('button', { name: '清空回收站' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('2 个会话');
    fireEvent.click(within(dialog).getByRole('button', { name: /永久删除 2 个会话/ }));
    await waitFor(() => expect(h.calls.some((c) => c.kind === 'emptyTrash')).toBe(true));
  });

  it('移到回收站 + 撤销 toast：deleteSession 后点撤销 → restoreArchive', async () => {
    h.entries = [entry({ sessionId: 's1', groupSealId: 's1', title: '会话一' })];
    render(<ArchivesWorkspace onOpenSession={() => {}} />);
    await screen.findByText('会话一');
    fireEvent.click(screen.getByRole('button', { name: '移到回收站' }));
    await waitFor(() =>
      expect(h.calls.some((c) => c.kind === 'deleteSession' && c.arg === 's1')).toBe(true),
    );
    const undo = await screen.findByRole('button', { name: '撤销' });
    fireEvent.click(undo);
    await waitFor(() =>
      expect(h.calls.some((c) => c.kind === 'restoreArchive' && c.arg === 's1')).toBe(true),
    );
  });

  it('恢复 + 打开：restoreArchive 后点打开 → onOpenSession(根会话 id)', async () => {
    const opened: string[] = [];
    h.entries = [entry({ sessionId: 's1', groupSealId: 's1', title: '会话一' })];
    render(<ArchivesWorkspace onOpenSession={(id) => opened.push(id)} />);
    await screen.findByText('会话一');
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() =>
      expect(h.calls.some((c) => c.kind === 'restoreArchive' && c.arg === 's1')).toBe(true),
    );
    fireEvent.click(await screen.findByRole('button', { name: '打开' }));
    expect(opened).toEqual(['s1']);
  });
});

describe('ArchivesWorkspace 纯函数', () => {
  it('formatBytes：GB/MB/KB/B 档位', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe('2.0 GB');
  });

  it('remainingDays：purgeAt=null 永久；不足一天按 0', () => {
    const now = 1_000_000_000_000;
    expect(remainingDays(null, now)).toBeNull();
    expect(remainingDays(now + 86400000 * 3, now)).toBe(3);
    expect(remainingDays(now + 1000, now)).toBe(0);
  });

  it('toGroups：组头=父会话，子会话归组；缺父取首条', () => {
    const groups = toGroups([
      entry({ sessionId: 'c1', groupSealId: 'g', parentSessionId: 'p', createdAt: 2 }),
      entry({ sessionId: 'p', groupSealId: 'g', parentSessionId: null, createdAt: 1 }),
      entry({ sessionId: 'x', groupSealId: 'x', parentSessionId: null }),
    ]);
    expect(groups).toHaveLength(2);
    const g = groups.find((x) => x.root.groupSealId === 'g')!;
    expect(g.root.sessionId).toBe('p');
    expect(g.children.map((c) => c.sessionId)).toEqual(['c1']);
    expect(g.sessions).toBe(2);
  });
});
