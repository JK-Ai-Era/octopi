/**
 * Session 附件私有关键词投影 — 默认本地召回，不注册 Knowledge source。
 *
 * 原件与 manifest 是权威；本投影可由抽取文本重建，生命周期随 attachments root。
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  codeAdapter,
  FormatAdapterRegistry,
  markdownAdapter,
  textAdapter,
  type FormatAdapter,
} from '../../knowledge/adapters.js';
import {
  scoreKeywordCoverage,
  tokenizeKeywordDetail,
} from '../../memory/sqlite/keyword-search.js';
import type { SessionAttachment } from './types.js';

const INDEX_FILE = '.recall-index.json';
const INDEX_VERSION = 1;
const MAX_INDEXED_CHARS = 25 * 1024 * 1024;

export interface AttachmentRecallChunk {
  ordinal: number;
  text: string;
  startLine: number;
  endLine: number;
  symbol?: string;
}

export interface AttachmentRecallHit extends AttachmentRecallChunk {
  attachmentId: string;
  attachmentName: string;
  score: number;
}

interface IndexedAttachment {
  name: string;
  fingerprint: string;
  chunks: AttachmentRecallChunk[];
}

interface AttachmentRecallIndexData {
  version: typeof INDEX_VERSION;
  attachments: Record<string, IndexedAttachment>;
}

/**
 * 有界、可重建的附件关键词索引；调用方负责传入同一 Session 的附件。
 */
export class SessionAttachmentRecallIndex {
  private readonly root: string;
  private readonly path: string;
  private readonly adapters = new FormatAdapterRegistry([
    textAdapter,
    markdownAdapter,
    codeAdapter,
  ]);

  constructor(root: string) {
    this.root = root;
    this.path = join(root, INDEX_FILE);
  }

  /**
   * 用完整抽取文本覆盖单附件索引；不读取截断文本做索引。
   *
   * @param attachment - 已解析的附件登记
   * @param text - 完整抽取文本
   * @param sourcePath - 原附件逻辑路径，用于选择格式 adapter
   */
  async upsert(
    attachment: SessionAttachment,
    text: string,
    sourcePath: string,
  ): Promise<void> {
    if (text.length > MAX_INDEXED_CHARS) {
      throw new Error('attachment extract exceeds local recall index limit');
    }
    const adapter = this.adapters.match(sourcePath) ?? textAdapter;
    const next = await this.loadForWrite();
    if (text.length === 0) {
      delete next.attachments[attachment.id];
    } else {
      next.attachments[attachment.id] = {
        name: attachment.name,
        fingerprint: attachmentExtractHash(attachment, text),
        chunks: chunksForIndex(adapter, text, sourcePath),
      };
    }
    await this.persist(next);
  }

  /**
   * 删除单附件的本地投影。
   *
   * @param attachmentId - 附件 id
   */
  async remove(attachmentId: string): Promise<void> {
    const next = await this.loadForWrite();
    if (!(attachmentId in next.attachments)) return;
    delete next.attachments[attachmentId];
    await this.persist(next);
  }

  /** 删除整个 Session 的本地投影。 */
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  /**
   * 从权威抽取文本完整重建投影。调用方须收集全部成功后原子替换。
   *
   * @param items - 附件与完整抽取文本；缺项表示该附件没有可索引文本
   */
  async rebuild(items: Array<{ attachment: SessionAttachment; text: string; sourcePath: string }>): Promise<void> {
    const next: AttachmentRecallIndexData = { version: INDEX_VERSION, attachments: {} };
    for (const { attachment, text, sourcePath } of items) {
      if (text.length > MAX_INDEXED_CHARS) {
        throw new Error('attachment extract exceeds local recall index limit');
      }
      if (text.length === 0) continue;
      const adapter = this.adapters.match(sourcePath) ?? textAdapter;
      next.attachments[attachment.id] = {
        name: attachment.name,
        fingerprint: attachmentExtractHash(attachment, text),
        chunks: chunksForIndex(adapter, text, sourcePath),
      };
    }
    await this.persist(next);
  }

  /**
   * 仅查询已落盘投影；缺失/损坏/指纹不符返回 null，由注入层回退 structure_tools。
   *
   * @param query - LLM 分流给出的 focus 或用户正文
   * @param attachments - 本轮可见附件；此处仅缩范围，不扩大权限
   * @param limit - 全局 top-k 条数
   * @returns 有完整有效索引时的关键词命中；不可召回时 null
   */
  async search(
    query: string,
    attachments: SessionAttachment[],
    limit: number,
  ): Promise<AttachmentRecallHit[] | null> {
    const tokens = tokenizeKeywordDetail(query);
    if (tokens.all.length === 0 || attachments.length === 0 || limit <= 0) return [];
    const data = await this.load();
    for (const attachment of attachments) {
      const indexed = data.attachments[attachment.id];
      if (!indexed || !this.matchesExtract(attachment, indexed.fingerprint)) return null;
    }

    const hits: AttachmentRecallHit[] = [];
    for (const attachment of attachments) {
      const indexed = data.attachments[attachment.id]!;
      for (const chunk of indexed.chunks) {
        const score = scoreKeywordCoverage(
          { content: chunk.text, tags: [attachment.name, chunk.symbol ?? ''] },
          tokens,
        );
        if (score > 0) {
          hits.push({
            ...chunk,
            attachmentId: attachment.id,
            attachmentName: attachment.name,
            score,
          });
        }
      }
    }
    return hits
      .sort((a, b) =>
        b.score - a.score ||
        a.attachmentName.localeCompare(b.attachmentName) ||
        a.ordinal - b.ordinal)
      .slice(0, limit);
  }

  private async load(): Promise<AttachmentRecallIndexData> {
    if (!existsSync(this.path)) {
      throw new Error('attachment recall index unavailable');
    }
    return this.read();
  }

  /** 首次创建允许空投影；已有文件损坏不得被当作空表覆盖。 */
  private async loadForWrite(): Promise<AttachmentRecallIndexData> {
    if (!existsSync(this.path)) return { version: INDEX_VERSION, attachments: {} };
    return this.read();
  }

  private read(): AttachmentRecallIndexData {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!isIndexData(parsed)) throw new Error('invalid attachment recall index');
      return parsed;
    } catch (err) {
      throw new Error(
        `attachment recall index unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 正常代次只读 stat；变化时读全文验指纹，旧 manifest 缺代次不静默信任。 */
  private matchesExtract(attachment: SessionAttachment, indexedHash: string): boolean {
    const parse = attachment.parse;
    if (!attachment.extractPath || !parse?.extractHash ||
        parse.extractBytes == null || parse.extractMtimeMs == null || parse.extractCtimeMs == null) {
      return false;
    }
    try {
      const stat = statSync(join(this.root, attachment.extractPath));
      if (stat.size !== parse.extractBytes) return false;
      if (stat.mtimeMs === parse.extractMtimeMs &&
          stat.ctimeMs === parse.extractCtimeMs) {
        return indexedHash === parse.extractHash;
      }
      const text = readFileSync(join(this.root, attachment.extractPath), 'utf8');
      return indexedHash === attachmentExtractHash(attachment, text);
    } catch {
      // 抽取文件缺失/不可读时没有权威依据，召回回退结构。
      return false;
    }
  }

  private async persist(data: AttachmentRecallIndexData): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, this.path);
  }
}

/** Knowledge 的 codeAdapter 会跳过超长行；附件索引必须保留全部可检索文本。 */
function chunksForIndex(
  adapter: FormatAdapter,
  text: string,
  sourcePath: string,
): AttachmentRecallChunk[] {
  if (adapter.id !== 'code-tree' || !text.split('\n').some((line) => line.length > 2400)) {
    return adapter.chunk(text, sourcePath).map((chunk) => ({
      ordinal: chunk.ordinal,
      text: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      ...(chunk.symbol ? { symbol: chunk.symbol } : {}),
    }));
  }
  return textAdapter.chunk(text, sourcePath);
}

export function attachmentExtractHash(attachment: SessionAttachment, text: string): string {
  return createHash('sha256')
    .update(attachment.contentHash)
    .update('\0')
    .update(text)
    .digest('hex');
}

function isIndexData(value: unknown): value is AttachmentRecallIndexData {
  if (value == null || typeof value !== 'object') return false;
  const data = value as Partial<AttachmentRecallIndexData>;
  if (data.version !== INDEX_VERSION || data.attachments == null || typeof data.attachments !== 'object') {
    return false;
  }
  return Object.values(data.attachments).every((item) =>
    typeof item.name === 'string' &&
    typeof item.fingerprint === 'string' &&
    Array.isArray(item.chunks) &&
    item.chunks.every((chunk) =>
      Number.isInteger(chunk.ordinal) &&
      Number.isInteger(chunk.startLine) &&
      Number.isInteger(chunk.endLine) &&
      typeof chunk.text === 'string'));
}
