import { useMemo, useState } from 'react';
import type {
  RunMessageViewDto,
  RunTimelineEventDto,
} from '@octopi-agent/gateway/web/sdk/client';
import type { InspectorState } from '@octopi-agent/gateway/web/runtime/store';
import type { TokenUsage } from '@octopi-agent/core/types/step';
import { nominalTotalTokens, reportedPromptTokens } from '@octopi-agent/core/types/step';
import { extractUserMessageText } from '@octopi-agent/engine/harness/context/turn-envelope.js';
import { useT } from '../i18n/react';
import type { MessageKey } from '../i18n/core';

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
  { labelKey: MessageKey; hue: string; cls: string; speaker: string }
> = {
  user_speech: { labelKey: 'runObservatory.attrUserSpeech', hue: '#64748b', cls: 'badge-idle', speaker: 'human' },
  turn_envelope: {
    labelKey: 'runObservatory.attrTurnEnvelope',
    hue: '#64748b',
    cls: 'badge-idle',
    speaker: 'human',
  },
  carrier: {
    labelKey: 'runObservatory.attrCarrier',
    hue: '#0d9488',
    cls: 'badge-carrier',
    speaker: 'engine',
  },
  context_summary: {
    labelKey: 'runObservatory.attrContextSummary',
    hue: '#b45309',
    cls: 'badge-warn',
    speaker: 'engine',
  },
  engine_hint: {
    labelKey: 'runObservatory.attrEngineHint',
    hue: '#b45309',
    cls: 'badge-warn',
    speaker: 'engine',
  },
  turn_end: {
    labelKey: 'runObservatory.attrTurnEnd',
    hue: '#9ca3af',
    cls: 'badge-empty',
    speaker: 'engine',
  },
  hosted_system: {
    labelKey: 'runObservatory.attrHostedSystem',
    hue: '#c9a227',
    cls: 'badge-unregistered',
    speaker: 'engine',
  },
  system: {
    labelKey: 'runObservatory.attrSystemInjection',
    hue: '#c9a227',
    cls: 'badge-unregistered',
    speaker: 'engine',
  },
  assistant: {
    labelKey: 'runObservatory.attrAssistant',
    hue: '#4f46e5',
    cls: 'badge-included',
    speaker: 'llm',
  },
  tool: { labelKey: 'runObservatory.attrTool', hue: '#0d9488', cls: 'badge-empty', speaker: 'tool' },
};

/** turn_context 槽位标签（机器生成块） */
const SLOT_LABEL_KEY: Record<string, MessageKey> = {
  runtime_snapshot: 'runObservatory.slotRuntimeSnapshot',
  session_attachments: 'runObservatory.slotSessionAttachments',
  knowledge_grounding: 'runObservatory.slotKnowledgeGrounding',
};

function slotLabel(tag: string, t: (key: MessageKey) => string): string {
  const key = SLOT_LABEL_KEY[tag];
  return key ? t(key) : tag;
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
  const t = useT();

  const messages =
    phase === 'llm' ? inspector.runMessagesLlm : inspector.runMessages;

  const timeline = obs?.timeline ?? [];
  const lifecycle = obs?.lifecycle;
  const scope = obs?.scope;
  const guard = obs?.guardMetrics;
  // lifecycle 缺 steps/tools 时用 Guard 快照展示
  const stepsDisplay = lifecycle?.steps ?? guard?.steps;
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
          : ev.type.startsWith('step.')
            ? 'step'
            : 'engine';
      const b = buckets[cls] ?? (buckets[cls] = { count: 0, totalMs: 0 });
      b.count += 1;
      if (typeof ev.durationMs === 'number') b.totalMs += ev.durationMs;
    }
    return buckets;
  }, [timeline]);

  // F3 正式计时口径：run.timing（wait/build/run 分段）+ step.end.llmTiming（ttft/chars）
  const f3 = useMemo(() => {
    let waitMs: number | undefined;
    let buildMs: number | undefined;
    let runDurMs: number | undefined;
    const llm: Array<{ ttftMs?: number; durationMs?: number; reqChars?: number; outChars?: number }> = [];
    for (const ev of timeline) {
      const tm = ev.timing;
      if (!tm) continue;
      if (ev.type === 'run.timing') {
        if (tm.stage === 'run_start') waitMs = tm.waitMs;
        else if (tm.stage === 'context_ready') buildMs = tm.buildMs;
        else if (tm.stage === 'run_end') runDurMs = tm.durMs;
      } else if (ev.type === 'step.end') {
        llm.push({ ttftMs: tm.ttftMs, durationMs: tm.durationMs, reqChars: tm.reqChars, outChars: tm.outChars });
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

  // rawTokens（全量原文估算）：大哥拍板「不删，放 Run 页签」——只在本页展示，
  // 不进主显示/决策（原文 ≠ 请求视图，量纲不同，见 arch/context-size-accounting §4 R2/R3）
  const rawTokensBlock =
    inspector.rawTokens !== undefined ? (
      <section className="panel sidebar-section">
        <div className="sidebar-title">{t('runObservatory.rawTokensTitle')}</div>
        <div className="inspector-kv">
          {t('runObservatory.rawTokensLabel')}: {formatTokens(inspector.rawTokens)}
        </div>
        <div className="small muted">{t('runObservatory.rawTokensHint')}</div>
      </section>
    ) : null;

  if (observerStatus && observerStatus.enabled === false) {
    return (
      <div className="ctx-runtime">
        {rawTokensBlock}
        <section className="panel sidebar-section">
          <div className="sidebar-title">{t('runObservatory.observerOffTitle')}</div>
          <div className="small muted">
            {t('runObservatory.observerOffLead')}{' '}
            <span className="mono">observer.level=off</span>
            {t('runObservatory.observerOffAfterLevel')}{' '}
            <span className="mono">observer.level=full</span>{' '}
            {t('runObservatory.observerOffMidOr')}{' '}
            <span className="mono">summary</span>
            {t('runObservatory.observerOffTail')}{' '}
            <span className="mono">/debug/run/:sessionId/scope</span>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="ctx-runtime">
      {rawTokensBlock}
      <section className="ctx-panel">
        <div className="ctx-panel-header">
          <div>
            <div className="sidebar-title" style={{ marginBottom: 0 }}>Run Observatory</div>
            <div className="small muted">
              {t('runObservatory.observerChannelLead')}
              {observerStatus?.level ? ` · level=${observerStatus.level}` : ''}
              {observerStatus?.channels?.['context.llm'] === false
                ? t('runObservatory.llmChannelOff')
                : ''}
            </div>
            <div className="small muted">{t('runObservatory.auditIntro')}</div>
          </div>
          <button
            type="button"
            className="btn-ghost small"
            disabled={refreshing || !onRefresh}
            onClick={() => { void refresh(); }}
          >
            {refreshing ? t('runObservatory.refreshing') : t('runObservatory.refresh')}
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
          <div className="ctx-empty">{t('runObservatory.emptyObs')}</div>
        ) : (
          <>
            <div className="ctx-section-title">{t('runObservatory.runScopeTitle')}</div>
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
                <span className="k">privileged</span>
                <span className="v" style={scope?.toolRuntime?.privileged ? { color: '#c0392b', fontWeight: 700 } : undefined}>
                  {scope?.toolRuntime?.privileged ? 'PRIVILEGED' : '—'}
                </span>
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
                      {showFullPrompt
                        ? t('runObservatory.collapse')
                        : scope.systemPromptFull
                          ? t('runObservatory.fullText')
                          : t('runObservatory.preview')}
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
                      systemPrompt{' '}
                      {showFullPrompt && scope?.systemPromptFull
                        ? t('runObservatory.fullText')
                        : 'preview'}
                      {showFullPrompt && !scope?.systemPromptFull
                        ? t('runObservatory.promptNotCaptured')
                        : ''}
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

            <div className="ctx-section-title">{t('runObservatory.lifecycleTitle')}</div>
            <div className="small muted" style={{ marginBottom: 4 }}>
              {t('runObservatory.lifecycleHint')}
            </div>
            <div className="ctx-metrics">
              <div className="ctx-metric">
                <div className="k">steps</div>
                <div className="v">{stepsDisplay ?? '—'}</div>
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

            <div className="ctx-section-title">{t('runObservatory.timingTitle')}</div>
            <div className="small muted" style={{ marginBottom: 4 }}>
              {t('runObservatory.timingHintLead')}{' '}
              <span className="mono">run.timing</span>
              {t('runObservatory.timingHintAfterTiming')}{' '}
              <span className="mono">step.end.llmTiming</span>
              {t('runObservatory.timingHintAfterLlmTiming')}{' '}
              <span className="mono">run_end.durMs</span>{' '}
              {t('runObservatory.timingHintTail')}
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
                      ? t('runObservatory.ttftPerCall', {
                          list: f3.ttftList.map((v) => `${v}ms`).join(' / '),
                        })
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
                <div className="k">step Σ</div>
                <div className="v">
                  {timing.step ? `${formatMs(timing.step.totalMs)} (${timing.step.count})` : '—'}
                </div>
              </div>
            </div>

            {(obs.guardMetrics || obs.llmSummary || obs.messagesDiff) && (
              <>
                <div className="ctx-section-title">Guard · Metrics · LLM</div>
                <div className="small muted" style={{ marginBottom: 4 }}>
                  {t('runObservatory.guardHint')}
                </div>
                <div className="ctx-metrics">
                  <div className="ctx-metric">
                    <div className="k">iter (steps)</div>
                    <div className="v">{obs.guardMetrics?.steps ?? lifecycle?.steps ?? '—'}</div>
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
                    <div className="v" title={t('runObservatory.llmMsgsTitle')}>
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
                          ? `wrap-up (${obs.guardMetrics.wrapUpReason ?? '?'}, ${obs.guardMetrics.wrapUpStepsRemaining ?? 0} steps left)`
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
                    {t('runObservatory.messagesDiff', {
                      entry: obs.messagesDiff.entryCount,
                      final: obs.messagesDiff.finalCount,
                      added: obs.messagesDiff.added.length,
                    })}
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
                  {t('runObservatory.toolEffectHint')}
                </div>
                <div className="ctx-kv">
                  <span className="k">cwd</span>
                  <span className="v" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {obs.toolEffect.cwd || '—'}
                  </span>
                  <span className="k">isolation</span>
                  <span className="v">{obs.toolEffect.isolation || '—'}</span>
                  <span className="k">privileged</span>
                  <span className="v" style={obs.toolEffect.privileged ? { color: '#c0392b', fontWeight: 700 } : undefined}>
                    {obs.toolEffect.privileged ? 'PRIVILEGED' : '—'}
                  </span>
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
                <div className="ctx-section-title">{t('runObservatory.memoryTitle')}</div>
                <div className="small muted" style={{ marginBottom: 4 }}>
                  {t('runObservatory.memoryHint')}
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
                            <span className="muted">
                              {open ? t('runObservatory.collapse') : t('runObservatory.detail')}
                            </span>
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
                {t('runObservatory.timelineEmpty')}
              </div>
            )}

            <div className="ctx-section-title">
              Run Messages ·{' '}
              {phase === 'llm'
                ? t('runObservatory.phaseLlm')
                : phase === 'entry'
                  ? t('runObservatory.phaseEntry')
                  : t('runObservatory.phaseFinal')}
            </div>
            <div className="small muted" style={{ marginBottom: 6 }}>
              {phase === 'llm' ? t('runObservatory.messagesLlmHint') : t('runObservatory.messagesHint')}
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
                    {ATTR_META[kind] ? t(ATTR_META[kind].labelKey) : kind} {n}
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
                {filterHidden
                  ? t('runObservatory.filterHiddenOnlyActive')
                  : t('runObservatory.filterHiddenOnly')}
              </button>
              <button
                type="button"
                className="btn-ghost small"
                onClick={() => setShowPreviewOnly((v) => !v)}
              >
                {showPreviewOnly ? t('runObservatory.preview') : t('runObservatory.fullText')}
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
                        {t('runObservatory.llmSummaryCaptured')}
                        <b>{t('runObservatory.llmSummaryBadge')}</b>
                        {t('runObservatory.llmSummaryCount', { count: obs?.llmSummary?.count ?? 0 })}
                        <b>{t('runObservatory.llmSummaryNoBody')}</b>
                        {t('runObservatory.llmSummaryTail')}
                        <br />
                        {t('runObservatory.llmSummaryNeed')}
                        <span className="mono">observer.level=full</span>
                        {t('runObservatory.llmSummaryNeedMid')}
                        <span className="mono"> context.llm</span>
                        {t('runObservatory.llmSummaryNeedTail')}
                        <b>{t('runObservatory.llmSummaryRerun')}</b>
                        {t('runObservatory.llmSummaryRerunTail')}
                      </>
                    ) : (
                      <>
                        {t('runObservatory.llmEmptyTitle')}
                        <br />
                        {t('runObservatory.llmEmptyCheckLead')}
                        <span className="mono">observer.level=full</span>
                        {t('runObservatory.llmEmptyCheckMid')}
                        <b>{t('runObservatory.llmEmptyCheckRerun')}</b>
                        {t('runObservatory.llmEmptyCheckMid2')}
                        <span className="mono">channels.context.llm</span>
                        {t('runObservatory.llmEmptyCheckTail')}
                        <br />
                        {t('runObservatory.llmEmptyStatusLead')}
                        {observerStatus?.level ?? '—'} · llmChannel=
                        {String(observerStatus?.channels?.['context.llm'] ?? 'unknown')}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {t('runObservatory.levelNoBody')}
                    <span className="mono">observer.level=full</span>
                    {t('runObservatory.levelNoBodyTail')}
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
                              {attrMeta
                                ? t(attrMeta.labelKey)
                                : phase === 'llm'
                                  ? 'LLM'
                                  : t('runObservatory.workspace')}
                            </span>
                          </div>
                          <div className="ctx-band-meta">
                            {m.hiddenFromChat && (
                              <span
                                className="ctx-badge badge-empty"
                                title={t('runObservatory.hiddenChatTitle')}
                              >
                                {t('runObservatory.hiddenChatBadge')}
                              </span>
                            )}
                            {isEnvelope && (attr?.slots?.length ?? 0) > 0 ? (
                              attr!.slots!.map((s, si) => (
                                <span key={`${s.tag}-${si}`} className="ctx-slot-chip" title={t('runObservatory.slotChipTitle')}>
                                  {slotLabel(s.tag, t)} {s.chars}c
                                </span>
                              ))
                            ) : m.metadata?.source != null ? (
                              <span>source: {String(m.metadata.source)}</span>
                            ) : null}
                            <span>{m.contentChars ?? 0} chars</span>
                            {m.timestamp && <span>{new Date(m.timestamp).toLocaleTimeString()}</span>}
                            <span className="muted">
                              {open ? t('runObservatory.collapse') : t('runObservatory.detail')}
                            </span>
                          </div>
                          {!open && isEnvelope && (
                            <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                              <span className="ctx-slot-user">
                                {attr?.hasUserMessage === false
                                  ? t('runObservatory.envelopeIncompleteShort')
                                  : hasBody
                                    ? t('runObservatory.userTextLabel')
                                    : t('runObservatory.previewNoBodySlot')}
                              </span>
                              <span className="muted">
                                {previewText.slice(0, 160) || t('runObservatory.emptyParen')}
                                {attr?.userChars != null
                                  ? t('runObservatory.envelopeChars', {
                                      chars: attr.userChars,
                                      slots: attr.slots?.length ?? 0,
                                    })
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
                              {m.toolResults?.length
                                ? t('runObservatory.noTextPreviewWithTools')
                                : t('runObservatory.noTextPreview')}
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
                            <span className="v" title={t('runObservatory.hiddenTitleShort')}>{String(m.hiddenFromChat ?? false)}</span>
                          </div>
                          {isEnvelope && (
                            <>
                              <div className="ctx-section-title" style={{ marginTop: 8 }}>
                                {t('runObservatory.userMessageSection')}
                              </div>
                              <div className="ctx-layer-content">
                                <pre className="ctx-layer-content-body" style={{ whiteSpace: 'pre-wrap' }}>
                                  {attr?.hasUserMessage === false
                                    ? t('runObservatory.envelopeIncompleteBody')
                                    : hasBody
                                      ? (envelopeUserText || t('runObservatory.emptyParen'))
                                      : t('runObservatory.snapshotNoBody')}
                                </pre>
                              </div>
                              <div className="ctx-section-title" style={{ marginTop: 8 }}>
                                {t('runObservatory.machineSlotsSection')}
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
                                      {slotLabel(s.tag, t)} · {s.chars} chars ·{' '}
                                      {slotOpen ? t('runObservatory.collapse') : t('runObservatory.expand')}
                                    </button>
                                    {slotOpen && (
                                      <pre className="ctx-layer-content-body" style={{ whiteSpace: 'pre-wrap' }}>
                                        {body ?? t('runObservatory.slotNoBody')}
                                      </pre>
                                    )}
                                  </div>
                                );
                              })}
                              {!(attr?.slots ?? []).length && (
                                <div className="small muted">{t('runObservatory.noSlots')}</div>
                              )}
                            </>
                          )}
                          <div className="ctx-section-title" style={{ marginTop: 8 }}>
                            {t('runObservatory.contentSection')}
                          </div>
                          <div className="ctx-layer-content">
                            <div className="ctx-layer-content-meta">
                              <span className="mono muted">
                                {showPreviewOnly
                                  ? t('runObservatory.preview')
                                  : t('runObservatory.fullText')}
                                {m.content == null && m.contentPreview
                                  ? t('runObservatory.snapshotPreviewOnly')
                                  : ''}
                              </span>
                            </div>
                            <pre className="ctx-layer-content-body" style={{ whiteSpace: 'pre-wrap' }}>
                              {showPreviewOnly
                                ? (m.contentPreview || contentToText(m.content).slice(0, 400) || t('runObservatory.noContent'))
                                : (contentToText(m.content) || m.contentPreview || t('runObservatory.noContent'))}
                            </pre>
                          </div>
                          {(m.toolCalls?.length || m.toolResults?.length) && (
                            <>
                              <div className="ctx-section-title" style={{ marginTop: 8 }}>
                                {t('runObservatory.toolsSection')}
                              </div>
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
