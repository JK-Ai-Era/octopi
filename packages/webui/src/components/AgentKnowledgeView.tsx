/**
 * Agent 知识视野 — 只读辅视图（base，不含会话 overlay）
 * 改挂载请到项目详情；本视图只回答「它现在能看到什么」。
 * 规格：arch/knowledge-admin-ui.md §2.2
 */
import { useCallback, useEffect, useState } from 'react';
import { OctopiClient, type KnowledgeSourceDto } from '@octopi-agent/gateway/web/sdk/client';
import { useT } from '../i18n/react';

interface Visibility {
  hiddenSourceIds: string[];
  globalSources: Array<KnowledgeSourceDto & { hiddenForAgent: boolean }>;
  assignedProjects: Array<{
    projectKey: string;
    displayName?: string;
    sourceCount: number;
    assignedAgentIds: string[];
    sources: KnowledgeSourceDto[];
  }>;
  unassignedProjects: Array<{
    projectKey: string;
    displayName?: string;
    sourceCount: number;
    assignedAgentIds: string[];
  }>;
}

export function AgentKnowledgeView({
  client,
  agents,
  selectedAgentId,
  onSelectAgent,
  onOpenProject,
}: {
  client: OctopiClient;
  agents: string[];
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  onOpenProject?: (projectKey: string) => void;
}) {
  const [vis, setVis] = useState<Visibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const load = useCallback(async () => {
    try {
      setError(null);
      const v = await client.getKnowledgeVisibility(selectedAgentId);
      setVis(v);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, selectedAgentId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="panel kn-panel">
      <header className="kn-panel-header">
        <h2>{t('agentKnowledgeView.title')}</h2>
        <span className="small muted">{t('agentKnowledgeView.subtitle')}</span>
      </header>

      <div className="kn-form-row">
        <label className="small muted">Agent</label>
        <select
          value={selectedAgentId}
          onChange={(e) => onSelectAgent(e.target.value)}
        >
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
          {agents.length === 0 && <option value={selectedAgentId}>{selectedAgentId}</option>}
        </select>
        <button type="button" className="btn-ghost small" onClick={() => void load()}>
          {t('agentKnowledgeView.refresh')}
        </button>
      </div>

      {error && <div className="kn-error small">{error}</div>}
      {!vis && !error && <div className="small muted">{t('agentKnowledgeView.loading')}</div>}

      {vis && (
        <>
          <div className="kn-visibility-block">
            <div className="small" style={{ fontWeight: 600 }}>
              {t('agentKnowledgeView.globalTitle')}
              <span className="muted">
                {' · '}
                {t('agentKnowledgeView.globalVisible', {
                  visible: vis.globalSources.filter((s) => !s.hiddenForAgent).length,
                  total: vis.globalSources.length,
                })}
              </span>
            </div>
            {vis.globalSources.length === 0 && (
              <div className="small muted">{t('agentKnowledgeView.noGlobalSources')}</div>
            )}
            <div className="kn-list">
              {vis.globalSources.map((s) => (
                <div
                  key={s.id}
                  className={s.hiddenForAgent ? 'kn-vis-row kn-vis-hidden' : 'kn-vis-row'}
                >
                  <span className={s.hiddenForAgent ? 'corpus-dot' : 'corpus-dot corpus-dot-on'} />
                  <strong className="small">{s.displayName}</strong>
                  <span className="small muted mono">{s.kind}</span>
                  <span className="small muted">
                    {s.hiddenForAgent
                      ? t('agentKnowledgeView.hidden')
                      : t('agentKnowledgeView.visible')}{' '}
                    · {s.status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="kn-visibility-block">
            <div className="small" style={{ fontWeight: 600 }}>
              {t('agentKnowledgeView.projectsMounted')}
              <span className="muted"> · {vis.assignedProjects.length}</span>
            </div>
            {vis.assignedProjects.length === 0 && (
              <div className="kn-warn small">{t('agentKnowledgeView.noMountedProjects')}</div>
            )}
            <div className="kn-list">
              {vis.assignedProjects.map((p) => (
                <div key={p.projectKey} className="kn-vis-project">
                  <div className="kn-vis-row">
                    <span className="corpus-dot corpus-dot-on" />
                    <strong className="small">{p.displayName || p.projectKey}</strong>
                    <span className="small muted mono">{p.projectKey}</span>
                    <span className="small muted">
                      {t('agentKnowledgeView.sourceCount', { count: p.sourceCount })}
                    </span>
                    {onOpenProject && (
                      <button
                        type="button"
                        className="btn-ghost small"
                        onClick={() => onOpenProject(p.projectKey)}
                      >
                        {t('agentKnowledgeView.openProject')}
                      </button>
                    )}
                  </div>
                  <div className="kn-vis-sources">
                    {p.sources.map((s) => (
                      <div key={s.id} className="small muted mono">
                        · {s.displayName} <span className="status-neutral">({s.status})</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="kn-visibility-block">
            <div className="small muted" style={{ fontWeight: 600 }}>
              {t('agentKnowledgeView.projectsUnmounted')}
            </div>
            {vis.unassignedProjects.length === 0 && (
              <div className="small muted">{t('agentKnowledgeView.none')}</div>
            )}
            <div className="kn-list">
              {vis.unassignedProjects.map((p) => (
                <div key={p.projectKey} className="kn-vis-row kn-vis-hidden">
                  <span className="corpus-dot" />
                  <span className="small">{p.displayName || p.projectKey}</span>
                  <span className="small muted mono">{p.projectKey}</span>
                  <span className="small muted">
                    {t('agentKnowledgeView.sourceCount', { count: p.sourceCount })}
                    {p.assignedAgentIds.length > 0
                      ? ` · ${t('agentKnowledgeView.mountedTo', {
                          agents: p.assignedAgentIds.join(', '),
                        })}`
                      : ` · ${t('agentKnowledgeView.notMountedAnywhere')}`}
                  </span>
                  {onOpenProject && (
                    <button
                      type="button"
                      className="btn-ghost small"
                      onClick={() => onOpenProject(p.projectKey)}
                    >
                      {t('agentKnowledgeView.openProject')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="small muted">{t('agentKnowledgeView.footerHint')}</div>
        </>
      )}
    </section>
  );
}
