/**
 * WebUI 本地文件缓存 — OPFS 优先，内存兜底。
 * 目录：octopi-file-cache/<sessionId>/<fileId>.bin + .meta.json
 * 展示/转存一律读本地；GET 只在未命中时拉取。
 */

export interface CachedFileMeta {
  fileId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  sessionId: string;
  cachedAt: number;
}

export interface CachedFile {
  meta: CachedFileMeta;
  blob: Blob;
}

const ROOT = 'octopi-file-cache';

async function opfsAvailable(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const nav = navigator as Navigator & {
      storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
    };
    if (!nav.storage?.getDirectory) return null;
    return await nav.storage.getDirectory();
  } catch {
    return null;
  }
}

async function sessionDir(
  root: FileSystemDirectoryHandle,
  sessionId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const cache = await root.getDirectoryHandle(ROOT, { create });
    return await cache.getDirectoryHandle(sessionId, { create });
  } catch {
    return null;
  }
}

const mem = new Map<string, CachedFile>();

function key(sessionId: string, fileId: string): string {
  return `${sessionId}/${fileId}`;
}

export async function putCachedFile(
  sessionId: string,
  meta: Omit<CachedFileMeta, 'cachedAt' | 'sessionId'>,
  blob: Blob,
): Promise<CachedFile> {
  const full: CachedFile = {
    meta: { ...meta, sessionId, cachedAt: Date.now() },
    blob,
  };
  mem.set(key(sessionId, meta.fileId), full);

  const root = await opfsAvailable();
  if (root) {
    const dir = await sessionDir(root, sessionId, true);
    if (dir) {
      try {
        const bin = await dir.getFileHandle(`${meta.fileId}.bin`, { create: true });
        const w = await bin.createWritable();
        await w.write(blob);
        await w.close();
        const metaHandle = await dir.getFileHandle(`${meta.fileId}.meta.json`, { create: true });
        const mw = await metaHandle.createWritable();
        await mw.write(JSON.stringify(full.meta));
        await mw.close();
      } catch {
        // OPFS 写失败：内存仍可用
      }
    }
  }
  return full;
}

export async function getCachedFile(
  sessionId: string,
  fileId: string,
): Promise<CachedFile | null> {
  const hit = mem.get(key(sessionId, fileId));
  if (hit) return hit;

  const root = await opfsAvailable();
  if (!root) return null;
  const dir = await sessionDir(root, sessionId, false);
  if (!dir) return null;
  try {
    const bin = await dir.getFileHandle(`${fileId}.bin`);
    const file = await bin.getFile();
    const metaHandle = await dir.getFileHandle(`${fileId}.meta.json`);
    const metaText = await (await metaHandle.getFile()).text();
    const meta = JSON.parse(metaText) as CachedFileMeta;
    const cached: CachedFile = { meta, blob: file };
    mem.set(key(sessionId, fileId), cached);
    return cached;
  } catch {
    return null;
  }
}

/** 未命中则拉 gateway，写入缓存 */
export async function loadSessionFile(
  fetchFile: () => Promise<Response>,
  sessionId: string,
  fileRef: { fileId: string; name: string; mime: string; sizeBytes: number },
): Promise<CachedFile> {
  const cached = await getCachedFile(sessionId, fileRef.fileId);
  if (cached) return cached;
  const res = await fetchFile();
  if (!res.ok) {
    throw new Error(`file fetch failed: ${res.status}`);
  }
  const blob = await res.blob();
  return putCachedFile(
    sessionId,
    {
      fileId: fileRef.fileId,
      name: fileRef.name,
      mime: fileRef.mime || blob.type || 'application/octet-stream',
      sizeBytes: fileRef.sizeBytes || blob.size,
    },
    blob,
  );
}

/** 转存到用户磁盘 */
export function saveBlobAs(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export async function clearSessionFileCache(sessionId: string): Promise<void> {
  for (const k of [...mem.keys()]) {
    if (k.startsWith(`${sessionId}/`)) mem.delete(k);
  }
  const root = await opfsAvailable();
  if (!root) return;
  try {
    const cache = await root.getDirectoryHandle(ROOT);
    await cache.removeEntry(sessionId, { recursive: true });
  } catch {
    // 不存在则忽略
  }
}

export async function clearAllFileCache(): Promise<void> {
  mem.clear();
  const root = await opfsAvailable();
  if (!root) return;
  try {
    await root.removeEntry(ROOT, { recursive: true });
  } catch {
    // ignore
  }
}

export function classifyMime(mime: string): 'text' | 'image' | 'audio' | 'video' | 'other' {
  const m = (mime || '').toLowerCase();
  // SVG 可含脚本：禁止走 image/导航预览，按文本处理（或下载）
  if (m === 'image/svg+xml') return 'text';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (
    m.startsWith('text/') ||
    m === 'application/json' ||
    m === 'application/xml' ||
    m === 'application/x-ndjson' ||
    m === 'application/javascript'
  ) {
    return 'text';
  }
  return 'other';
}

export function isMarkdownMime(mime: string, name?: string): boolean {
  const m = (mime || '').toLowerCase();
  if (m === 'text/markdown') return true;
  // 仅按完整扩展名判断，避免 note.md.docx 之类误判
  const n = (name || '').toLowerCase();
  return /\.(md|markdown|mdx)$/.test(n);
}
