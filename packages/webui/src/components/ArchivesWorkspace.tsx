/**
 * 归档与回收站工作台（arch/session-archive-recycle.md §5.2–§5.4）
 *
 * 双 Tab（归档 / 回收站）+ 级联组展示 + 倒计时 + 强确认对话框（影响面量化、
 * 按钮文案自解释、Esc/点外关闭=取消）+ 撤销 toast。行内操作作用于整组。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  OctopiClient,
  type ArchiveEntryInfoDto,
} from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, getRegistryToken } from '../console-key';
import { useT } from '../i18n/react';
import type { MessageKey, MessageParams } from '../i18n/core';

/** 翻译函数形状（useT 返回值） */
type TFn = (key: MessageKey, params?: MessageParams) => string;

const DAY_MS = 24 * 60 * 60 * 1000;
const URGENT_DAYS = 7;

/** toast（可带单动作；§5.4 撤销动线） */
interface WorkspaceToast {
  message: string;
  action?: { label: string; run: () => void };
}

/** 强确认请求（§5.3：影响面量化 + 按钮文案自解释） */
type ConfirmRequest =
  | { kind: 'purge'; group: ArchiveGroup }
  | { kind: 'emptyTrash'; total: number; bytes: number };

/** 级联组视图（组头=父会话行；children 折叠展示） */
interface ArchiveGroup {
  root: ArchiveEntryInfoDto;
  children: ArchiveEntryInfoDto[];
  sessions: number;
  bytes: number;
  attachments: number;
  messages: number;
}

/** 字节人类可读（GB/MB/KB/B） */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 剩余天数（完整 24h 周期数；不足一天/已过期按 0；purgeAt=null 永久返回 null） */
export function remainingDays(purgeAt: number | null, now: number): number | null {
  if (purgeAt == null) return null;
  const diff = purgeAt - now;
  if (diff <= 0) return 0;
  return Math.floor(diff / DAY_MS);
}

/** 条目列表 → 级联组（组头=parentSessionId 为 null 者；缺则取首条） */
export function toGroups(entries: ArchiveEntryInfoDto[]): ArchiveGroup[] {
  const byGroup = new Map<string, ArchiveEntryInfoDto[]>();
  for (const e of entries) {
    const members = byGroup.get(e.groupSealId);
    if (members) members.push(e);
    else byGroup.set(e.groupSealId, [e]);
  }
  return [...byGroup.values()].map((members) => {
    const sorted = [...members].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const root = sorted.find((m) => m.parentSessionId == null) ?? sorted[0];
    return {
      root,
      children: sorted.filter((m) => m.sessionId !== root.sessionId),
      sessions: members.length,
      bytes: members.reduce((sum, m) => sum + m.bytes, 0),
      attachments: members.reduce((sum, m) => sum + m.attachmentCount, 0),
      messages: members.reduce((sum, m) => sum + m.messageCount, 0),
    };
  });
}

function formatDate(ts: number | null): string {
  return ts == null ? '—' : new Date(ts).toLocaleDateString();
}

/** 强确认对话框（role=dialog / aria-modal / Esc 与点外=取消） */
function StrongConfirm({
  request,
  t,
  onCancel,
  onConfirm,
}: {
  request: ConfirmRequest;
  t: TFn;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const isPurge = request.kind === 'purge';
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        ref={ref}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t(isPurge ? 'archives.confirmPurgeTitle' : 'archives.confirmEmptyTrashTitle')}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">
          {t(isPurge ? 'archives.confirmPurgeTitle' : 'archives.confirmEmptyTrashTitle')}
        </div>
        <div className="dialog-body">
          {request.kind === 'purge' ? (
            <div>
              {request.group.children.length > 0
                ? t('archives.confirmPurgeImpact', {
                    sessions: request.group.sessions,
                    children: request.group.children.length,
                    size: formatBytes(request.group.bytes),
                    attachments: request.group.attachments,
                  })
                : t('archives.confirmPurgeImpactNoChildren', {
                    sessions: request.group.sessions,
                    size: formatBytes(request.group.bytes),
                    attachments: request.group.attachments,
                  })}
            </div>
          ) : (
            <div>
              {t('archives.confirmEmptyTrashImpact', {
                sessions: request.total,
                size: formatBytes(request.bytes),
              })}
            </div>
          )}
          <div className="dialog-note">{t('archives.confirmPurgeNote')}</div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn-secondary small" onClick={onCancel}>
            {t('archives.cancel')}
          </button>
          <button type="button" className="btn-danger small" onClick={onConfirm}>
            {request.kind === 'purge'
              ? t('archives.confirmPurgeAction')
              : t('archives.confirmEmptyTrashAction', { sessions: request.total })}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ArchivesWorkspace({
  onOpenSession,
}: {
  onOpenSession: (sessionId: string) => void;
}) {
  const t = useT();
  const client = useMemo(
    () =>
      new OctopiClient({
        baseUrl: resolveDefaultBase(),
        apiKey: getConsoleKey() || undefined,
        registryToken: getRegistryToken() || undefined,
      }),
    [],
  );
  const [tab, setTab] = useState<'archived' | 'trashed'>('archived');
  const [entries, setEntries] = useState<ArchiveEntryInfoDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [toast, setToast] = useState<WorkspaceToast | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async (): Promise<void> => {
    try {
      const items = await client.listArchives();
      setEntries(items);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 倒计时分钟级刷新（展示用；不影响操作语义）
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const groups = useMemo(() => {
    const filtered = (entries ?? []).filter((e) => e.state === tab);
    const list = toGroups(filtered);
    // 归档 Tab：归档时间倒序；回收站 Tab：剩余天数升序（最紧急在上）
    return list.sort((a, b) =>
      tab === 'archived'
        ? b.root.sealedAt - a.root.sealedAt
        : (a.root.purgeAt ?? Infinity) - (b.root.purgeAt ?? Infinity),
    );
  }, [entries, tab]);

  const trashEntries = useMemo(
    () => (entries ?? []).filter((e) => e.state === 'trashed'),
    [entries],
  );

  const toggleGroup = (groupSealId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupSealId)) next.delete(groupSealId);
      else next.add(groupSealId);
      return next;
    });
  };

  const restore = async (g: ArchiveGroup): Promise<void> => {
    setBusyKey(g.root.sessionId);
    try {
      await client.restoreArchive(g.root.sessionId);
      setToast({
        message: t('archives.restored'),
        action: { label: t('archives.open'), run: () => onOpenSession(g.root.sessionId) },
      });
      await reload();
    } catch (err) {
      setToast({ message: t('archives.actionFailed', { message: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setBusyKey(null);
    }
  };

  const moveToTrash = async (g: ArchiveGroup): Promise<void> => {
    setBusyKey(g.root.sessionId);
    try {
      // 软删=组级封存改标 trashed（服务端 DELETE /sessions/:id 语义）
      await client.deleteSession(g.root.sessionId);
      setToast({
        message: t('archives.trashed'),
        action: {
          label: t('archives.undo'),
          run: () => void restore(g),
        },
      });
      await reload();
    } catch (err) {
      setToast({ message: t('archives.actionFailed', { message: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setBusyKey(null);
    }
  };

  const purge = async (g: ArchiveGroup): Promise<void> => {
    setBusyKey(g.root.sessionId);
    try {
      const result = await client.purgeArchive(g.root.sessionId);
      setToast(
        result.warnings.length > 0
          ? { message: t('archives.warnings', { count: result.warnings.length }) }
          : { message: t('archives.confirmPurgeAction') },
      );
      await reload();
    } catch (err) {
      setToast({ message: t('archives.actionFailed', { message: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setBusyKey(null);
      setConfirm(null);
    }
  };

  const emptyTrash = async (): Promise<void> => {
    setBusyKey('__empty__');
    try {
      const result = await client.emptyTrash();
      setToast(
        result.warnings.length > 0
          ? { message: t('archives.warnings', { count: result.warnings.length }) }
          : {
              message: t('archives.confirmEmptyTrashImpact', {
                sessions: result.purged.length,
                size: formatBytes(result.bytes),
              }),
            },
      );
      await reload();
    } catch (err) {
      setToast({ message: t('archives.actionFailed', { message: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setBusyKey(null);
      setConfirm(null);
    }
  };

  const renderRow = (g: ArchiveGroup): ReactNode => {
    const isTrash = tab === 'trashed';
    const days = remainingDays(g.root.purgeAt, now);
    const autoDays = g.root.sealedBy === 'auto' ? remainingDays(g.root.purgeAt, now) : null;
    return (
      <div className="archive-row" key={g.root.sessionId}>
        <div className="archive-row-title">
          <span className="archive-title">{g.root.title || g.root.sessionId}</span>
          {g.children.length > 0 && (
            <button
              type="button"
              className="archive-group-badge"
              title={g.children.map((c) => c.title || c.sessionId).join('\n')}
              onClick={() => toggleGroup(g.root.groupSealId)}
              aria-expanded={expanded.has(g.root.groupSealId)}
            >
              {t('archives.groupBadge', { count: g.children.length })}
            </button>
          )}
          {!isTrash && g.root.sealedBy === 'auto' && autoDays != null && (
            <span className="chip">{t('archives.autoBadge', { days: autoDays })}</span>
          )}
          {!isTrash && g.root.sealedBy !== 'auto' && (
            <span className="chip muted">{t('archives.manualBadge')}</span>
          )}
        </div>
        <div className="small muted archive-row-meta">
          {isTrash
            ? `${t('archives.trashedAt', { date: formatDate(g.root.sealedAt) })} · ${t('archives.trashRowMeta', { size: formatBytes(g.bytes) })} · ${
                days != null && days <= URGENT_DAYS
                  ? days === 0
                    ? t('archives.remainingToday')
                    : t('archives.remainingDaysUrgent', { days })
                  : t('archives.remainingDays', { days: days ?? 0 })
              }`
            : `${t('archives.sealedAt', { date: formatDate(g.root.sealedAt) })} · ${t('archives.rowMeta', { messages: g.messages, size: formatBytes(g.bytes) })}`}
        </div>
        {g.children.length > 0 && expanded.has(g.root.groupSealId) && (
          <div className="archive-group-children">
            {g.children.map((c) => (
              <div key={c.sessionId} className="small muted archive-child-row">
                {c.title || c.sessionId}
              </div>
            ))}
          </div>
        )}
        <div className="archive-row-actions">
          <button
            type="button"
            className="btn-secondary small"
            disabled={busyKey === g.root.sessionId}
            onClick={() => void restore(g)}
          >
            {t('archives.restore')}
          </button>
          {!isTrash && (
            <button
              type="button"
              className="btn-secondary small"
              disabled={busyKey === g.root.sessionId}
              onClick={() => void moveToTrash(g)}
            >
              {t('archives.moveToTrash')}
            </button>
          )}
          <button
            type="button"
            className="btn-ghost small archive-danger"
            disabled={busyKey === g.root.sessionId}
            onClick={() => setConfirm({ kind: 'purge', group: g })}
          >
            {t('archives.purge')}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="panel archives-workspace">
      <div className="archives-header">
        <div className="archives-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'archived'}
            className={tab === 'archived' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
            onClick={() => setTab('archived')}
          >
            {t('archives.tabArchived')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'trashed'}
            className={tab === 'trashed' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
            onClick={() => setTab('trashed')}
          >
            {t('archives.tabTrash')}
          </button>
        </div>
        {tab === 'trashed' && trashEntries.length > 0 && (
          <button
            type="button"
            className="btn-danger small"
            onClick={() =>
              setConfirm({
                kind: 'emptyTrash',
                total: toGroups(trashEntries).reduce((n, g) => n + g.sessions, 0),
                bytes: trashEntries.reduce((sum, e) => sum + e.bytes, 0),
              })
            }
          >
            {t('archives.emptyTrashAction')}
          </button>
        )}
      </div>

      {loadError && <div className="small status-error">{t('archives.loadFailed', { message: loadError })}</div>}
      {toast && (
        <div className="archives-toast">
          <span>{toast.message}</span>
          {toast.action && (
            <button type="button" className="btn-ghost small" onClick={() => { toast.action?.run(); setToast(null); }}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}

      <div className="archives-list">
        {entries === null && <div className="small muted">…</div>}
        {entries !== null && groups.length === 0 && (
          <div className="small muted">
            {tab === 'archived' ? t('archives.emptyArchived') : t('archives.emptyTrash')}
          </div>
        )}
        {groups.map(renderRow)}
      </div>

      {confirm && (
        <StrongConfirm
          request={confirm}
          t={t}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm.kind === 'purge') void purge(confirm.group);
            else void emptyTrash();
          }}
        />
      )}
    </div>
  );
}
