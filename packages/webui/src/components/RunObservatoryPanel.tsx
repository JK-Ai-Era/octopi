import { useMemo, useState } from 'react';
import type {
  RunMessageViewDto,
  RunTimelineEventDto,
} from '@octopi-agent/gateway/web/sdk/client';
import type { InspectorState } from '@octopi-agent/gateway/web/runtime/store';
import type { TokenUsage } from '@octopi-agent/core/types/turn';
import { nominalTotalTokens, reportedPromptTokens } from '@octopi-agent/core/types/turn';
import { extractUserMessageText } from '@octopi-agent/engine/harness/context/turn-envelope.js';

/** TokenUsage 是 cache-aware 七字段；展示统一走 core 汇总函数，禁止读旧 prompt/completion/total 字段 */
function formatUsageBrief(usage: TokenUsage): string {
  const p = reportedPromptTokens(usage);
  const c = usage.outputTokens;
  const t = nominalTotalTokens(usage);
  return `p=${p} c=${c} t=${t}${usage.cacheAware ? ' (cache-aware)' : ''}`;
}

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

/**
 * 归因徽章（G2/G4）：机器插槽与用户发言明确分开。
 * 语义真源 = 引擎 `RunMessageAttribution`；此处只做展示映射。
 */
const ATTR_META: Record<
  string,
  { label: string; hue: string; cls: string; speaker: string }
> = {
  user_speech: { label: '用户发言', hue: '#64748b', cls: 'badge-idle', speaker: 'human' },
  turn_envelope: { label: '用户发言 · turn 信封', hue: '#64748b', cls: 'badge-idle', speaker: 'human' },
  carrier: { label: '引擎插槽 · 机器生成', hue: '#0d9488', cls: 'badge-carrier', speaker: 'engine' },
  context_summary: { label: '上下文摘要 · 机器生成', hue: '#b45309', cls: 'badge-warn', speaker: 'engine' },
  engine_hint: { label: '引擎提示 · 机器生成', hue: '#b45309', cls: 'badge-warn', speaker: 'engine' },
  turn_end: { label: 'turn 闭标 · 机器边界', hue: '#9ca3af', cls: 'badge-empty', speaker: 'engine' },
  hosted_system: { label: '托管 system · 不回放聊天', hue: '#c9a227', cls: 'badge-unregistered', speaker: 'engine' },
  system: { label: 'system 注入', hue: '#c9a227', cls: 'badge-unregistered', speaker: 'engine' },
  assistant: { label: '模型输出', hue: '#4f46e5', cls: 'badge-included', speaker: 'llm' },
  tool: { label: '工具结果', hue: '#0d9488', cls: 'badge-empty', speaker: 'tool' },
};

/** turn_context 槽位标签（机器生成块） */
const SLOT_LABEL: Record<string, string> = {
  runtime_snapshot: '运行时快照 runtime_snapshot',
  session_attachments: '会话附件 session_attachments',
  knowledge_grounding: '知识检索 knowledge_grounding',
};

function slotLabel(tag: string): string {
  return SLOT_LABEL[tag] ?? tag;
}

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
  /** 展开的机器槽位（`msgIndex:slotIndex`） */
  const [expandedSlot, setExpandedSlot] = useState<string | null>(null);
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

  // 耗时（G3 轻量）：按事件前缀聚合 timeline 的 durationMs
  const timing = useMemo(() => {
    const buckets: Record<string, { count: number; totalMs: number }> = {};
    for (const ev of timeline) {
      const cls = ev.type.startsWith('tool.')
        ? 'tool'
        : ev.type.startsWith('model.') || ev.type.startsWith('llm')
          ? 'llm'
          : ev.type.startsWith('turn.')
            ? 'turn'
            : 'engine';
      const b = buckets[cls] ?? (buckets[cls] = { count: 0, totalMs: 0 });
      b.count += 1;
      if (typeof ev.durationMs === 'number') b.totalMs += ev.durationMs;
    }
    return buckets;
  }, [timeline]);

  // F3 正式计时口径：run.timing（wait/build/run 分段）+ turn.end.llmTiming（ttft/chars）
  const f3 = useMemo(() => {
    let waitMs: number | undefined;
    let buildMs: number | undefined;
    let runDurMs: number | undefined;
    const llm: Array<{ ttftMs?: number; durationMs?: number; reqChars?: number; outChars?: number }> = [];
    for (const ev of timeline) {
      const t = ev.timing;
      if (!t) continue;
      if (ev.type === 'run.timing') {
        if (t.stage === 'run_start') waitMs = t.waitMs;
        else if (t.stage === 'context_ready') buildMs = t.buildMs;
        else if (t.stage === 'run_end') runDurMs = t.durMs;
      } else if (ev.type === 'turn.end') {
        llm.push({ ttftMs: t.ttftMs, durationMs: t.durationMs, reqChars: t.reqChars, outChars: t.outChars });
      }
    }
    const ttfts = llm
      .map((c) => c.ttftMs)
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b);
    return {
      waitMs,
      buildMs,
      runDurMs,
      llmCalls: llm.length,
      ttftList: ttfts,
      ttftP50: ttfts.length ? ttfts[Math.ceil(ttfts.length * 0.5) - 1] : undefined,
      last: llm[llm.length - 1],
    };
  }, [timeline]);

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
            <div className="small muted">
              本页是「这轮模型看到了什么」的审计入口：hiddenFromChat = 聊天回放隐藏 ≠ 不可见，
              机器插槽（快照/grounding/附件/摘要）在此必须可见并归因。
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

            <div className="ctx-section-title">耗时 · run 分段与 LLM 计时</div>
            <div className="small muted" style={{ marginBottom: 4 }}>
              wait/build/run 分段来自 <span className="mono">run.timing</span>；ttft / chars 来自{' '}
              <span className="mono">turn.end.llmTiming</span>（F3 探针转正后的正式观测口径；
              空响应无 ttft，字段缺省即未采集）。run total 取 lifecycle（不含 wait；
              trace 的 <span className="mono">run_end.durMs</span> 含 wait）。下排为事件前缀聚合。
            </div>
            <div className="ctx-metrics">
              <div className="ctx-metric">
                <div className="k">wait</div>
                <div className="v">{formatMs(f3.waitMs)}</div>
              </div>
              <div className="ctx-metric">
                <div className="k">build</div>
                <div className="v">{formatMs(f3.buildMs)}</div>
              </div>
              <div className="ctx-metric">
                <div className="k">run total</div>
                <div className="v">{formatMs(durationDisplay ?? f3.runDurMs)}</div>
              </div>
              <div className="ctx-metric">
                <div
                  className="k"
                  title={
                    f3.ttftList.length
                      ? `每次调用 ttft：${f3.ttftList.map((v) => `${v}ms`).join(' / ')}`
                      : undefined
                  }
                >
                  ttft p50
                </div>
                <div className="v">{formatMs(f3.ttftP50)}</div>
              </div>
              <div className="ctx-metric">
                <div className="k">llm calls</div>
                <div className="v">{f3.llmCalls || '—'}</div>
              </div>
              <div className="ctx-metric">
                <div className="k">last req/out chars</div>
                <div className="v">
                  {f3.last ? `${f3.last.reqChars ?? '—'} / ${f3.last.outChars ?? '—'}` : '—'}
                </div>
              </div>
            </div>
            <div className="ctx-metrics">
              <div className="ctx-metric">
                <div className="k">tool Σ</div>
                <div className="v">
                  {timing.tool ? `${formatMs(timing.tool.totalMs)} (${timing.tool.count})` : '—'}
                </div>
              </div>
              <div className="ctx-metric">
                <div className="k">llm Σ</div>
                <div className="v">
                  {timing.llm ? `${formatMs(timing.llm.totalMs)} (${timing.llm.count})` : '—'}
                </div>
              </div>
              <div className="ctx-metric">
                <div className="k">turn Σ</div>
                <div className="v">
                  {timing.turn ? `${formatMs(timing.turn.totalMs)} (${timing.turn.count})` : '—'}
                </div>
              </div>
            </div>

            {(obs.guardMetrics || obs.llmSummary || obs.messagesDiff) && (
              <>
                <div className="ctx-section-title">Guard · Metrics · LLM</div>
                <div className="small muted" style={{ marginBottom: 4 }}>
                  iter = RunMetricsCollector 轮次（turn_end 次数）。tokensΣ = nominal Σ（诊断，非成本 hard）。usage 分项来自 UsageLedger（uncached/cached/out + cacheAware）。context est = LLM 出口估算 tokens。
                </div>
                <div className="ctx-metrics">
                  <div className="ctx-metric">
                    <div className="k">iter (turns)</div>
                    <div className="v">{obs.guardMetrics?.iteration ?? lifecycle?.turns ?? '—'}</div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">in uncached</div>
                    <div className="v">{formatTokens(obs.guardMetrics?.usageLedger?.inputUncachedTokens)}</div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">in cached</div>
                    <div className="v">{formatTokens(obs.guardMetrics?.usageLedger?.inputCachedTokens)}</div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">out</div>
                    <div className="v">{formatTokens(obs.guardMetrics?.usageLedger?.outputTokens)}</div>
                  </div>
                </div>
                <div className="ctx-metrics" style={{ marginTop: 6 }}>
                  <div className="ctx-metric">
                    <div className="k">tokensΣ (nominal)</div>
                    <div className="v">{formatTokens(obs.guardMetrics?.usageLedger?.nominalTotalTokens ?? obs.guardMetrics?.nominalTotalTokens)}</div>
                  </div>
                  <div className="ctx-metric">
                    <div className="k">cacheAware</div>
                    <div className="v">{obs.guardMetrics?.usageLedger?.cacheAware == null ? '—' : String(obs.guardMetrics.usageLedger.cacheAware)}</div>
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
                    <div className="v" title="仅 LLM 出口口径；未采集时不回落 workspace 计数">
                      {obs.llmSummary?.count ?? '—'}
                    </div>
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
                    <span className={`v ${obs.guardMetrics.budgetExceededReason ? 'status-warn' : obs.guardMetrics.wrapUpActive ? 'status-info' : ''}`}>
                      {obs.guardMetrics.budgetExceededReason
                        || (obs.guardMetrics.wrapUpActive
                          ? `wrap-up (${obs.guardMetrics.wrapUpReason ?? '?'}, ${obs.guardMetrics.wrapUpTurnsRemaining ?? 0} turns left)`
                          : '—')}
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
                            {ev.usage != null && (
                              <span>tok {formatTokens(nominalTotalTokens(ev.usage))}</span>
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
                              {ev.usage ? formatUsageBrief(ev.usage) : '—'}
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
            {summary?.byKind && Object.keys(summary.byKind).length > 0 && (
              <div className="ctx-budget-legend" style={{ marginTop: 4 }}>
                {Object.entries(summary.byKind).map(([kind, n]) => (
                  <span key={kind}>
                    <i className="ctx-dot" style={{ background: ATTR_META[kind]?.hue ?? '#64748b' }} />
                    {ATTR_META[kind]?.label ?? kind} {n}
                  </span>
                ))}
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
                  const attr = m.attribution;
                  const attrMeta = attr ? ATTR_META[attr.kind] : undefined;
                  const isEnvelope = attr?.kind === 'turn_envelope';
                  const hasBody = m.content != null;
                  const envelopeUserText = isEnvelope && hasBody
                    ? extractUserMessageText(m.content as never)
                    : '';
                  const previewText = isEnvelope
                    ? (hasBody ? envelopeUserText : (m.contentPreview ?? ''))
                    : m.contentPreview ||
                      contentToText(m.content).slice(0, 160) ||
                      (m.toolCalls?.length
                        ? `tools: ${m.toolCalls.map((t) => (t as { name?: string }).name ?? '?').join(', ')}`
                        : '');
                  return (
                    <div
                      key={m.index}
                      className={`ctx-band-shell ${attrMeta?.speaker === 'engine' ? 'ctx-band-carrier' : ''}`}
                    >
                      <button
                        type="button"
                        className="ctx-band"
                        onClick={() => setExpandedMsg(open ? null : m.index)}
                      >
                        <div
                          className="ctx-band-stripe"
                          style={{ background: attrMeta?.hue ?? ROLE_HUE[m.role] ?? '#64748b' }}
                        />
                        <div className="ctx-band-body">
                          <div className="ctx-band-top">
                            <div className="ctx-band-name">
                              <span className="ctx-band-id">#{m.index}</span> {m.role}
                              {attr?.turnId && <span className="ctx-layer-note">{attr.turnId}</span>}
                              {m.agentId && <span className="ctx-layer-note">{m.agentId}</span>}
                            </div>
                            <span className={`ctx-badge ${attrMeta?.cls ?? ROLE_BADGE[m.role] ?? 'badge-idle'}`}>
                              {attrMeta?.label ?? (phase === 'llm' ? 'LLM' : '工作区')}
                            </span>
                          </div>
                          <div className="ctx-band-meta">
                            {m.hiddenFromChat && (
                              <span
                                className="ctx-badge badge-empty"
                                title="聊天回放隐藏 ≠ 不可见：检查器保留审计（G2 口径）"
                              >
                                对话隐藏
                              </span>
                            )}
                            {isEnvelope && (attr?.slots?.length ?? 0) > 0 ? (
                              attr!.slots!.map((s, si) => (
                                <span key={`${s.tag}-${si}`} className="ctx-slot-chip" title="机器生成槽位">
                                  {slotLabel(s.tag)} {s.chars}c
                                </span>
                              ))
                            ) : m.metadata?.source != null ? (
                              <span>source: {String(m.metadata.source)}</span>
                            ) : null}
                            <span>{m.contentChars ?? 0} chars</span>
                            {m.timestamp && <span>{new Date(m.timestamp).toLocaleTimeString()}</span>}
                            <span className="muted">{open ? '收起' : '详情'}</span>
                          </div>
                          {!open && isEnvelope && (
                            <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                              <span className="ctx-slot-user">
                                {attr?.hasUserMessage === false
                                  ? '信封不完整（无 user_message 块）：'
                                  : hasBody
                                    ? '用户原文：'
                                    : '预览（无正文档位）：'}
                              </span>
                              <span className="muted">
                                {previewText.slice(0, 160) || '（空）'}
                                {attr?.userChars != null
                                  ? `（${attr.userChars} chars · 另含 ${attr.slots?.length ?? 0} 个机器槽位）`
                                  : ''}
                              </span>
                            </div>
                          )}
                          {!open && !isEnvelope && previewText && (
                            <div className="small muted" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                              {previewText.slice(0, 160)}
                            </div>
                          )}
                          {!open && !isEnvelope && !previewText && (
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
                            <span className="k">speaker</span>
                            <span className="v">{attr?.speaker ?? '—'}</span>
                            <span className="k">kind</span>
                            <span className="v">{attr?.kind ?? '—'}</span>
                            <span className="k">turnId</span>
                            <span className="v">{attr?.turnId || '—'}</span>
                            <span className="k">agentId</span>
                            <span className="v">{m.agentId || '—'}</span>
                            <span className="k">source</span>
                            <span className="v">
                              {m.metadata?.source != null ? String(m.metadata.source) : '—'}
                            </span>
                            <span className="k">chars</span>
                            <span className="v">{m.contentChars ?? '—'}</span>
                            <span className="k">hidden</span>
                            <span className="v" title="聊天回放隐藏 ≠ 不可见">{String(m.hiddenFromChat ?? false)}</span>
                          </div>
                          {isEnvelope && (
                            <>
                              <div className="ctx-section-title" style={{ marginTop: 8 }}>
                                用户原文 · &lt;user_message&gt;
                              </div>
                              <div className="ctx-layer-content">
                                <pre className="ctx-layer-content-body" style={{ whiteSpace: 'pre-wrap' }}>
                                  {attr?.hasUserMessage === false
                                    ? '（信封不完整：无 user_message 块，整封不是用户原文）'
                                    : hasBody
                                      ? (envelopeUserText || '（空）')
                                      : '（快照未含正文：observer.level=full 且新跑一轮后可见）'}
                                </pre>
                              </div>
                              <div className="ctx-section-title" style={{ marginTop: 8 }}>
                                机器槽位 · turn_context（这轮模型看到了什么）
                              </div>
                              {(attr?.slots ?? []).map((s, si) => {
                                const slotKey = `${m.index}:${si}`;
                                const slotOpen = expandedSlot === slotKey;
                                const body = typeof (s as { body?: string }).body === 'string'
                                  ? (s as { body?: string }).body
                                  : undefined;
                                return (
                                  <div key={slotKey} className="ctx-slot-block">
                                    <button
                                      type="button"
                                      className="btn-ghost small"
                                      onClick={() => setExpandedSlot(slotOpen ? null : slotKey)}
                                    >
                                      {slotLabel(s.tag)} · {s.chars} chars · {slotOpen ? '收起' : '展开'}
                                    </button>
                                    {slotOpen && (
                                      <pre className="ctx-layer-content-body" style={{ whiteSpace: 'pre-wrap' }}>
                                        {body ?? '（快照未含槽位正文：observer.level=full 且新跑一轮后可见）'}
                                      </pre>
                                    )}
                                  </div>
                                );
                              })}
                              {!(attr?.slots ?? []).length && (
                                <div className="small muted">无槽位（仅 boilerplate）。</div>
                              )}
                            </>
                          )}
                          <div className="ctx-section-title" style={{ marginTop: 8 }}>内容（原始消息文本）</div>
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
