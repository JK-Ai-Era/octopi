/**
 * 主题切换（批 2-2 / §5d 暗色模式）：三态 system / light / dark，
 * system 跟随 prefers-color-scheme（matchMedia 变化实时同步到 data-theme），
 * 选择持久化 localStorage（UI 偏好）。CSS 只认 html[data-theme='dark'] 一处定义。
 * 文案走 i18n（useT），标签键见 messages/shell。
 */

import { useEffect, useState } from 'react';
import { useT } from '../i18n/react';
import type { MessageKey } from '../i18n/core';

type ThemePref = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'octopi.theme';

function readPref(): ThemePref {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

/** 把偏好解析为实际主题并写到 <html data-theme>（system 时解析 matchMedia） */
function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}

/** 应用启动时调用一次（main.tsx / App mount）：恢复持久化偏好 */
export function initTheme(): void {
  applyTheme(readPref());
}

const LABEL_KEYS: Record<ThemePref, MessageKey> = {
  system: 'theme.followSystem',
  light: 'theme.light',
  dark: 'theme.dark',
};
const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };

/** 顶栏主题切换按钮（三态循环；title 显示当前语义） */
export function ThemeToggle(): JSX.Element {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const t = useT();

  useEffect(() => {
    applyTheme(pref);
    localStorage.setItem(STORAGE_KEY, pref);
    if (pref !== 'system') return;
    // system 模式下跟随系统变化实时刷新
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const icon = pref === 'system' ? '◐' : pref === 'dark' ? '●' : '○';
  const mode = t(LABEL_KEYS[pref]);
  return (
    <button
      type="button"
      className="btn-ghost small"
      onClick={() => setPref((p) => NEXT[p])}
      title={t('theme.toggleTitle', { mode })}
      aria-label={t('theme.ariaLabel', { mode })}
    >
      {icon} {mode}
    </button>
  );
}
