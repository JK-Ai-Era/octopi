/**
 * 会话 composer「语料」快挂 — 本会话 overlay 默认；跨会话显式升级
 * 规格：arch/knowledge-admin-ui.md §2.3
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OctopiClient, type KnowledgeSessionVisibilityItemDto } from '../../../src/integration/web/sdk/client';

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

export function SessionCorpusMenu({
  agentId,
  sessionId,
  onToast,
}: {
  agentId: string;
  sessionId: string | null;
  onToast?: (msg: string) => void;
}) {
  const client = useMemo(() => new OctopiClient({ baseUrl: resolveDefaultBase() }), []);
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [overrides, setOverrides] = useState<KnowledgeSessionVisibilityItemDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      setError(null);
      const [projs, vis] = await Promise.all([
        client.listKnowledgeProjects(agentId),
        client.getKnowledgeSessionVisibility(agentId, sessionId),
      ]);
      setProjects(projs);
      setOverrides(vis);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId, client, sessionId]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!sessionId) return null;

  const projectOverrides = overrides.filter((o) => o.targetType === 'project');
  const sourceOverrides = overrides.filter((o) => o.targetType === 'source');

  const overrideFor = (projectKey: string) =>
    projectOverrides.find((o) => o.targetId === projectKey);

  /** effective：base(已挂载) ⊕ project overlay（source 级另列） */
  const effective = projects.map((p) => {
    const mounted = p.assignedAgentIds.includes(agentId);
    const ov = overrideFor(p.projectKey);
    let state: 'default' | 'session-include' | 'session-exclude' = 'default';
    let visible = mounted;
    if (ov?.op === 'include') {
      state = 'session-include';
      visible = true;
    } else if (ov?.op === 'exclude') {
      state = 'session-exclude';
      visible = false;
    }
    return { ...p, mounted, state, visible, ov };
  });

  const projectVisibleCount = effective.filter((e) => e.visible).length;
  const chipLabel =
    sourceOverrides.length > 0
      ? `语料 ${projectVisibleCount} · 源级 ${sourceOverrides.length}`
      : `语料 ${projectVisibleCount}`;

  const setOverlay = async (
    projectKey: string,
    op: 'include' | 'exclude' | null,
  ) => {
    if (!sessionId) return;
    try {
      if (op == null) {
        await client.clearKnowledgeSessionVisibility(agentId, sessionId, {
          targetType: 'project',
          targetId: projectKey,
        });
        onToast?.(`已恢复「${projectKey}」默认可见性`);
      } else {
        await client.setKnowledgeSessionVisibility(agentId, {
          sessionId,
          targetType: 'project',
          targetId: projectKey,
          op,
        });
        onToast?.(
          op === 'include'
            ? `已附加 ${projectKey}（仅本会话）`
            : `本会话排除 ${projectKey}`,
        );
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const clearSourceOverlay = async (targetId: string) => {
    if (!sessionId) return;
    try {
      await client.clearKnowledgeSessionVisibility(agentId, sessionId, {
        targetType: 'source',
        targetId,
      });
      onToast?.(`已清除源级 overlay ${targetId.slice(0, 12)}…`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * 跨会话升级：改 Agent 挂载后清除本场 project overlay
   * （include 与新 base 重复；exclude 也不再需要），避免状态叠写。
   */
  const escalateToAgent = async (projectKey: string, mount: boolean) => {
    try {
      await client.setKnowledgeVisibility(agentId, {
        op: mount ? 'assignProject' : 'unassignProject',
        projectKey,
      });
      try {
        await client.clearKnowledgeSessionVisibility(agentId, sessionId, {
          targetType: 'project',
          targetId: projectKey,
        });
      } catch {
        // 无 overlay 时忽略
      }
      onToast?.(
        mount
          ? `已挂载 ${projectKey} → ${agentId}（跨会话；已清本场 project 调整）`
          : `已从 ${agentId} 卸载 ${projectKey}（跨会话；已清本场 project 调整）`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="corpus-chip-wrap">
      <button
        type="button"
        className={open ? 'btn-tab btn-tab-active corpus-chip' : 'btn-tab corpus-chip'}
        onClick={() => setOpen((v) => !v)}
        title="本会话语料（项目快挂）"
      >
        {chipLabel}
      </button>
      {open && (
        <div className="corpus-popover panel">
          <div className="corpus-popover-title small">
            本会话可见（effective）
            <button type="button" className="btn-ghost small" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>
          {error && <div className="kn-error small">{error}</div>}
          <div className="corpus-list">
            {effective.length === 0 && (
              <div className="small muted">尚无项目。请先到知识库创建项目。</div>
            )}
            {effective.map((p) => (
              <div key={p.projectKey} className="corpus-row">
                <div className="corpus-row-main">
                  <span className={p.visible ? 'corpus-dot corpus-dot-on' : 'corpus-dot'} />
                  <div>
                    <div>
                      <strong>{p.displayName || p.projectKey}</strong>
                      <span className="small muted">
                        {p.state === 'default' && (p.mounted ? '默认（项目已挂）' : '默认不可见')}
                        {p.state === 'session-include' && '本会话附加'}
                        {p.state === 'session-exclude' && '本会话排除'}
                      </span>
                    </div>
                    <div className="small muted mono">{p.projectKey} · {p.sourceCount} 源</div>
                  </div>
                </div>
                <div className="corpus-row-actions">
                  {p.state === 'default' && !p.visible && (
                    <button type="button" className="btn-secondary small" onClick={() => void setOverlay(p.projectKey, 'include')}>
                      本会话附加
                    </button>
                  )}
                  {p.state === 'default' && p.visible && (
                    <button type="button" className="btn-ghost small" onClick={() => void setOverlay(p.projectKey, 'exclude')}>
                      本会话排除
                    </button>
                  )}
                  {p.state !== 'default' && (
                    <button type="button" className="btn-ghost small" onClick={() => void setOverlay(p.projectKey, null)}>
                      恢复默认
                    </button>
                  )}
                  {!p.mounted ? (
                    <button
                      type="button"
                      className="btn-ghost small"
                      onClick={() => void escalateToAgent(p.projectKey, true)}
                    >
                      挂到 Agent
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-ghost small"
                      onClick={() => void escalateToAgent(p.projectKey, false)}
                    >
                      从 Agent 卸载
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {sourceOverrides.length > 0 && (
            <div className="corpus-source-ov">
              <div className="small" style={{ fontWeight: 600 }}>
                源级 overlay（优先于项目）
              </div>
              {sourceOverrides.map((o) => (
                <div key={`${o.targetType}:${o.targetId}`} className="corpus-row">
                  <div className="corpus-row-main">
                    <span className="small mono">
                      {o.targetId.slice(0, 16)}…
                    </span>
                    <span className="small muted">
                      {o.op === 'include' ? '本会话附加' : '本会话排除'}（source 级）
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost small"
                    onClick={() => void clearSourceOverlay(o.targetId)}
                  >
                    清除
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="corpus-foot small muted">
            本场调整只影响当前会话；「挂到 / 卸载 Agent」为跨会话，会清除该项目的本场 project 调整。
          </div>
        </div>
      )}
    </div>
  );
}
