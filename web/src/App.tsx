import { useState } from 'react';
import ChatWorkspace from './components/ChatWorkspace';

export default function App() {
  const [inspectorFocus, setInspectorFocus] = useState(false);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-title">
          <strong>Octopi Web</strong>
          <span className="small muted">Playground</span>
        </div>
        <div className="app-header-actions">
          <button
            type="button"
            className={inspectorFocus ? 'btn-secondary small btn-focus-active' : 'btn-ghost small'}
            onClick={() => setInspectorFocus((v) => !v)}
            title="扩大右栏检查器（上下文 / Run / 任务 / 工具）"
            aria-pressed={inspectorFocus}
          >
            {inspectorFocus ? '退出 Focus' : 'Focus'}
          </button>
        </div>
      </header>
      <ChatWorkspace inspectorFocus={inspectorFocus} />
    </div>
  );
}
