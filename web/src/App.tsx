import ChatWorkspace from './components/ChatWorkspace';

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-title">
          <strong>Octopi Web</strong>
          <span className="small muted">交互工作台</span>
        </div>
        <div className="small muted">Chat-first workspace</div>
      </header>
      <ChatWorkspace />
    </div>
  );
}
