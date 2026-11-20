/**
 * AccessKeyGate — 个人模式的「访问密钥」录入页（auth-guard 的 key 闸形态）。
 *
 * 凭据被网关明确拒绝、且没有可用的自动下发钥时出现（个人模式免登录，
 * 没有登录页可回——这页就是「类似登录页」的重新录入入口）。提交后整页重建重连。
 */

import { useState } from 'react';
import { useT } from '../i18n/react';
import { consumePendingKeyRejected } from '../auth-guard';
import { LanguageToggle } from './LanguageToggle';
import { ThemeToggle } from './ThemeToggle';

export function AccessKeyGate({ onSubmit }: { onSubmit: (key: string) => void }): JSX.Element {
  const t = useT();
  const [key, setKey] = useState('');
  // 一次性消费「刚提交的钥被拒」标记：区分「还没填」与「刚填的被拒」两种打开姿态
  const [rejected, setRejected] = useState(() => consumePendingKeyRejected());

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
          <h1 className="login-title">{t('accessKeyGate.title')}</h1>
          <p className="login-hint">{t('accessKeyGate.subtitle')}</p>
        </div>
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) onSubmit(key.trim());
          }}
        >
          <div className="login-field">
            <label className="login-label" htmlFor="access-key-input">
              {t('accessKeyGate.label')}
            </label>
            <input
              id="access-key-input"
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                if (rejected) setRejected(false); // 输入即视为重新开始，撤下旧错误
              }}
              placeholder={t('accessKeyGate.placeholder')}
              autoComplete="off"
            />
            <span className="login-field-hint">{t('accessKeyGate.hint')}</span>
          </div>
          {rejected && (
            <div className="login-error" role="alert">
              {t('accessKeyGate.rejected')}
            </div>
          )}
          <button type="submit" className="btn-primary login-submit" disabled={!key.trim()}>
            {t('accessKeyGate.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
