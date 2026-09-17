import { useEffect, useRef, useState } from 'react';
import { MarkdownMessage } from './MarkdownMessage';
import { ContextRuntimePanel } from './ContextRuntimePanel';
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
import type { RunStatus, InspectorState } from '../../../src/integration/web/runtime/store';
import type { SessionTaskView } from '../../../src/integration/web/sdk/client';
// 浏览器侧直连 token 模块（不经 harness barrel / context/index，避免拉入 Node 专用依赖）
import { estimateTextTokens } from '../../../src/harness/context/token-estimator';
import { JSON_CHARS_PER_TOKEN } from '../../../src/harness/context/token-constants';

const DEFAULT_BASE =
  (import.meta.env.VITE_OCTOPI_BASE as string | undefined)?.replace(/\/$/, '') ||
  'http://localhost:3000';

function formatTokens(n: number | undefined | null): string {
  const value = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function estimateConversationTokens(items: ConversationItem[]): number {
  let total = 0;
  for (const item of items) {
    switch (item.role) {
      case 'user':
        total += estimateTextTokens((item as UserConversationItem).content ?? '');
        break;
      case 'assistant':
        total += estimateTextTokens((item as AssistantConversationItem).content ?? '');
        break;
      case 'tool': {
        const t = item as ToolConversationItem;
        total += estimateTextTokens(t.toolName ?? '');
        total += estimateTextTokens(t.summary ?? '');
        const argsStr = typeof t.args === 'string' ? t.args : t.args != null ? JSON.stringify(t.args) : '';
        total += Math.ceil(argsStr.length / JSON_CHARS_PER_TOKEN);
        const resultStr = typeof t.result === 'string' ? t.result : t.result != null ? JSON.stringify(t.result) : '';
        total += Math.ceil(resultStr.length / JSON_CHARS_PER_TOKEN);
        break;
      }
      default:
        break;
    }
  }
  return total;
}

function formatTimestamp(ts: number | undefined | null): string {
  if (!ts || typeof ts !== 'number' || isNaN(ts)) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  const isSameYear = d.getFullYear() === now.getFullYear();
  const dateStr = isSameYear
    ? d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${dateStr} ${time}`;
}

/** 末尾是否已有带内容的已完成 assistant（用于抑制结束后残留的「思考中」占位） */
function hasCompletedAssistantTail(items: ConversationItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === 'system') continue;
    if (it.role === 'assistant') {
      const a = it as AssistantConversationItem;
      return a.status === 'completed' && Boolean(a.content?.trim());
    }
    return false;
  }
  return false;
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
            <div className="msg-user-content">{u.content}</div>
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
            {formatTimestamp(a.createdAt) && <span className="muted">{formatTimestamp(a.createdAt)}</span>}
          </div>
          <div className="panel msg-assistant-body" style={{ borderColor }}>
            <div className="msg-assistant-content">
              {a.content ? <MarkdownMessage content={a.content} /> : '(空)' }
            </div>
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
            {formatTimestamp(s.createdAt) && <span className="muted" style={{ marginLeft: 6 }}>{formatTimestamp(s.createdAt)}</span>}
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}

// ── Session Tasks panel (read-only) ──

function statusLabel(status: SessionTaskView['status']): string {
  switch (status) {
    case 'open': return '进行中';
    case 'paused': return '已暂停';
    case 'done': return '已完成';
    case 'dropped': return '已放弃';
    default: return status;
  }
}

const TASK_STATUS_ORDER: Record<SessionTaskView['status'], number> = {
  open: 0,
  paused: 1,
  done: 2,
  dropped: 3,
};

function TaskPanel({ tasks }: { tasks: SessionTaskView[] }) {
  const goals = tasks
    .filter((t) => !t.parentId)
    .slice()
    .sort((a, b) => {
      const s = TASK_STATUS_ORDER[a.status] - TASK_STATUS_ORDER[b.status];
      if (s !== 0) return s;
      return a.createdAt - b.createdAt;
    });

  if (!goals.length) {
    return (
      <div className="tasks-empty">
        <span className="tasks-empty-icon" aria-hidden>◎</span>
        暂无会话任务
        <div style={{ marginTop: 6 }}>
          对 Agent 说「帮我建一个任务…」即可开始跟踪
        </div>
      </div>
    );
  }

  const stepsOf = (goalId: string) =>
    tasks
      .filter((t) => t.parentId === goalId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return (
    <div className="task-list">
      {goals.map((goal) => {
        const steps = stepsOf(goal.id);
        const settled = steps.filter((s) => s.status === 'done' || s.status === 'dropped').length;
        const pct = steps.length ? Math.round((settled / steps.length) * 100) : 0;
        const cardClass = `task-card task-card-${goal.status}`;

        return (
          <article key={goal.id} className={cardClass}>
            <div className="task-card-top">
              <div className="task-card-title">{goal.description}</div>
              <span className={`task-badge task-badge-${goal.status}`}>
                {statusLabel(goal.status)}
              </span>
            </div>

            {steps.length > 0 && (
              <div className="task-meta-row">
                <span>步骤 {settled}/{steps.length}</span>
                <div className="task-progress-track" title={`${pct}%`}>
                  <div className="task-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <span>{pct}%</span>
              </div>
            )}

            {goal.progressNote && (
              <div className="task-note">{goal.progressNote}</div>
            )}

            {steps.length > 0 && (
              <ul className="task-steps">
                {steps.map((step) => (
                  <li key={step.id} className={`task-step task-step-${step.status}`}>
                    <span className="task-step-mark" aria-hidden>
                      {step.status === 'done' ? '✓' : step.status === 'paused' ? '‖' : ''}
                    </span>
                    <span>{step.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
    </div>
  );
}

// ── Main Component ──

export default function ChatWorkspace() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE);
  const [apiKey, setApiKey] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [connection, setConnection] = useState('idle');
  const [agents, setAgents] = useState<Array<{ id: string; model: { provider: string; model: string; contextWindow?: number } }>>([]);
  const [agentId, setAgentId] = useState('');
  const [sessions, setSessions] = useState<Array<{ id: string; agentId: string; lastInteractionAt: number }>>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [conversationItems, setConversationItems] = useState<ConversationItem[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('history');
  const [stream, setStream] = useState('');
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [inspector, setInspector] = useState<InspectorState>({});
  const [tasks, setTasks] = useState<SessionTaskView[]>([]);
  const [input, setInput] = useState('');
  const [rightTab, setRightTab] = useState<'context' | 'tasks' | 'tools' | 'help'>('context');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [mobileTab, setMobileTab] = useState<'chat' | 'left' | 'right'>('chat');
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [contextFocus, setContextFocus] = useState(false);

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
    }) as EventListener);
    store.addEventListener('runStatus', ((e: CustomEvent) => {
      setRunStatus(e.detail.status);
    }) as EventListener);
    store.addEventListener('inspector', ((e: CustomEvent) => {
      setInspector(e.detail.inspector as InspectorState);
    }) as EventListener);
    store.addEventListener('tasks', ((e: CustomEvent) => {
      setTasks(e.detail.tasks ?? []);
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
    const state = store.getState();
    setActiveSessionId(sessionId);
    // 从 store 恢复，不硬编码 idle —— 切回时可能仍有 running 工具或流式内容
    setRunStatus(state.chat.runStatus);
    setStream(state.chat.streamingContent ?? '');
    setTasks(state.chat.tasks ?? []);
    setConversationItems(state.chat.conversation ?? []);
    setViewMode(state.chat.viewMode);
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
      setTasks(store.getTasks());
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

  const connectionLabel = connection === 'connected' ? 'status-ok'
    : connection === 'connecting' || connection === 'reconnecting' ? 'status-warn' : 'status-neutral';

  const agentSessions = sessions.filter(s => agentId ? s.agentId === agentId : true)
    .sort((a, b) => (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0));

  const VISIBLE_SESSION_COUNT = 5;
  const displayedSessions = showAllSessions ? agentSessions : agentSessions.slice(0, VISIBLE_SESSION_COUNT);
  const hiddenSessionCount = agentSessions.length - displayedSessions.length;

  const isReconnecting = connection === 'reconnecting';
  const contextTokens = typeof inspector.contextTokens === 'number'
    ? inspector.contextTokens
    : conversationItems.length > 0 ? estimateConversationTokens(conversationItems) : undefined;
  const contextWindow = typeof inspector.contextWindow === 'number' ? inspector.contextWindow : agents.find((a) => a.id === agentId)?.model?.contextWindow;

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

      <main className={`app-main ${contextFocus ? 'app-main-focus' : ''} ${mobileTab === 'left' ? 'mobile-show-left' : ''} ${mobileTab === 'right' ? 'mobile-show-right' : ''}`}>
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
              {displayedSessions.map(s => (
                <button
                  key={s.id}
                  className={`btn-secondary session-btn ${activeSessionId === s.id ? 'session-btn-active' : ''}`}
                  onClick={() => openSession(s.id)}
                >
                  <div style={{ fontWeight: 600 }}>{s.id}</div>
                  <div className="small muted">{s.agentId} · {formatTimestamp(s.lastInteractionAt)}</div>
                </button>
              ))}
              {!agentSessions.length && <div className="small muted">暂无历史会话</div>}
              {hiddenSessionCount > 0 && !showAllSessions && (
                <button
                  className="btn-ghost small"
                  style={{ marginTop: 2, textAlign: 'center', width: '100%', color: 'var(--color-muted)' }}
                  onClick={() => setShowAllSessions(true)}
                >
                  展开更多会话 ({hiddenSessionCount})
                </button>
              )}
              {showAllSessions && agentSessions.length > VISIBLE_SESSION_COUNT && (
                <button
                  className="btn-ghost small"
                  style={{ marginTop: 2, textAlign: 'center', width: '100%', color: 'var(--color-muted)' }}
                  onClick={() => setShowAllSessions(false)}
                >
                  收起会话列表
                </button>
              )}
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
                <div className="small muted" style={{ marginTop: 2 }}>
                  {`上下文: ${contextTokens !== undefined ? formatTokens(contextTokens) : '~'}${typeof contextWindow === 'number' ? ` / ${formatTokens(contextWindow)}` : ''}`}
                </div>
              </div>
              <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="small muted" style={{ marginRight: 8 }}>[{viewMode}]</span>
                <span className={runStatus === 'error' ? 'status-error' : runStatus === 'streaming' ? 'status-ok' : 'status-neutral'}>{runStatus}</span>
                <button className="btn-secondary" onClick={abort} disabled={!['streaming', 'waiting', 'tools', 'sending'].includes(runStatus)}>中止</button>
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
                  <div className="msg-assistant-content">
                    <MarkdownMessage content={stream} />
                  </div>
                </div>
              </div>
            )}

            {/* 等待模型首 token：仅在尚未出现已完成最终回复时显示，避免结束后残留占位 */}
            {!stream &&
              (runStatus === 'streaming' || runStatus === 'waiting') &&
              !conversationItems.some(
                i => i.role === 'assistant' && (i as AssistantConversationItem).status === 'streaming',
              ) &&
              !hasCompletedAssistantTail(conversationItems) && (
              <div className="msg-assistant">
                <div className="msg-assistant-header">
                  <span>助手</span>
                  <span className="status-ok">· {runStatus === 'waiting' ? '等待响应' : '思考中…'}</span>
                </div>
                <div className="panel msg-assistant-body" style={{ borderColor: '#93c5fd' }}>
                  <div className="msg-assistant-content muted">（模型尚未返回内容）</div>
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
            <button
              className={rightTab === 'context' ? 'btn-tab btn-tab-active' : 'btn-tab'}
              onClick={() => setRightTab('context')}
            >
              上下文
            </button>
            <button
              className={rightTab === 'tasks' ? 'btn-tab btn-tab-active' : 'btn-tab'}
              onClick={() => setRightTab('tasks')}
            >
              任务
              {(() => {
                const n = tasks.filter((t) => !t.parentId && (t.status === 'open' || t.status === 'paused')).length;
                return n > 0 ? <span className="tab-count">{n}</span> : null;
              })()}
            </button>
            <button className={rightTab === 'tools' ? 'btn-tab btn-tab-active' : 'btn-tab'} onClick={() => setRightTab('tools')}>工具</button>
            <button className={rightTab === 'help' ? 'btn-tab btn-tab-active' : 'btn-tab'} onClick={() => setRightTab('help')}>帮助</button>
            {rightTab === 'context' && (
              <button
                type="button"
                className="btn-ghost small"
                style={{ marginLeft: 'auto' }}
                onClick={() => setContextFocus((v) => !v)}
              >
                {contextFocus ? '退出 Focus' : 'Focus'}
              </button>
            )}
          </div>

          {rightTab === 'context' && (
            <ContextRuntimePanel
              inspector={inspector}
              viewMode={viewMode}
              runStatus={runStatus}
              sessionId={activeSessionId}
              agentId={agentId}
              connection={connection}
              messageCount={conversationItems.filter(i => i.role === 'user' || i.role === 'assistant').length}
              onRefreshLayers={async () => {
                const store = storeRef.current;
                const client = clientRef.current;
                if (!store || !client || !activeSessionId) return;
                try {
                  const layers = await client.getSessionContextLayers(activeSessionId);
                  if (layers) {
                    store.applyContextLayersSnapshot(layers);
                  }
                } catch {
                  // ignore refresh errors; UI keeps previous snapshot
                }
              }}
            />
          )}

          {rightTab === 'tasks' && (
            <div>
              <div className="tasks-panel-header">
                <div className="sidebar-title" style={{ marginBottom: 0 }}>会话任务</div>
                <span className="small muted">
                  {tasks.filter((t) => !t.parentId && (t.status === 'open' || t.status === 'paused')).length} 进行中
                </span>
              </div>
              <div className="tasks-panel-hint">
                只读列表，由 Agent 维护。对 Agent 说「把 xx 标为完成」即可更新。
              </div>
              <TaskPanel tasks={tasks} />
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
                <li>右栏「上下文」：System 契约层 + Information 消息窗口（产品第 7 层）</li>
                <li>产品七层 ≠ ContextLayer：Information 是 session，Runtime 是契约附加</li>
                <li>Focus 模式放大右栏，便于 demo / 深度调试</li>
                <li>右栏「任务」实时展示会话任务树</li>
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
