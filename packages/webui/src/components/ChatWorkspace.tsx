import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MarkdownMessage } from './MarkdownMessage';
import { ContextRuntimePanel } from './ContextRuntimePanel';
import { RunObservatoryPanel } from './RunObservatoryPanel';
import { SessionCorpusMenu } from './SessionCorpusMenu';
import { SessionAttachmentsPanel } from './SessionAttachmentsPanel';
import { SessionEffectRootsPanel } from './SessionEffectRootsPanel';
import { GitStatusPanel } from './GitStatusPanel';
import { OctopiClient } from '@octopi-agent/gateway/web/sdk/client';
import { OctopiRuntimeStore } from '@octopi-agent/gateway/web/runtime/store';
import type {
  ConversationItem,
  UserConversationItem,
  AssistantConversationItem,
  ToolConversationItem,
  SystemConversationItem,
  ViewMode,
} from '@octopi-agent/gateway/web/conversation/types';
import type { RunStatus, InspectorState, ModelRetryInfo } from '@octopi-agent/gateway/web/runtime/store';
import type { SessionTaskView, SessionScheduleView, ModelCatalog, SessionModelView, CommandCatalogItemDto, PendingQuestion, PendingApproval, ApprovalScope, ClientToolCallDto, ClientToolDescriptorDto } from '@octopi-agent/gateway/web/sdk/client';
import { ClientToolCallCard, WebViewPreview, type RenderedWebView } from './ClientToolCallCard';
import { FileCard, FilePreviewPanel, fileRefFromCall, fileRefFromToolResult, type FileRef } from './FileDelivery';
import { looksLikeCodeOrMarkup } from '@octopi-agent/engine/harness/session/title';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, setConsoleKey } from '../console-key';

const DEFAULT_BASE = resolveDefaultBase();

/** WebUI 会话级 clientInstanceId（同一标签页稳定） */
function webuiClientInstanceId(): string {
  const key = 'octopi.webui.clientInstanceId';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = `webui_${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}

/** 从已持久化的 html_ui call 恢复预览 */
function webViewsFromCalls(calls: ClientToolCallDto[]): RenderedWebView[] {
  const out: RenderedWebView[] = [];
  for (const c of calls) {
    if (c.name !== 'html_ui' || c.state === 'pending') continue;
    const args = (c.args ?? {}) as { title?: unknown; html?: unknown; height?: unknown; mode?: unknown };
    const html = typeof args.html === 'string' ? args.html : '';
    if (!html) continue;
    out.push({
      id: c.id,
      title: typeof args.title === 'string' && args.title ? args.title : '网页',
      html,
      height: typeof args.height === 'number' ? args.height : 420,
      mode: args.mode === 'form' ? 'form' : 'display',
      createdAt: c.createdAt || 0,
    });
  }
  return out;
}

/** P0 样板 Client Tool（arch/client-tools.md） */
const WEBUI_SAMPLE_CLIENT_TOOLS: ClientToolDescriptorDto[] = [
  {
    name: 'html_ui',
    description:
      'Show an HTML UI on the user device. mode="display" (default): pure presentation, returns immediately {shown:true}. mode="form": embedded HTML form; returns {submitted:true,values} when the user submits or clicks done. Pass a complete HTML document in `html`. Prefer forms over asking for free-text when collecting structured input.',
    parameters: {
      title: { type: 'string', description: 'View title shown above the page', required: true },
      html: { type: 'string', description: 'Complete HTML document (inline CSS/JS allowed)', required: true },
      mode: {
        type: 'string',
        description: 'display = show only and return; form = collect form fields',
        enum: ['display', 'form'],
      },
      height: { type: 'number', description: 'Iframe height in px (160-1200, default 420)' },
    },
    interaction: 'ui',
    resultKinds: ['value'],
  },
  {
    name: 'photo_capture',
    description:
      'Take a photo with the device camera and return an image asset. Requires user consent. result.kind=asset.',
    parameters: {
      purpose: { type: 'string', description: 'Why the photo is needed', required: true },
    },
    interaction: 'device',
    device: { class: 'sensor', sensitivity: 'sensitive', consent: 'strict' },
    resultKinds: ['asset'],
  },
  {
    name: 'send_file',
    description:
      'Send a gateway file to the user (any format). Text and markdown open in the right File tab; images, audio, and video render in the conversation with local cache and save-as. ' +
      'Returns only a small confirmation (fileId, mime, size) — never the file body. Prefer this over dumping long file text into chat. ' +
      'For LLM-side reading of file contents use file_read instead. Paths are limited to the agent workspace and session attachments.',
    parameters: {
      path: {
        type: 'string',
        description: 'Absolute path or workspace-relative path (workspace / session attachments)',
        required: true,
      },
      title: { type: 'string', description: 'Display name (default: file basename)' },
      purpose: { type: 'string', description: 'Why this file is being sent to the user' },
    },
    interaction: 'ui',
    resultKinds: ['value'],
    processing: 'server',
  },
];

function formatTokens(n: number | undefined | null): string {
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return '未知';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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

/** 列表/标题栏展示名：有 title 用 title，否则「新会话」；标记/载荷样标题不当标题 */
function sessionDisplayTitle(s: { id: string; title?: string }): string {
  const t = s.title?.trim();
  if (!t || looksLikeCodeOrMarkup(t)) return '新会话';
  return t;
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
        <span className="msg-tool-name" style={{ color: statusColor }}>
          {item.purpose ? `${item.toolName}: ${item.purpose}` : item.toolName}
        </span>
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
          <span style={{ fontWeight: 600, color: statusColor }}>
            {item.purpose ? `${item.toolName}: ${item.purpose}` : item.toolName}
          </span>
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

function ConversationItemCard({
  item,
  onBranch,
  onEditResend,
}: {
  item: ConversationItem;
  onBranch?: (sourceIndex: number) => void;
  onEditResend?: (sourceIndex: number | undefined, content: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  switch (item.role) {
    case 'user': {
      const u = item as UserConversationItem;
      // 会话第一条用户气泡没有「更早历史」可分叉
      const canBranch = typeof u.sourceIndex === 'number' && u.sourceIndex > 0 && onBranch;
      return (
        <div className="msg-user">
          <div className={`msg-user-bubble${editing ? ' editing' : ''}`}>
            <div className="msg-user-label">
              用户
              {canBranch && (
                <button
                  className="btn-secondary"
                  style={{ marginLeft: 8, padding: '1px 8px', fontSize: 12 }}
                  title="从此条之前分叉：新会话不含本条，可改写后继续"
                  onClick={() => onBranch!(u.sourceIndex!)}
                >
                  分叉
                </button>
              )}
              {u.editResendable && onEditResend && !editing && (
                <button
                  className="btn-secondary"
                  style={{ marginLeft: 8, padding: '1px 8px', fontSize: 12 }}
                  title="编辑后重发：丢掉本轮中止残片，同会话继续"
                  onClick={() => {
                    setDraft(u.content);
                    setEditing(true);
                  }}
                >
                  编辑重发
                </button>
              )}
            </div>
            {editing ? (
              <div style={{ marginTop: 6 }}>
                <textarea
                  className="msg-user-edit"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={5}
                  autoFocus
                />
                <div className="small" style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    className="btn-primary"
                    onClick={() => {
                      const text = draft.trim();
                      if (!text) return;
                      setEditing(false);
                      onEditResend?.(u.sourceIndex, text);
                    }}
                  >
                    重发
                  </button>
                  <button className="btn-secondary" onClick={() => setEditing(false)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="msg-user-content">{u.content}</div>
            )}
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
            {a.status === 'streaming' && (
              // 仅思考流（llm_thinking_delta）阶段正文仍为空：显示「思考中」；正文出现后才进入「流式输出中」
              <span className="status-ok">· {a.content.trim() ? '流式输出中' : '思考中'}</span>
            )}
            {a.status === 'error' && <span className="status-error">· 错误</span>}
            {formatTimestamp(a.createdAt) && <span className="muted">{formatTimestamp(a.createdAt)}</span>}
          </div>
          <div className="panel msg-assistant-body" style={{ borderColor }}>
            {a.reasoning && a.reasoning.trim() && (
              <details className="msg-reasoning">
                <summary className="small muted">思考过程</summary>
                <div className="msg-reasoning-body small muted">
                  <MarkdownMessage content={a.reasoning} />
                </div>
              </details>
            )}
            <div className="msg-assistant-content">
              {a.content ? (
                <MarkdownMessage content={a.content} />
              ) : a.reasoning ? (
                // 仅有思考时正文留白，思考已在上方折叠区
                null
              ) : a.error ? (
                <span className="muted small">（出错，见下方）</span>
              ) : (
                '(空)'
              )}
            </div>
            {a.error && <div className="small status-error" style={{ marginTop: 6 }}>{a.error}</div>}
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

// ── ask_user pending question card ──

function QuestionCard({
  question,
  onAnswer,
  answering,
  onClose,
}: {
  question: PendingQuestion;
  onAnswer: (answer: string) => void;
  answering: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState('');

  return (
    <div className="panel question-card" style={{ borderColor: 'var(--color-warn)', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <div style={{ fontWeight: 600, flex: 1 }}>
          <span style={{ color: 'var(--color-warn)' }}>待回答</span>
          <span style={{ marginLeft: 8, fontWeight: 400 }} className="small muted">{question.question}</span>
        </div>
        <button
          className="btn-secondary"
          disabled={answering}
          title="中止任务并保留当前状态"
          onClick={onClose}
        >
          关闭
        </button>
      </div>
      {question.options && question.options.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {question.options.map((opt, idx) => (
            <button
              key={`${idx}-${opt}`}
              className="btn-secondary"
              disabled={answering}
              onClick={() => onAnswer(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ flex: 1 }}
          value={text}
          placeholder="输入回答…"
          disabled={answering}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim() && !answering) {
              onAnswer(text.trim());
              setText('');
            }
          }}
        />
        <button
          className="btn-primary"
          disabled={answering || !text.trim()}
          onClick={() => {
            onAnswer(text.trim());
            setText('');
          }}
        >
          回答
        </button>
      </div>
    </div>
  );
}

// ── SEC-7 HITL approval card ──

function ApprovalCard({
  approval,
  onDecide,
  deciding,
}: {
  approval: PendingApproval;
  onDecide: (action: 'approve' | 'reject', scope?: ApprovalScope) => void;
  deciding: boolean;
}) {
  const req = approval.request;
  const isEffect = req.kind === 'effect';
  return (
    <div className="panel question-card" style={{ borderColor: 'var(--color-danger, #dc2626)', marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        <span style={{ color: 'var(--color-danger, #dc2626)' }}>
          {isEffect ? '效应确认' : '高风险确认'}
        </span>
        <span style={{ marginLeft: 8, fontWeight: 400 }} className="small muted">
          {req.actionDescription || req.toolName}
        </span>
      </div>
      <div className="small muted" style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>
        {req.riskDescription}
        {Object.keys(req.arguments ?? {}).length > 0 && (
          <>{"\n"}Args: {JSON.stringify(req.arguments).slice(0, 200)}</>
        )}
      </div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        「本会话允许」/「始终允许」按<b>工具/效应类型</b>记账（如全部 shell），不是仅这一次参数。
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button className="btn-primary" disabled={deciding} onClick={() => onDecide('approve', 'once')}>
          允许一次
        </button>
        <button className="btn-secondary" disabled={deciding} onClick={() => onDecide('approve', 'session')}>
          本会话允许（{req.toolName}）
        </button>
        <button className="btn-secondary" disabled={deciding} onClick={() => onDecide('approve', 'always')}>
          始终允许（{req.toolName}）
        </button>
        <button className="btn-secondary" disabled={deciding} onClick={() => onDecide('reject')}>
          拒绝
        </button>
      </div>
    </div>
  );
}

const TASK_STATUS_ORDER: Record<SessionTaskView['status'], number> = {
  open: 0,
  paused: 1,
  done: 2,
  dropped: 3,
};

function SchedulePanel({
  schedules,
  onControl,
}: {
  schedules: SessionScheduleView[];
  onControl: (id: string, action: 'cancel' | 'pause' | 'resume') => void;
}) {
  if (!schedules.length) {
    return (
      <div className="tasks-empty">
        <span className="tasks-empty-icon" aria-hidden>⏱</span>
        暂无定时作业
        <div style={{ marginTop: 6 }}>
          对 Agent 说「2 小时后…」或「每天 9 点…」即可创建
        </div>
      </div>
    );
  }

  const formatWhen = (ts: number) => {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  };

  return (
    <div className="task-list">
      {schedules
        .slice()
        .sort((a, b) => {
          const ao = a.status === 'active' || a.status === 'paused' ? 0 : 1;
          const bo = b.status === 'active' || b.status === 'paused' ? 0 : 1;
          if (ao !== bo) return ao - bo;
          return a.nextFireAt - b.nextFireAt;
        })
        .map((s) => {
        const isOpen = s.status === 'active' || s.status === 'paused';
        return (
          <article key={s.id} className={`task-card task-card-${s.status === 'active' ? 'open' : s.status}`}>
            <div className="task-card-top">
              <div className="task-card-title">
                {s.title || s.prompt.slice(0, 40)}
              </div>
              <span className={`task-badge task-badge-${s.status === 'active' ? 'open' : s.status}`}>
                {s.status}
              </span>
            </div>
            <div className="task-meta-row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <span>
                {s.kind === 'once'
                  ? `once · ${formatWhen(s.fireAt ?? s.nextFireAt)}`
                  : s.kind === 'interval'
                    ? `every ${Math.round((s.intervalMs ?? 0) / 1000)}s`
                    : `cron ${s.cron ?? ''}`}
              </span>
              <span>
                run {s.runCount}
                {s.maxRuns !== undefined ? `/${s.maxRuns}` : ''}
              </span>
              {s.status === 'active' && (
                <span>next {formatWhen(s.nextFireAt)}</span>
              )}
            </div>
            {s.lastError && <div className="task-note">{s.lastError}</div>}
            {isOpen && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {s.status === 'active' ? (
                  <button type="button" className="btn btn-small" onClick={() => onControl(s.id, 'pause')}>
                    暂停
                  </button>
                ) : (
                  <button type="button" className="btn btn-small" onClick={() => onControl(s.id, 'resume')}>
                    恢复
                  </button>
                )}
                <button type="button" className="btn btn-small" onClick={() => onControl(s.id, 'cancel')}>
                  取消
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

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

export interface ChatWorkspaceProps {
  /** 顶栏统一 Focus：扩大右栏检查器 */
  inspectorFocus: boolean;
  /** 同步当前 Agent 到顶栏（Knowledge 管理面共用） */
  onAgentIdChange?: (agentId: string) => void;
}

export default function ChatWorkspace({ inspectorFocus, onAgentIdChange }: ChatWorkspaceProps) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE);
  const [apiKey, setApiKey] = useState(() => getConsoleKey());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [connection, setConnection] = useState('idle');
  const [agents, setAgents] = useState<Array<{
    id: string;
    model: { provider: string; model: string; contextWindow?: number };
    effectMode?: string;
    effectModeSource?: 'agent' | 'global' | 'default';
  }>>([]);
  const [agentId, setAgentId] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>({ models: [], agents: [] });
  const [sessionModel, setSessionModel] = useState<SessionModelView | null>(null);
  /** 下拉框选中的模型 id；会话打开时等于 sessionModel，否则为新建会话的预选 */
  const [selectedModelId, setSelectedModelId] = useState('');
  const [modelError, setModelError] = useState<string | null>(null);
  const [compactMsg, setCompactMsg] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [sessions, setSessions] = useState<Array<{
    id: string;
    agentId: string;
    lastInteractionAt: number;
    title?: string;
    titleSource?: 'snippet' | 'auto' | 'user';
    /** 置顶时间戳；存在即置顶排序 */
    pinnedAt?: number;
    /** 实时运行态（服务端标注 + WS state 事件更新） */
    running?: boolean;
  }>>([]);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** 「…」菜单展开的会话 id */
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  /** 「…」菜单锚点：开合时解析好的视口坐标（渲染不读 window，滚动/缩放即关闭） */
  const [menuPos, setMenuPos] = useState<{ right: number; top: number } | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  // 压缩提示属于单个 session 的一次动作：切走即清空，防跨 session 残留
  useEffect(() => {
    setCompactMsg(null);
    setCompacting(false);
  }, [activeSessionId]);
  const [conversationItems, setConversationItems] = useState<ConversationItem[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('history');
  const [stream, setStream] = useState('');
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  /** 模型重试状态：非 null 时显示「第 N/M 次重试」，让长等待可见 */
  const [modelRetry, setModelRetry] = useState<ModelRetryInfo | null>(null);
  const [inspector, setInspector] = useState<InspectorState>({});
  const [tasks, setTasks] = useState<SessionTaskView[]>([]);
  const [schedules, setSchedules] = useState<SessionScheduleView[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [answeringQuestion, setAnsweringQuestion] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [decidingApproval, setDecidingApproval] = useState(false);
  const [clientToolCalls, setClientToolCalls] = useState<ClientToolCallDto[]>([]);
  const [renderedWebViews, setRenderedWebViews] = useState<RenderedWebView[]>([]);
  const [deliveredFiles, setDeliveredFiles] = useState<Array<{ ref: FileRef; createdAt: number }>>([]);
  const [focusFileId, setFocusFileId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{ id: string; name: string; sizeBytes: number; status: string }>
  >([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentsReload, setAttachmentsReload] = useState(0);
  const [commands, setCommands] = useState<CommandCatalogItemDto[]>([]);
  const [cmdSuggestIndex, setCmdSuggestIndex] = useState(0);
  const [openIssues, setOpenIssues] = useState<Array<{ id: string; severity: string; title: string; detail: string }>>([]);
  const [rightTab, setRightTab] = useState<'context' | 'run' | 'tasks' | 'schedules' | 'attachments' | 'roots' | 'git' | 'file' | 'tools' | 'help'>('context');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [mobileTab, setMobileTab] = useState<'chat' | 'left' | 'right'>('chat');
  const [showAllSessions, setShowAllSessions] = useState(false);

  const clientRef = useRef<OctopiClient | null>(null);
  const storeRef = useRef<OctopiRuntimeStore | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 跟随输出滚到底；用户上滑后暂停，回到底部或新一轮回复再恢复 */
  const stickToBottomRef = useRef(true);

  // Initialize store once
  useEffect(() => {
    const client = new OctopiClient({ baseUrl, apiKey: apiKey || undefined });
    const store = new OctopiRuntimeStore(client);

    store.addEventListener('connection', ((e: CustomEvent) => {
      setConnection(e.detail.state);
      setAgents(e.detail.agents ?? []);
      if (e.detail.state === 'connected') setConnectError(null);
    }) as EventListener);
    store.addEventListener('models', ((e: CustomEvent) => {
      setModelCatalog(e.detail.catalog ?? { models: [], agents: [] });
    }) as EventListener);
    store.addEventListener('sessionModel', ((e: CustomEvent) => {
      const sm = e.detail.sessionModel as SessionModelView | null;
      setSessionModel(sm);
      if (sm) {
        setSelectedModelId(sm.modelId ?? sm.defaultModelId);
      }
    }) as EventListener);
    store.addEventListener('sessions', ((e: CustomEvent) => {
      const list = (e.detail.sessions ?? []) as Array<{ id: string; lastInteractionAt?: number }>;
      setSessions(e.detail.sessions);
      // 刷新后自动打开最近会话，否则回放文件卡片无从恢复。
      // 若 store 已有活动会话（createSession 刚建完）或本组件已选中，禁止抢开旧会话。
      const storeChatId = storeRef.current?.getState().chat.sessionId;
      if (
        !activeSessionIdRef.current &&
        !storeChatId &&
        list.length > 0
      ) {
        const latest = [...list].sort(
          (a, b) => (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0),
        )[0];
        if (latest) void openSession(latest.id);
      }
    }) as EventListener);
    store.addEventListener('session', ((e: CustomEvent) => {
      // 会话被删除（本端或其他端 session.removed 广播）时清空活动会话 UI
      if (!e.detail.session) clearActiveSessionUi();
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
    store.addEventListener('modelRetry', ((e: CustomEvent) => {
      setModelRetry((e.detail.retry ?? null) as ModelRetryInfo | null);
    }) as EventListener);
    store.addEventListener('inspector', ((e: CustomEvent) => {
      setInspector(e.detail.inspector as InspectorState);
    }) as EventListener);
    store.addEventListener('tasks', ((e: CustomEvent) => {
      setTasks(e.detail.tasks ?? []);
    }) as EventListener);
    store.addEventListener('schedules', ((e: CustomEvent) => {
      setSchedules(e.detail.schedules ?? []);
    }) as EventListener);
    store.addEventListener('questions', ((e: CustomEvent) => {
      setQuestions(e.detail.questions ?? []);
    }) as EventListener);
    store.addEventListener('approval', ((e: CustomEvent) => {
      setApprovals(e.detail.approvals ?? []);
    }) as EventListener);
    store.addEventListener('clientToolCalls', ((e: CustomEvent) => {
      const calls = (e.detail.calls ?? []) as ClientToolCallDto[];
      setClientToolCalls(calls);
      // 仅收集当前会话的文件，避免切会话后残留
      const curId = activeSessionIdRef.current;
      setDeliveredFiles((prev) => {
        const next = curId
          ? prev.filter((x) => {
              const sid = (x.ref as { sessionId?: string }).sessionId;
              return sid === undefined || sid === curId;
            })
          : [...prev];
        for (const c of calls) {
          const callSid = (c as { sessionId?: string }).sessionId;
          if (curId && callSid && callSid !== curId) continue;
          const ref = fileRefFromCall(c);
          if (!ref) continue;
          if (!next.some((x) => x.ref.fileId === ref.fileId)) {
            next.push({
              ref: { ...ref, ...(callSid ? { sessionId: callSid } : {}) } as FileRef,
              createdAt: c.createdAt || Date.now(),
            });
          }
        }
        next.sort((a, b) => a.createdAt - b.createdAt);
        return next;
      });
    }) as EventListener);
    store.addEventListener('error', ((e: CustomEvent) => {
      setConnectError(String(e.detail.error ?? ''));
    }) as EventListener);

    clientRef.current = client;
    storeRef.current = store;
    store.connect();

    // 命令目录 / 系统问题（REST；失败静默，下拉可退回内置列表）
    void client.getCommands().then((list) => {
      if (list?.length) setCommands(list);
    }).catch(() => { /* gateway 未就绪 */ });
    void client.listIssues('open').then((list) => {
      setOpenIssues(list.map((i) => ({ id: i.id, severity: i.severity, title: i.title, detail: i.detail })));
    }).catch(() => { /* ignore */ });

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

  useEffect(() => {
    onAgentIdChange?.(agentId || 'default');
  }, [agentId, onAgentIdChange]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // Agent 切换时：无活动会话则预选该 agent 默认模型
  useEffect(() => {
    if (activeSessionId) return;
    const fromCatalog = modelCatalog.agents.find(a => a.agentId === agentId)?.defaultModelId;
    const agent = agents.find(a => a.id === agentId);
    const fromAgents = agent ? `${agent.model.provider}/${agent.model.model}` : '';
    const agentDefault = fromCatalog || fromAgents;
    if (agentDefault) setSelectedModelId(agentDefault);
  }, [agentId, agents, modelCatalog.agents, activeSessionId]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  /** 新一轮 agent 回复 / 打开会话时恢复粘底跟随 */
  const enableStickToBottom = () => {
    stickToBottomRef.current = true;
    scrollToBottom();
  };

  const handleConversationScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 阈值内视为“在底部”：轻微布局抖动不会打断跟随
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;

    // 临近顶部：向前加载更早历史并拼在前面（纯展示；续聊走正常装配）
    if (el.scrollTop < 80 && storeRef.current?.hasMoreHistory()) {
      void loadMoreHistory();
    }
  };

  const loadMoreHistory = async () => {
    const el = scrollRef.current;
    const store = storeRef.current;
    if (!store || !store.hasMoreHistory()) return;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      await store.loadMoreHistory();
    } catch {
      // 展示分页失败不打断会话；下次滚动再试
    }
    // prepend 后把视口钉在原先那条消息上，避免跳动
    if (el) {
      requestAnimationFrame(() => {
        el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      });
    }
  };

  // Auto-scroll：仅在用户仍贴近底部时跟随；上滑阅读中不打断
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollToBottom();
  }, [conversationItems, stream, questions, approvals, clientToolCalls, renderedWebViews]);

  // 切换会话时清掉待发附件，避免 A 的文件挂到 B
  useEffect(() => {
    setPendingAttachments([]);
  }, [activeSessionId]);

  // 阻止浏览器把拖入的文件当导航打开
  useEffect(() => {
    const preventIfFiles = (e: DragEvent) => {
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.files?.length) {
        e.preventDefault();
      }
    };
    window.addEventListener('dragover', preventIfFiles);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', preventIfFiles);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const agentDefaultModelId =
    modelCatalog.agents.find(a => a.agentId === agentId)?.defaultModelId
    ?? (() => {
      const a = agents.find(x => x.id === agentId);
      return a ? `${a.model.provider}/${a.model.model}` : '';
    })();

  const effectiveModelId = activeSessionId
    ? (sessionModel?.modelId ?? sessionModel?.defaultModelId ?? agentDefaultModelId)
    : (selectedModelId || agentDefaultModelId);

  const modelOptions = (() => {
    const items = [...modelCatalog.models];
    if (agentDefaultModelId && !items.some(m => m.id === agentDefaultModelId)) {
      const a = agents.find(x => x.id === agentId);
      if (a) {
        items.push({
          id: agentDefaultModelId,
          provider: a.model.provider,
          model: a.model.model,
          contextWindow: a.model.contextWindow ?? null,
          known: typeof a.model.contextWindow === 'number',
          source: a.model.contextWindow ? 'config' : 'unknown',
        });
      }
    }
    if (effectiveModelId && !items.some(m => m.id === effectiveModelId)) {
      const resolvedHit = sessionModel?.resolved?.id === effectiveModelId ? sessionModel.resolved : undefined;
      items.push(resolvedHit ?? {
        id: effectiveModelId,
        provider: effectiveModelId.split('/')[0] ?? '',
        model: effectiveModelId.split('/').slice(1).join('/') || effectiveModelId,
        contextWindow: null,
        known: false,
        source: 'unknown',
      });
    }
    const levelItems = Object.entries(modelCatalog.levels ?? {}).map(([name, lv]) => {
      const hit = modelCatalog.models.find(m => m.id === lv.primary);
      return {
        id: lv.primary,
        provider: lv.primary.split('/')[0] ?? '',
        model: name,
        contextWindow: hit?.contextWindow ?? null,
        known: Boolean(hit?.known),
        source: (hit?.source ?? 'unknown') as string,
        isLevel: true,
        levelName: name,
      };
    });
    return { items, levelItems };
  })();

  const applyModelChange = async (modelRef: string) => {
    setSelectedModelId(modelRef);
    setModelError(null);
    // 预算展示：只读引擎下发 snapshot；未知时不填假值
    const catalogHit = modelCatalog.models.find(m => m.id === modelRef)
      ?? (sessionModel?.resolved?.id === modelRef ? sessionModel.resolved : undefined);
    if (catalogHit?.contextWindow != null) {
      setInspector(prev => ({ ...prev, contextWindow: catalogHit.contextWindow! }));
    } else {
      setInspector(prev => ({ ...prev, contextWindow: undefined }));
    }
    if (!activeSessionId) return;
    const store = storeRef.current;
    if (!store) return;
    try {
      const next = modelRef === agentDefaultModelId || modelRef === ''
        ? await store.setSessionModel(null)
        : await store.setSessionModel(modelRef);
      setSessionModel(next);
      if (next?.resolved?.contextWindow != null) {
        setInspector(prev => ({ ...prev, contextWindow: next.resolved!.contextWindow! }));
      } else {
        setInspector(prev => ({ ...prev, contextWindow: undefined }));
      }
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
    }
  };

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
    // 打开会话始终从底部开始看
    stickToBottomRef.current = true;
    setActiveSessionId(sessionId);
    activeSessionIdRef.current = sessionId;
    // 从 store 恢复，不硬编码 idle —— 切回时可能仍有 running 工具或流式内容
    setRunStatus(state.chat.runStatus);
    setStream(state.chat.streamingContent ?? '');
    setTasks(state.chat.tasks ?? []);
    setSchedules(state.chat.schedules ?? []);
    setQuestions(state.chat.questions ?? []);
    setApprovals(state.chat.approvals ?? []);
    setClientToolCalls(state.chat.clientToolCalls ?? []);
    setRenderedWebViews(webViewsFromCalls(state.chat.clientToolCalls ?? []));
    setDeliveredFiles([]);
    setFocusFileId(null);
    const restored: Array<{ ref: FileRef; createdAt: number }> = [];
    for (const c of state.chat.clientToolCalls ?? []) {
      const ref = fileRefFromCall(c);
      if (ref) restored.push({ ref, createdAt: c.createdAt || 0 });
    }
    // 历史 tool_result 兜底：metadata.clientToolCalls 被覆盖时仍可重建卡片
    for (const item of state.chat.conversation ?? []) {
      if (item.role !== 'tool') continue;
      const t = item as { toolName?: string; result?: unknown; createdAt?: number };
      const ref = fileRefFromToolResult(t.toolName ?? '', t.result);
      if (ref && !restored.some((x) => x.ref.fileId === ref.fileId)) {
        restored.push({ ref, createdAt: t.createdAt || item.createdAt || 0 });
      }
    }
    // 再从 file release 索引补齐（重启后 call 列表可能不全）
    try {
      const client = clientRef.current;
      if (client) {
        const files = await client.listSessionFiles(sessionId);
        for (const f of files) {
          const ref: FileRef = {
            fileId: f.fileId,
            name: f.name,
            mime: f.mime,
            sizeBytes: f.sizeBytes,
          };
          if (!restored.some((x) => x.ref.fileId === ref.fileId)) {
            restored.push({ ref, createdAt: f.createdAt || 0 });
          }
        }
      }
    } catch {
      // 列表失败时仅依赖 clientToolCalls / history
    }
    restored.sort((a, b) => a.createdAt - b.createdAt);
    setDeliveredFiles(restored);
    setFocusFileId(restored.length ? restored[restored.length - 1]!.ref.fileId : null);
    setConversationItems(state.chat.conversation ?? []);
    setViewMode(state.chat.viewMode);
    await store.refreshSessionModel();
    const sm = store.getSessionModel();
    setSessionModel(sm);
    if (sm) setSelectedModelId(sm.modelId ?? sm.defaultModelId);
    void registerSampleClientTools(sessionId);
  };

  /** 注册 WebUI 样板 Client Tool（幂等） */
  const registerSampleClientTools = async (sessionId: string) => {
    const store = storeRef.current;
    if (!store || !sessionId) return;
    try {
      await store.registerClientTools({
        sessionId,
        clientInstanceId: webuiClientInstanceId(),
        platform: 'web',
        descriptors: WEBUI_SAMPLE_CLIENT_TOOLS,
      });
    } catch {
      // Gateway 未升级/路由不可用时不阻塞会话
    }
  };

  // 在线性心跳：30s 续期（服务端 90s TTL）
  useEffect(() => {
    if (!activeSessionId || connection !== 'connected') return;
    const tick = () => {
      const store = storeRef.current;
      if (!store || !activeSessionId) return;
      void store.heartbeatClientTools(activeSessionId, webuiClientInstanceId()).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [activeSessionId, connection]);

  /** 卸载当前标签页能力，避免多标签卡死敏感 tool */
  useEffect(() => {
    const unload = () => {
      const store = storeRef.current;
      const sessionId = activeSessionId;
      if (!store || !sessionId) return;
      try {
        void store.unregisterClientTools?.(sessionId, webuiClientInstanceId());
      } catch {
        // pagehide 尽力而为
      }
    };
    window.addEventListener('pagehide', unload);
    return () => window.removeEventListener('pagehide', unload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const startRenameSession = (sessionId: string, currentTitle: string) => {
    setRenamingSessionId(sessionId);
    setRenameDraft(currentTitle);
    setActionError(null);
  };

  const commitRenameSession = async () => {
    const store = storeRef.current;
    const sessionId = renamingSessionId;
    if (!store || !sessionId) {
      setRenamingSessionId(null);
      return;
    }
    const title = renameDraft.trim();
    if (!title) {
      setActionError('标题不能为空');
      return;
    }
    try {
      await store.renameSession(sessionId, title);
      setRenamingSessionId(null);
      setRenameDraft('');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const closeSessionMenu = () => {
    setMenuSessionId(null);
    setMenuPos(null);
  };

  const openSessionMenu = (e: React.MouseEvent<HTMLButtonElement>, sessionId: string) => {
    if (menuSessionId === sessionId) {
      closeSessionMenu();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const menuHeight = 76;
    // 菜单锚在按钮上方展开；贴近视口顶部时翻转到下方（坐标此处解析完，渲染不读 window）
    const openUpward = rect.top >= menuHeight + 8;
    setMenuSessionId(sessionId);
    setMenuPos({
      right: Math.max(8, window.innerWidth - rect.right),
      top: openUpward ? rect.top - menuHeight - 4 : rect.top + 26,
    });
  };

  // 菜单是 fixed 定位的瞬态浮层：Esc 关闭；滚动/缩放后锚点失效即关闭
  useEffect(() => {
    if (!menuSessionId) return;
    const close = () => closeSessionMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSessionMenu();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menuSessionId]);

  const togglePinSession = async (sessionId: string, pinned: boolean) => {
    const store = storeRef.current;
    if (!store) return;
    setActionError(null);
    try {
      await store.setSessionPinned(sessionId, pinned);
      setToast(pinned ? '已置顶会话' : '已取消置顶');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 清空活动会话的 UI 态（删除会话后 / 远端删除广播）。useCallback：挂载期监听器长期持有，只碰稳定 setter/ref */
  const clearActiveSessionUi = useCallback(() => {
    setActiveSessionId(null);
    activeSessionIdRef.current = null;
    setRunStatus('idle');
    setStream('');
    setConversationItems([]);
    setTasks([]);
    setSchedules([]);
    setQuestions([]);
    setApprovals([]);
    setClientToolCalls([]);
    setRenderedWebViews([]);
    setDeliveredFiles([]);
    setFocusFileId(null);
    setSessionModel(null);
  }, []);

  const removeSession = async (sessionId: string) => {
    const store = storeRef.current;
    if (!store) return;
    let target = sessions.find((s) => s.id === sessionId);
    // 服务端 409 兜底；这里先拦在途 Run 避免用户白确认。徽标可能失鲜（WS 终态丢失），
    // 拒绝前先用服务端投影复核，防止陈旧「运行中」把删除永久卡死
    if (target?.running) {
      const fresh = await store.refreshSessions().catch(() => null);
      target = fresh?.find((s) => s.id === sessionId) ?? target;
      if (target.running) {
        setActionError('会话正在运行中，请先停止运行，再删除。');
        return;
      }
    }
    const label = target ? sessionDisplayTitle(target) : sessionId;
    if (!window.confirm(`删除会话「${label}」？消息记录与运行痕迹将一并删除，不可恢复。`)) return;
    setActionError(null);
    try {
      await store.deleteSession(sessionId);
      if (activeSessionIdRef.current === sessionId) {
        clearActiveSessionUi();
      }
      setToast('会话已删除');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const createSession = async () => {
    if (connection !== 'connected') { setActionError('请先连接 Gateway，再新建会话。'); return; }
    if (!agentId) { setActionError('请先选择一个 Agent，再新建会话。'); return; }
    const store = storeRef.current;
    if (!store) return;
    setActionError(null);
    setCreating(true);
    try {
      const modelToApply = selectedModelId && selectedModelId !== agentDefaultModelId
        ? selectedModelId
        : undefined;
      const created = await store.createSession(agentId, modelToApply ? { model: modelToApply } : undefined);
      stickToBottomRef.current = true;
      setActiveSessionId(created.id);
      activeSessionIdRef.current = created.id;
      setRunStatus('idle');
      setStream('');
      setConversationItems(store.getState().chat.conversation ?? []);
      setTasks(store.getTasks());
      setSchedules(store.getSchedules());
      setQuestions(store.getQuestions());
      setApprovals(store.getApprovals());
      setClientToolCalls(store.getClientToolCalls());
      // 新会话不得残留上一会话的文件卡片/预览
      setRenderedWebViews([]);
      setDeliveredFiles([]);
      setFocusFileId(null);
      void registerSampleClientTools(created.id);
      await store.refreshSessionModel();
      const sm = store.getSessionModel();
      setSessionModel(sm);
      if (sm) setSelectedModelId(sm.modelId ?? sm.defaultModelId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  const branchFromIndex = async (beforeIndex: number) => {
    const store = storeRef.current;
    const parent = activeSessionId;
    if (!store || !parent) {
      setActionError('请先打开要分叉的历史会话。');
      return;
    }
    setActionError(null);
    try {
      const created = await store.branchSession(parent, beforeIndex);
      stickToBottomRef.current = true;
      setActiveSessionId(created.id);
      activeSessionIdRef.current = created.id;
      setRunStatus('idle');
      setStream('');
      setTasks(store.getTasks());
      setQuestions(store.getQuestions());
      setApprovals(store.getApprovals());
      setClientToolCalls(store.getClientToolCalls());
      void registerSampleClientTools(created.id);
      await store.refreshSessionModel();
      const sm = store.getSessionModel();
      setSessionModel(sm);
      if (sm) setSelectedModelId(sm.modelId ?? sm.defaultModelId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const editAndResend = async (userMessageIndex: number | undefined, content: string) => {
    const store = storeRef.current;
    if (!store) return;
    setActionError(null);
    try {
      await store.editAndResend(userMessageIndex, content);
      stickToBottomRef.current = true;
      setRunStatus(store.getState().chat.runStatus);
      setStream('');
      setTasks(store.getTasks());
      setQuestions(store.getQuestions());
      setApprovals(store.getApprovals());
      setClientToolCalls(store.getClientToolCalls());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const answerQuestion = async (questionId: string, answer: string) => {
    const store = storeRef.current;
    if (!store) return;
    // 作答后是新一轮 agent 输出，恢复跟随
    enableStickToBottom();
    setAnsweringQuestion(true);
    try {
      await store.answerQuestion(questionId, answer);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnsweringQuestion(false);
    }
  };

  const resolveApproval = async (
    approvalId: string,
    action: 'approve' | 'reject',
    scope?: ApprovalScope,
  ) => {
    const store = storeRef.current;
    if (!store) return;
    enableStickToBottom();
    setDecidingApproval(true);
    try {
      // 确认人署名（ops P5 确认人入审计）：按 §8.6 拍板审批面即 owner，故角色归因（非实名）；
      // web 暂无认证层，多用户认证落地后应替换为认证身份，勿升级为编造的实名
      await store.resolveApproval(approvalId, { action, scope, approver: 'owner' });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDecidingApproval(false);
    }
  };

  const sendMessage = async () => {
    const store = storeRef.current;
    const hasAttach = pendingAttachments.length > 0;
    if (!store || (!input.trim() && !hasAttach)) return;
    const text = input.trim();

    // Client-local：/clear
    if (text === '/clear') {
      setInput('');
      setStream('');
      return;
    }

    // /stop 可抢占（busy 也允许）；运行中普通发送 = 插话（steer 进活跃 Run）
    const isStop = text === '/stop' || text.startsWith('/stop ');
    const interjecting =
      !isStop && (runStatus === 'streaming' || runStatus === 'waiting' || runStatus === 'tools');

    setActionError(null);
    // 用户主动发起新一轮：恢复粘底跟随
    enableStickToBottom();
    if (!interjecting) setRunStatus('waiting');
    try {
      await store.sendMessage(text, {
        attachmentIds: pendingAttachments.map((a) => a.id),
      });
      setInput('');
      setPendingAttachments([]);
    } catch (error) {
      // 发送失败：store 已退出 waiting；保留输入便于重试
      setActionError(error instanceof Error ? error.message : String(error));
      const st = store.getState().chat.runStatus;
      setRunStatus(st === 'waiting' || st === 'sending' ? 'error' : st);
    }
  };

  const uploadFiles = async (fileList: FileList | File[]) => {
    const client = clientRef.current;
    if (!client || !activeSessionId) {
      setActionError('请先打开会话再上传附件');
      return;
    }
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setUploading(true);
    try {
      const payload = await Promise.all(
        files.map(async (f) => {
          const buf = await f.arrayBuffer();
          let binary = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
          return {
            name: f.name,
            mime: f.type || undefined,
            dataBase64: btoa(binary),
          };
        }),
      );
      const uploaded = await client.uploadSessionAttachments(activeSessionId, payload);
      setPendingAttachments((prev) => [
        ...prev,
        ...uploaded.map((u) => ({ id: u.id, name: u.name, sizeBytes: u.sizeBytes, status: u.status })),
      ]);
      setAttachmentsReload((n) => n + 1);
      setToast(`已上传 ${uploaded.length} 个附件（仅本会话）`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  // ── 斜杠命令补全 ──
  /** 未连上 Gateway 时的本地兜底；形状与 CommandCatalogItemDto 对齐（含 usage） */
  const fallbackCommands: CommandCatalogItemDto[] = [
    { name: 'help', display: '/help', description: 'Show available commands', usage: '/help', kind: 'control', source: 'builtin' },
    { name: 'stop', display: '/stop', description: 'Stop the active run', usage: '/stop', kind: 'control', source: 'builtin' },
    { name: 'new', display: '/new', description: 'Start a new session', usage: '/new', kind: 'control', source: 'builtin' },
    { name: 'model', display: '/model', description: 'Show or switch model', usage: '/model [name]', kind: 'control', source: 'builtin' },
    { name: 'status', display: '/status', description: 'Show session status', usage: '/status', kind: 'control', source: 'builtin' },
    { name: 'issues', display: '/issues', description: 'List system issues', usage: '/issues', kind: 'control', source: 'builtin' },
    { name: 'clear', display: '/clear', description: 'Clear screen (client-side)', usage: '/clear', kind: 'client', source: 'builtin' },
  ];
  const catalog = commands.length ? commands : fallbackCommands;
  const cmdQuery = (() => {
    const t = input;
    if (!t.startsWith('/')) return null;
    if (t.includes('\n')) return null;
    // 行首命令 token（尚未空格进入参数）才弹出
    const sp = t.indexOf(' ');
    if (sp !== -1) return null;
    return t.slice(1).toLowerCase();
  })();
  const cmdMatches = cmdQuery === null
    ? []
    : catalog.filter((c) => c.name.toLowerCase().startsWith(cmdQuery)).slice(0, 8);
  const showCmdSuggest = cmdMatches.length > 0;

  const applyCommand = (name: string) => {
    const def = catalog.find((c) => c.name === name);
    const usage = def?.usage?.split(' ')[0] ?? `/${name}`;
    setInput(`${usage} `);
    setCmdSuggestIndex(0);
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as unknown as { isComposing?: boolean };

    if (showCmdSuggest) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCmdSuggestIndex((i) => (i + 1) % cmdMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCmdSuggestIndex((i) => (i - 1 + cmdMatches.length) % cmdMatches.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && cmdQuery !== null && !nativeEvent.isComposing)) {
        e.preventDefault();
        const pick = cmdMatches[cmdSuggestIndex] ?? cmdMatches[0];
        if (pick) applyCommand(pick.name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setInput('');
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.repeat && !nativeEvent.isComposing) {
      e.preventDefault();
      if (!activeSessionId || !input.trim()) return;
      sendMessage();
    }
  };

  const abort = () => {
    storeRef.current?.abort();
    setRunStatus('aborted');
    setActionError(null);
  };

  const runManualCompact = async () => {
    const store = storeRef.current;
    if (!store || !activeSessionId) return;
    const sid = activeSessionId;
    setCompacting(true);
    setCompactMsg(null);
    // 压缩结果只属于发起时的 session：中途切走则不回显（防跨会话残留）
    const show = (msg: string) => {
      if (activeSessionIdRef.current === sid) setCompactMsg(msg);
    };
    try {
      const r = await store.compactSession();
      if (!r.ok) {
        show(r.reason || '压缩不可用');
      } else if (!r.compacted) {
        show(r.reason || '未压缩');
      } else {
        const before = r.tokensBefore != null ? formatTokens(r.tokensBefore) : '?';
        const after = r.tokensAfter != null ? formatTokens(r.tokensAfter) : '?';
        show(`已结构压缩 ${before} → ${after}（消息估算）`);
      }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e));
    } finally {
      // 与 show 同款守卫：A 会话的收尾不得清掉 B 会话进行中的压缩标志
      if (activeSessionIdRef.current === sid) setCompacting(false);
    }
  };

  // Derive lists from conversation items
  const toolItems = conversationItems.filter((i): i is ToolConversationItem => i.role === 'tool');

  const connectionLabel = connection === 'connected' ? 'status-ok'
    : connection === 'connecting' || connection === 'reconnecting' ? 'status-warn' : 'status-neutral';

  const agentSessions = sessions.filter(s => agentId ? s.agentId === agentId : true)
    .sort((a, b) => {
      // 置顶优先，组内按最近交互倒序
      const pinDelta = (b.pinnedAt ? 1 : 0) - (a.pinnedAt ? 1 : 0);
      if (pinDelta !== 0) return pinDelta;
      return (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0);
    });

  const VISIBLE_SESSION_COUNT = 5;
  const displayedSessions = showAllSessions ? agentSessions : agentSessions.slice(0, VISIBLE_SESSION_COUNT);
  const hiddenSessionCount = agentSessions.length - displayedSessions.length;

  const isReconnecting = connection === 'reconnecting';
  // 只显示引擎真值（turn.end usage / 持久化恢复）；无值时不猜（新会话/未对话显示 '~'）。
  // 不用「已加载消息」估算——那只是末页 100 条，会把 400k 的会话显示成 21.6k 误导人。
  const contextTokens = typeof inspector.contextTokens === 'number' ? inspector.contextTokens : undefined;
  // 预算展示：只读引擎下发的 snapshot（catalog / sessionModel.resolved），UI 不做策略
  const selectedModelMeta =
    (sessionModel?.resolved?.id === effectiveModelId ? sessionModel.resolved : undefined)
    ?? modelCatalog.models.find(m => m.id === effectiveModelId);
  const contextWindow = selectedModelMeta?.contextWindow
    ?? null;
  const contextWindowKnown = Boolean(selectedModelMeta?.known) && contextWindow != null;
  const contextWindowLabel = contextWindowKnown && contextWindow != null
    ? formatTokens(contextWindow)
    : '未知';

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

      <main className={`app-main ${inspectorFocus ? 'app-main-focus' : ''} ${mobileTab === 'left' ? 'mobile-show-left' : ''} ${mobileTab === 'right' ? 'mobile-show-right' : ''}`}>
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
                  <input
                    value={apiKey}
                    onChange={e => {
                      setApiKey(e.target.value);
                      setConsoleKey(e.target.value);
                    }}
                    style={{ marginTop: 4 }}
                  />
                  <div className="small muted" style={{ marginTop: 4 }}>
                    非 LLM Key。仅当 Gateway 配置了协议鉴权时需要填写。钥匙保存在本机浏览器
                    （localStorage），换浏览器或清站点数据后需重填。
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
                    <div
                      className="small"
                      style={{
                        display: 'flex',
                        gap: 6,
                        alignItems: 'center',
                        marginTop: 2,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        className="small"
                        style={{
                          padding: '1px 6px',
                          borderRadius: 4,
                          border: '1px solid var(--border, #ccc)',
                          background:
                            a.effectMode === 'host'
                              ? 'rgba(220, 80, 40, 0.12)'
                              : a.effectMode === 'untrusted'
                                ? 'rgba(80, 60, 200, 0.12)'
                                : 'rgba(20, 140, 80, 0.1)',
                          color:
                            a.effectMode === 'host'
                              ? '#b33'
                              : a.effectMode === 'untrusted'
                                ? '#446'
                                : '#176',
                        }}
                        title={
                          a.effectModeSource === 'agent'
                            ? '来自 agents[].effectPolicy'
                            : a.effectModeSource === 'global'
                              ? '来自顶层 effectPolicy'
                              : '引擎缺省（未配置 mode）'
                        }
                      >
                        {a.effectMode ?? 'workspace'}
                      </span>
                      {a.effectModeSource && a.effectModeSource !== 'agent' && (
                        <span className="small muted">
                          {a.effectModeSource === 'global' ? '全局' : '缺省'}
                        </span>
                      )}
                    </div>
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
            <div className="session-list-scroll">
              {displayedSessions.map(s => (
                renamingSessionId === s.id ? (
                  <div key={s.id} className="btn-secondary session-btn session-btn-active" style={{ display: 'grid', gap: 4 }}>
                    <input
                      className="model-select"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRenameSession();
                        if (e.key === 'Escape') { setRenamingSessionId(null); setRenameDraft(''); }
                      }}
                      autoFocus
                      maxLength={40}
                    />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-primary small" style={{ flex: 1 }} onClick={() => void commitRenameSession()}>保存</button>
                      <button className="btn-ghost small" style={{ flex: 1 }} onClick={() => { setRenamingSessionId(null); setRenameDraft(''); }}>取消</button>
                    </div>
                  </div>
                ) : (
                  <div key={s.id} className="session-card">
                    <button
                      className={`btn-secondary session-btn ${activeSessionId === s.id ? 'session-btn-active' : ''}`}
                      onClick={() => openSession(s.id)}
                      onDoubleClick={() => startRenameSession(s.id, s.title ?? sessionDisplayTitle(s))}
                      title="单击打开 · 双击重命名"
                    >
                      <div className="session-card-title-row">
                        <span className="session-card-title">{sessionDisplayTitle(s)}</span>
                        {s.pinnedAt != null && (
                          <span className="session-pin-chip" title="已置顶">置顶</span>
                        )}
                        {s.running && (
                          <span className="session-running-badge" title="会话正在运行中">
                            <span className="session-running-dot" />
                            运行中
                          </span>
                        )}
                      </div>
                      <div className="small muted session-card-meta">
                        {s.agentId} · {formatTimestamp(s.lastInteractionAt)}
                      </div>
                    </button>
                    <button
                      className="session-menu-btn"
                      title="更多操作"
                      aria-label="会话操作菜单"
                      aria-expanded={menuSessionId === s.id}
                      onClick={(e) => openSessionMenu(e, s.id)}
                    >
                      …
                    </button>
                    {menuSessionId === s.id && menuPos && (
                      <>
                        <div className="session-menu-backdrop" onClick={closeSessionMenu} />
                        <div
                          className="session-menu"
                          role="menu"
                          style={{ right: menuPos.right, top: menuPos.top }}
                        >
                          <button
                            className="session-menu-item"
                            role="menuitem"
                            onClick={() => { closeSessionMenu(); void togglePinSession(s.id, s.pinnedAt == null); }}
                          >
                            {s.pinnedAt == null ? '置顶会话' : '取消置顶'}
                          </button>
                          <button
                            className="session-menu-item session-menu-item-danger"
                            role="menuitem"
                            onClick={() => { closeSessionMenu(); void removeSession(s.id); }}
                          >
                            删除会话
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )
              ))}
              {!agentSessions.length && <div className="small muted">暂无历史会话</div>}
            </div>
            {hiddenSessionCount > 0 && !showAllSessions && (
              <button
                className="btn-ghost small"
                style={{ marginTop: 6, textAlign: 'center', width: '100%', color: 'var(--color-muted)' }}
                onClick={() => setShowAllSessions(true)}
              >
                展开更多会话 ({hiddenSessionCount})
              </button>
            )}
            {showAllSessions && agentSessions.length > VISIBLE_SESSION_COUNT && (
              <button
                className="btn-ghost small"
                style={{ marginTop: 6, textAlign: 'center', width: '100%', color: 'var(--color-muted)' }}
                onClick={() => setShowAllSessions(false)}
              >
                收起会话列表
              </button>
            )}
          </section>
        </aside>

        {/* ── 中栏：对话 ── */}
        <section className="center-panel">
          <div className="center-header">
            <div className="center-header-row">
              <div>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {activeSessionId
                      ? sessionDisplayTitle(sessions.find(s => s.id === activeSessionId) ?? { id: activeSessionId })
                      : '未选择会话'}
                  </span>
                  {activeSessionId && (
                    <button
                      className="btn-ghost small"
                      style={{ flexShrink: 0 }}
                      onClick={() => {
                        const cur = sessions.find(s => s.id === activeSessionId);
                        startRenameSession(activeSessionId, cur?.title ?? sessionDisplayTitle(cur ?? { id: activeSessionId }));
                      }}
                      title="重命名会话"
                    >
                      重命名
                    </button>
                  )}
                </div>
                <div className="small muted">{agentId ? `Agent: ${agentId}` : '请先选择 Agent'}</div>
                <div className="center-model-row">
                  <label className="small muted" htmlFor="session-model-select">模型</label>
                  <select
                    id="session-model-select"
                    className="model-select"
                    value={effectiveModelId}
                    onChange={(e) => void applyModelChange(e.target.value)}
                    disabled={connection !== 'connected' || !agentId}
                  >
                    {!effectiveModelId && <option value="">（默认）</option>}
                    {agentDefaultModelId && (
                      <option value={agentDefaultModelId}>
                        {agentDefaultModelId}（Agent 默认）
                      </option>
                    )}
                    {modelOptions.items
                      .filter(m => m.id !== agentDefaultModelId)
                      .map(m => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                          {m.known && m.contextWindow != null
                            ? ` · ${formatTokens(m.contextWindow)}`
                            : ' · 窗口未知'}
                        </option>
                      ))}
                    {modelOptions.levelItems.map(lv => (
                      <option key={`level-${lv.levelName}`} value={lv.id}>
                        [{lv.levelName}] → {lv.id}
                      </option>
                    ))}
                  </select>
                  {activeSessionId && sessionModel?.modelId && sessionModel.modelId !== sessionModel.defaultModelId && (
                    <span className="small status-ok">会话覆盖</span>
                  )}
                </div>
                {modelError && <div className="small status-error">{modelError}</div>}
                <div className="small muted" style={{ marginTop: 2 }}>
                  {`上下文: ${contextTokens !== undefined ? formatTokens(contextTokens) : '~'} / ${contextWindowLabel}`}
                </div>
              </div>
              <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="small muted" style={{ marginRight: 8 }}>[{viewMode}]</span>
                <span className={runStatus === 'error' ? 'status-error' : runStatus === 'streaming' ? 'status-ok' : 'status-neutral'}>{runStatus}</span>
                <button
                  className="btn-secondary"
                  onClick={() => void runManualCompact()}
                  disabled={!activeSessionId || compacting}
                  title="结构压缩：头尾保护 + 中间摘要；不依赖 contextWindow"
                >
                  {compacting ? '压缩中…' : '压缩'}
                </button>
                <button className="btn-secondary" onClick={abort} disabled={!['streaming', 'waiting', 'tools', 'sending'].includes(runStatus)}>中止</button>
              </div>
            </div>
            {compactMsg && (
              <div className="small muted" style={{ marginTop: 4 }}>{compactMsg}</div>
            )}
          </div>

          <div ref={scrollRef} className="conversation-scroll" onScroll={handleConversationScroll}>
            {!activeSessionId && (
              <div className="panel empty-hint">
                <div className="empty-hint-title">从左侧开始</div>
                <div className="small muted">
                  先确认 Gateway 已连接，再选择 Agent，然后点击左侧的 <b>新建会话</b>。
                </div>
              </div>
            )}

            {(() => {
              // 时间线：会话项 + 问题 + Client Tool 卡片 + html_ui 预览，按 createdAt 交错
              type TimelineNode = {
                id: string;
                at: number;
                node: ReactNode;
              };
              const nodes: TimelineNode[] = [];
              const richToolNames = new Set(['html_ui', 'photo_capture']);
              /** 会话首条用户气泡：无更早用户历史，不提供分叉 */
              let firstUserItemId: string | undefined;
              for (const it of conversationItems) {
                if (it.role === 'user') {
                  firstUserItemId = it.id;
                  break;
                }
              }

              for (const item of conversationItems) {
                if (item.role === 'tool' && richToolNames.has(item.toolName)) continue;
                // 纯工具调用、无正文/思考/错误的 assistant 不渲染气泡（工具卡片单独保留）
                if (item.role === 'assistant') {
                  const a = item as AssistantConversationItem;
                  const hasText = Boolean(a.content && a.content.trim());
                  const hasReasoning = Boolean(a.reasoning && a.reasoning.trim());
                  if (!hasText && !hasReasoning && !a.error) continue;
                }
                const isFirstUser = item.role === 'user' && item.id === firstUserItemId;
                const userIdx =
                  item.role === 'user' ? (item as UserConversationItem).sourceIndex : undefined;
                nodes.push({
                  id: item.id,
                  at: item.createdAt,
                  node: (
                    <ConversationItemCard
                      key={item.id}
                      item={item}
                      onBranch={
                        item.role === 'user' &&
                        !isFirstUser &&
                        typeof userIdx === 'number' &&
                        userIdx > 0
                          ? (idx) => void branchFromIndex(idx)
                          : undefined
                      }
                      onEditResend={
                        item.role === 'user' && (item as UserConversationItem).editResendable
                          ? (idx, text) => void editAndResend(idx, text)
                          : undefined
                      }
                    />
                  ),
                });
              }

              for (const a of approvals.filter((x) => x.status === 'pending')) {
                nodes.push({
                  id: a.id,
                  at: a.createdAt || Date.now(),
                  node: (
                    <ApprovalCard
                      key={a.id}
                      approval={a}
                      deciding={decidingApproval}
                      onDecide={(action, scope) => void resolveApproval(a.id, action, scope)}
                    />
                  ),
                });
              }

              for (const q of questions.filter((x) => x.status === 'pending')) {
                nodes.push({
                  id: q.id,
                  at: q.createdAt || Date.now(),
                  node: (
                    <QuestionCard
                      key={q.id}
                      question={q}
                      answering={answeringQuestion}
                      onAnswer={(answer) => void answerQuestion(q.id, answer)}
                      onClose={abort}
                    />
                  ),
                });
              }

              for (const c of clientToolCalls.filter((x) => x.state === 'pending')) {
                const client = clientRef.current;
                if (!client || !activeSessionId) continue;
                nodes.push({
                  id: c.id,
                  at: c.createdAt || Date.now(),
                  node: (
                    <ClientToolCallCard
                      key={c.id}
                      call={c}
                      client={client}
                      sessionId={activeSessionId}
                      busy={false}
                      onResolved={() => {
                        setClientToolCalls((prev) => prev.filter((x) => x.id !== c.id));
                      }}
                      onWebView={(view) => {
                        setRenderedWebViews((prev) =>
                          prev.some((v) => v.id === view.id) ? prev : [...prev, view],
                        );
                      }}
                      onFileRef={(ref, createdAt) => {
                        setDeliveredFiles((prev) =>
                          prev.some((x) => x.ref.fileId === ref.fileId)
                            ? prev
                            : [...prev, { ref, createdAt }],
                        );
                        setFocusFileId(ref.fileId);
                        setRightTab('file');
                      }}
                    />
                  ),
                });
              }

              for (const v of renderedWebViews) {
                nodes.push({
                  id: v.id,
                  at: v.createdAt || Date.now(),
                  node: <WebViewPreview key={v.id} view={v} />,
                });
              }

              for (const f of deliveredFiles) {
                nodes.push({
                  id: `file_${f.ref.fileId}`,
                  at: f.createdAt || Date.now(),
                  node: (
                    <FileCard
                      key={f.ref.fileId}
                      client={clientRef.current}
                      sessionId={activeSessionId}
                      fileRef={f.ref}
                      createdAt={f.createdAt}
                      onOpen={(ref) => {
                        setFocusFileId(ref.fileId);
                        setRightTab('file');
                      }}
                    />
                  ),
                });
              }

              nodes.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
              return nodes.map((n) => n.node);
            })()}

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
                  {/* 重试中必须显式告知：否则用户看到的就是「等待响应」无限挂起 */}
                  {modelRetry ? (
                    <span className="status-warn">
                      · 上游无响应，第 {modelRetry.attempt}/{modelRetry.maxAttempts} 次重试
                      {modelRetry.delayMs > 0 ? `（${Math.round(modelRetry.delayMs / 1000)}s 后发起）` : ''}
                    </span>
                  ) : (
                    <span className="status-ok">· {runStatus === 'waiting' ? '等待响应' : '思考中…'}</span>
                  )}
                </div>
                <div className="panel msg-assistant-body" style={{ borderColor: modelRetry ? '#fcd34d' : '#93c5fd' }}>
                  <div className="msg-assistant-content muted">
                    {modelRetry
                      ? `（${modelRetry.reason}：${modelRetry.error.length > 160 ? `${modelRetry.error.slice(0, 160)}…` : modelRetry.error}）`
                      : '（模型尚未返回内容）'}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div
            className="composer"
            onDragOver={(e) => {
              if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onDrop={(e) => {
              if (e.dataTransfer?.files?.length) {
                e.preventDefault();
                e.stopPropagation();
                void uploadFiles(e.dataTransfer.files);
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length > 0) {
                e.preventDefault();
                void uploadFiles(files);
              }
            }}
          >
            {showCmdSuggest && (
              <div className="cmd-suggest" role="listbox">
                {cmdMatches.map((c, idx) => (
                  <div
                    key={c.name}
                    className={`cmd-suggest-item ${idx === cmdSuggestIndex ? 'cmd-suggest-active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyCommand(c.name);
                    }}
                  >
                    <span className="cmd-suggest-name">{c.display || `/${c.name}`}</span>
                    <span className="cmd-suggest-desc">{c.description}</span>
                    {c.usage && <span className="cmd-suggest-meta">{c.usage} · {c.source}</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="composer-attachments">
              {pendingAttachments.length > 0 && (
                <div className="attachment-chips">
                  {pendingAttachments.map((a) => (
                    <span key={a.id} className="attachment-chip">
                      {a.name}
                      <button
                        type="button"
                        className="btn-ghost small"
                        title="移除"
                        onClick={() =>
                          setPendingAttachments((prev) => prev.filter((x) => x.id !== a.id))
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <textarea
              value={input}
              onChange={e => {
                setInput(e.target.value);
                setCmdSuggestIndex(0);
              }}
              onKeyDown={handleComposerKeyDown}
              rows={4}
              placeholder="输入消息，或 / 打开命令列表；可拖拽/粘贴附件"
            />
            <div className="composer-footer">
              <div className="composer-tools">
                <label className="btn-secondary small" style={{ cursor: 'pointer' }}>
                  {uploading ? '上传中…' : '附件'}
                  <input
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      if (e.target.files?.length) void uploadFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>
                <SessionCorpusMenu
                  agentId={agentId || 'default'}
                  sessionId={activeSessionId}
                  onToast={setToast}
                />
              </div>
              <div className="small muted">
                {toast && <span className="corpus-toast">{toast}</span>}
                {openIssues.length > 0 && (
                  <span style={{ color: 'var(--color-warn)', marginRight: 8 }}>
                    ⚠️ {openIssues.length} issue · /issues
                  </span>
                )}
                {activeSessionId ? `发送到 ${activeSessionId}` : '请先打开一个会话'}。Enter 发送，Shift+Enter 换行。
              </div>
              <div className="composer-actions">
                <button className="btn-secondary" onClick={() => setInput('')}>清空</button>
                <button
                  className="btn-primary"
                  onClick={sendMessage}
                  disabled={!activeSessionId || (!input.trim() && pendingAttachments.length === 0)}
                >
                  发送
                </button>
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
              className={rightTab === 'run' ? 'btn-tab btn-tab-active' : 'btn-tab'}
              onClick={() => setRightTab('run')}
            >
              Run
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
            <button
              className={rightTab === 'schedules' ? 'btn-tab btn-tab-active' : 'btn-tab'}
              onClick={() => setRightTab('schedules')}
            >
              日程
              {(() => {
                const n = schedules.filter((s) => s.status === 'active' || s.status === 'paused').length;
                return n > 0 ? <span className="tab-count">{n}</span> : null;
              })()}
            </button>
            <button
              className={rightTab === 'attachments' ? 'btn-tab btn-tab-active' : 'btn-tab'}
              onClick={() => setRightTab('attachments')}
            >
              附件
              {pendingAttachments.length > 0 ? (
                <span className="tab-count">{pendingAttachments.length}</span>
              ) : null}
            </button>
            <button
              className={rightTab === 'roots' ? 'btn-tab btn-tab-active' : 'btn-tab'}
              onClick={() => setRightTab('roots')}
            >
              目录
            </button>
            <button
              className={rightTab === 'git' ? 'btn-tab btn-tab-active' : 'btn-tab'}
              onClick={() => setRightTab('git')}
            >
              Git
            </button>
            <button
              className={rightTab === 'file' ? 'btn-tab btn-tab-active' : 'btn-tab'}
              onClick={() => setRightTab('file')}
            >
              文件
              {deliveredFiles.length > 0 ? <span className="tab-count">{deliveredFiles.length}</span> : null}
            </button>
            <button className={rightTab === 'tools' ? 'btn-tab btn-tab-active' : 'btn-tab'} onClick={() => setRightTab('tools')}>工具</button>
            <button className={rightTab === 'help' ? 'btn-tab btn-tab-active' : 'btn-tab'} onClick={() => setRightTab('help')}>帮助</button>
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

          {rightTab === 'run' && (
            <RunObservatoryPanel
              inspector={inspector}
              runStatus={runStatus}
              sessionId={activeSessionId}
              onRefresh={async (options) => {
                const store = storeRef.current;
                if (!store) return;
                try {
                  await store.refreshRunObservatoryPublic(options);
                } catch {
                  // ignore
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

          {rightTab === 'schedules' && (
            <div>
              <div className="tasks-panel-header">
                <div className="sidebar-title" style={{ marginBottom: 0 }}>会话日程</div>
                <span className="small muted">
                  {schedules.filter((s) => s.status === 'active' || s.status === 'paused').length} 未闭合
                </span>
              </div>
              <div className="tasks-panel-hint">
                由 Agent 用 schedule_* 登记；到点自动唤醒本会话执行。
              </div>
              <SchedulePanel
                schedules={schedules}
                onControl={(id, action) => {
                  const store = storeRef.current;
                  if (!store) return;
                  void store.controlSchedule(id, action).catch(() => undefined);
                }}
              />
            </div>
          )}

          {rightTab === 'attachments' && (
            <SessionAttachmentsPanel
              client={clientRef.current}
              sessionId={activeSessionId}
              reloadToken={attachmentsReload}
              onToast={setToast}
            />
          )}

          {rightTab === 'roots' && (
            <SessionEffectRootsPanel
              client={clientRef.current}
              sessionId={activeSessionId}
              onToast={setToast}
            />
          )}

          {rightTab === 'git' && (
            <GitStatusPanel
              client={clientRef.current}
              sessionId={activeSessionId}
              agentId={agentId}
            />
          )}

          {rightTab === 'file' && (
            <FilePreviewPanel
              client={clientRef.current}
              sessionId={activeSessionId}
              files={deliveredFiles}
              focusFileId={focusFileId}
              onSelect={(ref) => setFocusFileId(ref.fileId)}
            />
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
                <li>左栏：连接 Gateway、选 Agent、开/开会话</li>
                <li>中栏：主对话（模型切换、压缩）</li>
                <li>右栏：上下文 / Run / 任务 / 附件 / 工具 — 观察本轮 agent 为什么这样答</li>
                <li>附件：选文件/拖拽/粘贴上传；默认仅本会话；卡片「…」可归入项目或删除</li>
                <li>顶栏 Focus：放大右栏检查器，便于 demo / 深度调试</li>
                <li>「模型」下拉切换会话模型；新建会话时作为预选</li>
                <li>会话级模型覆盖只影响该会话，不改 Agent 默认</li>
                <li>contextWindow 仅认配置；未配置显示「未知」</li>
                <li>「压缩」= 手动结构压缩（头尾+摘要），也可 POST /api/v1/sessions/:id/compact</li>
                <li>右栏「上下文」：产品八层 = System 契约层 L1–L7（含 Runtime）+ Information L8</li>
                <li>Information 是消息窗口（第 8 层），不进 System 装配栈</li>
                <li>右栏「Run」：Observer — RunScope / 时间线 / run messages</li>
                <li>右栏「任务」：会话任务树；对 Agent 说「把 xx 标为完成」即可更新</li>
                <li>右栏「附件」：本会话参考语料；可 file_read 深读</li>
                <li>右栏「文件」：send_file 发送的文本文件；图片/音视频在对话中展示，可转存</li>
                <li>右栏「Git」：选定目录的 git 工作区状态；按 web.gitStatusPollSeconds 轮询（默认 5s，0=不自动轮询），切换目录即刷新</li>
                <li>连接成功后自动刷新 Agent、模型目录和会话</li>
                <li>Enter 发送，Shift+Enter 换行；输入法选词阶段不会误触</li>
              </ul>
            </section>
          )}
        </aside>
      </main>
    </>
  );
}
