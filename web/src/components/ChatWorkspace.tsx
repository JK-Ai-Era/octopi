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

const DEFAULT_BASE = 'http://localhost:3000';

function formatTime(ts: number | undefined | null): string {
  if (!ts || typeof ts !== 'number' || isNaN(ts)) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString();
}

function ToolCard({ item }: { item: ToolConversationItem }) {
  const [expanded, setExpanded] = useState(false);
  const t = item;
  const statusColor = t.status === 'success' ? '#22c55e' : t.status === 'error' ? '#ef4444' : '#f59e0b';
  const hasDetails = t.args !== undefined || t.result !== undefined || t.summary !== undefined;

  return (
    <div style={{ marginBottom: 12, marginLeft: 24 }}>
      <div
        className="small muted"
        style={{ marginBottom: 4, cursor: hasDetails ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 6 }}
        onClick={() => hasDetails && setExpanded((v) => !v)}
      >
        {hasDetails && (
          <span style={{ fontSize: 10, transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        )}
        <span style={{ color: statusColor, fontWeight: 600 }}>{t.toolName}</span>
        <span className={t.status === 'error' ? 'status-error' : t.status === 'success' ? 'status-ok' : 'status-warn'}>{t.status}</span>
        <span className="small muted">{t.toolCallId}</span>
      </div>

      {t.status === 'running' && (
        <div style={{ height: 2, background: '#e5e7eb', borderRadius: 1, overflow: 'hidden', marginBottom: 4 }}>
          <div style={{ width: '40%', height: '100%', background: '#6366f1', animation: 'pulse 1.5s ease-in-out infinite' }} />
        </div>
      )}

      {t.error && <div className="small status-error" style={{ marginTop: 4 }}>{t.error}</div>}

      {expanded && (
        <div style={{ marginTop: 6, padding: 8, background: '#f9fafb', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 12 }}>
          {t.args !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>args</div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 120, overflow: 'auto' }}>{typeof t.args === 'string' ? t.args : JSON.stringify(t.args, null, 2)}</pre>
            </div>
          )}
          {t.result !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>result</div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 160, overflow: 'auto' }}>{typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2)}</pre>
            </div>
          )}
          {t.summary && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>summary</div>
              <div className="small muted">{t.summary}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolTimelineCard({ item }: { item: ToolConversationItem }) {
  const [expanded, setExpanded] = useState(false);
  const t = item;
  const statusColor = t.status === 'success' ? '#22c55e' : t.status === 'error' ? '#ef4444' : '#f59e0b';
  const hasDetails = t.result !== undefined || t.args !== undefined || t.error;

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
      <div
        style={{ cursor: hasDetails ? 'pointer' : 'default', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        onClick={() => hasDetails && setExpanded((v) => !v)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {hasDetails && (
            <span style={{ fontSize: 10, transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
          )}
          <span style={{ fontWeight: 600, color: statusColor }}>{t.toolName}</span>
          <span className={`small ${t.status === 'success' ? 'status-ok' : t.status === 'error' ? 'status-error' : 'status-warn'}`}>{t.status}</span>
        </div>
        <span className="small muted">{t.toolCallId}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, padding: 8, background: '#f9fafb', borderRadius: 6, fontSize: 12 }}>
          {t.args !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>args</div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 100, overflow: 'auto' }}>{typeof t.args === 'string' ? t.args : JSON.stringify(t.args, null, 2)}</pre>
            </div>
          )}
          {t.result !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>result</div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 160, overflow: 'auto' }}>{typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2)}</pre>
            </div>
          )}
          {t.error && (
            <div className="small status-error" style={{ marginTop: 4 }}>{t.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ConversationItemCard({ item }: { item: ConversationItem }) {
  switch (item.role) {
    case 'user': {
      const u = item as UserConversationItem;
      return (
        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ maxWidth: '75%', padding: '8px 12px', background: '#eef2ff', borderRadius: 12, borderBottomRightRadius: 4 }}>
            <div className="small muted" style={{ marginBottom: 4, textAlign: 'right' }}>user</div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{u.content}</pre>
          </div>
        </div>
      );
    }
    case 'assistant': {
      const a = item as AssistantConversationItem;
      const borderColor = a.status === 'streaming' ? '#93c5fd' : a.status === 'error' ? '#fca5a5' : '#e5e7eb';
      const statusLabel = a.status === 'streaming' ? '· streaming' : a.status === 'error' ? '· error' : '';
      return (
        <div style={{ marginBottom: 12 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>
            assistant {statusLabel && <span className={a.status === 'error' ? 'status-error' : 'status-ok'}>{statusLabel}</span>} {formatTime(a.createdAt) && <span className="small muted" style={{ marginLeft: 6 }}>{formatTime(a.createdAt)}</span>}
          </div>
          <div className="panel" style={{ padding: 10, borderColor }}>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{a.content || '(empty)'}</pre>
            {a.error && <div className="small status-error" style={{ marginTop: 6 }}>{a.error}</div>}
            {a.toolCalls && a.toolCalls.length > 0 && (
              <div className="small muted" style={{ marginTop: 6 }}>tools: {a.toolCalls.join(', ')}</div>
            )}
          </div>
        </div>
      );
    }
    case 'tool': {
      const t = item as ToolConversationItem;
      return <ToolCard item={t} />;
    }
    case 'system': {
      const s = item as SystemConversationItem;
      const bg = s.kind === 'error' ? '#fef2f2' : s.kind === 'blocked' ? '#fef2f2' : s.kind === 'warning' ? '#fffbeb' : '#f0f9ff';
      const border = s.kind === 'error' || s.kind === 'blocked' ? '#fca5a5' : s.kind === 'warning' ? '#fcd34d' : '#93c5fd';
      return (
        <div style={{ marginBottom: 12 }}>
          <div style={{ padding: '6px 12px', background: bg, border: `1px solid ${border}`, borderRadius: 8 }}>
            <span className="small" style={{ fontWeight: 600, marginRight: 6 }}>{s.kind}</span>
            <span className="small muted">{s.message}</span>
            {formatTime(s.createdAt) && <span className="small muted" style={{ marginLeft: 6 }}>{formatTime(s.createdAt)}</span>}
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}

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
  const [status, setStatus] = useState('idle');
  const [inspector, setInspector] = useState<Record<string, unknown>>({});
  const [input, setInput] = useState('');
  const [rightTab, setRightTab] = useState<'inspector' | 'tools' | 'help'>('inspector');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const clientRef = useRef<OctopiClient | null>(null);
  const storeRef = useRef<OctopiRuntimeStore | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
      if (e.detail.streaming) setStatus('streaming');
      if (!e.detail.streaming && status !== 'error') setStatus((prev) => (prev === 'streaming' ? 'idle' : prev));
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

    return () => {
      store.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, apiKey]);

  useEffect(() => {
    if (connection !== 'connected') return;
    refresh().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  useEffect(() => {
    if (!agentId && agents.length > 0) {
      setAgentId(agents[0].id);
    }
  }, [agents, agentId]);

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
    store.disconnect();
    store.connect();
    await refresh();
  };

  const openSession = async (sessionId: string) => {
    const store = storeRef.current;
    if (!store) return;
    await store.openSession(sessionId);
    setActiveSessionId(sessionId);
    setStatus('idle');
    setStream('');
  };

  const createSession = async () => {
    if (connection !== 'connected') {
      setActionError('请先连接 Gateway，再新建会话。');
      return;
    }
    if (!agentId) {
      setActionError('请先选择一个 Agent，再新建会话。');
      return;
    }

    const store = storeRef.current;
    if (!store) return;

    setActionError(null);
    setCreating(true);
    try {
      const created = await store.createSession(agentId);
      setActiveSessionId(created.id);
      setStatus('idle');
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
    setStatus('waiting');
    await store.sendMessage(input.trim());
    setInput('');
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行。
    // 兼容中文/日文等输入法：组合选词阶段的 Enter 不应触发发送。
    const nativeEvent = e.nativeEvent as unknown as { isComposing?: boolean };
    if (e.key === 'Enter' && !e.shiftKey && !e.repeat && !nativeEvent.isComposing) {
      e.preventDefault();
      if (!activeSessionId || !input.trim()) return;
      sendMessage();
    }
  };

  const abort = () => {
    storeRef.current?.abort();
    setStatus('aborted');
  };

  // Phase 3: 从 conversation items 派生 tool / system 列表
  const toolItems = conversationItems.filter((i): i is ToolConversationItem => i.role === 'tool');
  const systemItems = conversationItems.filter((i): i is SystemConversationItem => i.role === 'system');

  const connectionLabel = connection === 'connected'
    ? 'status-ok'
    : connection === 'connecting' || connection === 'reconnecting'
      ? 'status-warn'
      : 'status-neutral';

  const agentSessions = sessions.filter((s) => (agentId ? s.agentId === agentId : true));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr 320px', height: '100%', overflow: 'hidden' }}>
      {/* 左栏 */}
      <aside style={{ padding: 12, overflow: 'auto', borderRight: '1px solid #e5e7eb' }}>
        <section className="panel" style={{ padding: 12, marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>连接 Gateway</div>
          <div className="small muted" style={{ marginBottom: 8 }}>
            当前状态：
            <span className={connectionLabel}>{connection}</span>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <label className="small">
              Gateway URL
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
            </label>

            <button className="btn-ghost small" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? '收起高级设置' : '展开高级设置'}
            </button>

            {showAdvanced && (
              <label className="small">
                Gateway API Key
                <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
                <div className="small muted" style={{ marginTop: 4 }}>
                  这不是 LLM Key。只有当 Gateway 侧配置了协议鉴权时才需要填写；如果服务端未启用，可留空。
                </div>
              </label>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary" onClick={reconnect}>重连</button>
              <button className="btn-secondary" onClick={refresh}>刷新数据</button>
            </div>

            {connectError && (
              <div className="small status-error" style={{ marginTop: 4 }}>
                {connectError}
              </div>
            )}
          </div>
        </section>

        <section className="panel" style={{ padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontWeight: 600 }}>选择 Agent</div>
            <span className="small muted">{agents.length}</span>
          </div>
          {connection !== 'connected' ? (
            <div className="small muted">请先连接 Gateway</div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {agents.map((a) => (
                <button
                  key={a.id}
                  className={agentId === a.id ? 'btn-secondary selected-option' : 'btn-secondary'}
                  onClick={() => setAgentId(a.id)}
                  style={{
                    textAlign: 'left',
                    background: agentId === a.id ? '#eef2ff' : undefined,
                    borderColor: agentId === a.id ? '#a5b4fc' : undefined,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{a.id}</div>
                  <div className="small muted">{a.model.model}</div>
                </button>
              ))}
              {!agents.length && <div className="small muted">未发现可用 agents</div>}
            </div>
          )}
        </section>

        <section className="panel" style={{ padding: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>开始新会话</div>
          <div className="small muted" style={{ marginBottom: 8 }}>
            {agentId ? `当前 agent: ${agentId}` : '请先选择 agent'}
          </div>
          <button
            className="btn-primary"
            onClick={createSession}
            disabled={creating}
            style={{ width: '100%', marginBottom: 8, opacity: creating ? 0.7 : 1 }}
          >
            {creating ? '创建中...' : '新建会话'}
          </button>

          {actionError && (
            <div className="small status-error" style={{ marginBottom: 8 }}>
              {actionError}
            </div>
          )}

          <div style={{ fontWeight: 600, marginBottom: 8 }}>历史会话</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {agentSessions.map((s) => (
              <button
                key={s.id}
                className="btn-secondary"
                onClick={() => openSession(s.id)}
                style={{
                  textAlign: 'left',
                  background: activeSessionId === s.id ? '#f8fafc' : undefined,
                }}
              >
                <div style={{ fontWeight: 600 }}>{s.id}</div>
                <div className="small muted">{s.agentId} · {formatTime(s.lastInteractionAt ?? (s as any).updatedAt ?? (s as any).createdAt)}</div>
              </button>
            ))}
            {!agentSessions.length && <div className="small muted">暂无历史会话</div>}
          </div>
        </section>
      </aside>

      {/* 中栏 */}
      <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #e5e7eb', background: 'white' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{activeSessionId ?? '未选择 session'}</div>
              <div className="small muted">{agentId ? `agent: ${agentId}` : '请先选择 agent'}</div>
            </div>
            <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="small muted" style={{ marginRight: 8 }}>[{viewMode}]</span>
              <span className={status === 'error' ? 'status-error' : status === 'streaming' ? 'status-ok' : 'status-neutral'}>{status}</span>
              <button className="btn-secondary" onClick={abort} disabled={status !== 'streaming' && status !== 'waiting'}>Abort</button>
            </div>
          </div>
        </div>

        <div ref={scrollRef} style={{ flex: 1, padding: 14, overflowY: 'auto', minHeight: 0 }}>
          {!activeSessionId && (
            <div className="panel" style={{ padding: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>从左侧开始</div>
              <div className="small muted">
                先确认 Gateway 已连接，再选择 Agent，然后点左侧明显的 <b>新建会话</b>。
              </div>
            </div>
          )}

          {conversationItems.map((item) => (
            <ConversationItemCard key={item.id} item={item} />
          ))}

          {stream && status === 'streaming' && !conversationItems.some(
            (i) => i.role === 'assistant' && (i as AssistantConversationItem).status === 'streaming',
          ) && (
            <div style={{ marginBottom: 12 }}>
              <div className="small muted" style={{ marginBottom: 4 }}>assistant · streaming</div>
              <div className="panel" style={{ padding: 10, borderColor: '#93c5fd' }}>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{stream}</pre>
              </div>
            </div>
          )}
        </div>

        <div style={{ borderTop: '1px solid #e5e7eb', padding: 12, background: 'white', flexShrink: 0 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleComposerKeyDown}
            rows={4}
            placeholder="输入消息，发送到当前 session"
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
            <div className="small muted">
              {activeSessionId ? `发送到 ${activeSessionId}` : '请先打开一个 session'}。按 Enter 发送，Shift+Enter 换行。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary" onClick={() => setInput('')}>清空</button>
              <button className="btn-primary" onClick={sendMessage} disabled={!activeSessionId || !input.trim()}>发送</button>
            </div>
          </div>
        </div>
      </section>

      {/* 右栏 */}
      <aside style={{ borderLeft: '1px solid #e5e7eb', padding: 12, overflow: 'auto' }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button className={rightTab === 'inspector' ? 'btn-tab btn-tab-active' : 'btn-tab'} onClick={() => setRightTab('inspector')}>Inspector</button>
          <button className={rightTab === 'tools' ? 'btn-tab btn-tab-active' : 'btn-tab'} onClick={() => setRightTab('tools')}>Tools</button>
          <button className={rightTab === 'help' ? 'btn-tab btn-tab-active' : 'btn-tab'} onClick={() => setRightTab('help')}>Help</button>
        </div>

        {rightTab === 'inspector' && (
          <div style={{ display: 'grid', gap: 12 }}>
            <section className="panel" style={{ padding: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>会话状态</div>
              <div className="small">viewMode: {viewMode}</div>
              <div className="small">status: {status}</div>
              <div className="small">session: {activeSessionId ?? 'none'}</div>
              <div className="small">agent: {agentId || 'none'}</div>
              <div className="small">connection: {connection}</div>
            </section>

            {systemItems.length > 0 && (
              <section className="panel" style={{ padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontWeight: 600 }}>System notices</div>
                  <span className="small muted">{systemItems.length}</span>
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {systemItems.map((s) => (
                    <div key={s.id} style={{ padding: '4px 8px', borderRadius: 6, background: s.kind === 'error' || s.kind === 'blocked' ? '#fef2f2' : s.kind === 'warning' ? '#fffbeb' : '#f0f9ff', border: `1px solid ${s.kind === 'error' || s.kind === 'blocked' ? '#fca5a5' : s.kind === 'warning' ? '#fcd34d' : '#93c5fd'}` }}>
                      <span className="small" style={{ fontWeight: 600 }}>{s.kind}</span>
                      <span className="small muted" style={{ marginLeft: 6 }}>{s.message}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="panel" style={{ padding: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Runtime inspector</div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(inspector, null, 2)}</pre>
            </section>
          </div>
        )}

        {rightTab === 'tools' && (
          <section className="panel" style={{ padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>Tool timeline</div>
              <span className="small muted">{toolItems.length}</span>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {toolItems.map((t) => (
                <ToolTimelineCard key={t.toolCallId} item={t} />
              ))}
              {!toolItems.length && <div className="small muted">暂无工具运行记录</div>}
            </div>
          </section>
        )}

        {rightTab === 'help' && (
          <section className="panel" style={{ padding: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>第一版交互说明</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>左栏负责连接、Agent、会话创建</li>
              <li>中栏负责主聊天链路</li>
              <li>右栏负责运行时解释</li>
              <li>默认连接成功后会自动刷新可用 Agent 和 Session</li>
              <li>输入框支持 Enter 发送，Shift+Enter 换行</li>
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}
