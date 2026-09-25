/**
 * Agent 知识视野 — 只读辅视图（base，不含会话 overlay）
 * 改挂载请到项目详情；本视图只回答「它现在能看到什么」。
 * 规格：arch/knowledge-admin-ui.md §2.2
 */
import { useCallback, useEffect, useState } from 'react';
import { OctopiClient, type KnowledgeSourceDto } from '../../../src/integration/web/sdk/client';

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
        <h2>Agent 知识视野</h2>
        <span className="small muted">只读 · base（不含本会话 overlay）· 改挂载请到项目详情</span>
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
          刷新
        </button>
      </div>

      {error && <div className="kn-error small">{error}</div>}
      {!vis && !error && <div className="small muted">加载中…</div>}

      {vis && (
        <>
          <div className="kn-visibility-block">
            <div className="small" style={{ fontWeight: 600 }}>
              公共知识库
              <span className="muted">
                {' '}
                · 可见 {vis.globalSources.filter((s) => !s.hiddenForAgent).length} /{' '}
                {vis.globalSources.length}
              </span>
            </div>
            {vis.globalSources.length === 0 && (
              <div className="small muted">无公共源</div>
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
                    {s.hiddenForAgent ? '已隐藏' : '可见'} · {s.status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="kn-visibility-block">
            <div className="small" style={{ fontWeight: 600 }}>
              项目（已挂载）
              <span className="muted"> · {vis.assignedProjects.length}</span>
            </div>
            {vis.assignedProjects.length === 0 && (
              <div className="kn-warn small">
                未挂载任何项目。到「项目」详情勾选挂载后，这里会显示。
              </div>
            )}
            <div className="kn-list">
              {vis.assignedProjects.map((p) => (
                <div key={p.projectKey} className="kn-vis-project">
                  <div className="kn-vis-row">
                    <span className="corpus-dot corpus-dot-on" />
                    <strong className="small">{p.displayName || p.projectKey}</strong>
                    <span className="small muted mono">{p.projectKey}</span>
                    <span className="small muted">{p.sourceCount} 源</span>
                    {onOpenProject && (
                      <button
                        type="button"
                        className="btn-ghost small"
                        onClick={() => onOpenProject(p.projectKey)}
                      >
                        去项目详情
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
              项目（未挂载 · 本 Agent 不可见）
            </div>
            {vis.unassignedProjects.length === 0 && (
              <div className="small muted">无</div>
            )}
            <div className="kn-list">
              {vis.unassignedProjects.map((p) => (
                <div key={p.projectKey} className="kn-vis-row kn-vis-hidden">
                  <span className="corpus-dot" />
                  <span className="small">{p.displayName || p.projectKey}</span>
                  <span className="small muted mono">{p.projectKey}</span>
                  <span className="small muted">
                    {p.sourceCount} 源
                    {p.assignedAgentIds.length > 0
                      ? ` · 已挂 ${p.assignedAgentIds.join(', ')}`
                      : ' · 全局未挂载'}
                  </span>
                  {onOpenProject && (
                    <button
                      type="button"
                      className="btn-ghost small"
                      onClick={() => onOpenProject(p.projectKey)}
                    >
                      去项目详情
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="small muted">
            会话内附加/排除请用 composer「语料」；此处仅展示 Agent 级 base。
          </div>
        </>
      )}
    </section>
  );
}
