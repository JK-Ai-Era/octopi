import { useState } from 'react';
import type {
  LayerRuntimeViewDto,
} from '@octopi-agent/gateway/web/sdk/client';
import type { InspectorState } from '@octopi-agent/gateway/web/runtime/store';

/**
 * 产品八层之 1–7（System ContextLayer）。
 * 第 8 层 Information 不在此栈，单独 strip（消息窗口）。
 */
const LAYER_META: Record<LayerRuntimeViewDto['id'], { label: string; hue: string; n: number; note?: string }> = {
  wisdom: { label: '智慧', hue: '#c9a227', n: 1 },
  persona: { label: '人格', hue: '#4f46e5', n: 2 },
  skill: { label: '技能', hue: '#0d9488', n: 3 },
  knowledge: { label: '知识', hue: '#2563eb', n: 4 },
  cognition: { label: '认知', hue: '#7c3aed', n: 5 },
  memory: { label: '记忆', hue: '#059669', n: 6 },
  runtime: { label: '运行时', hue: '#64748b', n: 7, note: 'Run 活态' },
};

const STATUS_META: Record<LayerRuntimeViewDto['status'], { label: string; cls: string }> = {
  included: { label: '纳入', cls: 'badge-included' },
  empty: { label: '空', cls: 'badge-empty' },
  dropped: { label: '丢弃', cls: 'badge-dropped' },
  error: { label: '失败', cls: 'badge-error' },
  unregistered: { label: '未注册', cls: 'badge-unregistered' },
  idle: { label: '待装配', cls: 'badge-idle' },
};

/** E8 装配位置语义标注（缓存卖点对用户可见） */
const PLACEMENT_META: Record<'system' | 'snapshot', { label: string; cls: string; hint: string }> = {
  system: {
    label: '稳定 · system',
    cls: 'ctx-placement-system',
    hint: '缓存稳定前缀：跨轮逐字节稳定，前缀缓存命中（延迟与成本双赢）',
  },
  snapshot: {
    label: '易变 · snapshot',
    cls: 'ctx-placement-snapshot',
    hint: '本轮易变快照：每轮重建，装配在消息尾部 turn_context，不进 system prompt',
  },
};

type LayerRow = LayerRuntimeViewDto & { placement?: 'system' | 'snapshot' };

function formatTokens(n: number | undefined | null): string {
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return '未知';
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
  return rowPlacement(layer) === 'snapshot' ? '易变份' : '锚点份';
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);

  const layers = (snapshot?.layers ?? []) as LayerRow[];
  const rowKey = (l: LayerRow): string => `${l.id}#${rowPlacement(l)}`;
  const selected = layers.length
    ? (layers.find((l) => rowKey(l) === selectedKey) ?? layers[0])
    : null;

  const selectLayer = async (layer: LayerRow) => {
    setSelectedKey(rowKey(layer));
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
  const compactText = compact?.active
    ? `进行中（${compact.reason === 'proactive' ? '主动摘要' : '溢出'}）`
    : compact?.error
      ? `失败：${compact.error}`
      : compact?.cached
        ? '缓存重建'
        : compact?.tokensAfter !== undefined
          ? `完成${compact.tokensBefore !== undefined ? `（${formatTokens(compact.tokensBefore)}→${formatTokens(compact.tokensAfter)}）` : ''}`
          : '无';

  const renderBand = (layer: LayerRow) => {
    const meta = LAYER_META[layer.id];
    const status = STATUS_META[layer.status] ?? STATUS_META.idle;
    const placement = PLACEMENT_META[rowPlacement(layer)];
    const badgeCls = isWarnIncluded(layer) ? 'badge-warn' : status.cls;
    const badgeLabel = isWarnIncluded(layer) ? '纳入·告警' : status.label;
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
        className={`ctx-band ${selected && rowKey(selected) === rowKey(layer) ? 'ctx-band-selected' : ''}`}
        onClick={() => { void selectLayer(layer); }}
      >
        <div className="ctx-band-stripe" style={{ background: meta.hue }} />
        <div className="ctx-band-body">
          <div className="ctx-band-top">
            <div className="ctx-band-name">
              <span className="ctx-layer-n">L{meta.n}</span>
              {meta.label} <span className="ctx-band-id">{layer.id}</span>
              {rowRoleLabel(layer) && (
                <span className="ctx-layer-note">运行时 · {rowRoleLabel(layer)}</span>
              )}
            </div>
            <span className={`ctx-badge ${badgeCls}`}>{badgeLabel}</span>
          </div>
          <div className="ctx-band-meta">
            <span className={`ctx-placement ${placement.cls}`}>{placement.label}</span>
            <span>order {layer.order}</span>
            <span>prio {layer.priority}</span>
            <span>
              {hasCap ? `cap ${formatTokens(layer.budgetTokens)}` : '无单层上限'}
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
            每列一轮 · 上行=system 纳入 · 下行=快照纳入 · L1–L7
          </div>
          <div className="ctx-timeline">
            {(inspector.contextLayersTimeline ?? []).map((turn, idx) => {
              const sysIds = turn.included;
              const snapIds = turn.snapshotIncluded ?? [];
              return (
                <div
                  key={idx}
                  className="ctx-timeline-col"
                  title={`system ${formatTokens(turn.usedTokens)}${turn.usedSnapshotTokens != null ? ` / 快照 ${formatTokens(turn.usedSnapshotTokens)}` : ''} / 预算 ${formatTokens(turn.systemBudget)}`}
                >
                  <div className="ctx-timeline-label">T{idx + 1}</div>
                  <div className="ctx-timeline-bars">
                    {(Object.keys(LAYER_META) as Array<keyof typeof LAYER_META>).map((id) => {
                      const on = sysIds.includes(id);
                      const bad = turn.dropped.includes(id);
                      return (
                        <div
                          key={`sys-${id}`}
                          className={`ctx-timeline-cell ${on ? 'on' : bad ? 'bad' : ''}`}
                          style={on ? { background: LAYER_META[id].hue } : undefined}
                          title={`system · ${LAYER_META[id].label} ${on ? '纳入' : bad ? '丢弃/失败' : '—'}`}
                        />
                      );
                    })}
                  </div>
                  {(turn.snapshotIncluded != null || turn.usedSnapshotTokens != null) && (
                    <div className="ctx-timeline-bars">
                      {(Object.keys(LAYER_META) as Array<keyof typeof LAYER_META>).map((id) => {
                        const on = snapIds.includes(id);
                        const bad = (turn.snapshotDropped ?? []).includes(id);
                        return (
                          <div
                            key={`snap-${id}`}
                            className={`ctx-timeline-cell ${on ? 'on' : bad ? 'bad' : ''}`}
                            style={on ? { background: LAYER_META[id].hue } : undefined}
                            title={`快照 · ${LAYER_META[id].label} ${on ? '纳入' : bad ? '丢弃/失败' : '—'}`}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="ctx-panel">
        <div className="ctx-panel-header">
          <div>
            <div className="sidebar-title" style={{ marginBottom: 0 }}>上下文装配 · E8 双组</div>
            <div className="small muted">AssembleManifest 为真源 · 按 placement 分组（system / 本轮快照）</div>
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
            <div className="k">used · 快照</div>
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
          分账：system 组计入 usedTokens（缓存稳定前缀）；本轮快照组计入 usedSnapshotTokens（易变，缺省无预算上限）。
        </div>

        {/* ── System 组：缓存稳定前缀 ── */}
        <div className="ctx-group">
          <div className="ctx-group-header">
            <div className="ctx-group-title">System · 缓存稳定前缀（产品 L1–L7）</div>
            <span className="ctx-placement ctx-placement-system" title={PLACEMENT_META.system.hint}>
              {PLACEMENT_META.system.label}
            </span>
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            跨轮逐字节稳定 · 前缀缓存命中 → 延迟与成本双赢（宪法 E8）
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
                      title={`${meta.label}${rowRoleLabel(l) ? ` · ${rowRoleLabel(l)}` : ''} ${l.tokens}`}
                      style={{ width: `${Math.max(pct, 0.4)}%`, background: meta.hue }}
                    />
                  );
                })}
              </div>
              <div className="ctx-budget-legend">
                {systemIncluded.map((l) => (
                  <span key={rowKey(l)}>
                    <i className="ctx-dot" style={{ background: LAYER_META[l.id].hue }} />
                    {LAYER_META[l.id].label}
                    {rowRoleLabel(l) ? ` · ${rowRoleLabel(l)}` : ''} {formatTokens(l.tokens)}
                  </span>
                ))}
                {!systemIncluded.length && <span className="muted">本轮 system 组无层纳入</span>}
              </div>
            </div>
          ) : (
            <div className="ctx-empty">
              装配完成后，这里按 order 显示 system 组契约层（缓存稳定前缀）。
            </div>
          )}
          {systemRows.length > 0 && <div className="ctx-stack">{systemRows.map(renderBand)}</div>}
        </div>

        {/* ── 本轮快照组：易变 ── */}
        <div className="ctx-group ctx-group-snapshot">
          <div className="ctx-group-header">
            <div className="ctx-group-title">本轮快照 · 易变（content 尾部）</div>
            <span className="ctx-placement ctx-placement-snapshot" title={PLACEMENT_META.snapshot.hint}>
              {PLACEMENT_META.snapshot.label}
            </span>
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            每轮重建 · 装配进本轮 <span className="mono">&lt;turn_context&gt;</span>（消息尾部），不进 system prompt；
            含 query 择取（记忆/认知/智慧）与 Run 易变注入（datetime / 任务）
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
                        title={`${meta.label}${rowRoleLabel(l) ? ` · ${rowRoleLabel(l)}` : ''} ${l.tokens}`}
                        style={{ width: `${Math.max(pct, 0.4)}%`, background: meta.hue }}
                      />
                    );
                  })}
                </div>
                <div className="ctx-budget-legend">
                  {snapshotIncluded.map((l) => (
                    <span key={rowKey(l)}>
                      <i className="ctx-dot" style={{ background: LAYER_META[l.id].hue }} />
                      {LAYER_META[l.id].label}
                      {rowRoleLabel(l) ? ` · ${rowRoleLabel(l)}` : ''} {formatTokens(l.tokens)}
                    </span>
                  ))}
                  {!snapshotIncluded.length && <span className="muted">本轮快照组无层纳入</span>}
                  <span className="muted">
                    合计 {formatTokens(snapshotUsed)} tok · 预算未随快照下发（不画预算条）
                  </span>
                </div>
              </div>
              <div className="ctx-stack">{snapshotRows.map(renderBand)}</div>
            </>
          ) : (
            <div className="ctx-empty">
              无快照组条目：本会话快照为空，或该装配早于 E8（旧快照无 placement）。
            </div>
          )}
        </div>

        <div className="ctx-section-title">Information · 消息窗口（产品第 8 层）</div>
        <div className="ctx-info-panel">
          <div className="ctx-info-lead">
            产品第 8 层。session 正文与消息历史。由 <strong>DefaultContextEngine</strong> 做选择 / 压缩 / 主动摘要；
            <strong>不进入</strong> System 装配栈（ContextLayer 只到 L7 Runtime）。
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
            分馏关系：Information（session）→ 提炼 → Memory / Cognition / Wisdom → 再作为快照择取注入本轮 turn_context。
            对话正文见中栏消息列表。
          </div>
        </div>

        <div className="ctx-section-title">层详情</div>
        <div className="ctx-detail">
          {!selected ? (
            <div className="small muted">选择一层查看 placement / budget / reason / sources / 正文。</div>
          ) : (
            <>
              <div className="ctx-detail-title">
                <i className="ctx-dot" style={{ background: LAYER_META[selected.id].hue }} />
                <span className="ctx-layer-n">L{LAYER_META[selected.id].n}</span>
                {LAYER_META[selected.id].label}
                {rowRoleLabel(selected) && (
                  <span className="ctx-layer-note">运行时 · {rowRoleLabel(selected)}</span>
                )}
                <span className={`ctx-badge ${(STATUS_META[selected.status] ?? STATUS_META.idle).cls}`}>
                  {(STATUS_META[selected.status] ?? STATUS_META.idle).label}
                </span>
              </div>
              <div className="ctx-kv">
                <span className="k">id</span>
                <span className="v">{selected.id}</span>
                <span className="k">placement</span>
                <span className={`v ${PLACEMENT_META[rowPlacement(selected)].cls}`}>
                  {PLACEMENT_META[rowPlacement(selected)].label}
                </span>
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
                    : rowPlacement(selected) === 'snapshot'
                      ? '无硬顶 · 计入快照组'
                      : snapshot?.structureReserve != null
                        ? `无硬顶 · 共享 contentBudget ${formatTokens(Math.max(0, snapshot.systemBudget - snapshot.structureReserve))}`
                        : '无硬顶 · contentBudget 未随快照下发'}
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
