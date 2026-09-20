import { useMemo, useState } from 'react';
import type {
  RunMessageViewDto,
  RunTimelineEventDto,
} from '../../../src/integration/web/sdk/client';
import type { InspectorState } from '../../../src/integration/web/runtime/store';

function formatTokens(n: number | undefined | null): string {
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatMs(n: number | undefined | null): string {
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}

function contentToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string })?.type === 'text')
      .map((b) => String((b as { text?: string }).text ?? ''))
      .join('');
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

const ROLE_BADGE: Record<string, string> = {
  user: 'badge-idle',
  assistant: 'badge-included',
  system: 'badge-unregistered',
  tool: 'badge-empty',
};

const ROLE_HUE: Record<string, string> = {
  system: '#c9a227',
  tool: '#0d9488',
  assistant: '#4f46e5',
  user: '#64748b',
};

export interface RunObservatoryPanelProps {
  inspector: InspectorState;
  runStatus: string;
  sessionId: string | null;
  onRefresh?: (options?: { phase?: 'entry' | 'final' | 'llm' }) => Promise<void>;
}

/**
 * Run Observatory — 右栏 Run 观测面板（Observer 通道）
 *
 * 只消费 Hub/REST 快照；条目详情内联在条目下方。
 */
export function RunObservatoryPanel({
  inspector,
  runStatus,
  sessionId,
  onRefresh,
}: RunObservatoryPanelProps) {
  const obs = inspector.runObservatory;
  const observerStatus = inspector.observerStatus;
  const [phase, setPhase] = useState<'final' | 'entry' | 'llm'>('final');
  const [expandedMsg, setExpandedMsg] = useState<number | null>(null);
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);
  const [showPreviewOnly, setShowPreviewOnly] = useState(true);
  const [filterHidden, setFilterHidden] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showFullPrompt, setShowFullPrompt] = useState(false);

  const messages =
    phase === 'llm' ? inspector.runMessagesLlm : inspector.runMessages;

  const timeline = obs?.timeline ?? [];
  const lifecycle = obs?.lifecycle;
  const scope = obs?.scope;
  const guard = obs?.guardMetrics;
  // lifecycle 缺 turns/tools 时用 Guard 快照展示
  const turnsDisplay = lifecycle?.turns ?? guard?.iteration;
  const toolsDisplay = lifecycle?.toolCalls ?? guard?.totalToolCalls;
  const durationDisplay = lifecycle?.durationMs ?? guard?.elapsedMs;
  const endDisplay = lifecycle?.endReason ?? (runStatus === 'idle' && obs ? '—' : '');

  const summary = useMemo(() => {
    if (phase === 'llm') {
      return messages?.summary ?? obs?.llmSummary;
    }
    if (phase === 'entry' && messages?.phase === 'entry') return messages.summary;
    if (phase === 'final' && messages?.phase === 'final') return messages.summary;
    return obs?.messagesSummary ?? messages?.summary;
  }, [phase, messages, obs?.llmSummary, obs?.messagesSummary]);

  const messageList = useMemo(() => {
    const source: RunMessageViewDto[] = messages?.messages ?? [];
    if (!filterHidden) return source;
    return source.filter((m) => m.hiddenFromChat);
  }, [messages?.messages, filterHidden]);

  const refresh = async (nextPhase?: 'entry' | 'final' | 'llm') => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh(nextPhase ? { phase: nextPhase } : { phase });
    } finally {
      setRefreshing(false);
    }
  };

  if (observerStatus && observerStatus.enabled === false) {
    return (
      <div className="ctx-runtime">
        <section className="panel sidebar-section">
          <div className="sidebar-title">Run 观测 · Observer 已关闭</div>
          <div className="small muted">
            当前 <span className="mono">observer.level=off</span>（缺省不采集）。开发请在 octopi.json 设{' '}
            <span className="mono">observer.level=full</span> 或{' '}
            <span className="mono">summary</span>，重启引擎后生效。调试 API：{' '}
            <span className="mono">/debug/run/:sessionId/scope</span>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="ctx-runtime">
      <section className="ctx-panel">
        <div className="ctx-panel-header">
          <div>
            <div className="sidebar-title" style={{ marginBottom: 0 }}>Run Observatory</div>
            <div className="small muted">
              Observer 通道 · Run 可变现场（I1）· 对话历史 ≠ run messages
              {observerStatus?.level ? ` · level=${observerStatus.level}` : ''}
              {observerStatus?.channels?.['context.llm'] === false ? ' · llm通道关' : ''}
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost small"
            disabled={refreshing || !onRefresh}
            onClick={() => { void refresh(); }}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>

        <div className="ctx-metrics">
          <div className="ctx-metric">
            <div className="k">runStatus</div>
            <div className="v">{runStatus}</div>
          </div>
          <div className="ctx-metric">
            <div className="k">runId</div>
            <div className="v" style={{ fontSize: 11 }}>{obs?.runId ?? '—'}</div>
          </div>
          <div className="ctx-metric">
            <div className="k">observer</div>
            <div className="v" style={{ fontSize: 12 }}>
              {observerStatus?.level ?? obs?.observer.level ?? '—'}
            </div>
          </div>
          <div className="ctx-metric">
            <div className="k">session</div>
            <div className="v" style={{ fontSize: 11 }}>{sessionId ?? obs?.sessionId ?? '—'}</div>
          </div>
        </div>

        {!obs ? (
          <div className="ctx-empty">
            尚无 Run 观测记录。发送一条消息后，这里显示当前 Run 的 Scope / 时间线 / messages。
          </div>
        ) : (
          <>
            <div className="ctx-section-title">RunScope · 身份与效应面</div>
            <div className="ctx-detail">
              <div className="ctx-kv">
                <span className="k">agentId</span>
                <span className="v">{scope?.agentId || obs.agentId || '—'}</span>
                <span className="k">agentRevision</span>
                <span className="v">{scope?.agentRevision || '—'}</span>
                <span className="k">model</span>
                <span className="v">
                  {scope?.resolvedModel?.modelName
                    ? `${scope.resolvedModel.providerId ? `${scope.resolvedModel.providerId}/` : ''}${scope.resolvedModel.modelName}`
                    : '—'}
                </span>
                <span className="k">contextWindow</span>
                <span className="v">{formatTokens(scope?.resolvedModel?.contextWindow)}</span>
                <span className="k">tool.cwd</span>
                <span className="v" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                  {scope?.toolRuntime?.cwd || '—'}
                </span>
                <span className="k">isolation</span>
                <span className="v">{scope?.toolRuntime?.isolation || '—'}</span>
                <span className="k">systemPrompt</span>
                <span className="v">
                  {scope?.systemPromptChars != null ? (
                <>
                  {scope.systemPromptChars} chars
                  {(scope.systemPromptFull || scope.systemPromptPreview) && (
                    <button
                      type="button"
                      className="btn-ghost small"
                      style={{ marginLeft: 8 }}
                      onClick={() => setShowFullPrompt((v) => !v)}
                    >
                      {showFullPrompt ? '收起' : scope.systemPromptFull ? '全文' : '预览'}
                    </button>
                  )}
                </>
              ) : (
                '—'
              )}
                </span>
                <span className="k">capturedAt</span>
                <span className="v">
                  {scope?.capturedAt ? new Date(scope.capturedAt).toLocaleTimeString() : '—'}
                </span>
              </div>
              {(scope?.systemPromptFull || scope?.systemPromptPreview) && (showFullPrompt || scope?.systemPromptPreview) && (
                <div className="ctx-layer-content" style={{ marginTop: 8 }}>
                  <div className="ctx-layer-content-meta">
                    <span className="mono muted">
                      systemPrompt {showFullPrompt && scope?.systemPromptFull ? '全文' : 'preview'}
                      {showFullPrompt && !scope?.systemPromptFull ? '（未采全文，level=full 后重跑）' : ''}
                    </span>
                  </div>
                  <pre className="ctx-layer-content-body" style={{ whiteSpace: 'pre-wrap', maxHeight: showFullPrompt ? 360 : undefined, overflow: 'auto' }}>
                    {showFullPrompt
                      ? (scope?.systemPromptFull || scope?.systemPromptPreview || '')
                      : (scope?.systemPromptPreview || '')}
                  </pre>
                </div>
              )}
            </div>

            <div className="ctx-section-title">生命周期与 Timeline</div>
            <div className="small muted" style={{ marginBottom: 4 }}>
              turns/tools 来自 Run 事件计数（缺省回退 Guard metrics）。Timeline 为引擎适配后的 EventBus 事件。
            </div>
            <div className="ctx-metrics">
              <div className="ctx-metric">
                <div className="k">turns</div>
                <div className="v">{turnsDisplay ?? '—'}</div>
              </div>
              <div className="ctx-metric">
                <div className="k">tools</div>
                <div className="v">{toolsDisplay ?? '—'}</div>
              </div>
              <div className="ctx-metric">
                <div className="k">duration</div>
                <div className="v">{formatMs(durationDisplay)}</div>
              </div>
              <div className="ctx-metric">
                <div className="k">end</div>
                <div className="v" style={{ fontSize: 12 }}>{endDisplay || '—'}</div>
              </div>
            </div>
            {lifecycle?.error && (
              <div className="small status-error" style={{ marginTop: 6 }}>{lifecycle.error}</div>
            )}

            {(obs.guardMetrics || obs.llmSummary || obs.messagesDiff) && (
              <>
                <div className="ctx-section-title">Guard · Metrics · LLM</div>
                <div className="small muted" style={{ marginBottom: 4 }}>
                  iter = RunMetricsCollector 轮次（turn_end 次数）。tokensΣ = 各轮 LLM usage.totalTokens 之和（含 prompt+completion，<b>不是</b>当前上下文长度）。context est = LLM 出口估算 tokens。
                </div>
                <div className="ctx-metrics">
                  <div className="ctx-metric">
                    <div className="k">iter (turns)</div>
                    <div className="v">{obs.guardMetrics?.iteration ?? lifecycle?.turns ?? '—'}</div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">tokensΣ usage</div>
                    <div className="v">{formatTokens(obs.guardMetrics?.totalTokens)}</div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">context est</div>
                    <div className="v">{formatTokens(obs.llmEstimatedTokens)}</div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">consecErr</div>
                    <div className="v">{obs.guardMetrics?.consecutiveErrors ?? '—'}</div>
                  </div>
                </div>
                <div className="ctx-metrics" style={{ marginTop: 6 }}>
                  <div className="ctx-metric">
                    <div className="k">llm msgs</div>
                    <div className="v">{obs.llmSummary?.count ?? messages?.summary?.count ?? '—'}</div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">tool calls</div>
                    <div className="v">{obs.guardMetrics?.totalToolCalls ?? toolsDisplay ?? '—'}</div>
                  </div>
                </div>
                {obs.guardMetrics && (
                  <div className="ctx-kv" style={{ marginTop: 6 }}>
                    <span className="k">hasProgress</span>
                    <span className="v">{String(obs.guardMetrics.hasProgress ?? '—')}</span>
                    <span className="k">noopStreak</span>
                    <span className="v">{obs.guardMetrics.noopStreak ?? '—'}</span>
                    <span className="k">sameTool</span>
                    <span className="v">{obs.guardMetrics.consecutiveSameTool ?? '—'}</span>
                    <span className="k">uniqueTools</span>
                    <span className="v">{obs.guardMetrics.uniqueTools?.join(', ') || '—'}</span>
                    <span className="k">budget</span>
                    <span className={`v ${obs.guardMetrics.budgetExceededReason ? 'status-warn' : ''}`}>
                      {obs.guardMetrics.budgetExceededReason || '—'}
                    </span>
                    <span className="k">guard</span>
                    <span className={`v ${obs.guardMetrics.guardStoppedReason ? 'status-error' : ''}`}>
                      {obs.guardMetrics.guardStoppedReason
                        || (obs.guardMetrics.guardRecovered
                          ? `recovered: ${obs.guardMetrics.guardRecovered.reason} [${obs.guardMetrics.guardRecovered.actions.join(', ')}]`
                          : '—')}
                    </span>
                  </div>
                )}
                {obs.messagesDiff && (
                  <div className="small muted" style={{ marginTop: 6 }}>
                    entry→final：{obs.messagesDiff.entryCount} → {obs.messagesDiff.finalCount}
                    （+{obs.messagesDiff.added.length}）
                    {obs.messagesDiff.notes ? ` · ${obs.messagesDiff.notes}` : ''}
                    {obs.messagesDiff.added.length > 0 && (
                      <div className="ctx-budget-legend" style={{ marginTop: 4 }}>
                        {obs.messagesDiff.added.slice(0, 8).map((a) => (
                          <span key={a.index}>
                            #{a.index} {a.role}
                            {a.source ? `/${a.source}` : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {obs.toolEffect && (
              <>
                <div className="ctx-section-title">Tool Effect · I5</div>
                <div className="small muted" style={{ marginBottom: 4 }}>
                  本 Run 工具效应面：cwd / isolation + 按工具调用统计。
                </div>
                <div className="ctx-kv">
                  <span className="k">cwd</span>
                  <span className="v" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {obs.toolEffect.cwd || '—'}
                  </span>
                  <span className="k">isolation</span>
                  <span className="v">{obs.toolEffect.isolation || '—'}</span>
                </div>
                {obs.toolEffect.tools.length > 0 && (
                  <div className="ctx-budget-legend" style={{ marginTop: 6 }}>
                    {obs.toolEffect.tools.map((t) => (
                      <span key={t.name}>
                        {t.name} ×{t.calls}
                        {t.errors > 0 ? ` (err ${t.errors})` : ''}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}

            {obs.securityEvents && obs.securityEvents.length > 0 && (
              <>
                <div className="ctx-section-title">Security</div>
                <div className="ctx-stack" style={{ marginTop: 6 }}>
                  {obs.securityEvents.slice(-12).map((ev, idx) => (
                    <div key={`${ev.timestamp}-${idx}`} className="ctx-band-shell">
                      <div className="ctx-band">
                        <div
                          className="ctx-band-stripe"
                          style={{
                            background:
                              ev.severity === 'critical' || ev.severity === 'high'
                                ? '#dc2626'
                                : '#d97706',
                          }}
                        />
                        <div className="ctx-band-body">
                          <div className="ctx-band-top">
                            <div className="ctx-band-name">
                              <span className="ctx-band-id">{ev.type}</span>
                              {ev.toolName && <span> {ev.toolName}</span>}
                            </div>
                            <span className="ctx-badge badge-idle">
                              {new Date(ev.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="ctx-band-meta">
                            {ev.severity && <span>{ev.severity}</span>}
                            {ev.action && <span>{ev.action}</span>}
                            {ev.violationTypes?.length ? <span>{ev.violationTypes.join(', ')}</span> : null}
                          </div>
                          {ev.description && (
                            <div className="small muted" style={{ marginTop: 4 }}>
                              {ev.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {obs.memoryActivity && (
              <>
                <div className="ctx-section-title">Memory · 只读投影</div>
                <div className="small muted" style={{ marginBottom: 4 }}>
                  本 run 内 memory_store / memory_search 摘要（Observer 不写库，E3）。
                </div>
                <div className="ctx-metrics">
                  <div className="ctx-metric">
                    <div className="k">stores</div>
                    <div className="v">{obs.memoryActivity.stores}</div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">ok / rejected</div>
                    <div className="v">
                      {obs.memoryActivity.storedOk} / {obs.memoryActivity.rejected}
                    </div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">searches</div>
                    <div className="v">{obs.memoryActivity.searches}</div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">hits / superseded</div>
                    <div className="v">
                      {obs.memoryActivity.searchHits} / {obs.memoryActivity.superseded}
                    </div>
                  </div>
                </div>
                {obs.memoryActivity.entries.length > 0 && (
                  <div className="ctx-stack" style={{ marginTop: 6 }}>
                    {obs.memoryActivity.entries.slice(-10).map((e, idx) => (
                      <div key={`${e.timestamp}-${idx}`} className="small" style={{ opacity: e.success ? 1 : 0.75 }}>
                        <span className="mono">{e.kind}</span>{' '}
                        {e.kind === 'store'
                          ? `${e.memoryType ?? '—'} ${e.memoryId ?? ''} ${e.propositionPreview ?? ''}${e.rejectReason ? ` · ${e.rejectReason}` : ''}`
                          : `${e.query ?? ''} → ${e.resultCount ?? 0} hits`}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {timeline.length > 0 ? (
              <div className="ctx-stack" style={{ marginTop: 8 }}>
                {timeline.map((ev: RunTimelineEventDto, idx) => {
                  const open = expandedEvent === idx;
                  return (
                    <div key={`${ev.timestamp}-${idx}`} className="ctx-band-shell">
                      <button
                        type="button"
                        className={`ctx-band ${ev.hasError ? 'ctx-band-selected' : ''}`}
                        onClick={() => setExpandedEvent(open ? null : idx)}
                      >
                        <div
                          className="ctx-band-stripe"
                          style={{
                            background: ev.hasError
                              ? '#dc2626'
                              : ev.type.startsWith('tool.')
                                ? '#0d9488'
                                : ev.type.startsWith('run_guard') || ev.type.startsWith('budget')
                                  ? '#d97706'
                                  : '#64748b',
                          }}
                        />
                        <div className="ctx-band-body">
                          <div className="ctx-band-top">
                            <div className="ctx-band-name">
                              <span className="ctx-band-id">{ev.type}</span>
                              {ev.toolName && <span> {ev.toolName}</span>}
                            </div>
                            <span className={`ctx-badge ${ev.hasError ? 'badge-error' : 'badge-idle'}`}>
                              {new Date(ev.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="ctx-band-meta">
                            {ev.durationMs != null && <span>{formatMs(ev.durationMs)}</span>}
                            {ev.reason && <span>{ev.reason}</span>}
                            {ev.usage?.totalTokens != null && (
                              <span>tok {formatTokens(ev.usage.totalTokens)}</span>
                            )}
                            <span className="muted">{open ? '收起' : '详情'}</span>
                          </div>
                        </div>
                      </button>
                      {open && (
                        <div className="ctx-detail" style={{ margin: '0 0 6px' }}>
                          <div className="ctx-kv">
                            <span className="k">type</span>
                            <span className="v">{ev.type}</span>
                            <span className="k">timestamp</span>
                            <span className="v">{new Date(ev.timestamp).toISOString()}</span>
                            <span className="k">tool</span>
                            <span className="v">{ev.toolName || ev.toolCallId || '—'}</span>
                            <span className="k">durationMs</span>
                            <span className="v">{ev.durationMs ?? '—'}</span>
                            <span className="k">hasError</span>
                            <span className="v">{String(ev.hasError ?? false)}</span>
                            <span className="k">reason</span>
                            <span className="v">{ev.reason || '—'}</span>
                            <span className="k">usage</span>
                            <span className="v">
                              {ev.usage
                                ? `p=${ev.usage.promptTokens ?? '—'} c=${ev.usage.completionTokens ?? '—'} t=${ev.usage.totalTokens ?? '—'}`
                                : '—'}
                            </span>
                          </div>
                          <pre className="ctx-layer-content-body" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>
                            {JSON.stringify(ev, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="small muted" style={{ marginTop: 6 }}>
                Timeline 尚无节点。
              </div>
            )}

            <div className="ctx-section-title">
              Run Messages · {phase === 'llm' ? 'LLM 视图' : phase === 'entry' ? '入口工作区' : '结束工作区'}
            </div>
            <div className="small muted" style={{ marginBottom: 6 }}>
              {phase === 'llm'
                ? 'ContextEngine 出口（可能已 compact）。'
                : '对话历史会隐藏托管 system / 摘要；此处为 Run 工作区快照。'}
            </div>

            <div className="ctx-metrics">
              <div className="ctx-metric">
                <div className="k">count</div>
                <div className="v">{summary?.count ?? '—'}</div>
              </div>
              <div className="ctx-metric">
                <div className="k">systemPrompt</div>
                <div className="v">{summary?.systemPromptCount ?? '—'}</div>
              </div>
              <div className="ctx-metric">
                <div className="k">contextSummary</div>
                <div className="v">{summary?.contextSummaryCount ?? '—'}</div>
              </div>
              <div className="ctx-metric">
                <div className="k">hiddenFromChat</div>
                <div className="v">{summary?.hiddenFromChatCount ?? '—'}</div>
              </div>
            </div>
            {summary?.byRole && (
              <div className="ctx-budget-legend" style={{ marginTop: 6 }}>
                {Object.entries(summary.byRole).map(([role, n]) => (
                  <span key={role}>{role} {n}</span>
                ))}
                <span className="muted">{formatTokens(summary.chars)} chars</span>
                {obs?.llmEstimatedTokens != null && phase === 'llm' && (
                  <span className="muted">est {formatTokens(obs.llmEstimatedTokens)} tok</span>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {(['final', 'entry', 'llm'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className="btn-ghost small"
                  style={phase === p ? { borderColor: '#3b82f6' } : undefined}
                  onClick={() => {
                    setPhase(p);
                    setExpandedMsg(null);
                    void refresh(p);
                  }}
                >
                  {p}
                </button>
              ))}
              <button
                type="button"
                className="btn-ghost small"
                onClick={() => setFilterHidden((v) => !v)}
              >
                {filterHidden ? '仅隐藏条目 ✓' : '仅隐藏条目'}
              </button>
              <button
                type="button"
                className="btn-ghost small"
                onClick={() => setShowPreviewOnly((v) => !v)}
              >
                {showPreviewOnly ? '预览' : '全文'}
              </button>
            </div>

            {messages?.notes && (
              <div className="small muted" style={{ marginTop: 6 }}>{messages.notes}</div>
            )}

            {!messageList.length ? (
              <div className="ctx-empty" style={{ marginTop: 8 }}>
                {phase === 'llm' ? (
                  <>
                    {(obs?.llmSummary?.count ?? 0) > 0 ? (
                      <>
                        已采到 LLM <b>摘要</b>（{obs?.llmSummary?.count} 条，见上方计数），但
                        <b>无逐条正文</b>。
                        <br />
                        需 <span className="mono">observer.level=full</span>（打开
                        <span className="mono"> context.llm</span> + message 全文），并
                        <b>重新跑一轮</b>后再刷新。
                      </>
                    ) : (
                      <>
                        尚无 LLM 视图数据。
                        <br />
                        请确认：1）引擎已重启且 <span className="mono">observer.level=full</span>；
                        2）改配置后 <b>新跑一轮</b>（不会回填历史 run）；
                        3）<span className="mono">channels.context.llm</span> 未被显式关掉。
                        <br />
                        当前 status：level=
                        {observerStatus?.level ?? '—'} · llmChannel=
                        {String(observerStatus?.channels?.['context.llm'] ?? 'unknown')}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    当前档位未返回 message 全文。开发请设{' '}
                    <span className="mono">observer.level=full</span> 后重新跑一轮。
                  </>
                )}
              </div>
            ) : (
              <div className="ctx-stack" style={{ marginTop: 8 }}>
                {messageList.map((m) => {
                  const open = expandedMsg === m.index;
                  const previewText =
                    m.contentPreview ||
                    contentToText(m.content).slice(0, 160) ||
                    (m.toolCalls?.length
                      ? `tools: ${m.toolCalls.map((t) => (t as { name?: string }).name ?? '?').join(', ')}`
                      : '');
                  return (
                    <div key={m.index} className="ctx-band-shell">
                      <button
                        type="button"
                        className="ctx-band"
                        onClick={() => setExpandedMsg(open ? null : m.index)}
                      >
                        <div className="ctx-band-stripe" style={{ background: ROLE_HUE[m.role] ?? '#64748b' }} />
                        <div className="ctx-band-body">
                          <div className="ctx-band-top">
                            <div className="ctx-band-name">
                              <span className="ctx-band-id">#{m.index}</span> {m.role}
                              {m.agentId && <span className="ctx-layer-note">{m.agentId}</span>}
                            </div>
                            <span className={`ctx-badge ${ROLE_BADGE[m.role] ?? 'badge-idle'}`}>
                              {m.hiddenFromChat ? '对话隐藏' : phase === 'llm' ? 'LLM' : '工作区'}
                            </span>
                          </div>
                          <div className="ctx-band-meta">
                            {m.metadata?.source != null && <span>source: {String(m.metadata.source)}</span>}
                            <span>{m.contentChars ?? 0} chars</span>
                            {m.timestamp && <span>{new Date(m.timestamp).toLocaleTimeString()}</span>}
                            <span className="muted">{open ? '收起' : '详情'}</span>
                          </div>
                          {!open && previewText && (
                            <div className="small muted" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                              {previewText.slice(0, 160)}
                            </div>
                          )}
                          {!open && !previewText && (
                            <div className="small muted" style={{ marginTop: 4 }}>
                              （无文本预览{m.toolResults?.length ? '，见工具结果' : ''}）
                            </div>
                          )}
                        </div>
                      </button>

                      {open && (
                        <div className="ctx-detail" style={{ margin: '0 0 6px' }}>
                          <div className="ctx-kv">
                            <span className="k">index</span>
                            <span className="v">{m.index}</span>
                            <span className="k">role</span>
                            <span className="v">{m.role}</span>
                            <span className="k">agentId</span>
                            <span className="v">{m.agentId || '—'}</span>
                            <span className="k">source</span>
                            <span className="v">
                              {m.metadata?.source != null ? String(m.metadata.source) : '—'}
                            </span>
                            <span className="k">chars</span>
                            <span className="v">{m.contentChars ?? '—'}</span>
                            <span className="k">hidden</span>
                            <span className="v">{String(m.hiddenFromChat ?? false)}</span>
                          </div>
                          <div className="ctx-section-title" style={{ marginTop: 8 }}>内容</div>
                          <div className="ctx-layer-content">
                            <div className="ctx-layer-content-meta">
                              <span className="mono muted">
                                {showPreviewOnly ? '预览' : '全文'}
                                {m.content == null && m.contentPreview ? '（快照未含正文，仅 preview）' : ''}
                              </span>
                            </div>
                            <pre className="ctx-layer-content-body" style={{ whiteSpace: 'pre-wrap' }}>
                              {showPreviewOnly
                                ? (m.contentPreview || contentToText(m.content).slice(0, 400) || '（无内容）')
                                : (contentToText(m.content) || m.contentPreview || '（无内容）')}
                            </pre>
                          </div>
                          {(m.toolCalls?.length || m.toolResults?.length) && (
                            <>
                              <div className="ctx-section-title" style={{ marginTop: 8 }}>工具</div>
                              <pre className="ctx-layer-content-body" style={{ whiteSpace: 'pre-wrap' }}>
                                {JSON.stringify(
                                  { toolCalls: m.toolCalls, toolResults: m.toolResults },
                                  null,
                                  2,
                                )}
                              </pre>
                            </>
                          )}
                          {m.metadata && (
                            <>
                              <div className="ctx-section-title" style={{ marginTop: 8 }}>metadata</div>
                              <pre className="ctx-layer-content-body" style={{ whiteSpace: 'pre-wrap' }}>
                                {JSON.stringify(m.metadata, null, 2)}
                              </pre>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
