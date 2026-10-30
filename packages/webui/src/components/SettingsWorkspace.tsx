/**
 * SettingsWorkspace — 设置容器（模型 / Agent / 备份 三 tab）
 * 顶部：未知键黄条（告警不阻断保存，手动清理；P3 方案3）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OctopiClient } from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey } from '../console-key';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { AgentSettingsPanel } from './AgentSettingsPanel';
import { ConfigBackupPanel } from './ConfigBackupPanel';

type SettingsTab = 'models' | 'agents' | 'backups';

export function SettingsWorkspace() {
  const [tab, setTab] = useState<SettingsTab>('models');
  const client = useMemo(
    () => new OctopiClient({ baseUrl: resolveDefaultBase(), apiKey: getConsoleKey() || undefined }),
    [],
  );
  const [unknownKeys, setUnknownKeys] = useState<string[]>([]);
  const [unknownHash, setUnknownHash] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshUnknownKeys = useCallback(async () => {
    try {
      const view = await client.getConfigUnknownKeys();
      setUnknownKeys(view.keys);
      setUnknownHash(view.hash);
    } catch {
      // 黄条是辅助信息：拉取失败不阻断设置面板
    }
  }, [client]);

  useEffect(() => {
    void refreshUnknownKeys();
  }, [refreshUnknownKeys]);

  const cleanupUnknownKeys = async () => {
    if (
      !window.confirm(
        `确认从配置删除这些无效键？\n\n${unknownKeys.join('\n')}\n\n（它们运行时本就被忽略；删除前会自动备份）`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const result = await client.cleanupConfigUnknownKeys(unknownHash);
      setUnknownKeys(result.warnings ?? []);
      setUnknownHash(result.hash);
    } catch {
      // 冲突等错误：重拉展示最新态
      await refreshUnknownKeys();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <nav className="app-nav">
        <button
          type="button"
          className={tab === 'models' ? 'app-brand' : 'btn-ghost'}
          onClick={() => setTab('models')}
        >
          模型
        </button>
        <button
          type="button"
          className={tab === 'agents' ? 'app-brand' : 'btn-ghost'}
          onClick={() => setTab('agents')}
        >
          Agent
        </button>
        <button
          type="button"
          className={tab === 'backups' ? 'app-brand' : 'btn-ghost'}
          onClick={() => setTab('backups')}
        >
          备份 / 回滚
        </button>
      </nav>

      {unknownKeys.length > 0 && (
        <div className="set-notice" style={{ margin: '8px 24px 0', background: 'rgba(255, 193, 7, 0.15)', color: '#8a6d00' }}>
          ⚠️ 以下配置键运行时会忽略（可能是拼写错误）：<span className="mono">{unknownKeys.join(', ')}</span>
          <button type="button" className="btn-ghost small" disabled={busy} onClick={cleanupUnknownKeys} style={{ marginLeft: 12 }}>
            {busy ? '清理中…' : '清理无效键'}
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {tab === 'models' ? <ModelSettingsPanel /> : tab === 'agents' ? <AgentSettingsPanel /> : <ConfigBackupPanel />}
      </div>
    </div>
  );
}
