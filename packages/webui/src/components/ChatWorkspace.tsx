import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MarkdownMessage } from './MarkdownMessage';
import { ErrorCard, classifyFlowError, type FlowErrorItem } from './ErrorCard';
import { ContextRuntimePanel } from './ContextRuntimePanel';
import { RunObservatoryPanel } from './RunObservatoryPanel';
import { RunServicesPanel } from './RunServicesPanel';
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
import type { SessionTaskView, SessionScheduleView, SessionSummary, ModelCatalog, SessionModelView, CommandCatalogItemDto, PendingQuestion, PendingApproval, ApprovalScope, ClientToolCallDto, ClientToolDescriptorDto } from '@octopi-agent/gateway/web/sdk/client';
import { ClientToolCallCard, WebViewPreview, type RenderedWebView } from './ClientToolCallCard';
import { FileCard, FilePreviewPanel, fileRefFromCall, fileRefFromToolResult, type FileRef } from './FileDelivery';
import { looksLikeCodeOrMarkup } from '@octopi-agent/engine/harness/session/title';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey } from '../console-key';
import { t as tc, type MessageKey } from '../i18n/core';
import { useT } from '../i18n/react';
import { runStatusLabelKey } from './run-status-label';
import { reduceScrollEvent } from './conversation-follow';
import { createViewportAuthority, shouldApplyCompensation } from './viewport-authority';
import { buildTurnMarkers, historyTurnMarkers, markerKeyOf, type TurnMarker } from './turn-rail';
import { TurnRail } from './TurnRail';
import { ConversationAdapter } from '@octopi-agent/gateway/web/conversation/adapter';

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

/**
 * 输入区高度 / 右栏宽度的可调范围（模块级单一真源）。
 * 初始值、下限、视口上界都从这里派生；CSS 里的同名变量只是 JS 注入前的兜底。
 */
const COMPOSER_H_MIN = 200;
/** 初始高度 = 最小高度：首屏把空间让给对话区 */
const COMPOSER_H_DEFAULT = COMPOSER_H_MIN;
const RIGHT_W_MIN = 220;
const RIGHT_W_DEFAULT = 280;
const LEFT_W_MIN = 240;
const LEFT_W_DEFAULT = 280;
/**
 * 中栏（对话区）保底宽度：左右两侧拖拽合计不得把中栏压到这以下。
 * 窗口本身窄于「两侧下限 + 该值」时无法同时满足（CSS 按比例让步），
 * 这里只保证拖拽不会进一步侵占中栏。
 */
const CENTER_MIN_W = 420;

/**
 * 把 value 收进 [min, max]。max 由视口推导，极小窗口下可能小于 min——
 * 此时以 min 兜底（宁可略超可用空间，也不让输入区/侧栏缩到不可用）。
 * @param value 目标值
 * @param min 下限（硬约束）
 * @param max 上限（视口派生）
 * @returns 收束后的值
 */
function clampRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 输入区高度收束：下限 COMPOSER_H_MIN，上限视口 60%（与 CSS max-height 同源）。
 * @param h 目标高度 px
 * @returns 收束后的高度 px
 */
const clampComposerH = (h: number): number => clampRange(h, COMPOSER_H_MIN, Math.round(window.innerHeight * 0.6));

/**
 * 右栏宽度收束：下限 RIGHT_W_MIN；上限取「视口 50%」与「留出中栏保底」中更严的一个。
 * @param w 目标宽度 px
 * @param leftW 左栏当前宽度 px（拖拽时不变，resize 时用重算后的值）
 * @returns 收束后的宽度 px
 */
const clampRightW = (w: number, leftW: number): number =>
  clampRange(
    w,
    RIGHT_W_MIN,
    Math.min(Math.round(window.innerWidth * 0.5), window.innerWidth - leftW - CENTER_MIN_W),
  );

/**
 * 左栏宽度收束：下限 LEFT_W_MIN；上限取「视口 40%」与「留出中栏保底」中更严的一个。
 * @param w 目标宽度 px
 * @param rightW 右栏当前宽度 px
 * @returns 收束后的宽度 px
 */
const clampLeftW = (w: number, rightW: number): number =>
  clampRange(
    w,
    LEFT_W_MIN,
    Math.min(Math.round(window.innerWidth * 0.4), window.innerWidth - rightW - CENTER_MIN_W),
  );

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
      title: typeof args.title === 'string' && args.title ? args.title : tc('chatWorkspace.webViewDefaultTitle'),
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
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return tc('chatWorkspace.unknown');
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
  if (!t || looksLikeCodeOrMarkup(t)) return tc('chatWorkspace.newSession');
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
  const t = useT();
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

      {item.error && (() => {
        // 域×档：工具错误不套 provider 文案——可自救（self-heal）低调一行不进卡，
        // 仅内部异常（support）才出错误卡（带诊断 ID + raw 折叠，统一走 ErrorCard）
        const c = classifyFlowError(item.error, 'tool');
        if (c.level === 'self-heal') {
          return (
            <div className="small muted" style={{ marginTop: 4 }} title={item.error}>
              ⚠ {c.title}——{c.detail}
            </div>
          );
        }
        return (
          <div style={{ marginTop: 4 }}>
            <ErrorCard item={{ id: `tool-${item.id}`, at: Date.now(), ...c }} />
          </div>
        );
      })()}

      {expanded && (
        <div className="msg-tool-details">
          {item.args !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('chatWorkspace.toolArgs')}</div>
              <pre>{typeof item.args === 'string' ? item.args : JSON.stringify(item.args, null, 2)}</pre>
            </div>
          )}
          {item.result !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('chatWorkspace.toolResult')}</div>
              <pre>{typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2)}</pre>
            </div>
          )}
          {item.summary && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('chatWorkspace.toolSummary')}</div>
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
  const t = useT();
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
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('chatWorkspace.toolArgs')}</div>
              <pre>{typeof item.args === 'string' ? item.args : JSON.stringify(item.args, null, 2)}</pre>
            </div>
          )}
          {item.result !== undefined && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('chatWorkspace.toolResult')}</div>
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
  const t = useT();
  switch (item.role) {
    case 'user': {
      const u = item as UserConversationItem;
      // 会话第一条用户气泡没有「更早历史」可分叉
      const canBranch = typeof u.sourceIndex === 'number' && u.sourceIndex > 0 && onBranch;
      return (
        <div className="msg-user">
          <div className={`msg-user-bubble${editing ? ' editing' : ''}`}>
            <div className="msg-user-label">
              {t('chatWorkspace.roleUser')}
              {canBranch && (
                <button
                  className="btn-secondary"
                  style={{ marginLeft: 8, padding: '1px 8px', fontSize: 12 }}
                  title={t('chatWorkspace.branchTitle')}
                  onClick={() => onBranch!(u.sourceIndex!)}
                >
                  {t('chatWorkspace.branch')}
                </button>
              )}
              {u.editResendable && onEditResend && !editing && (
                <button
                  className="btn-secondary"
                  style={{ marginLeft: 8, padding: '1px 8px', fontSize: 12 }}
                  title={t('chatWorkspace.editResendTitle')}
                  onClick={() => {
                    setDraft(u.content);
                    setEditing(true);
                  }}
                >
                  {t('chatWorkspace.editResend')}
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
                    {t('chatWorkspace.resend')}
                  </button>
                  <button className="btn-secondary" onClick={() => setEditing(false)}>
                    {t('chatWorkspace.cancel')}
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
            <span>{t('chatWorkspace.roleAssistant')}</span>
            {a.status === 'streaming' && (
              // 仅思考流（llm_thinking_delta）阶段正文仍为空：显示「思考中」；正文出现后才进入「流式输出中」
              <span className="status-ok">· {a.content.trim() ? t('chatWorkspace.statusStreaming') : t('chatWorkspace.statusThinking')}</span>
            )}
            {a.status === 'error' && <span className="status-error">· {t('chatWorkspace.statusError')}</span>}
            {a.status === 'aborted' && <span className="status-neutral">· {t('chatWorkspace.statusAborted')}</span>}
            {formatTimestamp(a.createdAt) && <span className="muted">{formatTimestamp(a.createdAt)}</span>}
          </div>
          <div className="panel msg-assistant-body" style={{ borderColor }}>
            {a.reasoning && a.reasoning.trim() && (
              <details className="msg-reasoning">
                <summary className="small muted">{t('chatWorkspace.reasoning')}</summary>
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
                <span className="muted small">{t('chatWorkspace.errorSeeBelow')}</span>
              ) : (
                t('chatWorkspace.emptyContent')
              )}
            </div>
            {a.error && (() => {
              const c = classifyFlowError(a.error, 'provider');
              return (
                <div className="small status-error" style={{ marginTop: 6 }} title={a.error}>
                  ⚠ {c.title}——{c.detail}
                  {c.diagnosticId ? t('chatWorkspace.diagnosticId', { id: c.diagnosticId }) : ''}
                </div>
              );
            })()}
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
    case 'open': return tc('chatWorkspace.statusOpen');
    case 'paused': return tc('chatWorkspace.statusPaused');
    case 'done': return tc('chatWorkspace.statusDone');
    case 'dropped': return tc('chatWorkspace.statusDropped');
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
  const t = useT();

  return (
    <div className="panel question-card" style={{ borderColor: 'var(--color-warn)', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <div style={{ fontWeight: 600, flex: 1 }}>
          <span style={{ color: 'var(--color-warn)' }}>{t('chatWorkspace.questionPending')}</span>
          <span style={{ marginLeft: 8, fontWeight: 400 }} className="small muted">{question.question}</span>
        </div>
        <button
          className="btn-secondary"
          disabled={answering}
          title={t('chatWorkspace.questionCloseTitle')}
          onClick={onClose}
        >
          {t('chatWorkspace.close')}
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
          placeholder={t('chatWorkspace.answerPlaceholder')}
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
          {t('chatWorkspace.answer')}
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
  const t = useT();
  return (
    <div className="panel question-card" style={{ borderColor: 'var(--color-danger, #dc2626)', marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        <span style={{ color: 'var(--color-danger, #dc2626)' }}>
          {isEffect ? t('chatWorkspace.approvalEffect') : t('chatWorkspace.approvalHighRisk')}
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
        {t('chatWorkspace.approvalScopeHintPrefix')}<b>{t('chatWorkspace.approvalScopeHintBold')}</b>{t('chatWorkspace.approvalScopeHintSuffix')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button className="btn-primary" disabled={deciding} onClick={() => onDecide('approve', 'once')}>
          {t('chatWorkspace.approvalAllowOnce')}
        </button>
        <button className="btn-secondary" disabled={deciding} onClick={() => onDecide('approve', 'session')}>
          {t('chatWorkspace.approvalAllowSession', { tool: req.toolName })}
        </button>
        <button className="btn-secondary" disabled={deciding} onClick={() => onDecide('approve', 'always')}>
          {t('chatWorkspace.approvalAllowAlways', { tool: req.toolName })}
        </button>
        <button className="btn-secondary" disabled={deciding} onClick={() => onDecide('reject')}>
          {t('chatWorkspace.approvalReject')}
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

/** 空态快捷提示键（数组序即按钮顺序） */
const QUICK_PROMPT_KEYS = [
  'chatWorkspace.quickPromptEmail',
  'chatWorkspace.quickPromptSummarize',
  'chatWorkspace.quickPromptCapabilities',
] as const;

/** 右栏页签 id（概览行与详情浮层标题共用） */
type RailTabId =
  | 'context'
  | 'run'
  | 'services'
  | 'tasks'
  | 'schedules'
  | 'subsessions'
  | 'attachments'
  | 'roots'
  | 'git'
  | 'file'
  | 'tools';

/** 右栏页签标题键（模块级只存键，渲染时翻译） */
const RAIL_TAB_LABEL_KEYS: Record<RailTabId, MessageKey> = {
  context: 'chatWorkspace.railContext',
  run: 'chatWorkspace.railRun',
  services: 'chatWorkspace.railServices',
  tasks: 'chatWorkspace.railTasks',
  schedules: 'chatWorkspace.railSchedules',
  subsessions: 'chatWorkspace.railSubsessions',
  attachments: 'chatWorkspace.railAttachments',
  roots: 'chatWorkspace.railRoots',
  git: 'chatWorkspace.railGit',
  file: 'chatWorkspace.railFiles',
  tools: 'chatWorkspace.railTools',
};

function SchedulePanel({
  schedules,
  onControl,
}: {
  schedules: SessionScheduleView[];
  onControl: (id: string, action: 'cancel' | 'pause' | 'resume') => void;
}) {
  const t = useT();
  if (!schedules.length) {
    return (
      <div className="tasks-empty">
        <span className="tasks-empty-icon" aria-hidden>⏱</span>
        {t('chatWorkspace.scheduleEmpty')}
        <div style={{ marginTop: 6 }}>
          {t('chatWorkspace.scheduleEmptyHint')}
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
                    {t('chatWorkspace.schedulePause')}
                  </button>
                ) : (
                  <button type="button" className="btn btn-small" onClick={() => onControl(s.id, 'resume')}>
                    {t('chatWorkspace.scheduleResume')}
                  </button>
                )}
                <button type="button" className="btn btn-small" onClick={() => onControl(s.id, 'cancel')}>
                  {t('chatWorkspace.scheduleCancel')}
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
  const t = useT();
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
        {t('chatWorkspace.taskEmpty')}
        <div style={{ marginTop: 6 }}>
          {t('chatWorkspace.taskEmptyHint')}
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
                <span>{t('chatWorkspace.taskSteps', { settled, total: steps.length })}</span>
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
  /** §5b：右边栏显隐（Focus 语义 = 隐藏/显示，默认隐藏 = 产品面纯对话） */
  rightPanelVisible: boolean;
  /** 同步当前 Agent 到顶栏（Knowledge 管理面共用） */
  onAgentIdChange?: (agentId: string) => void;
}

export default function ChatWorkspace({ rightPanelVisible, onAgentIdChange }: ChatWorkspaceProps) {
  // 连接参数调用时读取（resolveDefaultBase/getConsoleKey）——设置-服务改地址/密钥后
  // 重连即生效，无需刷新页面（打磨批 M3；勿退回模块级常量/伪 state）。
  const baseUrl = resolveDefaultBase();
  const apiKey = getConsoleKey();
  const t = useT();
  // §5b splitter：右栏宽度（RIGHT_W_MIN–视口 50%/中栏保底，双击复位；localStorage 持久）
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    // MINOR-5：存储被禁（Safari 隐私模式）不白屏
    try {
      const saved = Number(localStorage.getItem('octopi.rightPanel.width'));
      // 初始值同样过 clamp：极小视口下默认值可能越上限，首屏不该等 resize 才纠正
      return Number.isFinite(saved) && saved > 0
        ? clampRightW(saved, LEFT_W_DEFAULT)
        : clampRightW(RIGHT_W_DEFAULT, LEFT_W_DEFAULT);
    } catch {
      return clampRightW(RIGHT_W_DEFAULT, LEFT_W_DEFAULT);
    }
  });
  // 左栏宽度（与右栏同构：拖拽 / 双击复位 / localStorage 持久）
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('octopi.leftSidebar.width'));
      return Number.isFinite(saved) && saved > 0
        ? clampLeftW(saved, RIGHT_W_DEFAULT)
        : clampLeftW(LEFT_W_DEFAULT, RIGHT_W_DEFAULT);
    } catch {
      return clampLeftW(LEFT_W_DEFAULT, RIGHT_W_DEFAULT);
    }
  });
  const rightDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const rightWRef = useRef(rightPanelWidth);
  rightWRef.current = rightPanelWidth;
  const leftDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const leftWRef = useRef(leftPanelWidth);
  leftWRef.current = leftPanelWidth;
  /** 右栏未显示时 grid 只有两列，不必为它预留宽度（否则左栏拉不宽） */
  const reserveRightW = rightPanelVisible ? rightWRef.current : 0;
  const onSplitterPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId); // Pointer Capture：拖出元素不丢事件
    rightDragRef.current = { startX: e.clientX, startW: rightWRef.current };
  };
  const onSplitterPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = rightDragRef.current;
    if (!drag) return;
    setRightPanelWidth(clampRightW(drag.startW + (drag.startX - e.clientX), leftWRef.current));
  };
  // 左栏手柄：向右拖 = 变宽（方向与右栏相反，仅此一处差异）
  const onLeftSplitterPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    leftDragRef.current = { startX: e.clientX, startW: leftWRef.current };
  };
  const onLeftSplitterPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = leftDragRef.current;
    if (!drag) return;
    setLeftPanelWidth(clampLeftW(drag.startW + (e.clientX - drag.startX), reserveRightW));
  };
  const onLeftSplitterPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!leftDragRef.current) return;
    leftDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    localStorage.setItem('octopi.leftSidebar.width', String(leftWRef.current));
  };
  const onLeftSplitterDoubleClick = (): void => {
    const next = clampLeftW(LEFT_W_DEFAULT, reserveRightW);
    setLeftPanelWidth(next);
    localStorage.setItem('octopi.leftSidebar.width', String(next));
  };
  // pointerup/pointercancel 共用收尾（与输入区分割条同构）
  const onSplitterPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!rightDragRef.current) return;
    rightDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    localStorage.setItem('octopi.rightPanel.width', String(rightWRef.current));
  };
  const onSplitterDoubleClick = (): void => {
    const next = clampRightW(RIGHT_W_DEFAULT, leftWRef.current);
    setRightPanelWidth(next);
    localStorage.setItem('octopi.rightPanel.width', String(next));
  };
  // 输入区高度拖拽：对话历史 ↔ 输入区横向分割条（COMPOSER_H_MIN–视口 60%，双击复位，localStorage 持久）
  const [composerHeight, setComposerHeight] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('octopi.composer.height'));
      // 初始值同样过 clamp（与右栏同构）：极小视口下默认值可能越上限
      return Number.isFinite(saved) && saved > 0 ? clampComposerH(saved) : clampComposerH(COMPOSER_H_DEFAULT);
    } catch {
      return clampComposerH(COMPOSER_H_DEFAULT);
    }
  });
  const composerDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const composerHRef = useRef(composerHeight);
  composerHRef.current = composerHeight;
  const onComposerSplitterDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    composerDragRef.current = { startY: e.clientY, startH: composerHRef.current };
  };
  const onComposerSplitterMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = composerDragRef.current;
    if (!drag) return;
    setComposerHeight(clampComposerH(drag.startH + (drag.startY - e.clientY)));
  };
  // pointerup/pointercancel 共用收尾：cancel 也必须清拖拽态并持久化（否则之后划过横条会误拖；M2/NIT-2）
  const onComposerSplitterUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!composerDragRef.current) return;
    composerDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    localStorage.setItem('octopi.composer.height', String(composerHRef.current));
  };
  const onComposerSplitterDoubleClick = (): void => {
    const next = clampComposerH(COMPOSER_H_DEFAULT);
    setComposerHeight(next);
    localStorage.setItem('octopi.composer.height', String(next));
  };
  // 窗口尺寸变化重 clamp（横屏/软键盘导致 innerHeight 缩小时，持久化值可能越界；打磨批 m3）
  useEffect(() => {
    const onResize = (): void => {
      setComposerHeight((h) => clampComposerH(h));
      // 先算左栏、再用其结果算右栏：一次收敛，避免两栏各自越界后互相挤爆中栏
      // 这里不用 reserveRightW（渲染期派生值），直接从 ref + 可见性读取，避免闭包捕获过期值
      const nextLeft = clampLeftW(leftWRef.current, rightPanelVisible ? rightWRef.current : 0);
      const nextRight = clampRightW(rightWRef.current, nextLeft);
      setLeftPanelWidth(nextLeft);
      setRightPanelWidth(nextRight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [rightPanelVisible]);
  const [connection, setConnection] = useState('idle');
  const [agents, setAgents] = useState<Array<{
    id: string;
    model: { provider: string; model: string; contextWindow?: number };
    effectMode?: string;
    effectModeSource?: 'agent' | 'global' | 'default';
  }>>([]);
  const [agentId, setAgentId] = useState('');
  // §5d：错误卡进对话流（按时间交错）；self-heal 级走 toast/静默，不进卡
  const [flowErrors, setFlowErrors] = useState<Array<FlowErrorItem & { sessionId: string }>>([]);
  const pushFlowError = useCallback((e: Omit<FlowErrorItem, 'id' | 'at'>): void => {
    setFlowErrors((prev) => [...prev, { ...e, sessionId: activeSessionId ?? '', id: `fe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now() }]);
  }, []);
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
    /** 委派来源投影（D7）：子会话在历史中彻底隐藏，收进右栏"子会话" */
    spawnBy?: { parentSessionId: string };
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
  // §5b：null = 概览（默认）；点 section 行进详情
  const [rightTab, setRightTab] = useState<'context' | 'run' | 'services' | 'tasks' | 'schedules' | 'subsessions' | 'attachments' | 'roots' | 'git' | 'file' | 'tools' | null>(null);
  // 专家模式：显示「运行透视」组（上下文/Run/服务）——普通用户不需要关注这 3 个
  const [expertMode, setExpertMode] = useState(() => {
    try {
      return localStorage.getItem('octopi.expert') === '1';
    } catch {
      return false;
    }
  });
  const [connectError, setConnectError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** 创建在途的同步镜像：state 是旧闭包值，连按 Enter / 连点按钮的同步重入只能靠 ref 拦 */
  const creatingRef = useRef(false);
  /** 切换 agent 联动中（防双击并发切换） */
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const [mobileTab, setMobileTab] = useState<'chat' | 'left' | 'right'>('chat');
  const [showAllSessions, setShowAllSessions] = useState(false);
  /** 左栏历史高亮会话（与查看态解耦：点子会话只切中/右栏，左栏保持主会话选中） */
  const [sidebarSessionId, setSidebarSessionId] = useState<string | null>(null);
  /** 当前查看会话的直接子会话（右栏"子会话"数据源；委派 spawnBy 归属） */
  const [childSessions, setChildSessions] = useState<SessionSummary[]>([]);

  const clientRef = useRef<OctopiClient | null>(null);
  const storeRef = useRef<OctopiRuntimeStore | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 跟随输出滚到底；用户上滑后暂停，回到底部或新一轮回复再恢复 */
  const stickToBottomRef = useRef(true);
  /** 最近一次程序滚动钉底后的实际 scrollTop：scroll 回调据此区分自家钉底与用户上滑 */
  const pinnedScrollTopRef = useRef<number | null>(null);
  /** 会话流内容根节点：ResizeObserver 观察其尺寸变化，异步长高时继续跟随 */
  const conversationContentRef = useRef<HTMLDivElement | null>(null);
  /** 视口写权威：分页回顶 restore 与 turn 跳转定位互斥（协议见 viewport-authority.ts）。
   * 职责：①程序写互斥与补偿让路 ②程序滚动回响不参与跟随意图判定 ③自动加载入口闸 */
  const viewportAuthorityRef = useRef(createViewportAuthority());
  /** user-messages 投影适配后的历史 turn 条目（未加载区间 marker 的来源） */
  const [historyTurnItems, setHistoryTurnItems] = useState<ConversationItem[]>([]);
  /** 回底悬浮按钮：上滑超过一屏时显示 */
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  /** 当前视口所处 turn 的 marker key（滚动追踪） */
  const [activeTurnKey, setActiveTurnKey] = useState<string | null>(null);
  /** 正在加载定位的 marker key */
  const [turnJumpBusyKey, setTurnJumpBusyKey] = useState<string | null>(null);
  /** 视口 turn 追踪的 rAF 节流句柄 */
  const activeTurnRafRef = useRef<number | null>(null);
  /** 会话 id 镜像同步（跳转续体据此判会话切换；state 是旧闭包值不可靠） */
  activeSessionIdRef.current = activeSessionId;
  /** turn 跳转 token：最新一次点击胜出，旧跳转不得覆盖视口/忙碌态 */
  const turnJumpTokenRef = useRef(0);

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
      const list = (e.detail.sessions ?? []) as Array<{ id: string; lastInteractionAt?: number; spawnBy?: unknown }>;
      setSessions(e.detail.sessions);
      // 刷新后自动打开最近会话，否则回放文件卡片无从恢复。
      // 若 store 已有活动会话（createSession 刚建完）或本组件已选中，禁止抢开旧会话。
      // 子会话（spawnBy）不参与自动打开：历史对用户隐藏，收进右栏"子会话"
      const storeChatId = storeRef.current?.getState().chat.sessionId;
      if (
        !activeSessionIdRef.current &&
        !storeChatId &&
        list.length > 0
      ) {
        const latest = [...list]
          .filter((s) => !s.spawnBy)
          .sort(
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
    store.addEventListener('error', (() => {
      setConnectError(tc('chatWorkspace.connectError')); // MINOR-6：不甩 raw
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

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // 浏览器把 scrollTop 钳到 scrollHeight - clientHeight；读回钳后值作为“自家钉底”锚点
    pinnedScrollTopRef.current = el.scrollTop;
  }, []);

  /** 新一轮 agent 回复 / 打开会话时恢复粘底跟随 */
  const enableStickToBottom = () => {
    stickToBottomRef.current = true;
    scrollToBottom();
  };

  const handleConversationScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 程序滚动（分页回顶 / 跳转定位）的回响不参与跟随意图判定：restore 的盲写
    // 曾把回到底部的用户拽回旧位、其事件把跟随永久打断。仅真实用户滚动定意图
    if (!viewportAuthorityRef.current.isProgrammaticScroll()) {
      // 归属后再更新跟随意图：自家钉底的回响不得误判成用户上滑（conversation-follow）
      const follow = reduceScrollEvent(
        { stickToBottom: stickToBottomRef.current, pinnedScrollTop: pinnedScrollTopRef.current },
        { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      );
      stickToBottomRef.current = follow.stickToBottom;
      pinnedScrollTopRef.current = follow.pinnedScrollTop;
    }

    // 回底按钮：上滑超过一屏显示；视口所处 turn 同步追踪
    setShowBackToBottom(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight);
    scheduleActiveTurnUpdate();

    // 临近顶部：向前加载更早历史并拼在前面（纯展示；续聊走正常装配）
    if (el.scrollTop < 80 && storeRef.current?.hasMoreHistory()) {
      void loadMoreHistory();
    }
  };

  /** 等平滑滚动落定再交还视口权威（scrollend 事件；不支持时超时兜底） */
  const waitScrollEnd = (el: HTMLElement): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.removeEventListener('scrollend', finish);
        resolve();
      };
      el.addEventListener('scrollend', finish);
      timer = setTimeout(finish, 800);
    });

  const loadMoreHistory = async () => {
    const el = scrollRef.current;
    const store = storeRef.current;
    const authority = viewportAuthorityRef.current;
    if (!store || !store.hasMoreHistory()) return;
    // 他人（turn 跳转）持有视口权威期间不发起加载：定位过程不容第三方写滚动
    if (authority.isHeld()) return;
    const owner = authority.take();
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
        // 补偿写让路：仅当接管者已执行视口写才丢弃——跳转未滚动/放弃跳转时
        // 本页 prepend 的修补仍须落地，否则视口留在偏移处（C7）
        if (authority.shouldDropCompensation(owner)) {
          authority.release(owner);
          return;
        }
        const delta = el.scrollHeight - prevHeight;
        // 只在「用户仍停留在原阅读位」时回顶。加载期间移动过视口（回到最底部、
        // 点了回到底部）就不得把人拽回旧位置——盲写（含 0 条加载的 prevTop+0）
        // 会把人拽离底部并让其 scroll 事件误杀粘底跟随。候选二（prevTop+delta）
        // 是 scroll anchoring 已补偿到位的情形：写入只消除 ≤容差的下方长高残差，
        // 并非严格无操作；残差超容差时跳过更正确（anchoring 已保持视觉位置）
        if (shouldApplyCompensation({ scrollTop: el.scrollTop, prevTop, delta })) {
          authority.markScrolled(owner); // 程序写：其 scroll 回响不得改变跟随意图
          el.scrollTop = prevTop + delta;
        }
        // 下一任务再解除权威。回响派发时序无规范保证（可能落在解除之后），
        // 但补偿写保持距底距离不变，晚到回响按距离重算得到相同意图，结果无害
        setTimeout(() => authority.release(owner), 0);
      });
    } else {
      authority.release(owner);
    }
  };

  /** 视口所处 turn 追踪：rAF 节流扫 DOM 锚点，取最后一个越过视口顶部的 turn */
  const scheduleActiveTurnUpdate = () => {
    if (activeTurnRafRef.current !== null) return;
    activeTurnRafRef.current = requestAnimationFrame(() => {
      activeTurnRafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + 24;
      let current: string | null = null;
      el.querySelectorAll<HTMLElement>('[data-turn-anchor]').forEach((a) => {
        if (a.getBoundingClientRect().top <= top) current = a.dataset.turnAnchor ?? null;
      });
      setActiveTurnKey(current);
    });
  };

  /** turn 定位锚点（data-turn-anchor 与 marker key 同源派生） */
  const findTurnAnchor = (el: HTMLElement, key: string): HTMLElement | null =>
    el.querySelector<HTMLElement>(`[data-turn-anchor="${key}"]`);

  /** 回到底部：恢复粘底跟随 */
  const backToBottom = () => {
    enableStickToBottom();
    setShowBackToBottom(false);
  };

  /** turn 定位跳转：未加载的 turn 先向前分页加载到 turn 首入列，再平滑定位。
   * 跳转 token：最新一次点击胜出——加载更慢的旧跳转不得后到覆盖视口/忙碌态/误报 toast */
  const jumpToTurn = async (marker: TurnMarker) => {
    const scroller = scrollRef.current;
    const store = storeRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!scroller || !store || !sessionId) return;
    const token = ++turnJumpTokenRef.current;
    // 跳转即回看历史：显式离开底部，后续输出不再跟随
    stickToBottomRef.current = false;
    // 全程持有视口权威：分页期间无人回顶/加载，平滑滚动尾巴不被 restore 掐断
    const authority = viewportAuthorityRef.current;
    const owner = authority.take();
    setTurnJumpBusyKey(marker.key);
    const aborted = () => turnJumpTokenRef.current !== token || activeSessionIdRef.current !== sessionId;
    // 分页看门狗：网关无响应（如事件循环冻结）时不无限持有视口权威
    let pagingTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      let anchor = findTurnAnchor(scroller, marker.key);
      let timedOut = false;
      if (!anchor && typeof marker.sourceIndex === 'number') {
        const loaded = await Promise.race([
          store.ensureUserMessageLoaded(marker.sourceIndex),
          new Promise<false>((resolve) => {
            pagingTimer = setTimeout(() => {
              timedOut = true;
              resolve(false);
            }, 30_000);
          }),
        ]);
        // prepend 渲染提交后锚点节点才存在：等提交落地再查。
        // 当前会话事件是同步 dispatch + 同步渲染，一帧足够；有界重试兜住
        // 将来改为过渡渲染（transition）时该假设失效的情况
        for (let i = 0; i < 3 && loaded && !anchor && !aborted(); i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          anchor = findTurnAnchor(scrollRef.current ?? scroller, marker.key);
        }
      }
      // 会话已切换或已有更新的跳转：本次作废，不动视口、不弹误报
      if (aborted()) return;
      if (!anchor) {
        setToast(t(timedOut ? 'chatWorkspace.turnJumpTimeout' : 'chatWorkspace.turnJumpFailed'));
        return;
      }
      const top = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const target = Math.max(0, scroller.scrollTop + top - 12);
      if (Math.abs(target - scroller.scrollTop) > 2) {
        authority.markScrolled(owner);
        scroller.scrollTo({ top: target, behavior: 'smooth' });
        await waitScrollEnd(scroller);
      }
      scheduleActiveTurnUpdate();
    } finally {
      clearTimeout(pagingTimer);
      authority.release(owner);
      if (!aborted()) setTurnJumpBusyKey(null);
    }
  };

  // Auto-scroll：仅在用户仍贴近底部时跟随；上滑阅读中不打断。
  // 用 layout effect 在 DOM 变更的同一提交内钉底：若等 passive effect，下一批
  // 工具卡片可能先于钉底落地，钉底 scroll 事件会被误读成“用户上滑”（同竞态另一侧）
  useLayoutEffect(() => {
    // 钉底不视「视口写权威」自抑：加载在途曾把工具完成时的钉底整个压制（内容
    // 长在视口外无人管）。与 restore 的冲突由其「仍停留原位」守卫裁决——钉底
    // 挪过视口后 restore 自然让路
    if (!stickToBottomRef.current) return;
    scrollToBottom();
  }, [conversationItems, stream, questions, approvals, clientToolCalls, renderedWebViews, scrollToBottom]);

  // 工具卡片展开、图片/iframe 加载等“无新事件的长高”也要跟随
  useEffect(() => {
    const content = conversationContentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      scrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  // turn 定位索引：user-messages 投影适配（失败降级为只显示已加载 turn）
  useEffect(() => {
    const client = clientRef.current;
    const sessionId = activeSessionId;
    // 会话切换：定位轨/跳转/回底状态全部作废重置，旧会话的 key 不得泄漏到新会话。
    // 视口权威一并复位：在途跳转的持有全部作废，否则其 waitScrollEnd 尾巴会把
    // 新会话的粘底钉底压住数百毫秒（C5）——旧持有者的 release 会因标记过期自然落空
    turnJumpTokenRef.current += 1;
    viewportAuthorityRef.current.reset();
    setHistoryTurnItems([]);
    setActiveTurnKey(null);
    setTurnJumpBusyKey(null);
    setShowBackToBottom(false);
    if (!client || !sessionId) return;
    let cancelled = false;
    void client
      .getSessionUserMessages(sessionId)
      .then(({ messages }) => {
        if (cancelled) return;
        setHistoryTurnItems(ConversationAdapter.buildHistoryItems(messages, sessionId));
      })
      .catch(() => { /* 展示层降级：定位轨只显示已加载 turn，不打断会话 */ });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // 定位轨 marker：历史索引 ∪ 已加载用户条目（合并规则见 turn-rail）
  const turnMarkers = useMemo(
    () => buildTurnMarkers(historyTurnMarkers(historyTurnItems), conversationItems),
    [historyTurnItems, conversationItems],
  );

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
      // MINOR-6：模型错误人话化在写入侧（raw 不进用户面）
      {
        const raw = error instanceof Error ? error.message : String(error);
        const c = classifyFlowError(raw, 'provider');
        setModelError(`${c.title}${c.detail ? `——${c.detail}` : ''}`);
      }
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
    // 调用时读地址/密钥：设置-服务保存后重连立即生效（M3，勿用挂载时快照）
    store.reconnect(resolveDefaultBase(), getConsoleKey() || undefined);
    await refresh();
  };

  const openSession = async (sessionId: string, opts?: { keepSidebarSelection?: boolean }) => {
    const store = storeRef.current;
    if (!store) return;
    await store.openSession(sessionId);
    const state = store.getState();
    // 打开会话始终从底部开始看
    enableStickToBottom();
    setActiveSessionId(sessionId);
    activeSessionIdRef.current = sessionId;
    // 点子会话下钻时左栏保持主会话选中（其余入口：高亮跟随打开的会话）
    if (!opts?.keepSidebarSelection) setSidebarSessionId(sessionId);
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

  /**
   * 点子会话行：中栏对话与右栏信息切换为子会话，左栏历史保持主会话选中
   * （产品定稿 2026-11-17：行为同点历史会话，仅左栏高亮不解耦）。
   */
  const openChildSession = (childId: string) => {
    setRightTab(null);
    void openSession(childId, { keepSidebarSelection: true });
  };

  /** 切换查看会话先清空子会话列表：防上一个会话的列表在拉取间隙闪现（NIT-2） */
  useEffect(() => {
    setChildSessions([]);
  }, [activeSessionId]);

  /** 当前查看会话的直接子会话（右栏"子会话"徽标与列表）：开面板/运行态/会话增删时刷新 */
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !activeSessionId || connection !== 'connected') {
      setChildSessions([]);
      return;
    }
    let cancelled = false;
    void client
      .listChildSessions(activeSessionId)
      .then((list) => {
        if (!cancelled) setChildSessions(list);
      })
      .catch(() => {
        // 查询失败显式清空：不拿陈旧列表冒充当前会话的子会话
        if (!cancelled) setChildSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, connection, runStatus, rightTab, sessions.length]);

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
      setActionError(t('chatWorkspace.titleEmpty'));
      return;
    }
    try {
      await store.renameSession(sessionId, title);
      setRenamingSessionId(null);
      setRenameDraft('');
    } catch (e) {
      pushFlowError(classifyFlowError(e instanceof Error ? e.message : String(e), 'app'));
      setActionError(t('chatWorkspace.actionFailed'));
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
      setToast(pinned ? t('chatWorkspace.toastPinned') : t('chatWorkspace.toastUnpinned'));
    } catch (e) {
      pushFlowError(classifyFlowError(e instanceof Error ? e.message : String(e), 'app'));
      setActionError(t('chatWorkspace.actionFailed'));
    }
  };

  /** 清空活动会话的 UI 态（删除会话后 / 远端删除广播）。useCallback：挂载期监听器长期持有，只碰稳定 setter/ref */
  const clearActiveSessionUi = useCallback(() => {
    const clearedId = activeSessionIdRef.current;
    setActiveSessionId(null);
    activeSessionIdRef.current = null;
    // 左栏高亮仅在正指向被清会话时清除：查看子会话时它被删，主会话高亮保留
    setSidebarSessionId((prev) => (prev === clearedId ? null : prev));
    setChildSessions([]);
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
        setActionError(t('chatWorkspace.deleteWhileRunning'));
        return;
      }
    }
    const label = target ? sessionDisplayTitle(target) : sessionId;
    if (!window.confirm(t('chatWorkspace.deleteConfirm', { label }))) return;
    setActionError(null);
    try {
      await store.deleteSession(sessionId);
      if (activeSessionIdRef.current === sessionId) {
        clearActiveSessionUi();
      }
      if (sidebarSessionId === sessionId) setSidebarSessionId(null);
      setToast(t('chatWorkspace.toastSessionDeleted'));
    } catch (e) {
      pushFlowError(classifyFlowError(e instanceof Error ? e.message : String(e), 'app'));
      setActionError(t('chatWorkspace.actionFailed'));
    }
  };

  /**
   * 新建会话后的 UI 全量激活（评审 M5：activeSessionIdRef/状态重置/文件卡清空/模型刷新
   * 缺一即状态分叉）。
   */
  const activateCreatedSession = async (created: { id: string }) => {
    enableStickToBottom();
    setActiveSessionId(created.id);
    activeSessionIdRef.current = created.id;
    setSidebarSessionId(created.id);
    setRunStatus('idle');
    setStream('');
    setConversationItems(storeRef.current!.getState().chat.conversation ?? []);
    setTasks(storeRef.current!.getTasks());
    setSchedules(storeRef.current!.getSchedules());
    setQuestions(storeRef.current!.getQuestions());
    setApprovals(storeRef.current!.getApprovals());
    setClientToolCalls(storeRef.current!.getClientToolCalls());
    // 新会话不得残留上一会话的文件卡片/预览
    setRenderedWebViews([]);
    setDeliveredFiles([]);
    setFocusFileId(null);
    void registerSampleClientTools(created.id);
    await storeRef.current!.refreshSessionModel();
    const sm = storeRef.current!.getSessionModel();
    setSessionModel(sm);
    if (sm) setSelectedModelId(sm.modelId ?? sm.defaultModelId);
  };

  /**
   * 新建会话并切为活动会话。
   * @returns 创建出的会话；null = 未创建，分两种：
   *   - 前置条件不满足 / 创建抛错 → 原因已写入 actionError，调用方可据此中止后续动作；
   *   - 创建在途（creatingRef）或 store 未就绪 → 静默返回、不报错（前者是被吸收的重复触发，不是失败）。
   */
  const createSession = async (): Promise<{ id: string } | null> => {
    if (connection !== 'connected') { setActionError(t('chatWorkspace.createNeedsConnection')); return null; }
    if (!agentId) { setActionError(t('chatWorkspace.createNeedsAgent')); return null; }
    const store = storeRef.current;
    if (!store) return null;
    // 创建在途（连点「新会话」/连按 Enter）：不再并发建出第二个会话
    if (creatingRef.current) return null;
    setActionError(null);
    setCreating(true);
    creatingRef.current = true;
    try {
      const modelToApply = selectedModelId && selectedModelId !== agentDefaultModelId
        ? selectedModelId
        : undefined;
      const created = await store.createSession(agentId, modelToApply ? { model: modelToApply } : undefined);
      await activateCreatedSession(created);
      return created;
    } catch (error) {
      pushFlowError(classifyFlowError(error instanceof Error ? error.message : String(error), 'app'));
      setActionError(t('chatWorkspace.actionFailed'));
      return null;
    } finally {
      setCreating(false);
      creatingRef.current = false;
    }
  };

  /** 详情浮层 Esc 关闭 + 焦点管理（批 3-3 / 评审 m10） */
  const detailModalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (rightTab === null) return;
    detailModalRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRightTab(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rightTab]);

  /**
   * 切换 agent：会话列表 + 中部窗口 + 右栏 + store 活动会话全量联动。
   *
   * 只 setAgentId 会让左栏列表（客户端过滤）看似同步、而中部/右栏仍绑旧会话，
   * 且 store.chat 仍指旧会话（此时发送会静默串台）。联动语义：打开该 agent
   * 最近会话；无会话则退回「未选中」空态（新建会话起点）。
   */
  const selectAgent = async (id: string) => {
    if (id === agentId || switchingAgent) return;
    const store = storeRef.current;
    if (!store) {
      setAgentId(id);
      return;
    }
    setActionError(null);
    setSwitchingAgent(true);
    const prevAgentId = agentId;
    try {
      const list = await store.refreshSessions(id);
      // 与 sessions 事件自动打开同口径：子会话（spawnBy）历史中彻底隐藏，不作打开候选
      const latest = [...list]
        .filter((s) => !s.spawnBy)
        .sort(
          (a, b) => (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0),
        )[0];
      // 成功拉到该 agent 的会话列表后才切换 UI agentId
      setAgentId(id);
      if (latest) {
        // S7：目标会话已打开则跳过（refreshSessions 的 sessions 事件监听器可能已自动打开）
        if (store.getState().chat.sessionId !== latest.id) {
          enableStickToBottom();
          await openSession(latest.id);
        }
      } else {
        store.closeCurrentSession();
        clearActiveSessionUi();
        setViewMode('history');
      }
    } catch (error) {
      // M5：切换失败必须退到空态并回滚 agentId——否则 UI 显示新 agent 而 store.chat 仍指
      // 旧会话，此时发送会静默串台（正是本 bug 的定义）
      pushFlowError(classifyFlowError(error instanceof Error ? error.message : String(error), 'app'));
      setActionError(t('chatWorkspace.actionFailed'));
      store.closeCurrentSession();
      clearActiveSessionUi();
      setViewMode('history');
      setAgentId(prevAgentId);
    } finally {
      setSwitchingAgent(false);
    }
  };

  const branchFromIndex = async (beforeIndex: number) => {
    const store = storeRef.current;
    const parent = activeSessionId;
    if (!store || !parent) {
      setActionError(t('chatWorkspace.branchNeedsSession'));
      return;
    }
    setActionError(null);
    try {
      const created = await store.branchSession(parent, beforeIndex);
      enableStickToBottom();
      setActiveSessionId(created.id);
      activeSessionIdRef.current = created.id;
      // 分支是用户选择的新会话：左栏高亮跟随（否则高亮停在旧会话上）
      setSidebarSessionId(created.id);
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
      pushFlowError(classifyFlowError(error instanceof Error ? error.message : String(error), 'app'));
      setActionError(t('chatWorkspace.actionFailed'));
    }
  };

  const editAndResend = async (userMessageIndex: number | undefined, content: string) => {
    const store = storeRef.current;
    if (!store) return;
    setActionError(null);
    try {
      await store.editAndResend(userMessageIndex, content);
      enableStickToBottom();
      setRunStatus(store.getState().chat.runStatus);
      setStream('');
      setTasks(store.getTasks());
      setQuestions(store.getQuestions());
      setApprovals(store.getApprovals());
      setClientToolCalls(store.getClientToolCalls());
    } catch (error) {
      pushFlowError(classifyFlowError(error instanceof Error ? error.message : String(error), 'app'));
      setActionError(t('chatWorkspace.actionFailed'));
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
      pushFlowError(classifyFlowError(error instanceof Error ? error.message : String(error), 'app'));
      setActionError(t('chatWorkspace.actionFailed'));
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
      pushFlowError(classifyFlowError(error instanceof Error ? error.message : String(error), 'app'));
      setActionError(t('chatWorkspace.actionFailed'));
    } finally {
      setDecidingApproval(false);
    }
  };

  const sendMessage = async (textOverride?: string) => {
    const store = storeRef.current;
    // 提前捕获待发附件：下面 await 自动建会话会跨越 activeSessionId 变更，[activeSessionId] effect
    // 会清空 pendingAttachments。当前上传本就要求已有会话（此刻必为空），这是防御性就地读取——
    // 将来若放开无会话上传，就不会被那个 effect 静默清掉、丢掉用户已挂上的文件
    const attachmentIds = pendingAttachments.map((a) => a.id);
    const hasAttach = attachmentIds.length > 0;
    const rawInput = textOverride ?? input;
    if (!store || (!rawInput.trim() && !hasAttach)) return;
    const text = rawInput.trim();

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

    // 无活动会话（首启 / 新建 agent 的空历史）：发送即自动建会话，再把这条消息发进新会话。
    if (!activeSessionId) {
      // /stop 无会话可停：静默忽略——既不为其建会话，也不让 store 抛「No active session」错误卡
      if (isStop) return;
      const created = await createSession();
      // null = 创建在途被吸收（静默，输入保留）或前置条件失败（原因已写入 actionError）
      if (!created) return;
    }

    setActionError(null);
    // 用户主动发起新一轮：恢复粘底跟随
    enableStickToBottom();
    if (!interjecting) setRunStatus('waiting');
    try {
      await store.sendMessage(text, {
        attachmentIds,
      });
      setInput('');
      setPendingAttachments([]);
    } catch (error) {
      // 发送失败：store 已退出 waiting；保留输入便于重试
      pushFlowError(classifyFlowError(error instanceof Error ? error.message : String(error), 'app'));
      setActionError(t('chatWorkspace.actionFailed'));
      const st = store.getState().chat.runStatus;
      setRunStatus(st === 'waiting' || st === 'sending' ? 'error' : st);
    }
  };

  const uploadFiles = async (fileList: FileList | File[]) => {
    const client = clientRef.current;
    if (!client || !activeSessionId) {
      setActionError(t('chatWorkspace.uploadNeedsSession'));
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
      setToast(t('chatWorkspace.toastUploaded', { count: uploaded.length }));
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

  // 命令列表键盘导航：选中项移出弹层可视区时自动滚动跟进（ArrowDown/Up 焦点可见）
  const activeCmdItemRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeCmdItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cmdSuggestIndex, showCmdSuggest]);

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
      // 无活动会话同样放行：sendMessage 内自动建会话（创建在途/失败由其自行中止）
      if (!input.trim()) return;
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
        show(r.reason || t('chatWorkspace.compactUnavailable'));
      } else if (!r.compacted) {
        show(r.reason || t('chatWorkspace.notCompacted'));
      } else if (r.contextSize == null) {
        // 降级显式（评审 F7）：压缩成功但没拿到压缩后读数快照——不静默成功，提示已压缩但无读数
        show(t('chatWorkspace.compactedNoSize'));
      }
      // 正常成功不弹「已结构压缩」提示（2026-11-18 产品变更）：顶栏上下文大小前段直接换显压缩后大小
    } catch (e) {
      show(e instanceof Error ? e.message : String(e));
    } finally {
      // 与 show 同款守卫：A 会话的收尾不得清掉 B 会话进行中的压缩标志
      if (activeSessionIdRef.current === sid) setCompacting(false);
    }
  };

  // Derive lists from conversation items
  const toolItems = conversationItems.filter((i): i is ToolConversationItem => i.role === 'tool');

  // 子会话（spawnBy）在历史中彻底隐藏（产品定稿 2026-11-17）：收进右栏"子会话"
  const agentSessions = sessions.filter(s => !s.spawnBy)
    .filter(s => agentId ? s.agentId === agentId : true)
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
  // 上下文用量：实测只进主显示（step.end usage / 持久化恢复），无实测不猜（新会话显示 '~'）；
  // 视图估算按产品裁决不再在对话面呈现（rawTokens 仍只在 Run 页签）。
  // 不用「已加载消息」估算——那只是末页 100 条，会把 400k 的会话显示成 21.6k 误导人。
  const promptTokensActual = typeof inspector.promptTokensActual === 'number' ? inspector.promptTokensActual : undefined;
  // 当前上下文大小显示槽（服务端 contextSize 快照，随会话持久化）：顶栏前段唯一取数源。
  // tooltip 按 source 标注（usage=上次实测 / compact-est=压缩后估算）+ asOf 时点——R3 来源
  // 标注，冷恢复后仍诚实。旧会话无快照时回退 promptTokensActual（标注「上次实测」）。
  const contextSize = inspector.contextSize;
  const contextSizeDisplay = contextSize?.tokens ?? promptTokensActual;
  // 预算展示：只读引擎下发的 snapshot（catalog / sessionModel.resolved），UI 不做策略
  const selectedModelMeta =
    (sessionModel?.resolved?.id === effectiveModelId ? sessionModel.resolved : undefined)
    ?? modelCatalog.models.find(m => m.id === effectiveModelId);
  const contextWindow = selectedModelMeta?.contextWindow
    ?? null;
  const contextWindowKnown = Boolean(selectedModelMeta?.known) && contextWindow != null;
  const contextWindowLabel = contextWindowKnown && contextWindow != null
    ? formatTokens(contextWindow)
    : t('chatWorkspace.unknown');

  return (
    <>
      {/* Reconnect banner */}
      {isReconnecting && (
        <div className="reconnect-banner">
          {t('chatWorkspace.reconnectBanner')}
        </div>
      )}

      {/* Mobile nav (hidden on desktop) */}
      <nav className="mobile-nav">
        <button className={mobileTab === 'left' ? 'mobile-nav-active' : ''} onClick={() => setMobileTab('left')}>{t('chatWorkspace.navSettings')}</button>
        <button className={mobileTab === 'chat' ? 'mobile-nav-active' : ''} onClick={() => setMobileTab('chat')}>{t('chatWorkspace.navChat')}</button>
        <button className={mobileTab === 'right' ? 'mobile-nav-active' : ''} onClick={() => setMobileTab('right')}>{t('chatWorkspace.navInspect')}</button>
      </nav>

      <main
        className={`app-main ${rightPanelVisible ? '' : 'app-main-no-right'} ${mobileTab === 'left' ? 'mobile-show-left' : ''} ${mobileTab === 'right' ? 'mobile-show-right' : ''}`}
        style={{ '--right-panel-w': `${rightPanelWidth}px`, '--sidebar-w': `${leftPanelWidth}px` } as React.CSSProperties}
      >
        {/* 左栏手柄放在 .app-main 内、.left-sidebar 外：aside 有 overflow-x:hidden，会把手柄裁掉 */}
        <div
          className="left-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('chatWorkspace.leftSplitterAria')}
          onPointerDown={onLeftSplitterPointerDown}
          onPointerMove={onLeftSplitterPointerMove}
          onPointerUp={onLeftSplitterPointerUp}
          onPointerCancel={onLeftSplitterPointerUp}
          onDoubleClick={onLeftSplitterDoubleClick}
        />
        {/* ── 左栏：连接、Agent、会话 ── */}
        <aside className="left-sidebar">
          <section className="connection-strip">
            <button
              type="button"
              className={`connection-dot connection-dot-${connection}`}
              onClick={() => void reconnect()}
              title={t('chatWorkspace.connectionTitle', { state: connection, base: baseUrl })}
              aria-label={t('chatWorkspace.reconnectAria')}
            />
            <span className="small muted">{connection}</span>
            <a className="small muted connection-strip-settings" href="#settings-services" title={t('chatWorkspace.settingsServices')}>{t('chatWorkspace.navSettings')}</a>
            {connectError && <span className="small status-error" title={connectError}>⚠</span>}
          </section>

          <section className="panel sidebar-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div className="sidebar-title" style={{ marginBottom: 0 }}>{t('chatWorkspace.selectAgent')}</div>
              <span className="small muted">{agents.length}</span>
            </div>
            {connection !== 'connected' ? (
              <div className="small muted">{t('chatWorkspace.connectFirst')}</div>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {agents.map(a => (
                  <button
                    key={a.id}
                    className={`btn-secondary agent-btn ${agentId === a.id ? 'agent-btn-selected' : ''}`}
                    onClick={() => void selectAgent(a.id)}
                    disabled={switchingAgent}
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
                            ? t('chatWorkspace.effectSourceAgent')
                            : a.effectModeSource === 'global'
                              ? t('chatWorkspace.effectSourceGlobal')
                              : t('chatWorkspace.effectSourceDefault')
                        }
                      >
                        {a.effectMode ?? 'workspace'}
                      </span>
                      {a.effectModeSource && a.effectModeSource !== 'agent' && (
                        <span className="small muted">
                          {a.effectModeSource === 'global' ? t('chatWorkspace.effectModeGlobal') : t('chatWorkspace.effectModeDefault')}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
                {!agents.length && <div className="small muted">{t('chatWorkspace.noAgents')}</div>}
              </div>
            )}
          </section>

          <section className="panel sidebar-section">
            <div className="sidebar-title">{t('chatWorkspace.newSession')}</div>
            <div className="small muted" style={{ marginBottom: 8 }}>
              {agentId ? t('chatWorkspace.currentAgent', { id: agentId }) : t('chatWorkspace.selectAgentFirst')}
            </div>
            <button className="btn-primary" onClick={createSession} disabled={creating} style={{ width: '100%', marginBottom: 8, opacity: creating ? 0.7 : 1 }}>
              {creating ? t('chatWorkspace.creating') : t('chatWorkspace.newSession')}
            </button>
            {actionError && <div className="small status-error" style={{ marginBottom: 8 }}>{actionError}</div>}

            <div className="sidebar-title">{t('chatWorkspace.historySessions')}</div>
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
                      <button className="btn-primary small" style={{ flex: 1 }} onClick={() => void commitRenameSession()}>{t('chatWorkspace.save')}</button>
                      <button className="btn-ghost small" style={{ flex: 1 }} onClick={() => { setRenamingSessionId(null); setRenameDraft(''); }}>{t('chatWorkspace.cancel')}</button>
                    </div>
                  </div>
                ) : (
                  <div key={s.id} className="session-card">
                    <button
                      className={`btn-secondary session-btn ${(sidebarSessionId ?? activeSessionId) === s.id ? 'session-btn-active' : ''}`}
                      onClick={() => openSession(s.id)}
                      onDoubleClick={() => startRenameSession(s.id, s.title ?? sessionDisplayTitle(s))}
                      title={t('chatWorkspace.sessionBtnTitle')}
                    >
                      <div className="session-card-title-row">
                        <span className="session-card-title">{sessionDisplayTitle(s)}</span>
                        {s.pinnedAt != null && (
                          <span className="session-pin-chip" title={t('chatWorkspace.pinnedTitle')}>{t('chatWorkspace.pinned')}</span>
                        )}
                        {s.running && (
                          <span className="session-running-badge" title={t('chatWorkspace.sessionRunningTitle')}>
                            <span className="session-running-dot" />
                            {t('chatWorkspace.running')}
                          </span>
                        )}
                      </div>
                      <div className="small muted session-card-meta">
                        {s.agentId} · {formatTimestamp(s.lastInteractionAt)}
                      </div>
                    </button>
                    <button
                      className="session-menu-btn"
                      title={t('chatWorkspace.moreActions')}
                      aria-label={t('chatWorkspace.sessionMenuAria')}
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
                            {s.pinnedAt == null ? t('chatWorkspace.pinSession') : t('chatWorkspace.unpinSession')}
                          </button>
                          <button
                            className="session-menu-item session-menu-item-danger"
                            role="menuitem"
                            onClick={() => { closeSessionMenu(); void removeSession(s.id); }}
                          >
                            {t('chatWorkspace.deleteSession')}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )
              ))}
              {!agentSessions.length && <div className="small muted">{t('chatWorkspace.noHistory')}</div>}
            </div>
            {hiddenSessionCount > 0 && !showAllSessions && (
              <button
                className="btn-ghost small"
                style={{ marginTop: 6, textAlign: 'center', width: '100%', color: 'var(--color-muted)' }}
                onClick={() => setShowAllSessions(true)}
              >
                {t('chatWorkspace.showMoreSessions', { count: hiddenSessionCount })}
              </button>
            )}
            {showAllSessions && agentSessions.length > VISIBLE_SESSION_COUNT && (
              <button
                className="btn-ghost small"
                style={{ marginTop: 6, textAlign: 'center', width: '100%', color: 'var(--color-muted)' }}
                onClick={() => setShowAllSessions(false)}
              >
                {t('chatWorkspace.collapseSessions')}
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
                      : t('chatWorkspace.noSessionSelected')}
                  </span>
                  {activeSessionId && (
                    <button
                      className="btn-ghost small"
                      style={{ flexShrink: 0 }}
                      onClick={() => {
                        const cur = sessions.find(s => s.id === activeSessionId);
                        startRenameSession(activeSessionId, cur?.title ?? sessionDisplayTitle(cur ?? { id: activeSessionId }));
                      }}
                      title={t('chatWorkspace.renameSessionTitle')}
                    >
                      {t('chatWorkspace.rename')}
                    </button>
                  )}
                </div>
                <div className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>{agentId ? t('chatWorkspace.agentLine', { id: agentId }) : t('chatWorkspace.selectAgentFirst')}</span>
                  <span
                    className="composer-usage small"
                    title={t(
                      contextSize
                        ? contextSize.source === 'compact-est'
                          ? 'chatWorkspace.contextUsageTitlePostCompact'
                          : 'chatWorkspace.contextUsageTitleAt'
                        : 'chatWorkspace.contextUsageTitle',
                      {
                        actual: contextSizeDisplay !== undefined ? formatTokens(contextSizeDisplay) : '~',
                        window: contextWindowLabel,
                        asOf: contextSize ? new Date(contextSize.asOf).toLocaleString() : '',
                      },
                    )}
                  >
                    {contextSizeDisplay !== undefined ? formatTokens(contextSizeDisplay) : '~'} / {contextWindowLabel}
                  </span>
                </div>
              </div>
              <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className={runStatus === 'error' ? 'status-error' : runStatus === 'streaming' ? 'status-ok' : 'status-neutral'}>{t(runStatusLabelKey(runStatus, compacting || inspector.compact?.active === true))}</span>
                <button
                  className="btn-secondary small"
                  onClick={() => void runManualCompact()}
                  disabled={!activeSessionId || compacting}
                  title={t('chatWorkspace.compactTitle')}
                >
                  {compacting ? t('chatWorkspace.compacting') : t('chatWorkspace.compact')}
                </button>
                <button className="btn-secondary small" onClick={abort} disabled={!['streaming', 'waiting', 'tools', 'sending'].includes(runStatus)}>{t('chatWorkspace.abort')}</button>
              </div>
            </div>
            {compactMsg && (
              <div className="small muted" style={{ marginTop: 4 }}>{compactMsg}</div>
            )}
          </div>

          <div className="conversation-area">
          <div ref={scrollRef} className="conversation-scroll" onScroll={handleConversationScroll}>
            {/* 会话流内容根节点：ResizeObserver 的观察目标（异步长高仍跟随） */}
            <div ref={conversationContentRef} className="conversation-flow">
            {!activeSessionId && (
              <div className="panel empty-hint">
                <div className="empty-hint-title">{t('chatWorkspace.welcome')}</div>
                <div className="small muted">
                  {t('chatWorkspace.welcomeHintPrefix')}<b>{t('chatWorkspace.welcomeHintBold')}</b>{t('chatWorkspace.welcomeHintSuffix')}
                </div>
              </div>
            )}
            {activeSessionId && conversationItems.length === 0 && (
              <div className="panel empty-hint">
                <div className="empty-hint-title">{t('chatWorkspace.sayHi')}</div>
                <div className="small muted" style={{ marginBottom: 12 }}>
                  {t('chatWorkspace.sayHiHint')}
                </div>
                <div className="quick-prompts">
                  {QUICK_PROMPT_KEYS.map((key) => {
                    const prompt = t(key);
                    return (
                      <button
                        key={key}
                        className="btn-secondary small quick-prompt"
                        onClick={() => {
                          setInput(prompt);
                          void sendMessage(prompt);
                        }}
                      >
                        {prompt}
                      </button>
                    );
                  })}
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
                const card = (
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
                );
                nodes.push({
                  id: item.id,
                  at: item.createdAt,
                  // 用户气泡挂 turn 定位锚点（data-turn-anchor 与 marker key 同源）
                  node:
                    item.role === 'user' ? (
                      <div key={item.id} data-turn-anchor={markerKeyOf(item as UserConversationItem)}>
                        {card}
                      </div>
                    ) : (
                      card
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

              // §5d：错误卡按时间交错进对话流
              // M-13：只渲染当前会话的错误卡（切会话不串台）
              for (const fe of flowErrors.filter((x) => x.sessionId === (activeSessionId ?? ''))) {
                nodes.push({
                  id: fe.id,
                  at: fe.at,
                  node: <ErrorCard key={fe.id} item={fe} />,
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
                  <span>{t('chatWorkspace.roleAssistant')}</span>
                  <span className="status-ok">· {t('chatWorkspace.statusStreaming')}</span>
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
                  <span>{t('chatWorkspace.roleAssistant')}</span>
                  {/* 重试中必须显式告知：否则用户看到的就是「等待响应」无限挂起 */}
                  {modelRetry ? (
                    <span className="status-warn">
                      {t('chatWorkspace.retryNotice', { attempt: modelRetry.attempt, max: modelRetry.maxAttempts })}
                      {modelRetry.delayMs > 0 ? t('chatWorkspace.retryDelay', { seconds: Math.round(modelRetry.delayMs / 1000) }) : ''}
                    </span>
                  ) : (
                    <span className="status-ok">· {runStatus === 'waiting' ? t('chatWorkspace.statusWaiting') : t('chatWorkspace.statusThinkingEllipsis')}</span>
                  )}
                </div>
                <div className="panel msg-assistant-body" style={{ borderColor: modelRetry ? '#fcd34d' : '#93c5fd' }}>
                  <div className="msg-assistant-content muted">
                    {modelRetry
                      ? t('chatWorkspace.retryReason', {
                          reason: modelRetry.reason,
                          error: modelRetry.error.length > 160 ? `${modelRetry.error.slice(0, 160)}…` : modelRetry.error,
                        })
                      : t('chatWorkspace.waitingNoContent')}
                  </div>
                </div>
              </div>
            )}
            </div>
          </div>
          <TurnRail
            markers={turnMarkers}
            activeKey={activeTurnKey}
            busyKey={turnJumpBusyKey}
            onJump={(m) => void jumpToTurn(m)}
          />
          {showBackToBottom && activeSessionId && (
            <button type="button" className="back-to-bottom" onClick={backToBottom}>
              ↓ {t('chatWorkspace.backToBottom')}
            </button>
          )}
          </div>

          {/* 对话 ↔ 输入区分割条（拖动调整输入区高度，双击复位） */}
          <div
            className="composer-splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('chatWorkspace.composerSplitterAria')}
            onPointerDown={onComposerSplitterDown}
            onPointerMove={onComposerSplitterMove}
            onPointerUp={onComposerSplitterUp}
            onPointerCancel={onComposerSplitterUp}
            onDoubleClick={onComposerSplitterDoubleClick}
          />
          <div
            className="composer"
            style={{ '--composer-h': `${composerHeight}px` } as React.CSSProperties}
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
            <div className="composer-attachments">
              {pendingAttachments.length > 0 && (
                <div className="attachment-chips">
                  {pendingAttachments.map((a) => (
                    <span key={a.id} className="attachment-chip">
                      {a.name}
                      <button
                        type="button"
                        className="btn-ghost small"
                        title={t('chatWorkspace.remove')}
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
            <div className="composer-input-wrap">
            {showCmdSuggest && (
              <div className="cmd-suggest" role="listbox">
                {cmdMatches.map((c, idx) => (
                  <div
                    key={c.name}
                    ref={idx === cmdSuggestIndex ? activeCmdItemRef : undefined}
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
            <textarea
              className="composer-textarea"
              value={input}
              onChange={e => {
                setInput(e.target.value);
                setCmdSuggestIndex(0);
              }}
              onKeyDown={handleComposerKeyDown}
              rows={1}
              placeholder={t('chatWorkspace.composerPlaceholder')}
              title={activeSessionId ? t('chatWorkspace.composerTitleActive', { id: activeSessionId }) : t('chatWorkspace.composerTitleInactive')}
            />
            </div>
            <div className="composer-footer">
              {/* 工具条：附件 / 语料 / 模型选择（会话控制与物料集中一行，不再底部单占一排） */}
              <div className="composer-tools">
                <label className="btn-secondary small" style={{ cursor: 'pointer' }}>
                  {uploading ? t('chatWorkspace.uploading') : t('chatWorkspace.attachments')}
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
              {/* 单行 footer：左=附件/语料；中=toast/警告；右=模型选择 + 发送（按钮尺寸统一） */}
              <div className="composer-footer-center small muted">
                {toast && <span className="corpus-toast">{toast}</span>}
                {openIssues.length > 0 && (
                  <span className="small" style={{ color: 'var(--color-warn)' }}>
                    ⚠️ {openIssues.length} issue · /issues
                  </span>
                )}
                {modelError && <span className="small status-error">{modelError}</span>}
                {/* actionError 只渲染在左栏，而左栏在移动端 chat 页签下是 CSS 隐藏的——
                    空态首条消息发送失败必须在输入区也露出，否则用户按了回车毫无反馈 */}
                {actionError && <span className="small status-error">{actionError}</span>}
              </div>
              <div className="composer-footer-right">
                <select
                  aria-label={t('chatWorkspace.sessionModelAria')}
                  className="model-select"
                  value={effectiveModelId}
                  onChange={(e) => void applyModelChange(e.target.value)}
                  disabled={connection !== 'connected' || !agentId}
                  title={t('chatWorkspace.sessionModelTitle')}
                >
                  {!effectiveModelId && <option value="">{t('chatWorkspace.modelDefaultOption')}</option>}
                  {agentDefaultModelId && (
                    <option value={agentDefaultModelId}>
                      {agentDefaultModelId}{t('chatWorkspace.agentDefaultSuffix')}
                    </option>
                  )}
                  {modelOptions.items
                    .filter(m => m.id !== agentDefaultModelId)
                    .map(m => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                        {m.known && m.contextWindow != null
                          ? ` · ${formatTokens(m.contextWindow)}`
                          : t('chatWorkspace.windowUnknown')}
                      </option>
                    ))}
                  {modelOptions.levelItems.map(lv => (
                    <option key={`level-${lv.levelName}`} value={lv.id}>
                      [{lv.levelName}] → {lv.id}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-primary small"
                  onClick={() => void sendMessage()}
                  disabled={
                    // 只在「本次发送正在等自动建会话」时禁用：已有会话时点新会话不该连坐发送键
                    // （Enter 路径本就不看 creating，两边必须同口径）
                    (!activeSessionId && creating) || (!input.trim() && pendingAttachments.length === 0)
                  }
                >
                  {t('chatWorkspace.send')}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ── 右栏：概览 + 详情（§5b） ── */}
        <aside className="right-panel">
          {/* §5b splitter：4px 手柄拖宽（280px–约视口 50%），双击复位 */}
          <div
            className="right-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('chatWorkspace.rightSplitterAria')}
            onPointerDown={onSplitterPointerDown}
            onPointerMove={onSplitterPointerMove}
            onPointerUp={onSplitterPointerUp}
            onPointerCancel={onSplitterPointerUp}
            onDoubleClick={onSplitterDoubleClick}
          />
          {/* ── 概览（重设计）：图标行 + 分组卡片 + 徽标；专家开关收口底部 ── */}
          <div className="rail-overview">
            {(() => {
              const railGroups: Array<{ titleKey: MessageKey; rows: Array<{ id: RailTabId; icon: string; labelKey: MessageKey; badge?: number }> }> = [
                {
                  titleKey: 'chatWorkspace.groupProgress',
                  rows: [
                    { id: 'tasks', icon: '☑', labelKey: 'chatWorkspace.railTasks', badge: tasks.filter((t) => !t.parentId && (t.status === 'open' || t.status === 'paused')).length },
                    { id: 'schedules', icon: '◷', labelKey: 'chatWorkspace.railSchedules', badge: schedules.filter((sc) => sc.status === 'active' || sc.status === 'paused').length },
                    { id: 'subsessions', icon: '🖇', labelKey: 'chatWorkspace.railSubsessions', badge: childSessions.length },
                  ],
                },
                {
                  titleKey: 'chatWorkspace.groupMaterials',
                  rows: [
                    { id: 'attachments', icon: '📎', labelKey: 'chatWorkspace.railAttachments', badge: pendingAttachments.length },
                    { id: 'roots', icon: '📁', labelKey: 'chatWorkspace.railRoots' },
                    { id: 'file', icon: '📄', labelKey: 'chatWorkspace.railFiles', badge: deliveredFiles.length },
                  ],
                },
                {
                  titleKey: 'chatWorkspace.groupEnvironment',
                  rows: [
                    { id: 'git', icon: '🌿', labelKey: 'chatWorkspace.railGit' },
                    { id: 'tools', icon: '🔧', labelKey: 'chatWorkspace.railTools' },
                  ],
                },
                ...(expertMode
                  ? [{
                      titleKey: 'chatWorkspace.groupRuntime' as MessageKey,
                      rows: [
                        { id: 'context' as const, icon: '📚', labelKey: 'chatWorkspace.railContext' as MessageKey },
                        { id: 'run' as const, icon: '▶', labelKey: 'chatWorkspace.railRun' as MessageKey },
                        { id: 'services' as const, icon: '⚙', labelKey: 'chatWorkspace.railServices' as MessageKey },
                      ],
                    }]
                  : []),
              ];
              return railGroups.map((g) => (
                <section className="rail-group" key={g.titleKey}>
                  <div className="rail-group-title">{t(g.titleKey)}</div>
                  {g.rows.map((r) => (
                    <button key={r.id} className="rail-row" onClick={() => setRightTab(r.id)}>
                      <span className="rail-row-icon" aria-hidden>{r.icon}</span>
                      <span className="rail-row-label">{t(r.labelKey)}</span>
                      {r.badge ? <span className="tab-count">{r.badge}</span> : null}
                      <span className="rail-row-chevron" aria-hidden>›</span>
                    </button>
                  ))}
                </section>
              ));
            })()}
            <div className="rail-expert-toggle">
              <span className="small muted">{t('chatWorkspace.expertMode')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={expertMode}
                aria-label={t('chatWorkspace.expertModeAria')}
                title={t('chatWorkspace.expertModeTitle')}
                className={`switch ${expertMode ? 'switch-on' : ''}`}
                onClick={() => {
                  const next = !expertMode;
                  setExpertMode(next);
                  try {
                    localStorage.setItem('octopi.expert', next ? '1' : '0');
                  } catch {
                    // 存储不可用：本次会话生效
                  }
                }}
              >
                <span className="switch-knob" />
              </button>
            </div>
          </div>

          {/* ── 详情浮层（批 3-3）：点行下钻——概览保留在后，Esc/遮罩/「← 概览」关闭 ── */}
          {rightTab !== null && (
            <div className="detail-modal-overlay" role="presentation" onClick={() => setRightTab(null)}>
              <div
                className="detail-modal"
                role="dialog"
                aria-modal="true"
                aria-label={t('chatWorkspace.detailAria')}
                tabIndex={-1}
                ref={detailModalRef}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="rail-detail-head">
                  <button className="btn-ghost small" onClick={() => setRightTab(null)}>
                    {t('chatWorkspace.backToOverview')}
                  </button>
                  <span className="rail-detail-title">
                    {t(RAIL_TAB_LABEL_KEYS[rightTab])}
                  </span>
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

          {rightTab === 'services' && clientRef.current && (
            <RunServicesPanel client={clientRef.current} />
          )}

          {rightTab === 'tasks' && (
            <div>
              <div className="tasks-panel-header">
                <div className="sidebar-title" style={{ marginBottom: 0 }}>{t('chatWorkspace.tasksPanelTitle')}</div>
                <span className="small muted">
                  {t('chatWorkspace.tasksActiveCount', {
                    count: tasks.filter((x) => !x.parentId && (x.status === 'open' || x.status === 'paused')).length,
                  })}
                </span>
              </div>
              <div className="tasks-panel-hint">
                {t('chatWorkspace.tasksPanelHint')}
              </div>
              <TaskPanel tasks={tasks} />
            </div>
          )}

          {rightTab === 'schedules' && (
            <div>
              <div className="tasks-panel-header">
                <div className="sidebar-title" style={{ marginBottom: 0 }}>{t('chatWorkspace.schedulesPanelTitle')}</div>
                <span className="small muted">
                  {t('chatWorkspace.schedulesOpenCount', {
                    count: schedules.filter((x) => x.status === 'active' || x.status === 'paused').length,
                  })}
                </span>
              </div>
              <div className="tasks-panel-hint">
                {t('chatWorkspace.schedulesPanelHint')}
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

          {rightTab === 'subsessions' && (
            <div>
              <div className="tasks-panel-header">
                <div className="sidebar-title" style={{ marginBottom: 0 }}>{t('chatWorkspace.railSubsessions')}</div>
                <span className="small muted">{t('chatWorkspace.subsessionsCount', { count: childSessions.length })}</span>
              </div>
              <div className="tasks-panel-hint">
                {t('chatWorkspace.subsessionsPanelHint')}
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {childSessions.map((s) => (
                  <button
                    key={s.id}
                    className="btn-secondary session-btn"
                    style={{ textAlign: 'left' }}
                    onClick={() => openChildSession(s.id)}
                    title={t('chatWorkspace.openSubsessionTitle')}
                  >
                    <div className="session-card-title-row">
                      <span className="session-card-title">{sessionDisplayTitle(s)}</span>
                      {s.running && (
                        <span className="session-running-badge" title={t('chatWorkspace.subsessionRunningTitle')}>
                          <span className="session-running-dot" />
                          {t('chatWorkspace.running')}
                        </span>
                      )}
                    </div>
                    <div className="small muted session-card-meta">
                      {s.agentId} · {formatTimestamp(s.createdAt ?? s.lastInteractionAt)}
                      {s.spawnBy?.depth ? t('chatWorkspace.subsessionDepth', { depth: s.spawnBy.depth }) : ''}
                    </div>
                  </button>
                ))}
                {!childSessions.length && <div className="small muted">{t('chatWorkspace.noSubsessions')}</div>}
              </div>
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
                <div className="sidebar-title" style={{ marginBottom: 0 }}>{t('chatWorkspace.toolsTimelineTitle')}</div>
                <span className="small muted">{toolItems.length}</span>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {toolItems.map(t => <ToolTimelineCard key={t.toolCallId} item={t} />)}
                {!toolItems.length && <div className="small muted">{t('chatWorkspace.noToolRuns')}</div>}
              </div>
            </section>
          )}

              </div>
            </div>
          )}
        </aside>
      </main>
    </>
  );
}
