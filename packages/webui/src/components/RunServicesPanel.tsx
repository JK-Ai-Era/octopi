import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/react';

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
  const t = useT();
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
          {t('runServices.title')}
          <button
            className="btn-tab"
            style={{ marginLeft: 'auto', fontSize: '11px' }}
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? t('runServices.refreshing') : t('runServices.refresh')}
          </button>
        </div>
        {error && <div className="small muted">{t('runServices.loadFailed', { error })}</div>}
        {loading && !fleet && <div className="small muted">{t('runServices.loading')}</div>}
        {!error && !loading && !fleet && (
          <div className="small muted">{t('runServices.empty')}</div>
        )}
        {fleet && (
          <>
            <div className="inspector-kv">
              <span className="small muted">{t('runServices.replicasExpected')}</span>
              <span className="small">{fleet.route.replicasPerVersion}</span>
              <span className="small muted">{t('runServices.versionPointer')}</span>
              <span className="small">{fleet.route.versionPointer}</span>
              <span className="small muted">{t('runServices.weights')}</span>
              <span className="small">
                {Object.keys(fleet.route.weights).length === 0
                  ? '—'
                  : Object.entries(fleet.route.weights)
                      .map(([v, w]) => `${v} ${w}%`)
                      .join(' / ')}
              </span>
            </div>
            {fleet.instances.length === 0 ? (
              <div className="small muted">{t('runServices.noInstances')}</div>
            ) : (
              <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                    <th style={{ padding: '2px 6px 2px 0' }}>{t('runServices.colInstance')}</th>
                    <th style={{ padding: '2px 6px 2px 0' }}>{t('runServices.colState')}</th>
                    <th style={{ padding: '2px 6px 2px 0' }}>{t('runServices.colVersion')}</th>
                    <th style={{ padding: '2px 6px 2px 0' }}>PID</th>
                    <th style={{ padding: '2px 6px 2px 0' }}>{t('runServices.colPort')}</th>
                    <th style={{ padding: '2px 6px 2px 0' }}>{t('runServices.colLoad')}</th>
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
                        {t('runServices.loadInFlight', { count: i.load.inFlightRuns })}
                        {i.load.queued > 0
                          ? ` / ${t('runServices.loadQueued', { count: i.load.queued })}`
                          : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="small muted">{t('runServices.buildRefHint')}</div>
          </>
        )}
      </section>
    </div>
  );
}
