/**
 * ConfigBackupPanel — 配置备份/回滚面板（P3）
 *
 * 每次配置写入自动留 `octopi.json.bak.<ts>`；这里列出并支持回滚到任一备份
 * （回滚走同一写回管线：校验 + 再备份 + 全量热重建）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OctopiClient } from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, getRegistryToken } from '../console-key';
import { useT } from '../i18n/react';

interface BackupItem {
  path: string;
  mtimeMs: number;
  size: number;
}

export function ConfigBackupPanel() {
  const t = useT();
  const client = useMemo(
    () => new OctopiClient({ baseUrl: resolveDefaultBase(), apiKey: getConsoleKey() || undefined, registryToken: getRegistryToken() || undefined }),
    [],
  );
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [hash, setHash] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [list, view] = await Promise.all([client.getConfigBackups(), client.getConfigModels()]);
      setBackups(list);
      setHash(view.hash);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rollbackTo = async (item: BackupItem) => {
    const stamp = new Date(item.mtimeMs).toLocaleString();
    if (!window.confirm(t('configBackup.confirmRollback', { time: stamp }))) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.rollbackConfig(item.path, hash);
      if (result.applied === 'restart-required') {
        setNotice(t('configBackup.rolledBackRestart'));
      } else {
        setNotice(t('configBackup.rolledBack'));
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-panel">
      <div className="set-header">
        <h2>{t('configBackup.title')}</h2>
        <span className="small muted">{t('configBackup.subtitle')}</span>
      </div>

      {error && <div className="set-error">{error}</div>}
      {notice && <div className="set-notice">{notice}</div>}

      <div className="set-list" style={{ maxWidth: 640 }}>
        {backups.length === 0 && <div className="small muted">{t('configBackup.empty')}</div>}
        {backups.map((item) => (
          <div key={item.path} className="set-item" style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <span className="small mono">{new Date(item.mtimeMs).toLocaleString()}</span>
            <span className="small muted">{Math.round(item.size / 1024)} KB</span>
            <button type="button" className="btn-ghost small" disabled={busy} onClick={() => rollbackTo(item)}>
              {t('configBackup.rollbackHere')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
