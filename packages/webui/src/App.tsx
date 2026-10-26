import { useState } from 'react';
import ChatWorkspace from './components/ChatWorkspace';
import { KnowledgeAdminPanel } from './components/KnowledgeAdminPanel';
import { PrivilegedBadge } from './components/PrivilegedBadge';
import { SettingsWorkspace } from './components/SettingsWorkspace';

type Surface = 'playground' | 'knowledge' | 'settings';

export default function App() {
  const [inspectorFocus, setInspectorFocus] = useState(false);
  const [surface, setSurface] = useState<Surface>('playground');
  const [agentId, setAgentId] = useState('default');

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-title">
          <strong>Octopi Web</strong>
          <nav className="app-nav">
            <button
              type="button"
              className={surface === 'playground' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
              onClick={() => setSurface('playground')}
            >
              Playground
            </button>
            <button
              type="button"
              className={surface === 'knowledge' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
              onClick={() => setSurface('knowledge')}
            >
              Knowledge
            </button>
            <button
              type="button"
              className={surface === 'settings' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
              onClick={() => setSurface('settings')}
            >
              Settings
            </button>
          </nav>
        </div>
        <div className="app-header-actions">
          {/* ops P4 §8.1：常驻 PRIVILEGED 标记（非一次性 toast） */}
          <PrivilegedBadge />
          {surface === 'playground' && (
            <button
              type="button"
              className={inspectorFocus ? 'btn-secondary small btn-focus-active' : 'btn-ghost small'}
              onClick={() => setInspectorFocus((v) => !v)}
              title="扩大右栏检查器（上下文 / Run / 任务 / 工具）"
              aria-pressed={inspectorFocus}
            >
              {inspectorFocus ? '退出 Focus' : 'Focus'}
            </button>
          )}
        </div>
      </header>
      {surface === 'playground' ? (
        <ChatWorkspace
          inspectorFocus={inspectorFocus}
          onAgentIdChange={setAgentId}
        />
      ) : surface === 'knowledge' ? (
        <KnowledgeAdminPanel agentId={agentId || 'default'} />
      ) : (
        <SettingsWorkspace />
      )}
    </div>
  );
}
