/**
 * 会话 composer「语料」快挂 — 本会话 overlay 默认；跨会话显式升级
 * 规格：arch/knowledge-admin-ui.md §2.3
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OctopiClient, type KnowledgeSessionVisibilityItemDto } from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, getRegistryToken } from '../console-key';
import { useT } from '../i18n/react';

interface ProjectRow {
  projectKey: string;
  displayName?: string;
  sourceCount: number;
  assignedAgentIds: string[];
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
  const client = useMemo(
    () => new OctopiClient({ baseUrl: resolveDefaultBase(), apiKey: getConsoleKey() || undefined, registryToken: getRegistryToken() || undefined }),
    [],
  );
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [overrides, setOverrides] = useState<KnowledgeSessionVisibilityItemDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

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
      ? t('sessionCorpusMenu.chipLabelSources', {
          count: projectVisibleCount,
          sources: sourceOverrides.length,
        })
      : t('sessionCorpusMenu.chipLabel', { count: projectVisibleCount });

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
        onToast?.(t('sessionCorpusMenu.restoredDefault', { project: projectKey }));
      } else {
        await client.setKnowledgeSessionVisibility(agentId, {
          sessionId,
          targetType: 'project',
          targetId: projectKey,
          op,
        });
        onToast?.(
          op === 'include'
            ? t('sessionCorpusMenu.includedToast', { project: projectKey })
            : t('sessionCorpusMenu.excludedToast', { project: projectKey }),
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
      onToast?.(
        t('sessionCorpusMenu.clearedSourceOverlay', { target: targetId.slice(0, 12) }),
      );
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
          ? t('sessionCorpusMenu.mountedToAgent', { project: projectKey, agent: agentId })
          : t('sessionCorpusMenu.unmountedFromAgent', { agent: agentId, project: projectKey }),
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
        title={t('sessionCorpusMenu.chipTitle')}
      >
        {chipLabel}
      </button>
      {open && (
        <div className="corpus-popover panel">
          <div className="corpus-popover-title small">
            {t('sessionCorpusMenu.popoverTitle')}
            <button type="button" className="btn-ghost small" onClick={() => setOpen(false)}>
              {t('sessionCorpusMenu.close')}
            </button>
          </div>
          {error && <div className="kn-error small">{error}</div>}
          <div className="corpus-list">
            {effective.length === 0 && (
              <div className="small muted">{t('sessionCorpusMenu.noProjects')}</div>
            )}
            {effective.map((p) => (
              <div key={p.projectKey} className="corpus-row">
                <div className="corpus-row-main">
                  <span className={p.visible ? 'corpus-dot corpus-dot-on' : 'corpus-dot'} />
                  <div>
                    <div>
                      <strong>{p.displayName || p.projectKey}</strong>
                      <span className="small muted">
                        {p.state === 'default' &&
                          (p.mounted
                            ? t('sessionCorpusMenu.defaultMounted')
                            : t('sessionCorpusMenu.defaultHidden'))}
                        {p.state === 'session-include' &&
                          t('sessionCorpusMenu.sessionInclude')}
                        {p.state === 'session-exclude' &&
                          t('sessionCorpusMenu.sessionExclude')}
                      </span>
                    </div>
                    <div className="small muted mono">
                      {p.projectKey} ·{' '}
                      {t('sessionCorpusMenu.sourceCount', { count: p.sourceCount })}
                    </div>
                  </div>
                </div>
                <div className="corpus-row-actions">
                  {p.state === 'default' && !p.visible && (
                    <button type="button" className="btn-secondary small" onClick={() => void setOverlay(p.projectKey, 'include')}>
                      {t('sessionCorpusMenu.sessionInclude')}
                    </button>
                  )}
                  {p.state === 'default' && p.visible && (
                    <button type="button" className="btn-ghost small" onClick={() => void setOverlay(p.projectKey, 'exclude')}>
                      {t('sessionCorpusMenu.sessionExclude')}
                    </button>
                  )}
                  {p.state !== 'default' && (
                    <button type="button" className="btn-ghost small" onClick={() => void setOverlay(p.projectKey, null)}>
                      {t('sessionCorpusMenu.restoreDefault')}
                    </button>
                  )}
                  {!p.mounted ? (
                    <button
                      type="button"
                      className="btn-ghost small"
                      onClick={() => void escalateToAgent(p.projectKey, true)}
                    >
                      {t('sessionCorpusMenu.mountToAgent')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-ghost small"
                      onClick={() => void escalateToAgent(p.projectKey, false)}
                    >
                      {t('sessionCorpusMenu.unmountFromAgent')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {sourceOverrides.length > 0 && (
            <div className="corpus-source-ov">
              <div className="small" style={{ fontWeight: 600 }}>
                {t('sessionCorpusMenu.sourceOverlayTitle')}
              </div>
              {sourceOverrides.map((o) => (
                <div key={`${o.targetType}:${o.targetId}`} className="corpus-row">
                  <div className="corpus-row-main">
                    <span className="small mono">
                      {o.targetId.slice(0, 16)}…
                    </span>
                    <span className="small muted">
                      {o.op === 'include'
                        ? t('sessionCorpusMenu.sessionInclude')
                        : t('sessionCorpusMenu.sessionExclude')}
                      {t('sessionCorpusMenu.sourceLevel')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost small"
                    onClick={() => void clearSourceOverlay(o.targetId)}
                  >
                    {t('sessionCorpusMenu.clear')}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="corpus-foot small muted">{t('sessionCorpusMenu.footerHint')}</div>
        </div>
      )}
    </div>
  );
}
