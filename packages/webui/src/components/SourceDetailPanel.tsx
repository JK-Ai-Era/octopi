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
    const t = setInterval(() => {
      void loadDetail();
      void loadFiles();
    }, 3000);
    return () => clearInterval(t);
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
        show(`处理中：${label} · 剩余任务 ${active}…`, 'info');
      }
      await loadFiles();
      await loadDetail();
      const parts = last.slice(0, 3).map((x) => {
        const st = x.fileStatus ?? (x.exists ? '未索引' : '已清理');
        return `${st}${x.chunkCount ? `·${x.chunkCount}块` : ''}${x.error ? `(${x.error})` : ''}`;
      });
      const more = last.length > 3 ? ` 等 ${last.length} 项` : '';
      show(`完成：${label}${parts.length ? ` → ${parts.join('，')}${more}` : ''}`, 'ok');
    },
    [agentId, client, loadDetail, loadFiles, show, sourceId],
  );

  const reprocessOne = async (path: string) => {
    const name = path.split(/[\\/]/).pop() ?? path;
    await run(
      `one:${path}`,
      () => client.reprocessKnowledgeFiles(agentId, sourceId, { paths: [path] }),
      async (r) => {
        const cleaned = r.cleanedNonFiles ?? 0;
        if (cleaned > 0 && (r.queued ?? 0) === 0 && (r.alreadyActive ?? 0) === 0) {
          show(`「${name}」是目录脏行，已清理（无需解析）`, 'ok');
          await loadFiles();
          await loadDetail();
          return;
        }
        const extra = r.resumed ? ' · 已自动继续索引（原为中止态）' : '';
        const already = r.alreadyActive ?? 0;
        if ((r.queued ?? 0) === 0 && already > 0) {
          show(`「${name}」已在队列/执行中，跟踪完成态…${extra}`, 'info');
        } else {
          show(`已入队重做「${name}」（${r.queued} 条）· 跟踪完成态…${extra}`, 'ok');
        }
        void watchPathsDone([path], `「${name}」`);
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
          show(`处理中：${label} · 源内剩余任务 ${active}…`, 'info');
        } catch {
          /* 轮询失败继续 */
        }
      }
      await loadFiles();
      await loadDetail();
      show(`完成：${label} · 列表已刷新`, 'ok');
    },
    [agentId, client, loadDetail, loadFiles, show, sourceId],
  );

  const reprocessFiltered = async () => {
    const n = total;
    if (n <= 0) return;
    const label = [
      statusFilter !== 'all' ? `状态=${statusFilter}` : null,
      extFilter !== 'all' ? `类型=.${extFilter}` : null,
      q ? `路径含「${q}」` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const tip = label ? `（${label}）` : '（全部文件）';
    if (!confirm(`对筛选出的 ${n} 个文件执行「重做」${tip}？\n将重新解析、分块并补向量。`)) {
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
        const extra = r.resumed ? ' · 已自动继续索引（原为中止态）' : '';
        const cleaned = r.cleanedNonFiles ?? 0;
        const already = r.alreadyActive ?? 0;
        show(
          `批量重做${tip}：新入队 ${r.queued}${already ? ` · 已在队列 ${already}` : ''}${
            cleaned ? ` · 清目录脏行 ${cleaned}` : ''
          }${extra} · 跟踪完成态…`,
          'ok',
        );
        void watchSourceIdle(`批量重做 ${r.queued + already} 项${tip}`);
      },
    );
  };

  if (!detail) {
    return <div className="small muted">加载源详情…</div>;
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
          文件 {detail.fileCount} · 分块 {detail.chunkCount} · 向量 {detail.embeddingCount ?? 0}
          {detail.errorFileCount > 0 && (
            <span className="status-error"> · 失败 {detail.errorFileCount}</span>
          )}
          {detail.skippedFileCount > 0 && (
            <span className="muted"> · 跳过 {detail.skippedFileCount}</span>
          )}
        </span>
        {detail.status === 'discovering' || detail.status === 'indexing' ? (
          <span className="muted">覆盖 扫描中…</span>
        ) : detail.coverage != null ? (
          <span className="muted">覆盖 {Math.round(detail.coverage * 100)}%</span>
        ) : null}
      </div>
      <div className="small mono muted">{detail.location}</div>
      {detail.description && <div className="small">{detail.description}</div>}
      {detail.generatedDescription && (
        <div className="small muted">自动描述：{detail.generatedDescription}</div>
      )}
      {detail.scopeRef.level === 'project' && (
        <div className="small muted">
          项目 <span className="mono">{detail.scopeRef.key}</span>
          {detail.assignedAgentIds.length > 0
            ? ` · 挂载 ${detail.assignedAgentIds.join(', ')}`
            : ' · 未挂载'}
        </div>
      )}
      {detail.scopeRef.level === 'global' && detail.hiddenForAgentIds.length > 0 && (
        <div className="small muted">
          对隐藏：{detail.hiddenForAgentIds.join(', ')}
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
          索引文件（{total}）
          {loadingFiles && <span className="muted"> · 加载中…</span>}
          <button
            type="button"
            className="btn-ghost small"
            style={{ marginLeft: 8 }}
            disabled={total <= 0 || busy === 'bulk'}
            onClick={() => void reprocessFiltered()}
            title="对当前筛选结果强制重新解析/分块/向量"
          >
            {busy === 'bulk' ? '入队中…' : '批量重做'}
          </button>
        </div>

        <div className="kn-file-filters small">
          <div className="kn-filter-row">
            {(
              [
                ['all', `全部 ${statusCounts.indexed + statusCounts.skipped + statusCounts.error}`],
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
              aria-label="文件类型"
            >
              <option value="all">全部类型</option>
              {extCounts.map((e) => (
                <option key={e.ext} value={e.ext}>
                  .{e.ext}（{e.n}）
                </option>
              ))}
            </select>
            <input
              className="small"
              style={{ minWidth: 160, flex: 1 }}
              placeholder="路径关键词…"
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
              搜索
            </button>
            <select
              className="small"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              aria-label="每页条数"
            >
              {[20, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} 条/页
                </option>
              ))}
            </select>
          </div>
        </div>

        {files.length === 0 && (
          <div className="small muted">
            {total === 0
              ? '没有符合条件的文件。若刚注册，请点「重建索引」；也可放宽筛选。'
              : '当前页为空。'}
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
                <span className="small muted">{f.chunkCount} chunks</span>
              </button>
              <button
                type="button"
                className="btn-ghost small"
                title="强制重新解析、分块并补向量"
                disabled={busy === `one:${f.path}`}
                onClick={() => void reprocessOne(f.path)}
              >
                {busy === `one:${f.path}` ? '入队中…' : '重做'}
              </button>
            </div>
            {f.error && <div className="small status-error kn-file-err">{f.error}</div>}
            {openPath === f.path && (
              <div className="kn-chunks">
                {chunks.length === 0 && <div className="small muted">无 chunk</div>}
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
              上一页
            </button>
            <span className="muted">
              第 {page} / {totalPages} 页 · 共 {total} 条
            </span>
            <button
              type="button"
              className="btn-ghost small"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
