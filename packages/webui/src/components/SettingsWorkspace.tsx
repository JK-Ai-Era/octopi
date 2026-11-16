/**
 * SettingsWorkspace — 设置容器（§5d 五分组：模型 / 我的组织 / 外观 / 服务 / 关于）。
 * 保存沿用配置热生效 L0–L3 + hash 乐观锁（ModelSettingsPanel 已接）。
 */

import { useState } from 'react';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { AgentSettingsPanel } from './AgentSettingsPanel';
import { ConfigBackupPanel } from './ConfigBackupPanel';
import { ServiceSettingsPanel } from './ServiceSettingsPanel';
import { AppearanceSettingsPanel } from './AppearanceSettingsPanel';
import { AboutPanel } from './AboutPanel';

export type SettingsTab = 'models' | 'org' | 'appearance' | 'services' | 'about';

export interface SettingsWorkspaceProps {
  /** 顶栏帮助按钮直达「关于」等入口指定的初始分组 */
  initialTab?: SettingsTab;
}

export function SettingsWorkspace({ initialTab = 'models' }: SettingsWorkspaceProps): JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'models', label: '模型' },
    { id: 'org', label: '我的组织' },
    { id: 'appearance', label: '外观' },
    { id: 'services', label: '服务' },
    { id: 'about', label: '关于' },
  ];

  return (
    <div style={{ display: 'flex', gap: 16, padding: 16, height: 'calc(100vh - 48px)', overflow: 'hidden' }}>
      <nav style={{ display: 'grid', gap: 4, alignContent: 'start', minWidth: 120 }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={tab === t.id ? 'btn-primary small' : 'btn-ghost small'}
            style={{ textAlign: 'left' }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'models' && <ModelSettingsPanel />}
        {tab === 'org' && <AgentSettingsPanel />}
        {tab === 'appearance' && <AppearanceSettingsPanel />}
        {tab === 'services' && (
          <div style={{ display: 'grid', gap: 16 }}>
            <ServiceSettingsPanel />
            <ConfigBackupPanel />
          </div>
        )}
        {tab === 'about' && <AboutPanel />}
      </div>
    </div>
  );
}
