/**
 * 文件展示 — 按 mime 分发：文本/Markdown 右栏、图片、音视频、其它 FileCard。
 * 字节一律经本地缓存（file-cache）读取。
 */

import { useEffect, useMemo, useState } from 'react';
import type { OctopiClient } from '@octopi-agent/gateway/web/sdk/client';
import { MarkdownMessage } from './MarkdownMessage';
import {
  classifyMime,
  isMarkdownMime,
  loadSessionFile,
  saveBlobAs,
  type CachedFile,
} from '../file-cache';

export interface FileRef {
  fileId: string;
  name: string;
  mime: string;
  sizeBytes: number;
}

export function useSessionFile(
  client: OctopiClient | null,
  sessionId: string | null,
  fileRef: FileRef | null,
): { file: CachedFile | null; error: string | null; loading: boolean } {
  const [file, setFile] = useState<CachedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = fileRef ? `${sessionId}:${fileRef.fileId}` : '';

  useEffect(() => {
    if (!client || !sessionId || !fileRef) {
      setFile(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const loaded = await loadSessionFile(
          () => client.fetchSessionFile(sessionId, fileRef.fileId),
          sessionId,
          fileRef,
        );
        if (!cancelled) setFile(loaded);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sessionId, key]);

  return { file, error, loading };
}

export function hasPreviewRenderer(mime: string): boolean {
  const k = classifyMime(mime);
  return k === 'text' || k === 'image' || k === 'audio' || k === 'video';
}

export function FilePreviewPanel({
  client,
  sessionId,
  files,
  focusFileId,
  onSelect,
}: {
  client: OctopiClient | null;
  sessionId: string | null;
  /** 本会话已发送的全部文件（按时间序） */
  files: Array<{ ref: FileRef; createdAt?: number }>;
  /** 当前聚焦文件；缺省最后一个 */
  focusFileId?: string | null;
  onSelect?: (ref: FileRef) => void;
}) {
  if (!files.length) {
    return (
      <section className="panel sidebar-section">
        <div className="sidebar-title">文件</div>
        <div className="small muted">Agent 发送的文件会显示在这里。点击对话中的文件名可打开。</div>
      </section>
    );
  }

  const focusId = focusFileId ?? files[files.length - 1]!.ref.fileId;
  const focused = files.find((f) => f.ref.fileId === focusId) ?? files[files.length - 1]!;

  return (
    <section className="panel sidebar-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div className="sidebar-title" style={{ marginBottom: 0 }}>
          文件
          <span className="small muted" style={{ marginLeft: 8, fontWeight: 400 }}>
            {files.length} 个
          </span>
        </div>
      </div>
      {files.length > 1 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {files.map(({ ref }) => {
            const active = ref.fileId === focused.ref.fileId;
            return (
              <button
                key={ref.fileId}
                type="button"
                className={active ? 'btn-tab btn-tab-active' : 'btn-tab'}
                style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={ref.name}
                onClick={() => onSelect?.(ref)}
              >
                {ref.name}
              </button>
            );
          })}
        </div>
      ) : null}
      <FilePanelItem
        client={client}
        sessionId={sessionId}
        fileRef={focused.ref}
        createdAt={focused.createdAt}
      />
    </section>
  );
}

function FilePanelItem({
  client,
  sessionId,
  fileRef,
  createdAt,
}: {
  client: OctopiClient | null;
  sessionId: string | null;
  fileRef: FileRef;
  createdAt?: number;
}) {
  const { file, error, loading } = useSessionFile(client, sessionId, fileRef);
  return (
    <div style={{ borderTop: '1px solid var(--border-color, #e5e7eb)', paddingTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 }}>
        <div style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fileRef.name}
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={!file}
          onClick={() => file && saveBlobAs(file.blob, file.meta.name)}
        >
          转存
        </button>
      </div>
      <div className="small muted" style={{ marginBottom: 8, wordBreak: 'break-all' }}>
        {fileRef.mime || 'application/octet-stream'} · {fileRef.sizeBytes.toLocaleString()} 字节
        {createdAt ? ` · ${new Date(createdAt).toLocaleTimeString()}` : ''}
      </div>
      {loading && <div className="small muted">加载中…</div>}
      {error && <div className="small" style={{ color: 'var(--color-danger, #dc2626)' }}>{error}</div>}
      {file && <FileBody file={file} />}
    </div>
  );
}

export function FileBody({ file }: { file: CachedFile }) {
  const kind = classifyMime(file.meta.mime);
  const url = useMemo(() => URL.createObjectURL(file.blob), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  if (kind === 'image') {
    // 不用 <a target=_blank> 打开 blob：同源导航面可执行 SVG/HTML；仅 <img> 展示位图
    return (
      <img
        src={url}
        alt={file.meta.name}
        style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border-color, #e5e7eb)', cursor: 'zoom-in' }}
        onClick={(e) => {
          const el = e.currentTarget;
          el.style.cursor = el.style.maxWidth === 'none' ? 'zoom-in' : 'zoom-out';
          el.style.maxWidth = el.style.maxWidth === 'none' ? '100%' : 'none';
        }}
      />
    );
  }

  if (kind === 'audio') {
    return <audio controls src={url} style={{ width: '100%' }} preload="metadata" />;
  }

  if (kind === 'video') {
    return (
      <video controls src={url} style={{ width: '100%', borderRadius: 8 }} preload="metadata" playsInline />
    );
  }

  if (kind === 'text') {
    return <TextFileBody file={file} />;
  }

  // other：docx/pdf/zip/未知二进制 — 禁止进 Markdown/文本渲染器
  return <BinaryFileBody file={file} onDownload={() => saveBlobAs(file.blob, file.meta.name)} />;
}

function BinaryFileBody({ file, onDownload }: { file: CachedFile; onDownload: () => void }) {
  return (
    <div
      style={{
        padding: 16,
        border: '1px dashed var(--border-color, #e5e7eb)',
        borderRadius: 8,
        background: 'var(--color-bg-subtle, #f8fafc)',
        display: 'grid',
        gap: 8,
      }}
    >
      <div className="small muted">二进制 / 文档文件，不支持在线预览</div>
      <div className="small" style={{ wordBreak: 'break-all' }}>
        {file.meta.name}
      </div>
      <div className="small muted">
        {file.meta.mime || 'application/octet-stream'} · {file.meta.sizeBytes.toLocaleString()} 字节
      </div>
      <div>
        <button type="button" className="btn-secondary" onClick={onDownload}>
          转存到本地
        </button>
      </div>
    </div>
  );
}

function looksBinary(text: string): boolean {
  if (text.includes('\u0000')) return true;
  let bad = 0;
  const sample = text.slice(0, 2048);
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0xfffd) bad++;
  }
  return sample.length > 0 && bad > sample.length * 0.05;
}

function TextFileBody({ file }: { file: CachedFile }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void file.blob
      .text()
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (err) return <div className="small" style={{ color: 'var(--color-danger, #dc2626)' }}>{err}</div>;
  if (text == null) return <div className="small muted">读取中…</div>;

  // 误标成 text 的二进制（如 docx 被当成 text/plain）→ 不进 md 渲染器
  if (looksBinary(text)) {
    return <BinaryFileBody file={file} onDownload={() => saveBlobAs(file.blob, file.meta.name)} />;
  }

  const md = isMarkdownMime(file.meta.mime, file.meta.name);
  return (
    <div style={{ maxHeight: 'min(70vh, 720px)', overflow: 'auto' }}>
      {md ? (
        <MarkdownMessage content={text} />
      ) : (
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: 'var(--color-bg-subtle, #f8fafc)',
            border: '1px solid var(--border-color, #e5e7eb)',
            borderRadius: 8,
            fontSize: 'var(--text-sm)',
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

/** 对话时间线上的文件卡片（图片内嵌，音视频/其它可转存） */
export function FileCard({
  client,
  sessionId,
  fileRef,
  createdAt,
  onOpen,
}: {
  client: OctopiClient | null;
  sessionId: string | null;
  fileRef: FileRef;
  createdAt?: number;
  onOpen?: (ref: FileRef) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRenderer = hasPreviewRenderer(fileRef.mime);

  const activate = async () => {
    if (busy) return;
    setError(null);
    if (hasRenderer) {
      onOpen?.(fileRef);
      return;
    }
    // 无渲染器 → 转存
    if (!client || !sessionId) {
      setError('未连接，无法转存');
      return;
    }
    setBusy(true);
    try {
      const loaded = await loadSessionFile(
        () => client.fetchSessionFile(sessionId, fileRef.fileId),
        sessionId,
        fileRef,
      );
      saveBlobAs(loaded.blob, loaded.meta.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="panel file-card"
      style={{
        borderColor: 'var(--color-border, #e5e7eb)',
        marginBottom: 12,
        padding: '12px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: 'var(--color-primary, #111827)',
            flexShrink: 0,
          }}
        />
        <button
          type="button"
          onClick={() => void activate()}
          disabled={busy}
          title={hasRenderer ? '打开预览' : '转存到本地'}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'left',
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: busy ? 'wait' : 'pointer',
            fontWeight: 700,
            fontSize: '15px',
            // 不用 --color-accent（#eef2ff 几乎不可见）；写死高对比文字色
            color: '#111827',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          className="file-card-name"
        >
          {fileRef.name}
        </button>
        <span className="small muted" style={{ flexShrink: 0 }}>
          {hasRenderer ? '预览' : '转存'}
        </span>
      </div>
      <div className="small muted" style={{ marginTop: 6, marginLeft: 18 }}>
        {fileRef.mime || 'application/octet-stream'} · {fileRef.sizeBytes.toLocaleString()} 字节
        {createdAt ? ` · ${new Date(createdAt).toLocaleString()}` : ''}
        {busy ? ' · 处理中…' : ''}
      </div>
      {error ? (
        <div className="small" style={{ color: 'var(--color-danger, #dc2626)', marginTop: 6, marginLeft: 18 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function fileRefFromCall(call: {
  name: string;
  fileRef?: FileRef;
  args?: Record<string, unknown>;
}): FileRef | null {
  if (call.name !== 'send_file') return null;
  if (call.fileRef?.fileId) return call.fileRef;
  return null;
}
