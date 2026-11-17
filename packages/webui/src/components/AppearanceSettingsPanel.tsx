/**
 * 外观设置（§5d 外观组）：主题三态（跟随系统/浅/深，与顶栏 ThemeToggle 同一状态源）。
 */

import { ThemeToggle } from './ThemeToggle';
import { useT } from '../i18n/react';

export function AppearanceSettingsPanel(): JSX.Element {
  const t = useT();
  return (
    <div className="panel" style={{ display: 'grid', gap: 12 }}>
      <h3 style={{ margin: 0 }}>{t('appearanceSettingsPanel.title')}</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="small muted">{t('appearanceSettingsPanel.theme')}</span>
        <ThemeToggle />
        <span className="small muted">{t('appearanceSettingsPanel.themeHint')}</span>
      </div>
    </div>
  );
}
