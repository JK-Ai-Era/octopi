import { useCallback, useEffect, useState } from 'react';

/**
 * RunServicesPanel — run serve 实例页签（服务拓扑）。
 *
 * 显示当前运行中的 run serve 实例（instanceId / 版本 / 状态 / PID / 端口 / 负载）
 * 与路由快照（versionPointer / weights）。数据源 = GET /api/v1/fleet（gateway
 * fleet 运维面同一事实源）。页签激活时拉取一次，支持手动刷新。
 */

export interface FleetStatusDto {
  instances: Array<{
    instanceId: string;
    version: string;
    buildRef: string;
    port: number;
    pid: number;
    state: string;
    startedAt: number;
    load: { inFlightRuns: number; queued: number };
  }>;
  route: {
    versionPointer: string;
    replicasPerVersion: number;
    weights: Record<string, number>;
  };
}

export interface RunServicesPanelProps {
  /** SDK client（须有 getFleet） */
  client: { getFleet(): Promise<FleetStatusDto | null> };
}

function formatState(state: string): string {
  switch (state) {
    case 'ready':
      return '🟢 ready';
    case 'draining':
      return '🟡 draining';
    case 'starting':
      return '🔵 starting';
    default:
      return `🔴 ${state}`;
  }
}

export function RunServicesPanel({ client }: RunServicesPanelProps) {
  const [fleet, setFleet] = useState<FleetStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFleet(await client.getFleet());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="ctx-runtime">
      <section className="panel sidebar-section">
        <div className="sidebar-title">
          Run 服务实例
          <button
            className="btn-tab"
            style={{ marginLeft: 'auto', fontSize: '11px' }}
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
        {error && <div className="small muted">加载失败：{error}</div>}
        {loading && !fleet && <div className="small muted">加载中…</div>}
        {!error && !loading && !fleet && (
          <div className="small muted">服务未返回实例数据（/fleet 空响应）</div>
        )}
        {fleet && (
          <>
            <div className="inspector-kv">
              <span className="small muted">副本期望（replicasPerVersion）</span>
              <span className="small">{fleet.route.replicasPerVersion}</span>
              <span className="small muted">版本指针</span>
              <span className="small">{fleet.route.versionPointer}</span>
              <span className="small muted">权重</span>
              <span className="small">
                {Object.keys(fleet.route.weights).length === 0
                  ? '—'
                  : Object.entries(fleet.route.weights)
                      .map(([v, w]) => `${v} ${w}%`)
                      .join(' / ')}
              </span>
            </div>
            {fleet.instances.length === 0 ? (
              <div className="small muted">无运行中的 run serve 实例</div>
            ) : (
              <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                    <th style={{ padding: '2px 6px 2px 0' }}>实例</th>
                    <th style={{ padding: '2px 6px 2px 0' }}>状态</th>
                    <th style={{ padding: '2px 6px 2px 0' }}>版本</th>
                    <th style={{ padding: '2px 6px 2px 0' }}>PID</th>
                    <th style={{ padding: '2px 6px 2px 0' }}>端口</th>
                    <th style={{ padding: '2px 6px 2px 0' }}>负载</th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.instances.map((i) => (
                    <tr key={i.instanceId}>
                      <td style={{ padding: '2px 6px 2px 0' }}>{i.instanceId}</td>
                      <td style={{ padding: '2px 6px 2px 0' }}>{formatState(i.state)}</td>
                      <td style={{ padding: '2px 6px 2px 0' }} title={`buildRef: ${i.buildRef}`}>
                        {i.version}
                      </td>
                      <td style={{ padding: '2px 6px 2px 0' }}>{i.pid}</td>
                      <td style={{ padding: '2px 6px 2px 0' }}>{i.port}</td>
                      <td style={{ padding: '2px 6px 2px 0' }}>
                        {i.load.inFlightRuns} 在跑{i.load.queued > 0 ? ` / ${i.load.queued} 排队` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="small muted">
              版本列悬停可见 buildRef（构建产物根）；热换走 fleet spawn/promote/drain（运维面）。
            </div>
          </>
        )}
      </section>
    </div>
  );
}
