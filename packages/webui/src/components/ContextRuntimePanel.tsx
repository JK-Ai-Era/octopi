import { useEffect, useState } from 'react';
import type {
  LayerRuntimeViewDto,
} from '@octopi-agent/gateway/web/sdk/client';
import type { InspectorState } from '@octopi-agent/gateway/web/runtime/store';
import type { ViewMode } from '@octopi-agent/gateway/web/conversation/types';
import { useT } from '../i18n/react';
import { t as tNow, type MessageKey } from '../i18n/core';

/** 会话视图模式取值 → i18n 键（`Record` 强制全覆盖） */
const VIEW_MODE_LABEL_KEY: Record<ViewMode, MessageKey> = {
  history: 'contextRuntime.viewModeHistory',
  runtime: 'contextRuntime.viewModeRuntime',
  hybrid: 'contextRuntime.viewModeHybrid',
};

/**
 * 产品八层之 1–7（System ContextLayer）。
 * 第 8 层 Information 不在此栈，单独 strip（消息窗口）。
 */
const LAYER_META: Record<
  LayerRuntimeViewDto['id'],
  { labelKey: MessageKey; hue: string; n: number; noteKey?: MessageKey }
> = {
  wisdom: { labelKey: 'contextRuntime.layerWisdom', hue: '#c9a227', n: 1 },
  persona: { labelKey: 'contextRuntime.layerPersona', hue: '#4f46e5', n: 2 },
  skill: { labelKey: 'contextRuntime.layerSkill', hue: '#0d9488', n: 3 },
  knowledge: { labelKey: 'contextRuntime.layerKnowledge', hue: '#2563eb', n: 4 },
  cognition: { labelKey: 'contextRuntime.layerCognition', hue: '#7c3aed', n: 5 },
  memory: { labelKey: 'contextRuntime.layerMemory', hue: '#059669', n: 6 },
  runtime: {
    labelKey: 'contextRuntime.layerRuntime',
    hue: '#64748b',
    n: 7,
    noteKey: 'contextRuntime.layerRuntimeNote',
  },
};

const STATUS_META: Record<LayerRuntimeViewDto['status'], { labelKey: MessageKey; cls: string }> = {
  included: { labelKey: 'contextRuntime.statusIncluded', cls: 'badge-included' },
  empty: { labelKey: 'contextRuntime.statusEmpty', cls: 'badge-empty' },
  dropped: { labelKey: 'contextRuntime.statusDropped', cls: 'badge-dropped' },
  error: { labelKey: 'contextRuntime.statusError', cls: 'badge-error' },
  unregistered: { labelKey: 'contextRuntime.statusUnregistered', cls: 'badge-unregistered' },
  idle: { labelKey: 'contextRuntime.statusIdle', cls: 'badge-idle' },
};

/** E8 装配位置语义标注（缓存卖点对用户可见） */
const PLACEMENT_META: Record<
  'system' | 'snapshot',
  { labelKey: MessageKey; cls: string; hintKey: MessageKey }
> = {
  system: {
    labelKey: 'contextRuntime.placementSystemLabel',
    cls: 'ctx-placement-system',
    hintKey: 'contextRuntime.placementSystemHint',
  },
  snapshot: {
    labelKey: 'contextRuntime.placementSnapshotLabel',
    cls: 'ctx-placement-snapshot',
    hintKey: 'contextRuntime.placementSnapshotHint',
  },
};

type LayerRow = LayerRuntimeViewDto & { placement?: 'system' | 'snapshot' };

/**
 * 摘要请求体量：优先显示 **token 估算**（与会话顶栏同一把尺子）。
 *
 * 2026-11-13 修正：此前显示 JSON 字符数（"966K 字符"），与顶栏 token（341.2k）并排
 * 出现时量纲不同却视觉相当，用户据此以为「摘要请求比上下文大 3 倍」。实测 966K 字符
 * = 348k token（2.84 字符/token），本就是一回事。字符数仅在缺 token 估算时作降级显示。
 */
function formatRequestSize(requestTokens?: number, requestChars?: number): string | undefined {
  if (typeof requestTokens === 'number' && Number.isFinite(requestTokens) && requestTokens > 0) {
    return `${formatTokens(requestTokens)} tokens`;
  }
  if (typeof requestChars === 'number' && Number.isFinite(requestChars) && requestChars > 0) {
    // 降级：后端未上报 token 估算（旧事件形态），仍如实标注字符单位
    return requestChars < 1024
      ? tNow('contextRuntime.requestChars', { n: requestChars })
      : tNow('contextRuntime.requestKChars', { n: (requestChars / 1024).toFixed(0) });
  }
  return undefined;
}

function formatTokens(n: number | undefined | null): string {
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return tNow('contextRuntime.unknown');
  const value = n;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function isWarnIncluded(layer: LayerRow): boolean {
  return layer.status === 'included' && Boolean(layer.reason);
}

function rowPlacement(layer: LayerRow): 'system' | 'snapshot' {
  return layer.placement === 'snapshot' ? 'snapshot' : 'system';
}

/** 双 runtime 行的份标注（主行=锚点份，附加行=易变份） */
function rowRoleLabel(layer: LayerRow): string | undefined {
  if (layer.id !== 'runtime') return undefined;
  return rowPlacement(layer) === 'snapshot'
    ? tNow('contextRuntime.rowRoleSnapshot')
    : tNow('contextRuntime.rowRoleAnchor');
}

export interface ContextRuntimePanelProps {
  inspector: InspectorState;
  viewMode: ViewMode;
  runStatus: string;
  sessionId: string | null;
  agentId: string;
  connection: string;
  /** 当前会话消息条数（Information 层） */
  messageCount?: number;
  /** 点选层时按需刷新快照（拉取层 content） */
  onRefreshLayers?: () => Promise<void>;
}

/**
 * 八层上下文 Runtime 面板（E8 双组视图）
 *
 * 产品八层 = System ContextLayer（1–7，含 Runtime）+ Information（8，消息窗口）。
 * E8：层按 placement 分两组——system（缓存稳定前缀）/ snapshot（本轮易变，content 尾部）；
 * usedTokens / usedSnapshotTokens 分账；双 runtime 条目分行展示。
 * 只渲染 AssembleManifest 快照，不重算层状态。
 */
export function ContextRuntimePanel({
  inspector,
  viewMode,
  runStatus,
  sessionId,
  agentId,
  connection,
  messageCount,
  onRefreshLayers,
}: ContextRuntimePanelProps) {
  const snapshot = inspector.contextLayers;
  const t = useT();
  /** 展开中的层（单开手风琴）：null = 全部收起 */
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  // M-5（2026-11-07 评审）：elapsed 不能只在 render 期计算——provider 静默期没有任何
  // 新事件触发重渲染，「已等待 Ns」会冻结在 0s。压缩进行中挂 1s tick 强制刷新。
  const [nowTick, setNowTick] = useState(() => Date.now());
  const compactActive = Boolean(inspector.compact?.active);
  useEffect(() => {
    if (!compactActive) return;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [compactActive]);

  const layers = (snapshot?.layers ?? []) as LayerRow[];
  const rowKey = (l: LayerRow): string => `${l.id}#${rowPlacement(l)}`;

  const toggleLayer = async (layer: LayerRow) => {
    const key = rowKey(layer);
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (layer.content || !onRefreshLayers) return;
    setLoadingContent(true);
    try {
      await onRefreshLayers();
    } finally {
      setLoadingContent(false);
    }
  };

  const systemRows = layers.filter((l) => rowPlacement(l) === 'system');
  const snapshotRows = layers.filter((l) => rowPlacement(l) === 'snapshot');
  const systemIncluded = systemRows.filter((l) => l.included);
  const snapshotIncluded = snapshotRows.filter((l) => l.included);
  const snapshotUsed = snapshot?.usedSnapshotTokens ?? 0;

  const compact = inspector.compact;
  // P3：进行中要能回答「在等什么、等了多久、发出去多大」——三样都来自后端事件，
  // 不做前端猜测；elapsed 由上面的 1s tick 驱动刷新（provider 静默期也走秒）。
  const compactElapsedS =
    compact?.active && compact.startedAt
      ? Math.max(0, Math.round((nowTick - compact.startedAt) / 1000))
      : undefined;
  const compactReasonLabel =
    compact?.reason === 'proactive'
      ? t('contextRuntime.compactReasonProactive')
      : compact?.reason === 'overflow'
        ? t('contextRuntime.compactReasonOverflow')
        : t('contextRuntime.compactReasonSummary');
  const compactText = compact?.active
    ? t('contextRuntime.compactActive', { reason: compactReasonLabel }) +
      (compact.phase === 'summarize'
        ? t('contextRuntime.compactRequestSent') +
          (() => {
            const size = formatRequestSize(compact.requestTokens, compact.requestChars);
            return size ? ` ${size}` : '';
          })() +
          (compactElapsedS !== undefined
            ? t('contextRuntime.compactElapsed', { s: compactElapsedS })
            : '') +
          (compact.timeoutMs
            ? t('contextRuntime.compactBudget', { s: Math.round(compact.timeoutMs / 1000) })
            : '')
        : '')
    : compact?.error
      ? t('contextRuntime.compactFailed', { error: compact.error })
      : compact?.cached
        ? t('contextRuntime.compactCacheRebuilt')
        : compact?.tokensAfter !== undefined
          ? t('contextRuntime.compactDone') +
            (compact.tokensBefore !== undefined
              ? t('contextRuntime.compactDonePair', {
                  before: formatTokens(compact.tokensBefore),
                  after: formatTokens(compact.tokensAfter),
                })
              : '')
          : t('contextRuntime.compactNone');

  const renderBand = (layer: LayerRow) => {
    const isOpen = expandedKey === rowKey(layer);
    const meta = LAYER_META[layer.id];
    const status = STATUS_META[layer.status] ?? STATUS_META.idle;
    const placement = PLACEMENT_META[rowPlacement(layer)];
    const badgeCls = isWarnIncluded(layer) ? 'badge-warn' : status.cls;
    const badgeLabel = isWarnIncluded(layer)
      ? t('contextRuntime.badgeIncludedWarn')
      : t(status.labelKey);
    const hasCap = layer.budgetTokens != null && layer.budgetTokens > 0;
    const denom = rowPlacement(layer) === 'snapshot'
      ? Math.max(snapshotUsed, 1)
      : Math.max(snapshot?.usedTokens ?? 0, 1);
    const pct = hasCap
      ? Math.min(100, (layer.tokens / (layer.budgetTokens || 1)) * 100)
      : layer.tokens > 0
        ? Math.min(100, (layer.tokens / denom) * 100)
        : 0;
    return (
      <button
        key={rowKey(layer)}
        type="button"
        className={`ctx-band ${isOpen ? 'ctx-band-selected' : ''}`}
        aria-expanded={isOpen}
        onClick={() => { void toggleLayer(layer); }}
      >
        <div className="ctx-band-stripe" style={{ background: meta.hue }} />
        <div className="ctx-band-body">
          <div className="ctx-band-top">
            <div className="ctx-band-name">
              <span className="ctx-layer-n">L{meta.n}</span>
              {t(meta.labelKey)} <span className="ctx-band-id">{layer.id}</span>
              {rowRoleLabel(layer) && (
                <span className="ctx-layer-note">
                  {t('contextRuntime.runtimeRowNote', { role: rowRoleLabel(layer) ?? '' })}
                </span>
              )}
            </div>
            <div className="ctx-band-top-right">
              <span className={`ctx-badge ${badgeCls}`}>{badgeLabel}</span>
              <span className="ctx-band-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
            </div>
          </div>
          <div className="ctx-band-meta">
            <span className={`ctx-placement ${placement.cls}`}>{t(placement.labelKey)}</span>
            <span>order {layer.order}</span>
            <span>prio {layer.priority}</span>
            <span>
              {hasCap ? `cap ${formatTokens(layer.budgetTokens)}` : t('contextRuntime.noLayerCap')}
            </span>
            <span>tokens {formatTokens(layer.tokens)}</span>
            <span>{layer.droppable ? 'droppable' : 'keep'}</span>
          </div>
          <div className="ctx-tok-row">
            <div className="ctx-tok-track">
              <div
                className="ctx-tok-fill"
                style={{
                  width: `${pct}%`,
                  background: meta.hue,
                }}
              />
            </div>
            <div className="ctx-tok-label">
              {hasCap ? `${Math.round(pct)}%` : 'pool'}
            </div>
          </div>
        </div>
      </button>
    );
  };

  /** 层详情：就地展开在所属卡片下方（不再依赖底部独立区块） */
  const renderDetail = (layer: LayerRow) => {
    const placement = PLACEMENT_META[rowPlacement(layer)];
    return (
      <div className="ctx-detail ctx-detail-inline">
        <div className="ctx-kv">
          <span className="k">id</span>
          <span className="v">{layer.id}</span>
          <span className="k">placement</span>
          <span className={`v ${placement.cls}`}>{t(placement.labelKey)}</span>
          <span className="k">priority</span>
          <span className="v">{layer.priority}</span>
          <span className="k">order</span>
          <span className="v">{layer.order}</span>
          <span className="k">droppable</span>
          <span className="v">{String(layer.droppable)}</span>
          <span className="k">budget</span>
          <span className="v">
            {layer.budgetTokens != null && layer.budgetTokens > 0
              ? `${formatTokens(layer.budgetTokens)}${t('contextRuntime.hardCap')}`
              : rowPlacement(layer) === 'snapshot'
                ? t('contextRuntime.noHardCapSnapshot')
                : snapshot?.structureReserve != null
                  ? t('contextRuntime.noHardCapShared', {
                      budget: formatTokens(Math.max(0, snapshot.systemBudget - snapshot.structureReserve)),
                    })
                  : t('contextRuntime.noHardCapUnknown')}
          </span>
          <span className="k">tokens</span>
          <span className="v">{formatTokens(layer.tokens)}</span>
          <span className="k">sources</span>
          <span className="v">{layer.sources?.join(', ') || '—'}</span>
          <span className="k">reason</span>
          <span className={`v ${layer.reason ? (layer.status === 'error' ? 'status-error' : 'status-warn') : ''}`}>
            {layer.reason || '—'}
          </span>
        </div>
        {layer.dropped && (
          <div className="small status-warn" style={{ marginTop: 6 }}>
            dropped: {layer.dropped}
          </div>
        )}

        <div className="ctx-section-title" style={{ marginTop: 10 }}>
          {t('contextRuntime.layerContentTitle')}
        </div>
        {loadingContent ? (
          <div className="small muted" style={{ marginTop: 6 }}>
            {t('contextRuntime.loadingLayerContent')}
          </div>
        ) : layer.content ? (
          <div className="ctx-layer-content">
            <div className="ctx-layer-content-meta">
              <span className="mono">
                {layer.content.length} chars · {formatTokens(layer.tokens)} tokens
              </span>
            </div>
            <pre className="ctx-layer-content-body">{layer.content}</pre>
          </div>
        ) : layer.preview ? (
          <div className="ctx-layer-content">
            <div className="ctx-layer-content-meta">
              <span className="mono muted">{t('contextRuntime.previewNoFullText')}</span>
            </div>
            <pre className="ctx-layer-content-body">{layer.preview}</pre>
          </div>
        ) : (
          <div className="small muted" style={{ marginTop: 6 }}>
            {layer.status === 'empty' || layer.status === 'unregistered' || layer.status === 'idle'
              ? t('contextRuntime.noLayerBody')
              : t('contextRuntime.noLayerContent')}
          </div>
        )}
      </div>
    );
  };

  const renderLayerItem = (layer: LayerRow) => {
    const key = rowKey(layer);
    const isOpen = expandedKey === key;
    return (
      <div key={key} className={`ctx-stack-item ${isOpen ? 'is-open' : ''}`}>
        {renderBand(layer)}
        {isOpen && renderDetail(layer)}
      </div>
    );
  };

  return (
    <div className="ctx-runtime">
      <section className="panel sidebar-section">
        <div className="sidebar-title">{t('contextRuntime.sessionStateTitle')}</div>
        <div className="inspector-kv">
          {t('contextRuntime.viewModeLabel')}: {t(VIEW_MODE_LABEL_KEY[viewMode])}
        </div>
        <div className="inspector-kv">
          {t('contextRuntime.runStatusLabel')}: {runStatus}
        </div>
        <div className="inspector-kv">
          {t('contextRuntime.compactLabel')}: {compactText}
        </div>
        <div className="inspector-kv">
          {t('contextRuntime.sessionLabel')}: {sessionId ?? t('contextRuntime.none')}
        </div>
        <div className="inspector-kv">
          Agent: {agentId || t('contextRuntime.none')}
        </div>
        <div className="inspector-kv">
          {t('contextRuntime.connectionLabel')}: {connection}
        </div>
        {snapshot?.fallback && (
          <div className="small status-error" style={{ marginTop: 6 }}>
            {t('contextRuntime.assemblyFallback')}
            {snapshot.fallbackError ? t('contextRuntime.assemblyFallbackError', { error: snapshot.fallbackError }) : ''}
          </div>
        )}
      </section>

      {inspector.contextHealth && (
        <section className="panel sidebar-section">
          <div className="sidebar-title">{t('contextRuntime.dataPlaneHealthTitle')}</div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {t('contextRuntime.dataPlaneHealthHint')}
          </div>
          <div className="ctx-health-grid">
            <div className="ctx-health-item">
              <span className="k">persona</span>
              <span className="v">
                {inspector.contextHealth.summary.personaLoaded
                  ? t('contextRuntime.loaded')
                  : t('contextRuntime.notLoaded')}
              </span>
            </div>
            <div className="ctx-health-item">
              <span className="k">skills</span>
              <span className="v">{inspector.contextHealth.summary.skills ?? '—'}</span>
            </div>
            <div className="ctx-health-item">
              <span className="k">memory</span>
              <span className="v">{inspector.contextHealth.summary.memory ?? '—'}</span>
            </div>
            <div className="ctx-health-item">
              <span className="k">wisdom</span>
              <span className="v">{inspector.contextHealth.summary.wisdom ?? '—'}</span>
            </div>
            <div className="ctx-health-item">
              <span className="k">cognition</span>
              <span className="v">
                {inspector.contextHealth.summary.cognitionNodes !== undefined
                  ? `${inspector.contextHealth.summary.cognitionNodes}n / ${inspector.contextHealth.summary.cognitionEdges ?? 0}e`
                  : '—'}
              </span>
            </div>
            <div className="ctx-health-item">
              <span className="k">configured</span>
              <span className="v">{inspector.contextHealth.configured ? 'yes' : 'no'}</span>
            </div>
          </div>
        </section>
      )}

      <section className="ctx-panel">
        <div className="ctx-panel-header">
          <div>
            <div className="sidebar-title" style={{ marginBottom: 0 }}>{t('contextRuntime.assemblyTitle')}</div>
            <div className="small muted">{t('contextRuntime.assemblyHint')}</div>
          </div>
          <div className="small mono muted">
            {snapshot?.query ? `query: ${snapshot.query.slice(0, 36)}` : 'query: —'}
          </div>
        </div>

        <div className="ctx-metrics">
          <div className="ctx-metric">
            <div className="k">systemBudget</div>
            <div className="v">{snapshot ? formatTokens(snapshot.systemBudget) : '—'}</div>
          </div>
          <div className="ctx-metric">
            <div className="k">used · system</div>
            <div className="v">{snapshot ? formatTokens(snapshot.usedTokens) : '—'}</div>
          </div>
          <div className="ctx-metric">
            <div className="k">used · {t('contextRuntime.snapshotShort')}</div>
            <div className="v">
              {snapshot?.usedSnapshotTokens != null ? formatTokens(snapshot.usedSnapshotTokens) : '—'}
            </div>
          </div>
          <div className="ctx-metric">
            <div className="k">included</div>
            <div className="v">
              {snapshot
                ? `${systemIncluded.length + snapshotIncluded.length} / ${layers.length}`
                : '—'}
            </div>
          </div>
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>
          {t('contextRuntime.budgetLedgerHint')}
        </div>

        {/* ── System 组：缓存稳定前缀 ── */}
        <div className="ctx-group">
          <div className="ctx-group-header">
            <div className="ctx-group-title">{t('contextRuntime.systemGroupTitle')}</div>
            <span className="ctx-placement ctx-placement-system" title={t(PLACEMENT_META.system.hintKey)}>
              {t(PLACEMENT_META.system.labelKey)}
            </span>
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {t('contextRuntime.systemGroupHint')}
          </div>
          {snapshot && snapshot.systemBudget > 0 ? (
            <div className="ctx-budget">
              <div className="ctx-budget-bar">
                {systemIncluded.filter((l) => l.tokens > 0).map((l) => {
                  const meta = LAYER_META[l.id];
                  const denom = Math.max(snapshot.systemBudget, snapshot.usedTokens, 1);
                  const pct = (l.tokens / denom) * 100;
                  return (
                    <div
                      key={rowKey(l)}
                      className="ctx-budget-seg"
                      title={`${t(meta.labelKey)}${rowRoleLabel(l) ? ` · ${rowRoleLabel(l)}` : ''} ${l.tokens}`}
                      style={{ width: `${Math.max(pct, 0.4)}%`, background: meta.hue }}
                    />
                  );
                })}
              </div>
              <div className="ctx-budget-legend">
                {systemIncluded.map((l) => (
                  <span key={rowKey(l)}>
                    <i className="ctx-dot" style={{ background: LAYER_META[l.id].hue }} />
                    {t(LAYER_META[l.id].labelKey)}
                    {rowRoleLabel(l) ? ` · ${rowRoleLabel(l)}` : ''} {formatTokens(l.tokens)}
                  </span>
                ))}
                {!systemIncluded.length && (
                  <span className="muted">{t('contextRuntime.noSystemLayers')}</span>
                )}
              </div>
            </div>
          ) : (
            <div className="ctx-empty">
              {t('contextRuntime.systemGroupEmpty')}
            </div>
          )}
          {systemRows.length > 0 && <div className="ctx-stack">{systemRows.map(renderLayerItem)}</div>}
        </div>

        {/* ── 本轮快照组：易变 ── */}
        <div className="ctx-group ctx-group-snapshot">
          <div className="ctx-group-header">
            <div className="ctx-group-title">{t('contextRuntime.snapshotGroupTitle')}</div>
            <span className="ctx-placement ctx-placement-snapshot" title={t(PLACEMENT_META.snapshot.hintKey)}>
              {t(PLACEMENT_META.snapshot.labelKey)}
            </span>
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {t('contextRuntime.snapshotGroupHintLead')}
            <span className="mono">&lt;turn_context&gt;</span>
            {t('contextRuntime.snapshotGroupHintTail')}
          </div>
          {snapshotRows.length > 0 ? (
            <>
              <div className="ctx-budget">
                <div className="ctx-budget-bar ctx-budget-bar-snapshot">
                  {snapshotIncluded.filter((l) => l.tokens > 0).map((l) => {
                    const meta = LAYER_META[l.id];
                    const denom = Math.max(snapshotUsed, 1);
                    const pct = (l.tokens / denom) * 100;
                    return (
                      <div
                        key={rowKey(l)}
                        className="ctx-budget-seg"
                        title={`${t(meta.labelKey)}${rowRoleLabel(l) ? ` · ${rowRoleLabel(l)}` : ''} ${l.tokens}`}
                        style={{ width: `${Math.max(pct, 0.4)}%`, background: meta.hue }}
                      />
                    );
                  })}
                </div>
                <div className="ctx-budget-legend">
                  {snapshotIncluded.map((l) => (
                    <span key={rowKey(l)}>
                      <i className="ctx-dot" style={{ background: LAYER_META[l.id].hue }} />
                      {t(LAYER_META[l.id].labelKey)}
                      {rowRoleLabel(l) ? ` · ${rowRoleLabel(l)}` : ''} {formatTokens(l.tokens)}
                    </span>
                  ))}
                  {!snapshotIncluded.length && (
                    <span className="muted">{t('contextRuntime.noSnapshotLayers')}</span>
                  )}
                  <span className="muted">
                    {t('contextRuntime.snapshotTotalLegend', { tokens: formatTokens(snapshotUsed) })}
                  </span>
                </div>
              </div>
              <div className="ctx-stack">{snapshotRows.map(renderLayerItem)}</div>
            </>
          ) : (
            <div className="ctx-empty">
              {t('contextRuntime.snapshotGroupEmpty')}
            </div>
          )}
        </div>

        <div className="ctx-section-title">{t('contextRuntime.informationTitle')}</div>
        <div className="ctx-info-panel">
          <div className="ctx-info-lead">
            {t('contextRuntime.informationLead1')}
            <strong>DefaultContextEngine</strong>
            {t('contextRuntime.informationLead2')}
            <strong>{t('contextRuntime.informationLead3')}</strong>
            {t('contextRuntime.informationLead4')}
          </div>
          <div className="ctx-metrics" style={{ marginTop: 8 }}>
            <div className="ctx-metric">
              <div className="k">messages</div>
              <div className="v">{messageCount != null ? String(messageCount) : '—'}</div>
            </div>
            <div className="ctx-metric">
              <div className="k">{t('contextRuntime.promptTokensActualLabel')}</div>
              <div className="v">{formatTokens(inspector.promptTokensActual)}</div>
            </div>
            <div className="ctx-metric">
              <div className="k">{t('contextRuntime.viewTokensEstLabel')}</div>
              <div className="v">{formatTokens(inspector.viewTokensEst)}</div>
            </div>
            <div className="ctx-metric">
              <div className="k">contextWindow</div>
              <div className="v">{formatTokens(inspector.contextWindow)}</div>
            </div>
            <div className="ctx-metric">
              <div className="k">compact</div>
              <div className="v" style={{ fontSize: 12 }}>{compactText}</div>
            </div>
          </div>
          <div className="ctx-info-row" style={{ marginTop: 8 }}>
            <span>truncatedFrom</span>
            <span>{inspector.truncatedFrom != null ? String(inspector.truncatedFrom) : '—'}</span>
          </div>
          <div className="ctx-info-row">
            <span>truncatedTo</span>
            <span>{inspector.truncatedTo != null ? String(inspector.truncatedTo) : '—'}</span>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            {t('contextRuntime.distillationHint')}
          </div>
        </div>
      </section>

      <section className="panel sidebar-section">
        <button type="button" className="btn-ghost small" onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? t('contextRuntime.hideRawData') : t('contextRuntime.showRawData')}
        </button>
        {showRaw && (
          <pre className="ctx-raw" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify({ inspector, contextLayers: snapshot ?? null }, null, 2)}
          </pre>
        )}
      </section>
    </div>
  );
}
