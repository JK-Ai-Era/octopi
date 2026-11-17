/**
 * 右栏「附件」页签 — 本会话附件列表 + 归入项目 / 删除
 * 规格：arch/knowledge-session-attachments.md §8.2
 *
 * 弹层用 backdrop 关闭（不依赖 document 事件时序，避免与 React 点击抢序）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  OctopiClient,
  type SessionAttachmentDto,
} from '@octopi-agent/gateway/web/sdk/client';
import { useT } from '../i18n/react';

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function SessionAttachmentsPanel({
  client,
  sessionId,
  reloadToken = 0,
  onToast,
}: {
  client: OctopiClient | null;
  sessionId: string | null;
  reloadToken?: number;
  onToast?: (msg: string) => void;
}) {
  const [items, setItems] = useState<SessionAttachmentDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [promoteFor, setPromoteFor] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState('');
  const [busy, setBusy] = useState(false);
  const t = useT();

  const closeOverlays = useCallback(() => {
    setMenuFor(null);
    setPromoteFor(null);
  }, []);

  // Esc 关闭
  useEffect(() => {
    if (!menuFor && !promoteFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeOverlays();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuFor, promoteFor, closeOverlays]);

  const refresh = useCallback(async () => {
    if (!client || !sessionId) {
      setItems([]);
      return;
    }
    try {
      setError(null);
      const list = await client.listSessionAttachments(sessionId);
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadToken]);

  const doDelete = async (id: string) => {
    if (!client || !sessionId) return;
    if (!window.confirm(t('sessionAttachments.confirmDelete'))) return;
    setBusy(true);
    try {
      await client.deleteSessionAttachment(sessionId, id);
      onToast?.(t('sessionAttachments.deletedToast'));
      closeOverlays();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doPromote = async (id: string) => {
    if (!client || !sessionId || !projectKey.trim()) return;
    setBusy(true);
    try {
      await client.promoteSessionAttachment(sessionId, id, { projectKey: projectKey.trim() });
      onToast?.(t('sessionAttachments.promotedToast', { key: projectKey.trim() }));
      setProjectKey('');
      closeOverlays();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openMenu = (id: string, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 160) });
    setPromoteFor(null);
    setMenuFor(id);
  };

  if (!sessionId) {
    return <div className="small muted">{t('sessionAttachments.noSession')}</div>;
  }

  return (
    <section className="panel sidebar-section attachment-panel">
      <div className="sidebar-title" style={{ marginBottom: 0 }}>
        {t('sessionAttachments.title')}
        <button type="button" className="btn-ghost small" onClick={() => void refresh()}>
          {t('sessionAttachments.refresh')}
        </button>
      </div>
      {error && <div className="kn-error small">{error}</div>}
      {items.length === 0 ? (
        <div className="small muted" style={{ marginTop: 8 }}>
          {t('sessionAttachments.empty')}
        </div>
      ) : (
        <div className="attachment-list" style={{ marginTop: 8 }}>
          {items.map((a) => {
            const menuOpen = menuFor === a.id;
            const promoteOpen = promoteFor === a.id;
            return (
              <div key={a.id} className="attachment-row">
                <div className="corpus-row-main">
                  <div>
                    <div>
                      <strong>{a.name}</strong>{' '}
                      <span className="small muted mono">
                        {formatSize(a.sizeBytes)} · {a.status}
                        {a.searchableSourceId ? t('sessionAttachments.searchableSuffix') : ''}
                      </span>
                    </div>
                    <div className="small muted mono">{a.path}</div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost small"
                  title={t('sessionAttachments.moreTitle')}
                  // 开关置于 backdrop 之上，保证可点
                  style={menuOpen || promoteOpen ? { position: 'relative', zIndex: 90 } : undefined}
                  onClick={(e) => {
                    if (menuOpen) {
                      closeOverlays();
                    } else {
                      openMenu(a.id, e.currentTarget as HTMLElement);
                    }
                  }}
                >
                  …
                </button>

                {menuOpen && (
                  <>
                    <div className="attachment-menu-backdrop" onClick={closeOverlays} />
                    <div
                      className="attachment-menu panel"
                      style={{ top: menuPos.top, left: menuPos.left }}
                    >
                      <button
                        type="button"
                        className="btn-ghost small"
                        style={{ display: 'block', width: '100%', textAlign: 'left' }}
                        disabled={busy || Boolean(a.searchableSourceId)}
                        onClick={async () => {
                          if (!client || !sessionId) return;
                          setBusy(true);
                          try {
                            const r = await client.makeAttachmentSearchable(sessionId, a.id);
                            onToast?.(t('sessionAttachments.madeSearchableToast', { id: r.sourceId.slice(0, 10) }));
                            closeOverlays();
                            await refresh();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {a.searchableSourceId
                          ? t('sessionAttachments.alreadySearchable')
                          : t('sessionAttachments.makeSearchable')}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost small"
                        style={{ display: 'block', width: '100%', textAlign: 'left' }}
                        onClick={() => {
                          setMenuFor(null);
                          setPromoteFor(a.id);
                        }}
                      >
                        {t('sessionAttachments.promoteMenu')}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost small"
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          color: 'var(--color-danger, #b91c1c)',
                        }}
                        disabled={busy}
                        onClick={() => void doDelete(a.id)}
                      >
                        {t('sessionAttachments.deleteAction')}
                      </button>
                    </div>
                  </>
                )}

                {promoteOpen && (
                  <>
                    <div className="attachment-menu-backdrop" onClick={closeOverlays} />
                    <div
                      className="attachment-promote panel"
                      style={{ top: menuPos.top, left: menuPos.left }}
                    >
                      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
                        {t('sessionAttachments.promoteTitle')}
                      </div>
                      <input
                        className="small"
                        style={{ width: '100%', marginBottom: 6 }}
                        placeholder="projectKey"
                        value={projectKey}
                        onChange={(e) => setProjectKey(e.target.value)}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn-secondary small"
                          disabled={busy || !projectKey.trim()}
                          onClick={() => void doPromote(a.id)}
                        >
                          {t('sessionAttachments.confirmPromote')}
                        </button>
                        <button type="button" className="btn-ghost small" onClick={closeOverlays}>
                          {t('sessionAttachments.cancel')}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="corpus-foot small muted" style={{ marginTop: 8 }}>
        {t('sessionAttachments.footnote')}
      </div>
    </section>
  );
}
