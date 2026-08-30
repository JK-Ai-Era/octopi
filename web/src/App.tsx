import ChatWorkspace from './components/ChatWorkspace';

export default function App() {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#f6f7f9' }}>
      <header style={{ padding: '10px 16px', borderBottom: '1px solid #e5e7eb', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <strong>Octopi Web</strong>
          <span className="small muted">第一版交互骨架</span>
        </div>
        <div className="small muted">Chat-first workspace</div>
      </header>
      <main style={{ flex: 1, minHeight: 0 }}>
        <ChatWorkspace />
      </main>
    </div>
  );
}
