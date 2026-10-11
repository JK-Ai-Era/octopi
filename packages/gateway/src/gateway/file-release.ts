/**
 * 文件外发（File Release）— send_file 签发 fileId + 内容下发 + 审计
 *
 * 安全：
 * - 浏览器只认不透明 fileId，不认 path
 * - 仅工具 release 过的文件可 GET
 * - 路径策略（realpath 防 symlink 逃逸）+ 敏感名拦截 + fail-closed 审计
 * - 事件：file.released / file.fetched / file.rejected / file.denied
 */

import { appendFile, mkdir, open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, basename, resolve, sep, isAbsolute, join } from 'node:path';

export type FileReleaseSourceKind = 'workspace' | 'attachment' | 'tool_output' | 'other';

export interface FileReleaseRecord {
  fileId: string;
  sessionId: string;
  agentId: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
  name: string;
  mime: string;
  sizeBytes: number;
  /** realpath 之后的绝对路径（读文件用） */
  absPath: string;
  sourceKind: FileReleaseSourceKind;
  sourcePathDisplay: string;
  purpose?: string;
  createdAt: number;
}

/** 持久化到 session.metadata.fileReleases 的索引（回放用） */
export interface FileReleaseIndexEntry {
  fileId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  absPath: string;
  sourcePathDisplay: string;
  sourceKind: FileReleaseSourceKind;
  toolName: string;
  createdAt: number;
}

export type FileAuditEventType =
  | 'file.released'
  | 'file.fetched'
  | 'file.rejected'
  | 'file.denied';

export interface FileAuditEvent {
  id: string;
  type: FileAuditEventType;
  at: number;
  sessionId: string;
  agentId?: string;
  runId?: string;
  fileId?: string;
  name?: string;
  mime?: string;
  sizeBytes?: number;
  sourcePath?: string;
  sourceKind?: FileReleaseSourceKind;
  toolName?: string;
  toolCallId?: string;
  clientInstanceId?: string;
  purpose?: string;
  reason?: string;
  range?: { start: number; end: number };
  policy?: {
    pathAllowed?: boolean;
    sensitiveHit?: string | null;
    sourcePolicy?: string;
  };
}

export interface ReleaseFileInput {
  sessionId: string;
  agentId: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
  path: string;
  name?: string;
  purpose?: string;
  clientInstanceId?: string;
  allowedRoots: string[];
  resolveBases: string[];
}

export interface ReleaseFileResult {
  fileRef: {
    fileId: string;
    name: string;
    mime: string;
    sizeBytes: number;
  };
  record: FileReleaseRecord;
}

export type ReadContentResult =
  | {
      ok: true;
      record: FileReleaseRecord;
      totalSize: number;
      start: number;
      end: number;
      ranged: boolean;
      /** 调用方负责 close */
      handle: FileHandle;
    }
  | { ok: false; reason: 'not_found' | 'source_missing' | 'unsatisfiable'; totalSize?: number };

const SENSITIVE_NAME_PATTERNS: RegExp[] = [
  /^\.env(?:\.|$)/i,
  /(^|[_-])id[_-]?rsa/i,
  /(^|[_-])id[_-]?ed25519/i,
  /credential/i,
  /secret/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /^octopi\.json$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
];

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])credentials([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
];

const MAX_FILE_BYTES_DEFAULT = 2 * 1024 * 1024 * 1024; // 2GB
/** 会话 release 次数：0 / 缺省 = 不限 */
const MAX_RELEASES_PER_SESSION_DEFAULT = 0;
/** 内存/持久索引条数上限（防长会话无界膨胀；与 quota 无关） */
const MAX_INDEX_ENTRIES_DEFAULT = 2000;

export function detectMime(filePath: string, override?: string): string {
  if (override && override.includes('/')) return override;
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.mdx': 'text/markdown',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.jsonl': 'application/x-ndjson',
    '.yml': 'text/yaml',
    '.yaml': 'text/yaml',
    '.toml': 'text/plain',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.ts': 'text/plain',
    '.tsx': 'text/plain',
    '.jsx': 'text/plain',
    '.py': 'text/plain',
    '.go': 'text/plain',
    '.rs': 'text/plain',
    '.java': 'text/plain',
    '.sh': 'text/plain',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.7z': 'application/x-7z-compressed',
    '.rar': 'application/vnd.rar',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/x-ndjson' ||
    mime === 'image/svg+xml'
  );
}

/** 可内联预览的图片（排除 SVG：可含脚本，禁止 <img>/导航打开） */
export function isSafeInlineImageMime(mime: string): boolean {
  const m = (mime || '').toLowerCase();
  return m.startsWith('image/') && m !== 'image/svg+xml';
}

export function classifySourceKind(absPath: string, attachmentRoot?: string): FileReleaseSourceKind {
  if (attachmentRoot) {
    const root = resolve(attachmentRoot);
    const prefix = root.endsWith(sep) ? root : root + sep;
    const p = resolve(absPath);
    const win = process.platform === 'win32';
    const np = win ? p.toLowerCase() : p;
    const nr = win ? prefix.toLowerCase() : prefix;
    if (np === (win ? root.toLowerCase() : root) || np.startsWith(nr)) return 'attachment';
  }
  return 'workspace';
}

function findSensitiveHit(name: string, absPath: string): string | null {
  const base = basename(absPath);
  for (const re of SENSITIVE_NAME_PATTERNS) {
    if (re.test(base) || re.test(name)) return `name:${re.source}`;
  }
  for (const re of SENSITIVE_PATH_PATTERNS) {
    if (re.test(absPath)) return `path:${re.source}`;
  }
  return null;
}

function underRoot(abs: string, root: string): boolean {
  const win = process.platform === 'win32';
  const norm = (s: string) => {
    const r = resolve(s);
    return win ? r.toLowerCase() : r;
  };
  const p = norm(abs);
  const r = norm(root);
  const prefix = r.endsWith(sep) ? r : r + sep;
  return p === r || p.startsWith(prefix);
}

function makeFileId(): string {
  return `f_${randomBytes(12).toString('hex')}`;
}

function makeAuditId(): string {
  return `fa_${randomBytes(8).toString('hex')}`;
}

/**
 * Range 解析（RFC 7233 单位 bytes）。
 * @returns null=无 Range；'unsatisfiable'=416；否则闭区间 [start,end]
 */
export function parseRangeHeader(
  header: string | undefined,
  totalSize: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^bytes=/i.test(trimmed)) return null;
  const spec = trimmed.slice(6).split(',')[0]?.trim();
  if (!spec) return 'unsatisfiable';
  const dash = spec.indexOf('-');
  if (dash < 0) return 'unsatisfiable';
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();
  if (totalSize === 0) return 'unsatisfiable';

  if (startStr === '') {
    // suffix: bytes=-500
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix < 0) return 'unsatisfiable';
    if (suffix === 0) return 'unsatisfiable';
    const start = Math.max(0, totalSize - suffix);
    return { start, end: totalSize - 1 };
  }

  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0 || !Number.isInteger(start)) return 'unsatisfiable';
  if (start >= totalSize) return 'unsatisfiable';

  if (endStr === '') {
    return { start, end: totalSize - 1 };
  }
  const end = Number(endStr);
  if (!Number.isFinite(end) || end < start || !Number.isInteger(end)) return 'unsatisfiable';
  return { start, end: Math.min(end, totalSize - 1) };
}

export class FileReleaseService {
  private readonly records = new Map<string, FileReleaseRecord>();
  private readonly bySession = new Map<string, Set<string>>();
  private readonly hydrating = new Map<string, Promise<void>>();
  private readonly auditDir: string;
  private readonly maxBytes: number;
  /** 0 = 不限 */
  private readonly maxReleasesPerSession: number;
  private readonly maxIndexEntries: number;
  private readonly persistIndex: (
    sessionId: string,
    entries: FileReleaseIndexEntry[],
  ) => Promise<void>;
  private readonly loadIndex: (sessionId: string) => Promise<FileReleaseIndexEntry[]>;
  /** persistIndex 串行队列（按 session） */
  private readonly persistQueues = new Map<string, Promise<void>>();

  constructor(options: {
    auditDir: string;
    maxBytes?: number;
    maxReleasesPerSession?: number;
    /** 索引/内存条数上限；缺省 2000 */
    maxIndexEntries?: number;
    persistIndex: (sessionId: string, entries: FileReleaseIndexEntry[]) => Promise<void>;
    loadIndex: (sessionId: string) => Promise<FileReleaseIndexEntry[]>;
  }) {
    this.auditDir = options.auditDir;
    this.maxBytes =
      options.maxBytes != null && options.maxBytes > 0
        ? options.maxBytes
        : MAX_FILE_BYTES_DEFAULT;
    this.maxReleasesPerSession =
      options.maxReleasesPerSession != null && options.maxReleasesPerSession > 0
        ? options.maxReleasesPerSession
        : MAX_RELEASES_PER_SESSION_DEFAULT;
    this.maxIndexEntries =
      options.maxIndexEntries != null && options.maxIndexEntries > 0
        ? options.maxIndexEntries
        : MAX_INDEX_ENTRIES_DEFAULT;
    this.persistIndex = options.persistIndex;
    this.loadIndex = options.loadIndex;
  }

  /** 会话恢复灌入索引；并发调用共享同一 in-flight promise */
  async hydrateSession(sessionId: string): Promise<void> {
    const existing = this.hydrating.get(sessionId);
    if (existing) return existing;
    if (this.bySession.has(sessionId)) return;

    const p = (async () => {
      const entries = await this.loadIndex(sessionId).catch(() => [] as FileReleaseIndexEntry[]);
      const set = new Set<string>();
      for (const e of entries) {
        const rec: FileReleaseRecord = {
          fileId: e.fileId,
          sessionId,
          agentId: '',
          toolName: e.toolName || 'send_file',
          name: e.name,
          mime: e.mime,
          sizeBytes: e.sizeBytes,
          absPath: e.absPath,
          sourceKind: e.sourceKind,
          sourcePathDisplay: e.sourcePathDisplay,
          createdAt: e.createdAt,
        };
        this.records.set(e.fileId, rec);
        set.add(e.fileId);
      }
      this.bySession.set(sessionId, set);
    })();

    this.hydrating.set(sessionId, p);
    try {
      await p;
    } finally {
      this.hydrating.delete(sessionId);
    }
  }

  async listSessionReleases(sessionId: string): Promise<FileReleaseRecord[]> {
    await this.hydrateSession(sessionId);
    const ids = this.bySession.get(sessionId);
    if (!ids) return [];
    const out: FileReleaseRecord[] = [];
    for (const id of ids) {
      const r = this.records.get(id);
      if (r) out.push(r);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  get(fileId: string, sessionId: string): FileReleaseRecord | null {
    const rec = this.records.get(fileId);
    if (!rec || rec.sessionId !== sessionId) return null;
    return rec;
  }

  /**
   * 签发 fileId。失败路径写 file.rejected 审计后 throw。
   * 审计写失败 → fail-closed，不签发。
   */
  async release(input: ReleaseFileInput): Promise<ReleaseFileResult> {
    const reject = async (
      reason: string,
      policy: FileAuditEvent['policy'],
      partial?: Partial<FileAuditEvent>,
    ) => {
      await this.appendAudit({
        id: makeAuditId(),
        type: 'file.rejected',
        at: Date.now(),
        sessionId: input.sessionId,
        agentId: input.agentId,
        runId: input.runId,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        clientInstanceId: input.clientInstanceId,
        purpose: input.purpose,
        sourcePath: input.path,
        reason,
        policy,
        ...partial,
      });
      throw new Error(
        reason.startsWith('PATH_FORBIDDEN') || reason.startsWith('SENSITIVE')
          ? reason
          : `invalid_arguments: ${reason}`,
      );
    };

    await this.hydrateSession(input.sessionId);

    const ids = this.bySession.get(input.sessionId)!;
    if (this.maxReleasesPerSession > 0 && ids.size >= this.maxReleasesPerSession) {
      await reject(
        `quota_exceeded: too many file releases in session (max ${this.maxReleasesPerSession})`,
        { sourcePolicy: 'quota' },
      );
    }

    const raw = input.path.trim();
    if (!raw) {
      await reject('empty path', { pathAllowed: false });
    }

    // 逻辑路径解析（相对路径按 resolveBases 探测）
    let logical: string;
    if (isAbsolute(raw)) {
      logical = resolve(raw);
    } else {
      const cleaned = raw.replace(/^[/\\]+/, '');
      let found: string | undefined;
      for (const base of input.resolveBases) {
        const tryPath = resolve(base, cleaned);
        try {
          await stat(tryPath);
          found = tryPath;
          break;
        } catch {
          // next
        }
      }
      logical = found ?? resolve(input.resolveBases[0] ?? process.cwd(), cleaned);
    }

    // realpath：展开 symlink 后再做路径/敏感判定（防 notes.md → id_rsa 逃逸）
    let candidate: string;
    try {
      candidate = await realpath(logical);
    } catch {
      candidate = logical;
    }
    // allowedRoots 也展开一次（根目录本身可能是链接）
    const allowedResolved = await Promise.all(
      input.allowedRoots.map(async (r) => {
        try {
          return await realpath(r);
        } catch {
          return resolve(r);
        }
      }),
    );

    const pathAllowed = allowedResolved.some((r) => underRoot(candidate, r));
    if (!pathAllowed) {
      await reject(
        `PATH_FORBIDDEN: path not under allowed roots`,
        { pathAllowed: false, sourcePolicy: 'allowed_roots' },
        { sourcePath: candidate },
      );
    }

    // 敏感判定：逻辑名 + realpath 双查
    const sensitiveHit =
      findSensitiveHit(raw, candidate) || findSensitiveHit(basename(logical), logical);
    if (sensitiveHit) {
      await reject(
        `SENSITIVE_PATH: blocked by policy (${sensitiveHit})`,
        {
          pathAllowed: true,
          sensitiveHit,
          sourcePolicy: 'sensitive_blocklist',
        },
        { sourcePath: candidate },
      );
    }

    let sizeBytes = 0;
    try {
      const st = await stat(candidate);
      if (!st.isFile()) {
        await reject(
          `not a file: ${basename(candidate)}`,
          { pathAllowed: true, sensitiveHit: null },
          { sourcePath: candidate },
        );
      }
      sizeBytes = st.size;
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.startsWith('invalid_arguments') ||
          err.message.startsWith('PATH_FORBIDDEN') ||
          err.message.startsWith('SENSITIVE'))
      ) {
        throw err;
      }
      await reject(
        `file not found: ${basename(candidate)}`,
        { pathAllowed: true, sensitiveHit: null },
        { sourcePath: candidate },
      );
    }

    if (sizeBytes > this.maxBytes) {
      await reject(
        `file too large: ${sizeBytes} bytes (max ${this.maxBytes})`,
        {
          pathAllowed: true,
          sensitiveHit: null,
          sourcePolicy: 'max_size',
        },
        { sourcePath: candidate, sizeBytes },
      );
    }

    const attachmentRoot = input.allowedRoots.find((r) => /attachments$/i.test(r));
    const sourceKind = classifySourceKind(candidate, attachmentRoot);
    const name = (input.name?.trim() || basename(candidate)).slice(0, 256);
    const mime = detectMime(candidate);
    const fileId = makeFileId();
    const now = Date.now();

    const record: FileReleaseRecord = {
      fileId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      runId: input.runId,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      name,
      mime,
      sizeBytes,
      absPath: candidate,
      sourceKind,
      sourcePathDisplay: raw,
      purpose: input.purpose,
      createdAt: now,
    };

    await this.appendAudit({
      id: makeAuditId(),
      type: 'file.released',
      at: now,
      sessionId: input.sessionId,
      agentId: input.agentId,
      runId: input.runId,
      fileId,
      name,
      mime,
      sizeBytes,
      sourcePath: raw,
      sourceKind,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      clientInstanceId: input.clientInstanceId,
      purpose: input.purpose,
      policy: {
        pathAllowed: true,
        sensitiveHit: null,
        sourcePolicy: sourceKind,
      },
    });

    this.records.set(fileId, record);
    ids.add(fileId);
    this.pruneIndexes(input.sessionId);

    await this.queuePersist(input.sessionId);

    return {
      fileRef: { fileId, name, mime, sizeBytes },
      record,
    };
  }

  /**
   * 打开已 release 文件（支持 Range 头）。返回 FileHandle，由调用方 close。
   * 未授权 / 源丢失 / Range 不可满足 → { ok:false } 并写审计。
   */
  async readContent(
    sessionId: string,
    fileId: string,
    options?: {
      /** 原始 Range 头（如 `bytes=0-9`）；由 parseRangeHeader 统一解析 */
      rangeHeader?: string;
      clientInstanceId?: string;
    },
  ): Promise<ReadContentResult> {
    const clientInstanceId = options?.clientInstanceId;
    await this.hydrateSession(sessionId);
    const rec = this.get(fileId, sessionId);
    if (!rec) {
      await this.appendAudit({
        id: makeAuditId(),
        type: 'file.denied',
        at: Date.now(),
        sessionId,
        fileId,
        clientInstanceId,
        reason: 'not_released_or_wrong_session',
      });
      return { ok: false, reason: 'not_found' };
    }

    let handle: FileHandle;
    try {
      handle = await open(rec.absPath, 'r');
    } catch {
      await this.appendAudit({
        id: makeAuditId(),
        type: 'file.denied',
        at: Date.now(),
        sessionId,
        fileId,
        name: rec.name,
        clientInstanceId,
        reason: 'source_missing',
      });
      return { ok: false, reason: 'source_missing' };
    }

    try {
      const st = await handle.stat();
      const totalSize = st.size;
      const parsed = parseRangeHeader(options?.rangeHeader, totalSize);
      if (parsed === 'unsatisfiable') {
        await handle.close();
        await this.appendAudit({
          id: makeAuditId(),
          type: 'file.denied',
          at: Date.now(),
          sessionId,
          fileId,
          name: rec.name,
          clientInstanceId,
          reason: 'unsatisfiable_range',
        });
        return { ok: false, reason: 'unsatisfiable', totalSize };
      }

      const ranged = parsed != null;
      const start = parsed ? parsed.start : 0;
      const end = parsed ? parsed.end : totalSize - 1;
      if (!ranged && totalSize === 0) {
        await this.appendAudit({
          id: makeAuditId(),
          type: 'file.fetched',
          at: Date.now(),
          sessionId,
          agentId: rec.agentId || undefined,
          runId: rec.runId,
          fileId,
          name: rec.name,
          mime: rec.mime,
          sizeBytes: 0,
          sourcePath: rec.sourcePathDisplay,
          sourceKind: rec.sourceKind,
          toolName: rec.toolName,
          clientInstanceId,
        });
        return { ok: true, record: rec, totalSize: 0, start: 0, end: -1, ranged: false, handle };
      }

      await this.appendAudit({
        id: makeAuditId(),
        type: 'file.fetched',
        at: Date.now(),
        sessionId,
        agentId: rec.agentId || undefined,
        runId: rec.runId,
        fileId,
        name: rec.name,
        mime: rec.mime,
        sizeBytes: totalSize,
        sourcePath: rec.sourcePathDisplay,
        sourceKind: rec.sourceKind,
        toolName: rec.toolName,
        clientInstanceId,
        range: ranged ? { start, end } : undefined,
      });

      return { ok: true, record: rec, totalSize, start, end, ranged, handle };
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  }

  private pruneIndexes(sessionId: string): void {
    const ids = this.bySession.get(sessionId);
    if (!ids || ids.size <= this.maxIndexEntries) return;
    const ordered = [...ids]
      .map((id) => this.records.get(id))
      .filter((r): r is FileReleaseRecord => Boolean(r))
      .sort((a, b) => a.createdAt - b.createdAt);
    const drop = ordered.slice(0, ids.size - this.maxIndexEntries);
    for (const r of drop) {
      ids.delete(r.fileId);
      this.records.delete(r.fileId);
    }
  }

  private async queuePersist(sessionId: string): Promise<void> {
    const prev = this.persistQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const entries = (await this.listSessionReleases(sessionId)).map((r) => ({
        fileId: r.fileId,
        name: r.name,
        mime: r.mime,
        sizeBytes: r.sizeBytes,
        absPath: r.absPath,
        sourcePathDisplay: r.sourcePathDisplay,
        sourceKind: r.sourceKind,
        toolName: r.toolName,
        createdAt: r.createdAt,
      }));
      await this.persistIndex(sessionId, entries);
    });
    this.persistQueues.set(
      sessionId,
      next.catch(() => {}),
    );
    await next;
  }

  private async appendAudit(event: FileAuditEvent): Promise<void> {
    const day = new Date(event.at).toISOString().slice(0, 10);
    const dir = join(this.auditDir, 'files');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${day}.jsonl`);
    // fail-closed：审计写失败向上抛，release 不得静默成功
    await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
  }

  /** 仅测试：清空内存（不删审计文件） */
  resetForTests(): void {
    this.records.clear();
    this.bySession.clear();
    this.hydrating.clear();
    this.persistQueues.clear();
  }
}
