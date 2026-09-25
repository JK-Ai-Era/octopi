/**
 * Knowledge 管理面 — 公共知识库 / 项目 两级注册
 * 规格：arch/knowledge-admin-ui.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OctopiClient,
  type KnowledgeSourceDto,
} from '../../../src/integration/web/sdk/client';
import { SourceDetailPanel } from './SourceDetailPanel';
import { AgentKnowledgeView } from './AgentKnowledgeView';

type Panel = 'global' | 'projects' | 'agents' | 'search';

interface ProjectRow {
  projectKey: string;
  displayName?: string;
  sourceCount: number;
  assignedAgentIds: string[];
}

function resolveDefaultBase(): string {
  const fromEnv = (import.meta.env.VITE_OCTOPI_BASE as string | undefined)?.replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:3000`;
  }
  return 'http://localhost:3000';
}

function statusClass(status: string): string {
  if (status === 'ready') return 'status-ok';
  if (status === 'partial' || status === 'discovering' || status === 'indexing') return 'status-warn';
  if (status === 'error') return 'status-error';
  return 'status-neutral';
}

function SourceRow({
  client,
  agentId,
  agents,
  source,
  onReindex,
  onDelete,
  onPatch,
  onChanged,
  extra,
}: {
  client: OctopiClient;
  agentId: string;
  agents: string[];
  source: KnowledgeSourceDto;
  onReindex: () => void;
  onDelete: () => void;
  onPatch: (patch: Record<string, unknown>) => void;
  onChanged?: () => void;
  extra?: React.ReactNode;
}) {
  const [desc, setDesc] = useState(source.description ?? '');
  const [open, setOpen] = useState(false);
  const [hideOpen, setHideOpen] = useState(false);
  useEffect(() => setDesc(source.description ?? ''), [source.description]);

  const isGlobal = source.scopeRef.level === 'global';

  return (
    <div className="kn-source-row">
      <div className="kn-source-main">
        <div className="kn-source-title">
          <button
            type="button"
            className="btn-ghost small kn-expand"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? '▾' : '▸'}
          </button>
          <strong>{source.displayName}</strong>
          <span className={`small ${statusClass(source.status)}`}>{source.status}</span>
          <span className="small muted mono">{source.kind}</span>
          {source.coverage != null && (
            <span className="small muted">coverage {Math.round(source.coverage * 100)}%</span>
          )}
        </div>
        <div className="small mono muted">{source.location}</div>
        <div className="kn-source-desc">
          <input
            value={desc}
            placeholder="人工描述（权威，覆盖自动摘要）"
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => {
              const next = desc.trim();
              const prev = source.description ?? '';
              if (next !== prev) onPatch({ description: next ? next : null });
            }}
          />
          {!source.description && source.generatedDescription && (
            <div className="small muted">
              自动：{source.generatedDescription.slice(0, 80)}
            </div>
          )}
        </div>
        {isGlobal && (
          <div className="kn-hide">
            <button
              type="button"
              className="btn-ghost small"
              onClick={() => setHideOpen((v) => !v)}
            >
              {hideOpen ? '收起隐藏名单' : '对 Agent 隐藏…'}
            </button>
            {hideOpen && (
              <GlobalHideList
                client={client}
                agents={agents}
                sourceId={source.id}
                onChanged={onChanged}
              />
            )}
          </div>
        )}
        {extra}
        {open && (
          <SourceDetailPanel
            client={client}
            agentId={agentId}
            sourceId={source.id}
            onChanged={onChanged}
          />
        )}
      </div>
      <div className="kn-source-actions">
        <button type="button" className="btn-secondary small" onClick={onReindex}>
          重建索引
        </button>
        <button type="button" className="btn-ghost small" onClick={onDelete}>
          卸载
        </button>
      </div>
    </div>
  );
}

/** 公共库源：对 Agent 隐藏 / 取消隐藏 */
function GlobalHideList({
  client,
  agents,
  sourceId,
  onChanged,
}: {
  client: OctopiClient;
  agents: string[];
  sourceId: string;
  onChanged?: () => void;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setErr(null);
      // 复用 visibility 摘要：hiddenSourceIds 不含 per-source；用 detail
      const detail = await client.getKnowledgeSourceDetail('default', sourceId);
      setHidden(new Set(detail?.hiddenForAgentIds ?? []));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [client, sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (agent: string, isHidden: boolean) => {
    try {
      setErr(null);
      await client.setKnowledgeVisibility(agent, {
        op: isHidden ? 'unhide' : 'hide',
        sourceId,
      });
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="kn-hide-list">
      {err && <div className="small status-error">{err}</div>}
      {agents.map((a) => {
        const isHidden = hidden.has(a);
        return (
          <label key={a} className="kn-mount-item">
            <input
              type="checkbox"
              checked={isHidden}
              onChange={() => void toggle(a, isHidden)}
            />
            <span className="mono">{a}</span>
            <span className="small muted">{isHidden ? '已隐藏' : '可见'}</span>
          </label>
        );
      })}
      {agents.length === 0 && <div className="small muted">无已注册 Agent</div>}
    </div>
  );
}

export function KnowledgeAdminPanel({ agentId }: { agentId: string }) {
  const client = useMemo(() => new OctopiClient({ baseUrl: resolveDefaultBase() }), []);
  const [panel, setPanel] = useState<Panel>('global');
  const [globalSources, setGlobalSources] = useState<KnowledgeSourceDto[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [projectSources, setProjectSources] = useState<KnowledgeSourceDto[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newProjectKey, setNewProjectKey] = useState('');
  const [newSource, setNewSource] = useState({
    kind: 'directory',
    location: '',
    displayName: '',
    description: '',
  });
  const [searchQ, setSearchQ] = useState('');
  const [searchHits, setSearchHits] = useState<
    Array<{ sourceId: string; path: string; startLine: number; endLine: number; score: number; snippet: string }>
  >([]);
  const [searchMeta, setSearchMeta] = useState<string>('');
  const [stats, setStats] = useState<Record<string, number>>({});
  const [progress, setProgress] = useState<{
    sourceId: string;
    path?: string;
    status: string;
    detail?: string;
  } | null>(null);
  const [selectedAgentView, setSelectedAgentView] = useState(agentId);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [globals, projs, agentList, st] = await Promise.all([
        client.listKnowledgeSources(agentId, { scopeLevel: 'global' }),
        client.listKnowledgeProjects(agentId),
        client.getAgents(),
        client.getKnowledgeStats(agentId),
      ]);
      setGlobalSources(globals);
      setProjects(projs);
      setAgents(agentList.map((a) => a.id));
      setStats(st);
      if (selectedProject) {
        const ps = await client.listKnowledgeSources(agentId, {
          scopeLevel: 'project',
          projectKey: selectedProject,
        });
        setProjectSources(ps);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId, client, selectedProject]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // WS：knowledge.index.progress（系统级）
  useEffect(() => {
    client.on({
      onEvent: (_sid, event) => {
        if (event.type !== 'knowledge.index.progress') return;
        const d = (event.data ?? {}) as {
          sourceId?: string;
          path?: string;
          status?: string;
          detail?: string;
        };
        setProgress({
          sourceId: d.sourceId ?? '',
          path: d.path,
          status: d.status ?? '',
          detail: d.detail,
        });
        void refreshRef.current();
      },
    });
    client.connect();
    return () => {
      client.disconnect();
    };
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActiveIndexing = useMemo(() => {
    const all = [...globalSources, ...projectSources];
    return (
      all.some((s) =>
        s.status === 'pending' || s.status === 'discovering' || s.status === 'partial',
      ) ||
      (stats.jobsQueued ?? 0) > 0 ||
      (stats.jobsRunning ?? 0) > 0
    );
  }, [globalSources, projectSources, stats]);

  useEffect(() => {
    if (!hasActiveIndexing) return;
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [hasActiveIndexing, refresh]);

  const registerSource = async (scope: { level: 'global' | 'project'; key: string }) => {
    if (!newSource.location.trim()) return;
    setBusy(true);
    try {
      await client.createKnowledgeSource(agentId, {
        kind: newSource.kind,
        location: newSource.location.trim(),
        scopeRef: scope,
        displayName: newSource.displayName.trim() || undefined,
        description: newSource.description.trim() || undefined,
      });
      setNewSource({ kind: 'directory', location: '', displayName: '', description: '' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const patchSource = async (sourceId: string, patch: Record<string, unknown>) => {
    try {
      await client.updateKnowledgeSource(agentId, sourceId, patch);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleMount = async (projectKey: string, mounted: boolean) => {
    try {
      await client.setKnowledgeVisibility(agentId, {
        op: mounted ? 'unassignProject' : 'assignProject',
        projectKey,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selected = projects.find((p) => p.projectKey === selectedProject);

  return (
    <div className="kn-admin">
      <div className="kn-admin-nav">
        <button
          type="button"
          className={panel === 'global' ? 'btn-tab btn-tab-active' : 'btn-tab'}
          onClick={() => setPanel('global')}
        >
          公共知识库
        </button>
        <button
          type="button"
          className={panel === 'projects' ? 'btn-tab btn-tab-active' : 'btn-tab'}
          onClick={() => setPanel('projects')}
        >
          项目
        </button>
        <button
          type="button"
          className={panel === 'agents' ? 'btn-tab btn-tab-active' : 'btn-tab'}
          onClick={() => setPanel('agents')}
        >
          Agent 视野
        </button>
        <button
          type="button"
          className={panel === 'search' ? 'btn-tab btn-tab-active' : 'btn-tab'}
          onClick={() => setPanel('search')}
        >
          试搜
        </button>
      </div>

      {error && <div className="kn-error">{error}</div>}

      <div className="kn-stats small muted mono">
        sources {stats.sources ?? 0} · files {stats.files ?? 0} · chunks {stats.chunks ?? 0}
        {' · '}
        queue {stats.jobsQueued ?? 0} / running {stats.jobsRunning ?? 0}
        {hasActiveIndexing && <span className="status-warn"> · indexing…</span>}
      </div>

      {progress && (
        <div className="kn-progress small">
          <span className="status-warn">索引</span>
          <span className="mono">{progress.sourceId}</span>
          {progress.path && <span className="mono muted">{progress.path}</span>}
          <span>{progress.status}</span>
          {progress.detail && <span className="muted">{progress.detail}</span>}
          <button type="button" className="btn-ghost small" onClick={() => setProgress(null)}>
            清除
          </button>
        </div>
      )}

      {panel === 'global' && (
        <section className="panel kn-panel">
          <header className="kn-panel-header">
            <h2>公共知识库</h2>
            <span className="small muted">全局源 · 默认全员可见 · 可对 Agent 隐藏</span>
          </header>

          <div className="kn-register">
            <strong className="small">注册公共源</strong>
            <div className="kn-form-row">
              <select
                value={newSource.kind}
                onChange={(e) => setNewSource((s) => ({ ...s, kind: e.target.value }))}
              >
                <option value="directory">directory</option>
                <option value="file">file</option>
                <option value="workspace">workspace</option>
                <option value="url">url</option>
                <option value="connector">connector</option>
              </select>
              <input
                placeholder="location（路径 / URL）"
                value={newSource.location}
                onChange={(e) => setNewSource((s) => ({ ...s, location: e.target.value }))}
              />
              <input
                placeholder="displayName"
                value={newSource.displayName}
                onChange={(e) => setNewSource((s) => ({ ...s, displayName: e.target.value }))}
              />
              <button
                type="button"
                className="btn-primary small"
                disabled={busy || !newSource.location.trim()}
                onClick={() => registerSource({ level: 'global', key: 'global' })}
              >
                注册
              </button>
            </div>
          </div>

          <div className="kn-list">
            {globalSources.length === 0 && (
              <div className="small muted">尚无公共源。注册后 agent 默认可见。</div>
            )}
            {globalSources.map((s) => (
              <SourceRow
                key={s.id}
                client={client}
                agentId={agentId}
                agents={agents}
                source={s}
                onReindex={() => {
                  void client.reindexKnowledgeSource(agentId, s.id).then(refresh);
                }}
                onDelete={() => {
                  if (confirm(`卸载「${s.displayName}」？会清索引与使用痕迹。`)) {
                    void client.deleteKnowledgeSource(agentId, s.id).then(refresh);
                  }
                }}
                onPatch={(patch) => void patchSource(s.id, patch)}
                onChanged={refresh}
              />
            ))}
          </div>
        </section>
      )}

      {panel === 'projects' && (
        <div className="kn-projects-layout">
          <section className="panel kn-panel kn-project-list">
            <header className="kn-panel-header">
              <h2>项目</h2>
              <span className="small muted">先建项目，再挂源；挂载后 Agent 可见</span>
            </header>
            <div className="kn-form-row">
              <input
                placeholder="projectKey"
                value={newProjectKey}
                onChange={(e) => setNewProjectKey(e.target.value)}
              />
              <button
                type="button"
                className="btn-secondary small"
                disabled={!newProjectKey.trim()}
                onClick={() => {
                  const key = newProjectKey.trim();
                  void client
                    .createKnowledgeProject(agentId, key)
                    .then(() => {
                      setNewProjectKey('');
                      setSelectedProject(key);
                      return refresh();
                    })
                    .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                }}
              >
                新建项目
              </button>
            </div>
            <div className="kn-list">
              {projects.length === 0 && (
                <div className="small muted">尚无项目。先建项目再挂源。</div>
              )}
              {projects.map((p) => (
                <button
                  key={p.projectKey}
                  type="button"
                  className={
                    selectedProject === p.projectKey
                      ? 'kn-project-item kn-project-item-active'
                      : 'kn-project-item'
                  }
                  onClick={() => setSelectedProject(p.projectKey)}
                >
                  <div>
                    <strong>{p.displayName || p.projectKey}</strong>
                    <div className="small muted mono">{p.projectKey}</div>
                  </div>
                  <div className="small muted">
                    {p.sourceCount} 源 · {p.assignedAgentIds.length > 0 ? `可见于 ${p.assignedAgentIds.join(', ')}` : '未挂载'}
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="panel kn-panel">
            {!selected && (
              <div className="kn-empty small muted">选择左侧项目，查看源与挂载。</div>
            )}
            {selected && (
              <>
                <header className="kn-panel-header">
                  <h2>{selected.displayName || selected.projectKey}</h2>
                  <span className="small muted mono">{selected.projectKey}</span>
                </header>

                <div className="kn-mount">
                  <strong className="small">挂载给 Agent</strong>
                  {selected.assignedAgentIds.length === 0 && (
                    <div className="kn-warn small">
                      尚未挂载给任何 Agent，当前无人可见。只挂给一个 Agent = 该 Agent 独享。
                    </div>
                  )}
                  <div className="kn-mount-list">
                    {agents.map((a) => {
                      const mounted = selected.assignedAgentIds.includes(a);
                      return (
                        <label key={a} className="kn-mount-item">
                          <input
                            type="checkbox"
                            checked={mounted}
                            onChange={() => void toggleMount(selected.projectKey, mounted)}
                          />
                          <span className="mono">{a}</span>
                          <span className="small muted">{mounted ? '已挂载' : '未挂载'}</span>
                        </label>
                      );
                    })}
                    {agents.length === 0 && <div className="small muted">无已注册 Agent</div>}
                  </div>
                </div>

                <div className="kn-register">
                  <strong className="small">项目源</strong>
                  <div className="kn-form-row">
                    <select
                      value={newSource.kind}
                      onChange={(e) => setNewSource((s) => ({ ...s, kind: e.target.value }))}
                    >
                      <option value="directory">directory</option>
                      <option value="file">file</option>
                      <option value="workspace">workspace</option>
                      <option value="url">url</option>
                      <option value="connector">connector</option>
                    </select>
                    <input
                      placeholder="location"
                      value={newSource.location}
                      onChange={(e) => setNewSource((s) => ({ ...s, location: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="btn-primary small"
                      disabled={busy || !newSource.location.trim()}
                      onClick={() =>
                        registerSource({ level: 'project', key: selected.projectKey })
                      }
                    >
                      注册到本项目
                    </button>
                  </div>
                </div>

                <div className="kn-list">
                  {projectSources.length === 0 && (
                    <div className="small muted">本项目尚无源。</div>
                  )}
                  {projectSources.map((s) => (
                    <SourceRow
                      key={s.id}
                      client={client}
                      agentId={agentId}
                      agents={agents}
                      source={s}
                      onReindex={() => {
                        void client.reindexKnowledgeSource(agentId, s.id).then(refresh);
                      }}
                      onDelete={() => {
                        if (confirm(`卸载「${s.displayName}」？会清索引与使用痕迹。`)) {
                          void client.deleteKnowledgeSource(agentId, s.id).then(refresh);
                        }
                      }}
                      onPatch={(patch) => void patchSource(s.id, patch)}
                      onChanged={refresh}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {panel === 'agents' && (
        <AgentKnowledgeView
          client={client}
          agents={agents}
          selectedAgentId={selectedAgentView || agentId}
          onSelectAgent={setSelectedAgentView}
          onOpenProject={(key) => {
            setSelectedProject(key);
            setPanel('projects');
            void refresh();
          }}
        />
      )}

      {panel === 'search' && (
        <section className="panel kn-panel">
          <header className="kn-panel-header">
            <h2>试搜</h2>
            <span className="small muted">宿主直搜 · effective view · 命中带溯源</span>
          </header>
          <div className="kn-form-row">
            <input
              placeholder="查询关键词"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void client
                    .searchKnowledge(agentId, searchQ, { limit: 8 })
                    .then((r) => {
                      setSearchHits(r.hits);
                      setSearchMeta(
                        `hits=${r.hits.length} · vector=${r.usedVector ? 'on' : 'off'} · coverage=${Math.round((r.coverage ?? 0) * 100)}%`,
                      );
                    })
                    .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                }
              }}
            />
            <button
              type="button"
              className="btn-primary small"
              onClick={() => {
                void client
                  .searchKnowledge(agentId, searchQ, { limit: 8 })
                  .then((r) => {
                    setSearchHits(r.hits);
                    setSearchMeta(
                      `hits=${r.hits.length} · vector=${r.usedVector ? 'on' : 'off'} · coverage=${Math.round((r.coverage ?? 0) * 100)}%`,
                    );
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : String(err)));
              }}
            >
              搜索
            </button>
          </div>
          {searchMeta && <div className="small muted mono">{searchMeta}</div>}
          <div className="kn-list">
            {searchHits.map((h, i) => (
              <div key={`${h.sourceId}-${h.path}-${i}`} className="kn-hit">
                <div className="small mono">
                  {h.path}:{h.startLine}-{h.endLine} · score {h.score.toFixed(3)}
                </div>
                <pre className="kn-hit-snippet">{h.snippet}</pre>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
