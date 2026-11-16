/**
 * 登录页（m4：②③模式 registry 登录）。
 * personal 模式不渲染此页（免登录）；(tenant?, name) + password → /registry/login → token 存本机。
 */

import { useState } from 'react';
import { OctopiClient } from '@octopi-agent/gateway/web/sdk/client.js';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, setRegistryToken, getRegistryToken } from '../console-key';
import { getDeploymentMode } from '../runtime-config';

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }): JSX.Element {
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
        setError('用户名或密码不正确');
      } else {
        setError('无法连接登录服务，请检查服务状态后重试');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel wizard-panel">
      <h2>登录</h2>
      <p className="small muted">
        {mode === 'multi-organization' ? '多组织部署——请输入组织、用户名与密码。' : '组织部署——请输入用户名与密码。'}
      </p>
      <div className="wizard-form">
        {mode === 'multi-organization' && (
          <label className="small">
            组织
            <input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="组织名" />
          </label>
        )}
        <label className="small">
          用户名
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" />
        </label>
        <label className="small">
          密码
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
        {busy ? '登录中…' : '登录'}
      </button>
    </div>
  );
}
