/**
 * 登录页（m4：②③模式 registry 登录）。
 * personal 模式不渲染此页（免登录）；(tenant?, name) + password → /registry/login → token 存本机。
 *
 * 两层凭证各走各的头（2026-11-13 评审）：部署级访问密钥走 Authorization（channels[].apiKey），
 * 用户身份走 X-Registry-Token。本机访问由 serve-webui 自动下发访问密钥（§7b 三层①）；
 * 远程/局域网访问拿不到下发，登录页在缺钥匙时补一条访问密钥输入（否则 /registry/login
 * 会撞 apiKey 闸的 401——登录页此前没有获取钥匙的通道，鸡生蛋）。
 */

import { useState } from 'react';
import { OctopiClient } from '@octopi-agent/gateway/web/sdk/client.js';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, setConsoleKey, setRegistryToken, getRegistryToken } from '../console-key';
import { getDeploymentMode } from '../runtime-config';
import { useT } from '../i18n/react';
import { LanguageToggle } from './LanguageToggle';
import { ThemeToggle } from './ThemeToggle';

type LoginErrorKind = 'credentials' | 'apiKey' | 'unreachable';

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }): JSX.Element {
  const t = useT();
  const mode = getDeploymentMode();
  const [tenant, setTenant] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [accessKey, setAccessKey] = useState('');
  // 缺钥匙才显形（本机已自动下发时不打扰）；apiKey 闸被拒时强制展开
  const [needAccessKey, setNeedAccessKey] = useState(() => !getConsoleKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LoginErrorKind | null>(null);

  const login = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const key = accessKey.trim();
      // 密钥只在登录成功后持久化（错输不污染 localStorage）；密钥框显形时清掉陈旧缓存
      if (needAccessKey && !key) setConsoleKey('');
      const client = new OctopiClient({
        baseUrl: resolveDefaultBase(),
        apiKey: key || getConsoleKey() || undefined,
        registryToken: getRegistryToken() || undefined,
      });
      const token = await client.registryLogin({
        name: name.trim(),
        password,
        ...(mode === 'multi-organization' && tenant.trim() ? { tenant: tenant.trim() } : {}),
      });
      if (key) setConsoleKey(key); // 闸门已验过（登录即带 Authorization），再持久化
      setRegistryToken(token);
      onLoggedIn();
    } catch (e) {
      // MINOR-7：网络/服务端故障不冒充密码错（同形防枚举只对 401 维持）；
      // apiKey 闸的 401 文案独立成第三态——那是钥匙问题，不是用户口令问题
      const msg = String(e instanceof Error ? e.message : e);
      if (msg.includes('invalid_credentials')) {
        setError('credentials');
      } else if (/api[\s_-]?key/i.test(msg)) {
        setError('apiKey');
        setNeedAccessKey(true);
      } else if (msg.includes('401')) {
        setError('credentials');
      } else {
        setError('unreachable');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-topbar">
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <div className="login-card">
        <div className="login-brand">
          <span className="login-brand-name">Octopi</span>
          <span className="login-brand-tag">Web Console</span>
        </div>
        <div className="login-heading">
          <h1 className="login-title">{t('loginPage.title')}</h1>
          <p className="login-hint">
            {mode === 'multi-organization' ? t('loginPage.hintMultiOrg') : t('loginPage.hintOrg')}
          </p>
        </div>
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && name.trim() && password) void login();
          }}
        >
          {needAccessKey && (
            <div className="login-field">
              <label className="login-label" htmlFor="login-access-key">
                {t('loginPage.accessKey')}
              </label>
              <input
                id="login-access-key"
                type="password"
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
                placeholder={t('loginPage.accessKeyPlaceholder')}
                autoComplete="off"
                aria-describedby="login-access-key-hint"
              />
              <span className="login-field-hint" id="login-access-key-hint">
                {t('loginPage.accessKeyHint')}
              </span>
            </div>
          )}
          {mode === 'multi-organization' && (
            <div className="login-field">
              <label className="login-label" htmlFor="login-org">
                {t('loginPage.org')}
              </label>
              <input
                id="login-org"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                placeholder={t('loginPage.orgPlaceholder')}
              />
            </div>
          )}
          <div className="login-field">
            <label className="login-label" htmlFor="login-username">
              {t('loginPage.username')}
            </label>
            <input id="login-username" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" />
          </div>
          <div className="login-field">
            <label className="login-label" htmlFor="login-password">
              {t('loginPage.password')}
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          {error && (
            <div className="login-error" role="alert">
              {error === 'credentials'
                ? t('loginPage.errorInvalidCredentials')
                : error === 'apiKey'
                  ? t('loginPage.errorApiKey')
                  : t('loginPage.errorUnreachable')}
            </div>
          )}
          <button type="submit" className="btn-primary login-submit" disabled={busy || !name.trim() || !password}>
            {busy ? t('loginPage.busy') : t('loginPage.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
