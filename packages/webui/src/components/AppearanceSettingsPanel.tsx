/**
 * 外观设置（§5d 外观组）：主题三态（跟随系统/浅/深，与顶栏 ThemeToggle 同一状态源）。
 */

import { ThemeToggle } from './ThemeToggle';

export function AppearanceSettingsPanel(): JSX.Element {
  return (
    <div className="panel" style={{ display: 'grid', gap: 12 }}>
      <h3 style={{ margin: 0 }}>外观</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="small muted">主题</span>
        <ThemeToggle />
        <span className="small muted">（跟随系统 / 浅色 / 深色，选择会记住）</span>
      </div>
    </div>
  );
}
