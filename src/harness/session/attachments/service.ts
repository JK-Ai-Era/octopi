/**
 * SessionAttachmentService — 会话附件权威登记 + 落盘
 *
 * 规格：arch/knowledge-session-attachments.md
 * 数据面：OCTOPI_HOME/sessions/&lt;sid&gt;/attachments/
 * 原则：原件 + .manifest.json 为权威；抽取/索引可重建。
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveSessionAttachmentsPaths } from './paths.js';
import { attachmentExtension, isPathInside, sanitizeAttachmentName } from './sanitize.js';
import {
  classifyAttachmentKind,
  extractText,
  isPlainReadable,
} from './extract.js';
import {
  DEFAULT_ATTACHMENT_LIMITS,
  type AttachmentLimits,
  type AttachmentManifest,
  type AttachmentUploadInput,
  type SessionAttachment,
} from './types.js';

export interface SessionAttachmentServiceOptions {
  /** 通常 `OCTOPI_HOME/sessions` */
  sessionsDir: string;
  limits?: Partial<AttachmentLimits>;
}

export class SessionAttachmentService {
  private readonly sessionsDir: string;
  private readonly limits: AttachmentLimits;

  /**
   * @param options - sessionsDir + 可选限额覆盖
   */
  constructor(options: SessionAttachmentServiceOptions) {
    this.sessionsDir = options.sessionsDir;
    // 只合并已定义字段：`{ ...defaults, allowedExtensions: undefined }` 会把默认值抹掉
    const o = options.limits ?? {};
    this.limits = {
      maxFiles: o.maxFiles ?? DEFAULT_ATTACHMENT_LIMITS.maxFiles,
      maxFileBytes: o.maxFileBytes ?? DEFAULT_ATTACHMENT_LIMITS.maxFileBytes,
      maxTotalBytes: o.maxTotalBytes ?? DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes,
      allowedExtensions:
        o.allowedExtensions && o.allowedExtensions.length > 0
          ? o.allowedExtensions
          : DEFAULT_ATTACHMENT_LIMITS.allowedExtensions,
    };
  }

  get limitsConfig(): AttachmentLimits {
    return { ...this.limits };
  }

  /**
   * 某会话附件根（只读工具面也可用）
   *
   * @param sessionId - 会话 id
   */
  attachmentRoot(sessionId: string): string {
    return resolveSessionAttachmentsPaths(this.sessionsDir, sessionId).root;
  }

  /**
   * 列出附件（不含 promoted）
   *
   * @param sessionId - 会话 id
   */
  list(sessionId: string): SessionAttachment[] {
    return this.readManifest(sessionId).items.filter((i) => i.status !== 'promoted');
  }

  /**
   * 列出全部（含 promoted，审计用）
   *
   * @param sessionId - 会话 id
   */
  listAll(sessionId: string): SessionAttachment[] {
    return this.readManifest(sessionId).items;
  }

  /**
   * 单条查询
   *
   * @param sessionId - 会话 id
   * @param attachmentId - 附件 id
   */
  get(sessionId: string, attachmentId: string): SessionAttachment | null {
    return this.readManifest(sessionId).items.find((i) => i.id === attachmentId) ?? null;
  }

  /**
   * 保存上传附件（同步落盘 + 解析可读文本）
   *
   * @param sessionId - 会话 id
   * @param input - 文件名 + 内容
   * @throws 超限 / 类型不允许
   */
  async save(sessionId: string, input: AttachmentUploadInput): Promise<SessionAttachment> {
    const name = sanitizeAttachmentName(input.name);
    const ext = attachmentExtension(name);
    if (this.limits.allowedExtensions.length > 0 && ext && !this.limits.allowedExtensions.includes(ext)) {
      throw new Error(`file type not allowed: ${ext}`);
    }
    if (!ext && this.limits.allowedExtensions.length > 0) {
      throw new Error('file type not allowed: missing extension');
    }

    const data = Buffer.isBuffer(input.data)
      ? input.data
      : typeof input.data === 'string'
        ? Buffer.from(input.data, 'utf8')
        : Buffer.from(input.data);
    if (data.byteLength > this.limits.maxFileBytes) {
      throw new Error(`file exceeds maxFileBytes (${this.limits.maxFileBytes})`);
    }

    const manifest = this.readManifest(sessionId);
    const live = manifest.items.filter((i) => i.status !== 'promoted');
    if (live.length >= this.limits.maxFiles) {
      throw new Error(`too many attachments (max ${this.limits.maxFiles})`);
    }
    const total = live.reduce((s, i) => s + i.sizeBytes, 0) + data.byteLength;
    if (total > this.limits.maxTotalBytes) {
      throw new Error(`attachments exceed maxTotalBytes (${this.limits.maxTotalBytes})`);
    }

    const root = this.attachmentRoot(sessionId);
    await mkdir(root, { recursive: true });

    const uniqueName = this.uniqueName(live, name);
    const abs = join(root, uniqueName);
    if (!isPathInside(root, abs)) {
      throw new Error('invalid attachment path');
    }
    await writeFile(abs, data);

    const kind = classifyAttachmentKind(uniqueName);
    const contentHash = createHash('sha256').update(data).digest('hex');
    const item: SessionAttachment = {
      id: `att_${randomUUID().slice(0, 12)}`,
      name: uniqueName,
      mime: input.mime ?? guessMime(uniqueName),
      sizeBytes: data.byteLength,
      contentHash: `sha256:${contentHash}`,
      path: uniqueName,
      status: 'ready',
      kind,
      createdAt: Date.now(),
    };

    if (isPlainReadable(kind, uniqueName)) {
      item.extractPath = uniqueName;
      const extracted = extractText(data, uniqueName, kind);
      if (extracted) {
        item.status = 'parsed';
        item.parse = { ok: true, chars: extracted.chars };
      } else {
        item.status = 'parse_failed';
        item.parse = { ok: false, error: 'binary content in text extension' };
      }
    } else if (kind === 'image') {
      item.status = 'ready';
    } else {
      item.status = 'ready';
      item.parse = { ok: false, error: 'no extractor for this type (see OP adapter)' };
    }

    manifest.items.push(item);
    await this.writeManifest(sessionId, manifest);
    return item;
  }

  /**
   * 删除附件（原件 + 伴生 + manifest 条目）
   *
   * @param sessionId - 会话 id
   * @param attachmentId - 附件 id
   */
  async delete(sessionId: string, attachmentId: string): Promise<boolean> {
    const manifest = this.readManifest(sessionId);
    const idx = manifest.items.findIndex((i) => i.id === attachmentId);
    if (idx < 0) return false;
    const item = manifest.items[idx];
    if (item.status === 'promoted') {
      throw new Error('attachment already promoted; delete from project source');
    }
    const root = this.attachmentRoot(sessionId);
    const absFile = join(root, item.path);
    if (!isPathInside(root, absFile)) {
      throw new Error('invalid attachment path in manifest');
    }
    await safeUnlink(absFile);
    if (item.extractPath && item.extractPath !== item.path) {
      const absExtract = join(root, item.extractPath);
      if (isPathInside(root, absExtract)) {
        await safeUnlink(absExtract);
      }
    }
    manifest.items.splice(idx, 1);
    await this.writeManifest(sessionId, manifest);
    return true;
  }

  /**
   * 会话删除 / 归档清理：移除整个附件目录
   *
   * @param sessionId - 会话 id
   */
  async deleteAll(sessionId: string): Promise<void> {
    const root = this.attachmentRoot(sessionId);
    await rm(root, { recursive: true, force: true });
  }

  /**
   * 标记已绑定可检索 source
   *
   * @param sessionId - 会话 id
   * @param attachmentId - 附件 id
   * @param sourceId - Knowledge source id
   */
  async markSearchable(
    sessionId: string,
    attachmentId: string,
    sourceId: string,
  ): Promise<SessionAttachment> {
    const manifest = this.readManifest(sessionId);
    const item = manifest.items.find((i) => i.id === attachmentId);
    if (!item) throw new Error(`attachment not found: ${attachmentId}`);
    item.searchableSourceId = sourceId;
    await this.writeManifest(sessionId, manifest);
    return item;
  }

  /**
   * 标记已归入项目（文件移出后调用）
   *
   * @param sessionId - 会话 id
   * @param attachmentId - 附件 id
   * @param info - 项目信息
   */
  async markPromoted(
    sessionId: string,
    attachmentId: string,
    info: { projectKey: string; targetSourceId?: string },
  ): Promise<SessionAttachment> {
    const manifest = this.readManifest(sessionId);
    const item = manifest.items.find((i) => i.id === attachmentId);
    if (!item) throw new Error(`attachment not found: ${attachmentId}`);
    item.status = 'promoted';
    item.promoted = { ...info, at: Date.now() };
    await this.writeManifest(sessionId, manifest);
    return item;
  }

  /**
   * 绝对路径（工具 / promote 用）
   *
   * @param sessionId - 会话 id
   * @param attachmentId - 附件 id
   */
  resolveAbsolutePath(sessionId: string, attachmentId: string): string {
    const item = this.get(sessionId, attachmentId);
    if (!item) throw new Error(`attachment not found: ${attachmentId}`);
    const root = this.attachmentRoot(sessionId);
    const abs = join(root, item.path);
    if (!isPathInside(root, abs)) throw new Error('invalid attachment path');
    return abs;
  }

  /**
   * 读取抽取/原文文本（注入用）
   *
   * @param sessionId - 会话 id
   * @param attachmentId - 附件 id
   * @param maxChars - 截断上限
   */
  readExtractedText(sessionId: string, attachmentId: string, maxChars?: number): string | null {
    const item = this.get(sessionId, attachmentId);
    if (!item) return null;
    const rel = item.extractPath ?? item.path;
    const root = this.attachmentRoot(sessionId);
    const abs = join(root, rel);
    if (!isPathInside(root, abs)) return null;
    try {
      const text = readFileSync(abs, 'utf8');
      return maxChars != null ? text.slice(0, maxChars) : text;
    } catch {
      return null;
    }
  }

  private uniqueName(live: SessionAttachment[], name: string): string {
    const taken = new Set(live.map((i) => i.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const ext = attachmentExtension(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${stem}_${n}${ext}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${stem}_${randomUUID().slice(0, 6)}${ext}`;
  }

  private readManifest(sessionId: string): AttachmentManifest {
    const { manifestPath } = resolveSessionAttachmentsPaths(this.sessionsDir, sessionId);
    try {
      const raw = readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as AttachmentManifest;
      return { sessionId, version: 1, items: parsed.items ?? [] };
    } catch {
      return { sessionId, version: 1, items: [] };
    }
  }

  private async writeManifest(sessionId: string, manifest: AttachmentManifest): Promise<void> {
    const { root, manifestPath } = resolveSessionAttachmentsPaths(this.sessionsDir, sessionId);
    await mkdir(root, { recursive: true });
    const tmp = `${manifestPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 2));
    await rename(tmp, manifestPath);
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // 删除失败不阻断 manifest 更新；文件系统残留由 session 清理兜底
  }
}

function guessMime(name: string): string {
  const ext = attachmentExtension(name);
  const map: Record<string, string> = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.html': 'text/html',
    '.ts': 'text/typescript',
    '.js': 'text/javascript',
    '.py': 'text/x-python',
  };
  return map[ext] ?? 'application/octet-stream';
}
