/**
 * 顶栏语言切换按钮（zh⇄en 两态）：显式选择持久化 localStorage；
 * 默认语言由配置下发（解析顺序见 i18n/core）。
 */

import { LANG_NAMES, type Lang } from '../i18n/core';
import { useLang, useT } from '../i18n/react';

/** 顶栏语言切换按钮（显示当前语言名，点击切到另一语言） */
export function LanguageToggle(): JSX.Element {
  const [lang, setLang] = useLang();
  const t = useT();
  const next: Lang = lang === 'zh' ? 'en' : 'zh';
  const names = { current: LANG_NAMES[lang], next: LANG_NAMES[next] };
  return (
    <button
      type="button"
      className="btn-ghost small"
      onClick={() => setLang(next)}
      title={t('langToggle.title', names)}
      aria-label={t('langToggle.ariaLabel', names)}
    >
      {LANG_NAMES[lang]}
    </button>
  );
}
