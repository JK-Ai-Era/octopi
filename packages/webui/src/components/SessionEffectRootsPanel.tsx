/**
 * 右栏「目录」页签 — 会话临时允许根（transactionRoots）
 *
 * 语义：只追加/移除本会话临时 root；不放宽 pathContainment / shellEscape / mode。
 * 路径必须为绝对路径。
 */
import { useCallback, useEffect, useState } from 'react';
import type { OctopiClient } from '@octopi-agent/gateway/web/sdk/client';
import { useT } from '../i18n/react';

export function SessionEffectRootsPanel({
  client,
  sessionId,
  onToast,
}: {
  client: OctopiClient | null;
  sessionId: string | null;
  onToast?: (msg: string) => void;
}) {
  const [temporaryRoots, setTemporaryRoots] = useState<string[]>([]);
  const [configuredRoots, setConfiguredRoots] = useState<string[]>([]);
  const [mode, setMode] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();

  const refresh = useCallback(async () => {
    if (!client || !sessionId) {
      setTemporaryRoots([]);
      setConfiguredRoots([]);
      setMode(undefined);
      return;
    }
    try {
      setError(null);
      const data = await client.getSessionEffectRoots(sessionId);
      setTemporaryRoots(data.temporaryRoots ?? []);
      setConfiguredRoots(data.configuredRoots ?? []);
      setMode(data.mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addRoot = async () => {
    const path = draft.trim();
    if (!client || !sessionId || !path) return;
    if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
      setError(t('sessionEffectRoots.absolutePathRequired'));
      return;
    }
    setBusy(true);
    try {
      setError(null);
      await client.addSessionEffectRoot(sessionId, path);
      setDraft('');
      onToast?.(t('sessionEffectRoots.addedToast'));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeRoot = async (path: string) => {
    if (!client || !sessionId) return;
    setBusy(true);
    try {
      setError(null);
      await client.removeSessionEffectRoot(sessionId, path);
      onToast?.(t('sessionEffectRoots.removedToast'));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!sessionId) {
    return <div className="small muted">{t('sessionEffectRoots.noSession')}</div>;
  }

  return (
    <section className="panel sidebar-section">
      <div className="sidebar-title" style={{ marginBottom: 0 }}>
        {t('sessionEffectRoots.title')}
        <button type="button" className="btn-ghost small" onClick={() => void refresh()}>
          {t('sessionEffectRoots.refresh')}
        </button>
      </div>
      <div className="small muted" style={{ margin: '6px 0 10px' }}>
        {t('sessionEffectRoots.hintLead')}
        {mode ? t('sessionEffectRoots.hintMode', { mode }) : ''}
        {t('sessionEffectRoots.hintTail')}
      </div>
      {/* 缓存代价提示：临时根会改变前缀，跨过一轮就可能让提示缓存失效 */}
      <div className="small muted" style={{ margin: '0 0 10px' }}>
        {t('sessionEffectRoots.cacheHint')}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input
          type="text"
          className="model-select"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="/absolute/path"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void addRoot();
            }
          }}
          disabled={busy}
        />
        <button
          type="button"
          className="btn"
          disabled={busy || !draft.trim()}
          onClick={() => void addRoot()}
        >
          {t('sessionEffectRoots.add')}
        </button>
      </div>

      {error && <div className="small status-error" style={{ marginBottom: 8 }}>{error}</div>}

      <div className="small muted" style={{ marginBottom: 4 }}>
        {t('sessionEffectRoots.temporarySection')}
      </div>
      {temporaryRoots.length === 0 ? (
        <div className="small muted" style={{ marginBottom: 12 }}>
          {t('sessionEffectRoots.none')}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
          {temporaryRoots.map((p) => (
            <div
              key={p}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                border: '1px solid var(--border, #ddd)',
                borderRadius: 6,
              }}
            >
              <code
                className="small"
                style={{ flex: 1, wordBreak: 'break-all', whiteSpace: 'normal' }}
              >
                {p}
              </code>
              <button
                type="button"
                className="btn-ghost small"
                disabled={busy}
                onClick={() => void removeRoot(p)}
              >
                {t('sessionEffectRoots.remove')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="small muted" style={{ marginBottom: 4 }}>
        {t('sessionEffectRoots.configuredSection')}
      </div>
      {configuredRoots.length === 0 ? (
        <div className="small muted">{t('sessionEffectRoots.configuredEmpty')}</div>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          {configuredRoots.map((p) => (
            <code
              key={p}
              className="small"
              style={{ wordBreak: 'break-all', whiteSpace: 'normal', opacity: 0.85 }}
            >
              {p}
            </code>
          ))}
        </div>
      )}
    </section>
  );
}
