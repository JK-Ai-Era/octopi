/**
 * 右栏「目录」页签 — 会话临时允许根（transactionRoots）
 *
 * 语义：只追加/移除本会话临时 root；不放宽 pathContainment / shellEscape / mode。
 * 路径必须为绝对路径。
 */
import { useCallback, useEffect, useState } from 'react';
import type { OctopiClient } from '@octopi-agent/gateway/web/sdk/client';

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
      setError('必须是绝对路径（如 /data/scratch 或 C:\\data\\scratch）');
      return;
    }
    setBusy(true);
    try {
      setError(null);
      await client.addSessionEffectRoot(sessionId, path);
      setDraft('');
      onToast?.('已添加会话临时目录');
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
      onToast?.('已移除会话临时目录');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!sessionId) {
    return <div className="small muted">请先打开会话。</div>;
  }

  return (
    <section className="panel sidebar-section">
      <div className="sidebar-title" style={{ marginBottom: 0 }}>
        允许目录 · 仅本会话
        <button type="button" className="btn-ghost small" onClick={() => void refresh()}>
          刷新
        </button>
      </div>
      <div className="small muted" style={{ margin: '6px 0 10px' }}>
        临时追加可写/可撤销根（absolute path）。不放宽安全模式
        {mode ? `（当前 mode=${mode}）` : ''}；会话结束后失效。
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
          添加
        </button>
      </div>

      {error && <div className="small status-error" style={{ marginBottom: 8 }}>{error}</div>}

      <div className="small muted" style={{ marginBottom: 4 }}>
        会话临时（可移除）
      </div>
      {temporaryRoots.length === 0 ? (
        <div className="small muted" style={{ marginBottom: 12 }}>
          （无）
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
                移除
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="small muted" style={{ marginBottom: 4 }}>
        配置中的根（只读）
      </div>
      {configuredRoots.length === 0 ? (
        <div className="small muted">（未配置 workspace / transactionRoots）</div>
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
