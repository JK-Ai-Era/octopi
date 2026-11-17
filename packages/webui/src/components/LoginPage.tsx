/**
 * 登录页（m4：②③模式 registry 登录）。
 * personal 模式不渲染此页（免登录）；(tenant?, name) + password → /registry/login → token 存本机。
 */

import { useState } from 'react';
import { OctopiClient } from '@octopi-agent/gateway/web/sdk/client.js';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, setRegistryToken, getRegistryToken } from '../console-key';
import { getDeploymentMode } from '../runtime-config';
import { useT } from '../i18n/react';

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }): JSX.Element {
  const t = useT();
  const mode = getDeploymentMode();
  const [tenant, setTenant] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const client = new OctopiClient({ baseUrl: resolveDefaultBase(), apiKey: getConsoleKey() || undefined, registryToken: getRegistryToken() || undefined });
      const token = await client.registryLogin({
        name: name.trim(),
        password,
        ...(mode === 'multi-organization' && tenant.trim() ? { tenant: tenant.trim() } : {}),
      });
      setRegistryToken(token);
      onLoggedIn();
    } catch (e) {
      // MINOR-7：网络/服务端故障不冒充密码错（同形防枚举只对 401 维持）
      const msg = String(e instanceof Error ? e.message : e);
      if (msg.includes('invalid_credentials') || msg.includes('401')) {
        setError(t('loginPage.errorInvalidCredentials'));
      } else {
        setError(t('loginPage.errorUnreachable'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel wizard-panel">
      <h2>{t('loginPage.title')}</h2>
      <p className="small muted">
        {mode === 'multi-organization' ? t('loginPage.hintMultiOrg') : t('loginPage.hintOrg')}
      </p>
      <div className="wizard-form">
        {mode === 'multi-organization' && (
          <label className="small">
            {t('loginPage.org')}
            <input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder={t('loginPage.orgPlaceholder')} />
          </label>
        )}
        <label className="small">
          {t('loginPage.username')}
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" />
        </label>
        <label className="small">
          {t('loginPage.password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && password) void login();
            }}
          />
        </label>
      </div>
      {error && <div className="small status-error">{error}</div>}
      <button className="btn-primary" onClick={() => void login()} disabled={busy || !name.trim() || !password}>
        {busy ? t('loginPage.busy') : t('loginPage.submit')}
      </button>
    </div>
  );
}
