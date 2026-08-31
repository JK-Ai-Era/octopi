import { useEffect, useRef, useState } from 'react';
import { OctopiClient } from '../../../src/integration/web/sdk/client';
import { OctopiRuntimeStore } from '../../../src/integration/web/runtime/store';
import type {
  ConversationItem,
  UserConversationItem,
  AssistantConversationItem,
  ToolConversationItem,
  SystemConversationItem,
  ViewMode,
} from '../../../src/integration/web/conversation/types';
import type { RunStatus } from '../../../src/integration/web/runtime/store';

const DEFAULT_BASE = 'http://localhost:3000';

function formatTime(ts: number | undefined | null): string {
  if (!ts || typeof ts !== 'number' || isNaN(ts)) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString();
}

// ── Tool Card (shared between conversation and timeline) ──

function ToolCard({ item }: { item: ToolConversationItem }) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = item.status === 'success' ? 'var(--color-ok)' : item.status === 'error' ? 'var(--color-error)' : 'var(--color-warn)';
  const hasDetails = item.args !== undefined || item.result !== undefined || item.summary !== undefined;

  return (
    <div className="msg-tool">
      <div
        className="msg-tool-header"
        onClick={() => hasDetails && setExpanded(v => !v)}
      >
        {hasDetails && (
          <span className={`expand-arrow ${expanded ? 'expand-arrow-open' : ''}`}>▶</span>
        )}
        <span className="msg-tool-name" style={{ color: statusColor }}>{item.toolName}</span>
        <span className={item.status === 'error' ? 'status-error' : item.status === 'success' ? 'status-ok' : 'status-warn'}>{item.status}</span>
        <span className="small muted">{item.toolCallId}</span>
      </div>

      {item.status === 'running' && (
        <div className="tool-progress">
          <div className="tool-progress-bar" />
        </div>
      )}

      {item.error && <div className="small status-error" style={{ marginTop: 4 }}>{item.error}</div>}

      {expanded && (
        <div className="msg-tool-details">
          {item.args !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>参数</div>
              <pre>{typeof item.args === 'string' ? item.args : JSON.stringify(item.args, null, 2)}</pre>
            </div>
          )}
          {item.result !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>结果</div>
              <pre>{typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2)}</pre>
            </div>
          )}
          {item.summary && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>摘要</div>
              <div className="small muted">{item.summary}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolTimelineCard({ item }: { item: ToolConversationItem }) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = item.status === 'success' ? 'var(--color-ok)' : item.status === 'error' ? 'var(--color-error)' : 'var(--color-warn)';
  const hasDetails = item.result !== undefined || item.args !== undefined || item.error;

  return (
    <div className="tool-timeline-card">
      <div
        className="tool-timeline-header"
        onClick={() => hasDetails && setExpanded(v => !v)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {hasDetails && (
            <span className={`expand-arrow ${expanded ? 'expand-arrow-open' : ''}`}>▶</span>
          )}
          <span style={{ fontWeight: 600, color: statusColor }}>{item.toolName}</span>
          <span className={`small ${item.status === 'success' ? 'status-ok' : item.status === 'error' ? 'status-error' : 'status-warn'}`}>{item.status}</span>
        </div>
        <span className="small muted">{item.toolCallId}</span>
      </div>
      {expanded && (
        <div className="msg-tool-details" style={{ marginTop: 8 }}>
          {item.args !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>参数</div>
              <pre>{typeof item.args === 'string' ? item.args : JSON.stringify(item.args, null, 2)}</pre>
            </div>
          )}
          {item.result !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>结果</div>
              <pre>{typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2)}</pre>
            </div>
          )}
          {item.error && <div className="small status-error" style={{ marginTop: 4 }}>{item.error}</div>}
        </div>
      )}
    </div>
  );
}

// ── Conversation Item Card ──

function ConversationItemCard({ item }: { item: ConversationItem }) {
  switch (item.role) {
    case 'user': {
      const u = item as UserConversationItem;
      return (
        <div className="msg-user">
          <div className="msg-user-bubble">
            <div className="msg-user-label">用户</div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{u.content}</pre>
          </div>
        </div>
      );
    }
    case 'assistant': {
      const a = item as AssistantConversationItem;
      const borderColor = a.status === 'streaming' ? '#93c5fd' : a.status === 'error' ? '#fca5a5' : 'var(--color-border)';
      return (
        <div className="msg-assistant">
          <div className="msg-assistant-header">
            <span>助手</span>
            {a.status === 'streaming' && <span className="status-ok">· 流式输出中</span>}
            {a.status === 'error' && <span className="status-error">· 错误</span>}
            {formatTime(a.createdAt) && <span className="muted">{formatTime(a.createdAt)}</span>}
          </div>
          <div className="panel msg-assistant-body" style={{ borderColor }}>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{a.content || '(空)'}</pre>
            {a.error && <div className="small status-error" style={{ marginTop: 6 }}>{a.error}</div>}
            {a.toolCalls && a.toolCalls.length > 0 && (
              <div className="small muted" style={{ marginTop: 6 }}>工具: {a.toolCalls.join(', ')}</div>
            )}
          </div>
        </div>
      );
    }
    case 'tool':
      return <ToolCard item={item as ToolConversationItem} />;
    case 'system': {
      const s = item as SystemConversationItem;
      const variant = (s.kind === 'error' || s.kind === 'blocked') ? 'msg-system-error'
        : s.kind === 'warning' ? 'msg-system-warning' : 'msg-system-info';
      return (
        <div className="msg-system">
          <div className={`msg-system-inner ${variant}`}>
            <strong>{s.kind}</strong>
            <span className="muted">{s.message}</span>
            {formatTime(s.createdAt) && <span className="muted" style={{ marginLeft: 6 }}>{formatTime(s.createdAt)}</span>}
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}

// ── Main Component ──

export default function ChatWorkspace() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE);
  const [apiKey, setApiKey] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [connection, setConnection] = useState('idle');
  const [agents, setAgents] = useState<Array<{ id: string; model: { provider: string; model: string } }>>([]);
  const [agentId, setAgentId] = useState('');
  const [sessions, setSessions] = useState<Array<{ id: string; agentId: string; lastInteractionAt: number }>>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [conversationItems, setConversationItems] = useState<ConversationItem[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('history');
  const [stream, setStream] = useState('');
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [inspector, setInspector] = useState<Record<string, unknown>>({});
  const [input, setInput] = useState('');
  const [rightTab, setRightTab] = useState<'inspector' | 'tools' | 'help'>('inspector');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [mobileTab, setMobileTab] = useState<'chat' | 'left' | 'right'>('chat');

  const clientRef = useRef<OctopiClient | null>(null);
  const storeRef = useRef<OctopiRuntimeStore | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Initialize store once
  useEffect(() => {
    const client = new OctopiClient({ baseUrl, apiKey: apiKey || undefined });
    const store = new OctopiRuntimeStore(client);

    store.addEventListener('connection', ((e: CustomEvent) => {
      setConnection(e.detail.state);
      setAgents(e.detail.agents ?? []);
      if (e.detail.state === 'connected') setConnectError(null);
    }) as EventListener);
    store.addEventListener('sessions', ((e: CustomEvent) => {
      setSessions(e.detail.sessions);
    }) as EventListener);
    store.addEventListener('conversation', ((e: CustomEvent) => {
      setConversationItems(e.detail.items);
    }) as EventListener);
    store.addEventListener('viewMode', ((e: CustomEvent) => {
      setViewMode(e.detail.mode);
    }) as EventListener);
    store.addEventListener('stream', ((e: CustomEvent) => {
      setStream(e.detail.content);
      // Derive runStatus from store state (fixes stale closure)
      setRunStatus(store.getState().chat.runStatus);
    }) as EventListener);
    store.addEventListener('inspector', ((e: CustomEvent) => {
      setInspector(e.detail.inspector);
    }) as EventListener);
    store.addEventListener('error', ((e: CustomEvent) => {
      setConnectError(String(e.detail.error ?? ''));
    }) as EventListener);

    clientRef.current = client;
    storeRef.current = store;
    store.connect();

    return () => { store.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh on connect
  useEffect(() => {
    if (connection !== 'connected') return;
    refresh().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  // Auto-select first agent
  useEffect(() => {
    if (!agentId && agents.length > 0) setAgentId(agents[0].id);
  }, [agents, agentId]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [conversationItems, stream]);

  const refresh = async () => {
    const store = storeRef.current;
    if (!store) return;
    await store.refreshAgents();
    await store.refreshSessions(agentId || undefined);
  };

  const reconnect = async () => {
    setConnectError(null);
    setActionError(null);
    const store = storeRef.current;
    if (!store) return;
    // Use reconnect instead of destroying/recreating store
    store.reconnect(baseUrl, apiKey || undefined);
    await refresh();
  };

  const openSession = async (sessionId: string) => {
    const store = storeRef.current;
    if (!store) return;
    await store.openSession(sessionId);
    setActiveSessionId(sessionId);
    setRunStatus('idle');
    setStream('');
  };

  const createSession = async () => {
    if (connection !== 'connected') { setActionError('请先连接 Gateway，再新建会话。'); return; }
    if (!agentId) { setActionError('请先选择一个 Agent，再新建会话。'); return; }
    const store = storeRef.current;
    if (!store) return;
    setActionError(null);
    setCreating(true);
    try {
      const created = await store.createSession(agentId);
      setActiveSessionId(created.id);
      setRunStatus('idle');
      setStream('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  const sendMessage = async () => {
    const store = storeRef.current;
    if (!store || !input.trim()) return;
    setRunStatus('waiting');
    await store.sendMessage(input.trim());
    setInput('');
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as unknown as { isComposing?: boolean };
    if (e.key === 'Enter' && !e.shiftKey && !e.repeat && !nativeEvent.isComposing) {
      e.preventDefault();
      if (!activeSessionId || !input.trim()) return;
      sendMessage();
    }
  };

  const abort = () => {
    storeRef.current?.abort();
    setRunStatus('aborted');
  };

  // Derive lists from conversation items
  const toolItems = conversationItems.filter((i): i is ToolConversationItem => i.role === 'tool');
  const systemItems = conversationItems.filter((i): i is SystemConversationItem => i.role === 'system');

  const connectionLabel = connection === 'connected' ? 'status-ok'
    : connection === 'connecting' || connection === 'reconnecting' ? 'status-warn' : 'status-neutral';

  const agentSessions = sessions.filter(s => agentId ? s.agentId === agentId : true);

  const isReconnecting = connection === 'reconnecting';

  return (
    <>
      {/* Reconnect banner */}
      {isReconnecting && (
        <div className="reconnect-banner">
          连接已断开，正在重连...
        </div>
      )}

      {/* Mobile nav (hidden on desktop) */}
      <nav className="mobile-nav">
        <button className={mobileTab === 'left' ? 'mobile-nav-active' : ''} onClick={() => setMobileTab('left')}>设置</button>
        <button className={mobileTab === 'chat' ? 'mobile-nav-active' : ''} onClick={() => setMobileTab('chat')}>对话</button>
        <button className={mobileTab === 'right' ? 'mobile-nav-active' : ''} onClick={() => setMobileTab('right')}>检查</button>
      </nav>

      <main className={`app-main ${mobileTab === 'left' ? 'mobile-show-left' : ''} ${mobileTab === 'right' ? 'mobile-show-right' : ''}`}>
        {/* ── 左栏：连接、Agent、会话 ── */}
        <aside className="left-sidebar">
          <section className="panel sidebar-section">
            <div className="sidebar-title">连接 Gateway</div>
            <div className="small muted" style={{ marginBottom: 8 }}>
              状态：<span className={connectionLabel}>{connection}</span>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <label className="small">
                Gateway URL
                <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} style={{ marginTop: 4 }} />
              </label>
              <button className="btn-ghost small" onClick={() => setShowAdvanced(v => !v)}>
                {showAdvanced ? '收起高级设置' : '展开高级设置'}
              </button>
              {showAdvanced && (
                <label className="small">
                  Gateway API Key
                  <input value={apiKey} onChange={e => setApiKey(e.target.value)} style={{ marginTop: 4 }} />
                  <div className="small muted" style={{ marginTop: 4 }}>
                    非 LLM Key。仅当 Gateway 配置了协议鉴权时需要填写。
                  </div>
                </label>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-secondary" onClick={reconnect}>重连</button>
                <button className="btn-secondary" onClick={refresh}>刷新数据</button>
              </div>
              {connectError && <div className="small status-error" style={{ marginTop: 4 }}>{connectError}</div>}
            </div>
          </section>

          <section className="panel sidebar-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div className="sidebar-title" style={{ marginBottom: 0 }}>选择 Agent</div>
              <span className="small muted">{agents.length}</span>
            </div>
            {connection !== 'connected' ? (
              <div className="small muted">请先连接 Gateway</div>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {agents.map(a => (
                  <button
                    key={a.id}
                    className={`btn-secondary agent-btn ${agentId === a.id ? 'agent-btn-selected' : ''}`}
                    onClick={() => setAgentId(a.id)}
                  >
                    <div style={{ fontWeight: 600 }}>{a.id}</div>
                    <div className="small muted">{a.model.model}</div>
                  </button>
                ))}
                {!agents.length && <div className="small muted">未发现可用 Agent</div>}
              </div>
            )}
          </section>

          <section className="panel sidebar-section">
            <div className="sidebar-title">新建会话</div>
            <div className="small muted" style={{ marginBottom: 8 }}>
              {agentId ? `当前 Agent: ${agentId}` : '请先选择 Agent'}
            </div>
            <button className="btn-primary" onClick={createSession} disabled={creating} style={{ width: '100%', marginBottom: 8, opacity: creating ? 0.7 : 1 }}>
              {creating ? '创建中...' : '新建会话'}
            </button>
            {actionError && <div className="small status-error" style={{ marginBottom: 8 }}>{actionError}</div>}

            <div className="sidebar-title">历史会话</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {agentSessions.map(s => (
                <button
                  key={s.id}
                  className={`btn-secondary session-btn ${activeSessionId === s.id ? 'session-btn-active' : ''}`}
                  onClick={() => openSession(s.id)}
                >
                  <div style={{ fontWeight: 600 }}>{s.id}</div>
                  <div className="small muted">{s.agentId} · {formatTime(s.lastInteractionAt)}</div>
                </button>
              ))}
              {!agentSessions.length && <div className="small muted">暂无历史会话</div>}
            </div>
          </section>
        </aside>

        {/* ── 中栏：对话 ── */}
        <section className="center-panel">
          <div className="center-header">
            <div className="center-header-row">
              <div>
                <div style={{ fontWeight: 600 }}>{activeSessionId ?? '未选择会话'}</div>
                <div className="small muted">{agentId ? `Agent: ${agentId}` : '请先选择 Agent'}</div>
              </div>
              <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="small muted" style={{ marginRight: 8 }}>[{viewMode}]</span>
                <span className={runStatus === 'error' ? 'status-error' : runStatus === 'streaming' ? 'status-ok' : 'status-neutral'}>{runStatus}</span>
                <button className="btn-secondary" onClick={abort} disabled={runStatus !== 'streaming' && runStatus !== 'waiting'}>中止</button>
              </div>
            </div>
          </div>

          <div ref={scrollRef} className="conversation-scroll">
            {!activeSessionId && (
              <div className="panel empty-hint">
                <div className="empty-hint-title">从左侧开始</div>
                <div className="small muted">
                  先确认 Gateway 已连接，再选择 Agent，然后点击左侧的 <b>新建会话</b>。
                </div>
              </div>
            )}

            {conversationItems.map(item => (
              <ConversationItemCard key={item.id} item={item} />
            ))}

            {stream && runStatus === 'streaming' && !conversationItems.some(
              i => i.role === 'assistant' && (i as AssistantConversationItem).status === 'streaming',
            ) && (
              <div className="msg-assistant">
                <div className="msg-assistant-header">
                  <span>助手</span>
                  <span className="status-ok">· 流式输出中</span>
                </div>
                <div className="panel msg-assistant-body" style={{ borderColor: '#93c5fd' }}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{stream}</pre>
                </div>
              </div>
            )}
          </div>

          <div className="composer">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              rows={4}
              placeholder="输入消息，发送到当前会话"
            />
            <div className="composer-footer">
              <div className="small muted">
                {activeSessionId ? `发送到 ${activeSessionId}` : '请先打开一个会话'}。Enter 发送，Shift+Enter 换行。
              </div>
              <div className="composer-actions">
                <button className="btn-secondary" onClick={() => setInput('')}>清空</button>
                <button className="btn-primary" onClick={sendMessage} disabled={!activeSessionId || !input.trim()}>发送</button>
              </div>
            </div>
          </div>
        </section>

        {/* ── 右栏：检查器 ── */}
        <aside className="right-panel">
          <div className="right-tabs">
            <button className={rightTab === 'inspector' ? 'btn-tab btn-tab-active' : 'btn-tab'} onClick={() => setRightTab('inspector')}>检查</button>
            <button className={rightTab === 'tools' ? 'btn-tab btn-tab-active' : 'btn-tab'} onClick={() => setRightTab('tools')}>工具</button>
            <button className={rightTab === 'help' ? 'btn-tab btn-tab-active' : 'btn-tab'} onClick={() => setRightTab('help')}>帮助</button>
          </div>

          {rightTab === 'inspector' && (
            <div style={{ display: 'grid', gap: 12 }}>
              <section className="panel sidebar-section">
                <div className="sidebar-title">会话状态</div>
                <div className="inspector-kv">视图模式: {viewMode}</div>
                <div className="inspector-kv">运行状态: {runStatus}</div>
                <div className="inspector-kv">会话: {activeSessionId ?? '无'}</div>
                <div className="inspector-kv">Agent: {agentId || '无'}</div>
                <div className="inspector-kv">连接: {connection}</div>
              </section>

              {systemItems.length > 0 && (
                <section className="panel sidebar-section">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div className="sidebar-title" style={{ marginBottom: 0 }}>系统通知</div>
                    <span className="small muted">{systemItems.length}</span>
                  </div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {systemItems.map(s => {
                      const variant = (s.kind === 'error' || s.kind === 'blocked') ? 'msg-system-error'
                        : s.kind === 'warning' ? 'msg-system-warning' : 'msg-system-info';
                      return (
                        <div key={s.id} className={`msg-system-inner ${variant}`}>
                          <strong>{s.kind}</strong>
                          <span className="muted">{s.message}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <section className="panel sidebar-section">
                <div className="sidebar-title">运行时检查</div>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(inspector, null, 2)}</pre>
              </section>
            </div>
          )}

          {rightTab === 'tools' && (
            <section className="panel sidebar-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div className="sidebar-title" style={{ marginBottom: 0 }}>工具时间线</div>
                <span className="small muted">{toolItems.length}</span>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {toolItems.map(t => <ToolTimelineCard key={t.toolCallId} item={t} />)}
                {!toolItems.length && <div className="small muted">暂无工具运行记录</div>}
              </div>
            </section>
          )}

          {rightTab === 'help' && (
            <section className="panel sidebar-section">
              <div className="sidebar-title">使用说明</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-sm)' }}>
                <li>左栏负责连接、Agent、会话创建</li>
                <li>中栏负责主聊天链路</li>
                <li>右栏负责运行时检查</li>
                <li>连接成功后自动刷新 Agent 和会话</li>
                <li>Enter 发送，Shift+Enter 换行</li>
                <li>输入法组合选词阶段不会误触发送</li>
              </ul>
            </section>
          )}
        </aside>
      </main>
    </>
  );
}
