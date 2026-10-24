/**
 * SettingsWorkspace — 设置容器（模型 / Agent 双 tab）
 */
import { useState } from 'react';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { AgentSettingsPanel } from './AgentSettingsPanel';

type SettingsTab = 'models' | 'agents';

export function SettingsWorkspace() {
  const [tab, setTab] = useState<SettingsTab>('models');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <nav className="app-nav">
        <button
          type="button"
          className={tab === 'models' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
          onClick={() => setTab('models')}
        >
          模型
        </button>
        <button
          type="button"
          className={tab === 'agents' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
          onClick={() => setTab('agents')}
        >
          Agent
        </button>
      </nav>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {tab === 'models' ? <ModelSettingsPanel /> : <AgentSettingsPanel />}
      </div>
    </div>
  );
}
