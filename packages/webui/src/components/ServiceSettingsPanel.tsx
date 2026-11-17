/**
 * 服务设置（§5d 服务组 / §7b 连接组）：Gateway URL + API Key + 测试连接。
 * 三层钥匙口径：本机部署由 serve-webui 自动下发（无需手填）；远程/跨域手填存浏览器本机；
 * 反代部署可由 nginx 加头注入。
 */

import { useState } from 'react';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, setConsoleKey } from '../console-key';
import { useT } from '../i18n/react';

const GATEWAY_URL_STORAGE_KEY = 'octopi.console.gatewayUrl';

/** 读手填的 Gateway URL 覆盖（浏览器本机） */
export function getConsoleGatewayUrlOverride(): string {
  try {
    return window.localStorage.getItem(GATEWAY_URL_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 写手填覆盖；空串 = 清除（回到自动解析） */
export function setConsoleGatewayUrlOverride(url: string): void {
  try {
    if (url) {
      window.localStorage.setItem(GATEWAY_URL_STORAGE_KEY, url.replace(/\/$/, ''));
    } else {
      window.localStorage.removeItem(GATEWAY_URL_STORAGE_KEY);
    }
  } catch {
    // 存储不可用：刷新后回到自动解析，不假装已持久化
  }
}

export function ServiceSettingsPanel(): JSX.Element {
  const t = useT();
  const [gatewayUrl, setGatewayUrl] = useState(getConsoleGatewayUrlOverride());
  const [apiKey, setApiKey] = useState(getConsoleKey());
  const [testState, setTestState] = useState<{ status: 'idle' | 'busy' | 'ok' | 'fail'; detail?: string }>({ status: 'idle' });

  const testConnection = async (): Promise<void> => {
    setTestState({ status: 'busy' });
    try {
      const base = gatewayUrl.trim().replace(/\/$/, '') || resolveDefaultBase();
      const res = await fetch(`${base}/health`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const body = (await res.json()) as { ok?: boolean; data?: { agents?: unknown[] } };
      if (res.ok && body.ok) {
        const agents = Array.isArray(body.data?.agents) ? body.data!.agents!.length : 0;
        setTestState({ status: 'ok', detail: t('serviceSettings.connected', { base, count: agents }) });
      } else {
        setTestState({ status: 'fail', detail: t('serviceSettings.rejected', { status: res.status }) });
      }
    } catch (e) {
      setTestState({
        status: 'fail',
        detail: t('serviceSettings.unreachable', { error: e instanceof Error ? e.message : String(e) }),
      });
    }
  };

  return (
    <div className="panel" style={{ display: 'grid', gap: 12 }}>
      <h3 style={{ margin: 0 }}>{t('serviceSettings.title')}</h3>
      <p className="small muted" style={{ margin: 0 }}>
        {t('serviceSettings.hint')}
      </p>
      <label className="small" style={{ display: 'grid', gap: 4, maxWidth: 420 }}>
        {t('serviceSettings.gatewayUrlLabel')}
        <input
          value={gatewayUrl}
          placeholder="http://&lt;host&gt;:18180"
          onChange={(e) => setGatewayUrl(e.target.value)}
        />
      </label>
      <label className="small" style={{ display: 'grid', gap: 4, maxWidth: 420 }}>
        {t('serviceSettings.apiKeyLabel')}
        <input
          type="password"
          value={apiKey}
          placeholder={t('serviceSettings.apiKeyPlaceholder')}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          className="btn-primary small"
          onClick={() => {
            setConsoleGatewayUrlOverride(gatewayUrl.trim());
            setConsoleKey(apiKey.trim());
            void testConnection();
          }}
        >
          {t('serviceSettings.saveAndTest')}
        </button>
        {testState.status === 'busy' && <span className="small muted">{t('serviceSettings.testing')}</span>}
        {testState.status === 'ok' && <span className="small status-ok">{testState.detail}</span>}
        {testState.status === 'fail' && <span className="small status-error">{testState.detail}</span>}
      </div>
    </div>
  );
}
