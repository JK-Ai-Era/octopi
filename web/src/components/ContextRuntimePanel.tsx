import { useMemo, useState } from 'react';
import type {
  LayerRuntimeViewDto,
} from '../../../src/integration/web/sdk/client';
import type { InspectorState } from '../../../src/integration/web/runtime/store';

const LAYER_META: Record<LayerRuntimeViewDto['id'], { label: string; hue: string; note?: string }> = {
  wisdom: { label: '智慧', hue: '#c9a227' },
  persona: { label: '人格', hue: '#4f46e5' },
  skill: { label: '技能', hue: '#0d9488' },
  knowledge: { label: '知识', hue: '#2563eb' },
  cognition: { label: '认知', hue: '#7c3aed' },
  memory: { label: '记忆', hue: '#059669' },
  runtime: { label: '运行时', hue: '#64748b', note: '契约附加' },
};

const STATUS_META: Record<LayerRuntimeViewDto['status'], { label: string; cls: string }> = {
  included: { label: '纳入', cls: 'badge-included' },
  empty: { label: '空', cls: 'badge-empty' },
  dropped: { label: '丢弃', cls: 'badge-dropped' },
  error: { label: '失败', cls: 'badge-error' },
  unregistered: { label: '未注册', cls: 'badge-unregistered' },
  idle: { label: '待装配', cls: 'badge-idle' },
};

function formatTokens(n: number | undefined | null): string {
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return '未知';
  const value = n;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function isWarnIncluded(layer: LayerRuntimeViewDto): boolean {
  return layer.status === 'included' && Boolean(layer.reason);
}

export interface ContextRuntimePanelProps {
  inspector: InspectorState;
  viewMode: string;
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
 * 七层上下文 Runtime 面板
 *
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
  const [selectedId, setSelectedId] = useState<LayerRuntimeViewDto['id'] | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);

  const layers = snapshot?.layers ?? [];
  const selected = useMemo(() => {
    if (!layers.length) return null;
    return layers.find((l) => l.id === selectedId) ?? layers[0];
  }, [layers, selectedId]);

  const selectLayer = async (id: LayerRuntimeViewDto['id']) => {
    setSelectedId(id);
    const hit = layers.find((l) => l.id === id);
    if (hit?.content || !onRefreshLayers) return;
    setLoadingContent(true);
    try {
      await onRefreshLayers();
    } finally {
      setLoadingContent(false);
    }
  };

  const included = layers.filter((l) => l.included);
  const compact = inspector.compact;
  const compactText = compact?.active
    ? `进行中（${compact.reason === 'proactive' ? '主动摘要' : '溢出'}）`
    : compact?.error
      ? `失败：${compact.error}`
      : compact?.cached
        ? '缓存重建'
        : compact?.tokensAfter !== undefined
          ? `完成${compact.tokensBefore !== undefined ? `（${formatTokens(compact.tokensBefore)}→${formatTokens(compact.tokensAfter)}）` : ''}`
          : '无';

  return (
    <div className="ctx-runtime">
      <section className="panel sidebar-section">
        <div className="sidebar-title">会话状态</div>
        <div className="inspector-kv">视图模式: {viewMode}</div>
        <div className="inspector-kv">运行状态: {runStatus}</div>
        <div className="inspector-kv">上下文压缩: {compactText}</div>
        <div className="inspector-kv">会话: {sessionId ?? '无'}</div>
        <div className="inspector-kv">Agent: {agentId || '无'}</div>
        <div className="inspector-kv">连接: {connection}</div>
        {snapshot?.fallback && (
          <div className="small status-error" style={{ marginTop: 6 }}>
            装配回退 concat{snapshot.fallbackError ? `：${snapshot.fallbackError}` : ''}
          </div>
        )}
      </section>

      {inspector.contextHealth && (
        <section className="panel sidebar-section">
          <div className="sidebar-title">数据面健康</div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            store 计数 · 与单轮 manifest 互补
          </div>
          <div className="ctx-health-grid">
            <div className="ctx-health-item">
              <span className="k">persona</span>
              <span className="v">{inspector.contextHealth.summary.personaLoaded ? '已加载' : '未加载'}</span>
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

      {(inspector.contextLayersTimeline?.length ?? 0) > 0 && (
        <section className="panel sidebar-section">
          <div className="sidebar-title">近轮 Timeline</div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            每列一轮 · 色块=纳入
          </div>
          <div className="ctx-timeline">
            {(inspector.contextLayersTimeline ?? []).map((turn, idx) => (
              <div key={idx} className="ctx-timeline-col" title={`used ${formatTokens(turn.usedTokens)} / ${formatTokens(turn.systemBudget)}`}>
                <div className="ctx-timeline-label">T{idx + 1}</div>
                <div className="ctx-timeline-bars">
                  {(Object.keys(LAYER_META) as Array<keyof typeof LAYER_META>).map((id) => {
                    const on = turn.included.includes(id);
                    const bad = turn.dropped.includes(id);
                    return (
                      <div
                        key={id}
                        className={`ctx-timeline-cell ${on ? 'on' : bad ? 'bad' : ''}`}
                        style={on ? { background: LAYER_META[id].hue } : undefined}
                        title={`${LAYER_META[id].label} ${on ? '纳入' : bad ? '丢弃/失败' : '—'}`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="ctx-panel">
        <div className="ctx-panel-header">
          <div>
            <div className="sidebar-title" style={{ marginBottom: 0 }}>System 装配层（契约）</div>
            <div className="small muted">AssembleManifest 为真源 · 只含 system prompt 片段</div>
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
            <div className="k">usedTokens</div>
            <div className="v">{snapshot ? formatTokens(snapshot.usedTokens) : '—'}</div>
          </div>
          <div className="ctx-metric">
            <div className="k">reserve</div>
            <div className="v">{snapshot?.structureReserve != null ? String(snapshot.structureReserve) : '—'}</div>
          </div>
          <div className="ctx-metric">
            <div className="k">included</div>
            <div className="v">{snapshot ? `${included.length} / ${layers.length}` : '—'}</div>
          </div>
        </div>

        {snapshot && snapshot.systemBudget > 0 ? (
          <div className="ctx-budget">
            <div className="ctx-budget-bar">
              {included.map((l) => {
                const meta = LAYER_META[l.id];
                const denom = Math.max(
                  snapshot.systemBudget,
                  snapshot.usedTokens,
                  1,
                );
                const pct = (l.tokens / denom) * 100;
                return (
                  <div
                    key={l.id}
                    className="ctx-budget-seg"
                    title={`${meta.label} ${l.tokens}`}
                    style={{ width: `${Math.max(pct, 0.4)}%`, background: meta.hue }}
                  />
                );
              })}
            </div>
            <div className="ctx-budget-legend">
              {included.map((l) => (
                <span key={l.id}>
                  <i className="ctx-dot" style={{ background: LAYER_META[l.id].hue }} />
                  {LAYER_META[l.id].label} {formatTokens(l.tokens)}
                </span>
              ))}
              {!included.length && <span className="muted">本轮无层纳入</span>}
            </div>
          </div>
        ) : (
          <div className="ctx-empty">
            装配完成后，这里按 order 显示 System 契约层状态（Wisdom → Runtime）。
            <br />
            产品第 7 层 Information 不在本栈，见下方消息窗口面板。
            <br />
            未注册、空、丢弃是三种不同事实。
          </div>
        )}

        {layers.length > 0 && (
          <div className="ctx-stack">
            {layers.map((layer) => {
              const meta = LAYER_META[layer.id];
              const status = STATUS_META[layer.status] ?? STATUS_META.idle;
              const badgeCls = isWarnIncluded(layer) ? 'badge-warn' : status.cls;
              const badgeLabel = isWarnIncluded(layer) ? '纳入·告警' : status.label;
              const hasCap = layer.budgetTokens != null && layer.budgetTokens > 0;
              const pct = hasCap
                ? Math.min(100, (layer.tokens / (layer.budgetTokens || 1)) * 100)
                : snapshot && snapshot.usedTokens > 0
                  ? Math.min(100, (layer.tokens / Math.max(snapshot.usedTokens, 1)) * 100)
                  : layer.tokens > 0
                    ? 100
                    : 0;
              return (
                <button
                  key={layer.id}
                  type="button"
                  className={`ctx-band ${selected?.id === layer.id ? 'ctx-band-selected' : ''}`}
                  onClick={() => { void selectLayer(layer.id); }}
                >
                  <div className="ctx-band-stripe" style={{ background: meta.hue }} />
                  <div className="ctx-band-body">
                    <div className="ctx-band-top">
                      <div className="ctx-band-name">
                        {meta.label} <span className="ctx-band-id">{layer.id}</span>
                        {meta.note && <span className="ctx-layer-note">{meta.note}</span>}
                      </div>
                      <span className={`ctx-badge ${badgeCls}`}>{badgeLabel}</span>
                    </div>
                    <div className="ctx-band-meta">
                      <span>order {layer.order}</span>
                      <span>prio {layer.priority}</span>
                      <span>
                        {layer.budgetTokens != null && layer.budgetTokens > 0
                          ? `cap ${formatTokens(layer.budgetTokens)}`
                          : '无单层上限'}
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
                        {layer.budgetTokens != null && layer.budgetTokens > 0
                          ? `${Math.round(pct)}%`
                          : 'pool'}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="ctx-section-title">Information · 消息窗口（产品第 7 层）</div>
        <div className="ctx-info-panel">
          <div className="ctx-info-lead">
            session 正文与消息历史。由 <strong>DefaultContextEngine</strong> 做选择 / 压缩 / 主动摘要；
            <strong>不进入</strong> System 装配栈。
          </div>
          <div className="ctx-metrics" style={{ marginTop: 8 }}>
            <div className="ctx-metric">
              <div className="k">messages</div>
              <div className="v">{messageCount != null ? String(messageCount) : '—'}</div>
            </div>
            <div className="ctx-metric">
              <div className="k">contextTokens</div>
              <div className="v">{formatTokens(inspector.contextTokens)}</div>
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
            分馏关系：Information（session）→ 提炼 → Memory / Cognition / Wisdom → 再作为 System 层片段注入。
            对话正文见中栏消息列表。
          </div>
        </div>

        <div className="ctx-section-title">层详情 · System 契约层</div>
        <div className="ctx-detail">
          {!selected ? (
            <div className="small muted">选择一层查看 budget / reason / sources / 正文。</div>
          ) : (
            <>
              <div className="ctx-detail-title">
                <i className="ctx-dot" style={{ background: LAYER_META[selected.id].hue }} />
                {LAYER_META[selected.id].label}
                {LAYER_META[selected.id].note && (
                  <span className="ctx-layer-note">{LAYER_META[selected.id].note}</span>
                )}
                <span className={`ctx-badge ${(STATUS_META[selected.status] ?? STATUS_META.idle).cls}`}>
                  {(STATUS_META[selected.status] ?? STATUS_META.idle).label}
                </span>
              </div>
              <div className="ctx-kv">
                <span className="k">id</span>
                <span className="v">{selected.id}</span>
                <span className="k">priority</span>
                <span className="v">{selected.priority}</span>
                <span className="k">order</span>
                <span className="v">{selected.order}</span>
                <span className="k">droppable</span>
                <span className="v">{String(selected.droppable)}</span>
                <span className="k">budget</span>
                <span className="v">
                  {selected.budgetTokens != null && selected.budgetTokens > 0
                    ? `${formatTokens(selected.budgetTokens)}（硬顶）`
                    : `无硬顶 · 共享 contentBudget ${snapshot ? formatTokens(Math.max(0, snapshot.systemBudget - (snapshot.structureReserve ?? 50))) : '—'}`}
                </span>
                <span className="k">tokens</span>
                <span className="v">{formatTokens(selected.tokens)}</span>
                <span className="k">sources</span>
                <span className="v">{selected.sources?.join(', ') || '—'}</span>
                <span className="k">reason</span>
                <span className={`v ${selected.reason ? (selected.status === 'error' ? 'status-error' : 'status-warn') : ''}`}>
                  {selected.reason || '—'}
                </span>
              </div>
              {selected.dropped && (
                <div className="small status-warn" style={{ marginTop: 6 }}>
                  dropped: {selected.dropped}
                </div>
              )}

              <div className="ctx-section-title" style={{ marginTop: 10 }}>层内容</div>
              {loadingContent ? (
                <div className="small muted" style={{ marginTop: 6 }}>正在加载层内容…</div>
              ) : selected.content ? (
                <div className="ctx-layer-content">
                  <div className="ctx-layer-content-meta">
                    <span className="mono">
                      {selected.content.length} chars · {formatTokens(selected.tokens)} tokens
                    </span>
                  </div>
                  <pre className="ctx-layer-content-body">{selected.content}</pre>
                </div>
              ) : selected.preview ? (
                <div className="ctx-layer-content">
                  <div className="ctx-layer-content-meta">
                    <span className="mono muted">preview（未含全文）</span>
                  </div>
                  <pre className="ctx-layer-content-body">{selected.preview}</pre>
                </div>
              ) : (
                <div className="small muted" style={{ marginTop: 6 }}>
                  {selected.status === 'empty' || selected.status === 'unregistered' || selected.status === 'idle'
                    ? '本层本轮无正文。'
                    : '无层内容。请确认 contextAssembler.includeLayerContent=true 并重新装配一轮。'}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="panel sidebar-section">
        <button type="button" className="btn-ghost small" onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? '收起原始数据' : '原始数据'}
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
