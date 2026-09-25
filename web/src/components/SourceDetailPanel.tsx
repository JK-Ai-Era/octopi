/**
 * 源详情诊断 — 索引文件 + chunk 预览 + 状态读数
 * 规格：arch/knowledge-admin-ui.md（进得去吗）
 */
import { useCallback, useEffect, useState } from 'react';
import {
  OctopiClient,
  type KnowledgeSourceDetailDto,
} from '../../../src/integration/web/sdk/client';

interface FileRow {
  path: string;
  status: string;
  chunkCount: number;
  error?: string;
}

interface ChunkRow {
  id: string;
  path: string;
  text: string;
  startLine: number;
  endLine: number;
}

export function SourceDetailPanel({
  client,
  agentId,
  sourceId,
  onChanged,
}: {
  client: OctopiClient;
  agentId: string;
  sourceId: string;
  onChanged?: () => void;
}) {
  const [detail, setDetail] = useState<KnowledgeSourceDetailDto | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [d, f] = await Promise.all([
        client.getKnowledgeSourceDetail(agentId, sourceId),
        client.listKnowledgeSourceFiles(agentId, sourceId),
      ]);
      setDetail(d);
      setFiles(f);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId, client, sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 索引未就绪时轻量轮询（progress WS 后续替换）
  useEffect(() => {
    if (!detail) return;
    const active =
      detail.status === 'pending' ||
      detail.status === 'discovering' ||
      detail.status === 'partial';
    if (!active) return;
    const t = setInterval(() => {
      void load().then(() => onChanged?.());
    }, 2500);
    return () => clearInterval(t);
  }, [detail?.status, load, onChanged]);

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

  if (!detail) {
    return <div className="small muted">加载源详情…</div>;
  }

  return (
    <div className="kn-detail">
      {error && <div className="kn-error small">{error}</div>}
      <div className="kn-detail-meta small">
        <span className={detail.status === 'ready' ? 'status-ok' : detail.status === 'error' ? 'status-error' : 'status-warn'}>
          {detail.status}
        </span>
        <span className="mono muted">{detail.kind}</span>
        <span>
          files {detail.fileCount} · chunks {detail.chunkCount}
          {detail.errorFileCount > 0 && (
            <span className="status-error"> · err {detail.errorFileCount}</span>
          )}
          {detail.skippedFileCount > 0 && (
            <span className="muted"> · skip {detail.skippedFileCount}</span>
          )}
        </span>
        {detail.coverage != null && (
          <span className="muted">coverage {Math.round(detail.coverage * 100)}%</span>
        )}
      </div>
      <div className="small mono muted">{detail.location}</div>
      {detail.description && <div className="small">{detail.description}</div>}
      {!detail.description && detail.generatedDescription && (
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
          索引文件（{files.length}）
        </div>
        {files.length === 0 && (
          <div className="small muted">
            尚无索引文件。若刚注册，请点「重建索引」；状态未 ready 时会自动刷新。
          </div>
        )}
        {files.map((f) => (
          <div key={f.path} className="kn-file">
            <button
              type="button"
              className={openPath === f.path ? 'kn-file-row kn-file-open' : 'kn-file-row'}
              onClick={() => void openFile(f.path)}
            >
              <span className={`small ${f.status === 'error' ? 'status-error' : f.status === 'skipped' ? 'status-neutral' : 'status-ok'}`}>
                {f.status}
              </span>
              <span className="mono small" style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {f.path}
              </span>
              <span className="small muted">{f.chunkCount} chunks</span>
            </button>
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
      </div>
    </div>
  );
}
