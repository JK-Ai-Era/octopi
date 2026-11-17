/**
 * 源详情诊断 — 索引文件（状态/类型筛选 + 分页）+ chunk 预览
 * 规格：arch/knowledge-admin-ui.md（进得去吗）
 */
import { useCallback, useEffect, useState } from 'react';
import {
  OctopiClient,
  type KnowledgeSourceDetailDto,
} from '@octopi-agent/gateway/web/sdk/client';
import { OpFeedback, useOpFeedback } from './OpFeedback';
import { DescriptionSourceBadge } from './DescriptionSourceBadge';
import { useT } from '../i18n/react';

interface FileRow {
  path: string;
  status: string;
  chunkCount: number;
  error?: string;
  size: number;
  ext: string;
}

interface ChunkRow {
  id: string;
  path: string;
  text: string;
  startLine: number;
  endLine: number;
}

type StatusFilter = 'all' | 'indexed' | 'skipped' | 'error';

export function SourceDetailPanel({
  client,
  agentId,
  sourceId,
}: {
  client: OctopiClient;
  agentId: string;
  sourceId: string;
  onChanged?: () => void;
}) {
  const [detail, setDetail] = useState<KnowledgeSourceDetailDto | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [extFilter, setExtFilter] = useState('all');
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [statusCounts, setStatusCounts] = useState({ indexed: 0, skipped: 0, error: 0 });
  const [extCounts, setExtCounts] = useState<Array<{ ext: string; n: number }>>([]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const { op, busy, show, run } = useOpFeedback();
  const t = useT();

  const loadDetail = useCallback(async () => {
    try {
      const d = await client.getKnowledgeSourceDetail(agentId, sourceId);
      setDetail(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId, client, sourceId]);

  const loadFiles = useCallback(async () => {
    setLoadingFiles(true);
    try {
      setError(null);
      const r = await client.listKnowledgeSourceFilesPaged(agentId, sourceId, {
        status: statusFilter,
        ext: extFilter,
        q: q || undefined,
        page,
        pageSize,
      });
      setFiles(r.items);
      setTotal(r.total);
      setStatusCounts(r.statusCounts);
      setExtCounts(r.extCounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFiles(false);
    }
  }, [agentId, client, extFilter, page, pageSize, q, sourceId, statusFilter]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  // 索引未就绪时轻量轮询（只刷详情/当前页）
  useEffect(() => {
    if (!detail) return;
    const active =
      detail.status === 'pending' ||
      detail.status === 'discovering' ||
      detail.status === 'partial';
    if (!active) return;
    const timer = setInterval(() => {
      void loadDetail();
      void loadFiles();
    }, 8000);
    return () => clearInterval(timer);
  }, [detail?.status, loadDetail, loadFiles]);

  // 筛选变化时回第 1 页
  useEffect(() => {
    setPage(1);
  }, [statusFilter, extFilter, q, pageSize]);

  const openFile = async (path: string) => {
    if (openPath === path) {
      setOpenPath(null);
      setChunks([]);
      return;
    }
    setOpenPath(path);
    try {
      const cs = await client.listKnowledgeChunks(agentId, sourceId, path);
      setChunks(cs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 轮询直到所选路径上的 parse 任务结束，再回报结果 */
  const watchPathsDone = useCallback(
    async (paths: string[], label: string) => {
      if (paths.length === 0) return;
      const deadline = Date.now() + 90_000;
      let last: Awaited<ReturnType<typeof client.getKnowledgePathJobStates>> = [];
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          last = await client.getKnowledgePathJobStates(agentId, sourceId, paths);
        } catch {
          continue;
        }
        const active = last.reduce((s, x) => s + x.jobsActive, 0);
        if (active === 0) break;
        show(t('sourceDetailPanel.processingPath', { label, active }), 'info');
      }
      await loadFiles();
      await loadDetail();
      const parts = last.slice(0, 3).map((x) => {
        const st =
          x.fileStatus ??
          (x.exists ? t('sourceDetailPanel.notIndexed') : t('sourceDetailPanel.cleaned'));
        const chunks = x.chunkCount
          ? t('sourceDetailPanel.chunkCountSuffix', { count: x.chunkCount })
          : '';
        return `${st}${chunks}${x.error ? `(${x.error})` : ''}`;
      });
      const more =
        last.length > 3 ? ` ${t('sourceDetailPanel.moreItems', { count: last.length })}` : '';
      const done = t('sourceDetailPanel.doneLabel', { label });
      show(
        parts.length
          ? `${done} → ${parts.join(t('sourceDetailPanel.itemSeparator'))}${more}`
          : done,
        'ok',
      );
    },
    [agentId, client, loadDetail, loadFiles, show, sourceId, t],
  );

  const reprocessOne = async (path: string) => {
    const name = path.split(/[\\/]/).pop() ?? path;
    await run(
      `one:${path}`,
      () => client.reprocessKnowledgeFiles(agentId, sourceId, { paths: [path] }),
      async (r) => {
        const cleaned = r.cleanedNonFiles ?? 0;
        if (cleaned > 0 && (r.queued ?? 0) === 0 && (r.alreadyActive ?? 0) === 0) {
          show(t('sourceDetailPanel.dirtyRowCleaned', { name }), 'ok');
          await loadFiles();
          await loadDetail();
          return;
        }
        const extra = r.resumed ? ` · ${t('sourceDetailPanel.autoResumed')}` : '';
        const already = r.alreadyActive ?? 0;
        if ((r.queued ?? 0) === 0 && already > 0) {
          show(t('sourceDetailPanel.alreadyQueued', { name }) + extra, 'info');
        } else {
          show(
            t('sourceDetailPanel.queuedReprocess', { name, count: r.queued }) + extra,
            'ok',
          );
        }
        void watchPathsDone([path], t('sourceDetailPanel.quotedName', { name }));
      },
    );
  };

  /** 轮询源级任务直到空闲（批量重做） */
  const watchSourceIdle = useCallback(
    async (label: string) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const d = await client.getKnowledgeSourceDetail(agentId, sourceId);
          const jc = d?.jobControl;
          const active = (jc?.jobsQueued ?? 0) + (jc?.jobsRunning ?? 0);
          if (active === 0) break;
          show(t('sourceDetailPanel.processingSource', { label, active }), 'info');
        } catch {
          /* 轮询失败继续 */
        }
      }
      await loadFiles();
      await loadDetail();
      show(t('sourceDetailPanel.doneSourceRefreshed', { label }), 'ok');
    },
    [agentId, client, loadDetail, loadFiles, show, sourceId, t],
  );

  const reprocessFiltered = async () => {
    const n = total;
    if (n <= 0) return;
    const label = [
      statusFilter !== 'all'
        ? t('sourceDetailPanel.filterStatusLabel', { status: statusFilter })
        : null,
      extFilter !== 'all' ? t('sourceDetailPanel.filterExtLabel', { ext: extFilter }) : null,
      q ? t('sourceDetailPanel.filterPathLabel', { q }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const tip = label
      ? t('sourceDetailPanel.filterTipWrapped', { label })
      : t('sourceDetailPanel.filterTipAll');
    if (!confirm(t('sourceDetailPanel.bulkConfirm', { count: n, tip }))) {
      return;
    }
    await run(
      'bulk',
      () =>
        client.reprocessKnowledgeFiles(agentId, sourceId, {
          filter: {
            status: statusFilter,
            ext: extFilter,
            q: q || undefined,
          },
        }),
      async (r) => {
        const extra = r.resumed ? ` · ${t('sourceDetailPanel.autoResumed')}` : '';
        const cleaned = r.cleanedNonFiles ?? 0;
        const already = r.alreadyActive ?? 0;
        const head = t('sourceDetailPanel.bulkReprocessHeader', { tip, queued: r.queued });
        const alreadyText = already
          ? ` · ${t('sourceDetailPanel.bulkAlreadyQueued', { count: already })}`
          : '';
        const cleanedText = cleaned
          ? ` · ${t('sourceDetailPanel.bulkCleaned', { count: cleaned })}`
          : '';
        show(
          `${head}${alreadyText}${cleanedText}${extra} · ${t('sourceDetailPanel.trackingDone')}`,
          'ok',
        );
        void watchSourceIdle(
          t('sourceDetailPanel.bulkWatchLabel', { count: r.queued + already, tip }),
        );
      },
    );
  };

  if (!detail) {
    return <div className="small muted">{t('sourceDetailPanel.loadingDetail')}</div>;
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="kn-detail">
      {error && <div className="kn-error small">{error}</div>}
      <OpFeedback op={op} />
      <div className="kn-detail-meta small">
        <span className={detail.status === 'ready' ? 'status-ok' : detail.status === 'error' ? 'status-error' : 'status-warn'}>
          {detail.status}
        </span>
        <span className="mono muted">{detail.kind}</span>
        <span>
          {t('sourceDetailPanel.fileCount', { count: detail.fileCount })}
          {' · '}
          {t('sourceDetailPanel.chunkCount', { count: detail.chunkCount })}
          {' · '}
          {t('sourceDetailPanel.embeddingCount', { count: detail.embeddingCount ?? 0 })}
          {detail.errorFileCount > 0 && (
            <span className="status-error">
              {' · '}
              {t('sourceDetailPanel.failedCount', { count: detail.errorFileCount })}
            </span>
          )}
          {detail.skippedFileCount > 0 && (
            <span className="muted">
              {' · '}
              {t('sourceDetailPanel.skippedCount', { count: detail.skippedFileCount })}
            </span>
          )}
        </span>
        {detail.status === 'discovering' || detail.status === 'indexing' ? (
          <span className="muted">{t('sourceDetailPanel.coverageScanning')}</span>
        ) : detail.coverage != null ? (
          <span className="muted">
            {t('sourceDetailPanel.coveragePercent', {
              percent: Math.round(detail.coverage * 100),
            })}
          </span>
        ) : null}
      </div>
      <div className="small mono muted">{detail.location}</div>
      {detail.description && <div className="small">{detail.description}</div>}
      {detail.generatedDescription && (
        <div className="small muted">
          {t('sourceDetailPanel.generatedDescLabel')}
          <DescriptionSourceBadge source={detail.generatedDescriptionSource} />
          {detail.generatedDescription}
        </div>
      )}
      {detail.scopeRef.level === 'project' && (
        <div className="small muted">
          {t('sourceDetailPanel.projectLabel')} <span className="mono">{detail.scopeRef.key}</span>
          {detail.assignedAgentIds.length > 0
            ? ` · ${t('sourceDetailPanel.mountedTo', {
                agents: detail.assignedAgentIds.join(', '),
              })}`
            : ` · ${t('sourceDetailPanel.notMounted')}`}
        </div>
      )}
      {detail.scopeRef.level === 'global' && detail.hiddenForAgentIds.length > 0 && (
        <div className="small muted">
          {t('sourceDetailPanel.hiddenFor', { agents: detail.hiddenForAgentIds.join(', ') })}
        </div>
      )}
      {detail.errors && detail.errors.length > 0 && (
        <div className="kn-error small">
          {detail.errors.slice(0, 5).map((e, i) => (
            <div key={i}>
              {e.path ? `${e.path}: ` : ''}
              {e.message}
            </div>
          ))}
        </div>
      )}

      <div className="kn-files">
        <div className="small" style={{ fontWeight: 600 }}>
          {t('sourceDetailPanel.filesTitle', { total })}
          {loadingFiles && (
            <span className="muted">
              {' · '}
              {t('sourceDetailPanel.loading')}
            </span>
          )}
          <button
            type="button"
            className="btn-ghost small"
            style={{ marginLeft: 8 }}
            disabled={total <= 0 || busy === 'bulk'}
            onClick={() => void reprocessFiltered()}
            title={t('sourceDetailPanel.bulkTitle')}
          >
            {busy === 'bulk'
              ? t('sourceDetailPanel.queueing')
              : t('sourceDetailPanel.bulkReprocess')}
          </button>
        </div>

        <div className="kn-file-filters small">
          <div className="kn-filter-row">
            {(
              [
                [
                  'all',
                  t('sourceDetailPanel.filterAll', {
                    count: statusCounts.indexed + statusCounts.skipped + statusCounts.error,
                  }),
                ],
                ['indexed', `indexed ${statusCounts.indexed}`],
                ['skipped', `skipped ${statusCounts.skipped}`],
                ['error', `error ${statusCounts.error}`],
              ] as Array<[StatusFilter, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={statusFilter === key ? 'btn-secondary small' : 'btn-ghost small'}
                onClick={() => setStatusFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="kn-filter-row">
            <select
              className="small"
              value={extFilter}
              onChange={(e) => setExtFilter(e.target.value)}
              aria-label={t('sourceDetailPanel.extFilterAria')}
            >
              <option value="all">{t('sourceDetailPanel.allTypes')}</option>
              {extCounts.map((e) => (
                <option key={e.ext} value={e.ext}>
                  {t('sourceDetailPanel.extOption', { ext: e.ext, count: e.n })}
                </option>
              ))}
            </select>
            <input
              className="small"
              style={{ minWidth: 160, flex: 1 }}
              placeholder={t('sourceDetailPanel.pathPlaceholder')}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setQ(qInput.trim());
                }
              }}
            />
            <button
              type="button"
              className="btn-ghost small"
              onClick={() => setQ(qInput.trim())}
            >
              {t('sourceDetailPanel.search')}
            </button>
            <select
              className="small"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              aria-label={t('sourceDetailPanel.pageSizeAria')}
            >
              {[20, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {t('sourceDetailPanel.pageSizeOption', { count: n })}
                </option>
              ))}
            </select>
          </div>
        </div>

        {files.length === 0 && (
          <div className="small muted">
            {total === 0 ? t('sourceDetailPanel.noFiles') : t('sourceDetailPanel.emptyPage')}
          </div>
        )}
        {files.map((f) => (
          <div key={f.path} className="kn-file">
            <div className="kn-file-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className={openPath === f.path ? 'kn-file-row kn-file-open' : 'kn-file-row'}
                style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: '6px 8px' }}
                onClick={() => void openFile(f.path)}
              >
                <span className={`small ${f.status === 'error' ? 'status-error' : f.status === 'skipped' ? 'status-neutral' : 'status-ok'}`}>
                  {f.status}
                </span>
                <span className="mono small" style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {f.path}
                </span>
                {f.ext && <span className="small muted">.{f.ext}</span>}
                <span className="small muted">{t('sourceDetailPanel.fileChunkCount', { count: f.chunkCount })}</span>
              </button>
              <button
                type="button"
                className="btn-ghost small"
                title={t('sourceDetailPanel.reprocessTitle')}
                disabled={busy === `one:${f.path}`}
                onClick={() => void reprocessOne(f.path)}
              >
                {busy === `one:${f.path}`
                  ? t('sourceDetailPanel.queueing')
                  : t('sourceDetailPanel.reprocess')}
              </button>
            </div>
            {f.error && <div className="small status-error kn-file-err">{f.error}</div>}
            {openPath === f.path && (
              <div className="kn-chunks">
                {chunks.length === 0 && (
                  <div className="small muted">{t('sourceDetailPanel.noChunks')}</div>
                )}
                {chunks.map((c) => (
                  <div key={c.id} className="kn-chunk">
                    <div className="small mono muted">
                      L{c.startLine}–{c.endLine}
                    </div>
                    <pre className="kn-chunk-text">{c.text.slice(0, 600)}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {total > 0 && (
          <div className="kn-file-pager small">
            <button
              type="button"
              className="btn-ghost small"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {t('sourceDetailPanel.prevPage')}
            </button>
            <span className="muted">
              {t('sourceDetailPanel.pagerInfo', { page, totalPages, total })}
            </span>
            <button
              type="button"
              className="btn-ghost small"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {t('sourceDetailPanel.nextPage')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
