/**
 * Knowledge 索引文件限额 — 按格式分级上限 + 部分抽取
 *
 * 业务原则：大文件优先 **部分入索引** 而非整文件 skip；
 * 压缩包等容器不抽；媒体走「无适配器」默认跳过（后续可加适配器）。
 *
 * @module
 */

import { extname } from 'node:path';

export type KnowledgeFileKind = 'text' | 'pdf' | 'officeDoc' | 'sheet' | 'other';

export type OversizePolicy = 'partial' | 'skip';

export interface KnowledgeFileLimits {
  /** 超过格式上限时：partial=截断入索引（默认）；skip=整文件跳过 */
  oversize: OversizePolicy;
  /** 未归类 / 兜底单文件上限 */
  maxFileBytes: number;
  /** 绝对内存闸门（partial 也拒绝）；防止 worker 被超大文件打爆 */
  hardMaxFileBytes: number;
  maxBytes: {
    text: number;
    pdf: number;
    officeDoc: number;
    sheet: number;
  };
  partial: {
    maxSheets: number;
    maxRowsPerSheet: number;
    maxPdfPages: number;
    maxTextChars: number;
  };
  /** parse 基超时 */
  parseTimeoutMs: number;
  /** 每 MB 追加超时 */
  parseTimeoutPerMBMs: number;
  maxParseTimeoutMs: number;
}

export type KnowledgeFileLimitsInput = {
  oversize?: OversizePolicy;
  maxFileBytes?: number;
  hardMaxFileBytes?: number;
  maxBytes?: Partial<KnowledgeFileLimits['maxBytes']>;
  partial?: Partial<KnowledgeFileLimits['partial']>;
  parseTimeoutMs?: number;
  parseTimeoutPerMBMs?: number;
  maxParseTimeoutMs?: number;
};

/**
 * 推荐缺省（可按机器资源在 knowledge.index.files 覆盖）。
 *
 * - pptx/docx 体积多为图片，文本抽取可放宽到 200MB
 * - xlsx 全量 SheetJS 进内存，50MB 起步；超限走 partial
 * - pdf 50MB；text 20MB
 * - hardMax 256MB：partial 尝试的绝对上限
 */
export const DEFAULT_KNOWLEDGE_FILE_LIMITS: KnowledgeFileLimits = {
  oversize: 'partial',
  maxFileBytes: 50_000_000,
  hardMaxFileBytes: 256 * 1024 * 1024,
  maxBytes: {
    text: 20_000_000,
    pdf: 50_000_000,
    officeDoc: 200_000_000,
    sheet: 50_000_000,
  },
  partial: {
    maxSheets: 20,
    maxRowsPerSheet: 5_000,
    maxPdfPages: 200,
    maxTextChars: 2_000_000,
  },
  parseTimeoutMs: 45_000,
  parseTimeoutPerMBMs: 5_000,
  maxParseTimeoutMs: 300_000,
};

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.mdx',
  '.csv',
  '.json',
  '.jsonl',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.log',
  '.xml',
  '.html',
  '.htm',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.sql',
  '.sh',
  '.ps1',
  '.css',
  '.scss',
]);

const OFFICE_DOC_EXT = new Set([
  '.docx',
  '.pptx',
  '.doc',
  '.ppt',
  '.odt',
  '.odp',
  '.rtf',
  '.xmind',
  '.epub',
  '.tex',
]);

const SHEET_EXT = new Set(['.xlsx', '.xls', '.ods', '.xlsm']);

/** 按扩展名归类（媒体/压缩包等归 other → 无适配器时跳过） */
export function classifyFileKind(filePath: string): KnowledgeFileKind {
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXT.has(ext)) return 'text';
  if (ext === '.pdf') return 'pdf';
  if (OFFICE_DOC_EXT.has(ext)) return 'officeDoc';
  if (SHEET_EXT.has(ext)) return 'sheet';
  return 'other';
}

export function resolveKnowledgeFileLimits(
  input?: KnowledgeFileLimitsInput,
): KnowledgeFileLimits {
  const d = DEFAULT_KNOWLEDGE_FILE_LIMITS;
  return {
    oversize: input?.oversize ?? d.oversize,
    maxFileBytes: input?.maxFileBytes ?? d.maxFileBytes,
    hardMaxFileBytes: input?.hardMaxFileBytes ?? d.hardMaxFileBytes,
    maxBytes: {
      text: input?.maxBytes?.text ?? d.maxBytes.text,
      pdf: input?.maxBytes?.pdf ?? d.maxBytes.pdf,
      officeDoc: input?.maxBytes?.officeDoc ?? d.maxBytes.officeDoc,
      sheet: input?.maxBytes?.sheet ?? d.maxBytes.sheet,
    },
    partial: {
      maxSheets: input?.partial?.maxSheets ?? d.partial.maxSheets,
      maxRowsPerSheet: input?.partial?.maxRowsPerSheet ?? d.partial.maxRowsPerSheet,
      maxPdfPages: input?.partial?.maxPdfPages ?? d.partial.maxPdfPages,
      maxTextChars: input?.partial?.maxTextChars ?? d.partial.maxTextChars,
    },
    parseTimeoutMs: input?.parseTimeoutMs ?? d.parseTimeoutMs,
    parseTimeoutPerMBMs: input?.parseTimeoutPerMBMs ?? d.parseTimeoutPerMBMs,
    maxParseTimeoutMs: input?.maxParseTimeoutMs ?? d.maxParseTimeoutMs,
  };
}

/** 该格式的单文件上限 */
export function formatMaxBytes(
  limits: KnowledgeFileLimits,
  kind: KnowledgeFileKind,
): number {
  if (kind === 'text') return limits.maxBytes.text;
  if (kind === 'pdf') return limits.maxBytes.pdf;
  if (kind === 'officeDoc') return limits.maxBytes.officeDoc;
  if (kind === 'sheet') return limits.maxBytes.sheet;
  return limits.maxFileBytes;
}

export type SizeDecision =
  | { action: 'ok' }
  | { action: 'partial'; reason: 'oversize_soft' }
  | { action: 'skip'; reason: 'oversize_hard' | 'oversize_skip' };

/**
 * 按尺寸裁决：ok / partial / skip
 *
 * @param size - 文件字节数
 * @param kind - 格式类别
 * @param limits - 已解析限额
 */
export function decideBySize(
  size: number,
  kind: KnowledgeFileKind,
  limits: KnowledgeFileLimits,
): SizeDecision {
  if (size > limits.hardMaxFileBytes) {
    return { action: 'skip', reason: 'oversize_hard' };
  }
  const soft = formatMaxBytes(limits, kind);
  if (size <= soft) return { action: 'ok' };
  if (limits.oversize === 'skip') return { action: 'skip', reason: 'oversize_skip' };
  return { action: 'partial', reason: 'oversize_soft' };
}

/** parse 超时随体积放大（封顶 maxParseTimeoutMs） */
export function parseTimeoutForSize(
  size: number,
  limits: KnowledgeFileLimits,
): number {
  const mb = Math.max(0, size / (1024 * 1024));
  const t = limits.parseTimeoutMs + mb * limits.parseTimeoutPerMBMs;
  return Math.min(limits.maxParseTimeoutMs, Math.ceil(t));
}

/**
 * skip 是否值得再解析（配置调宽 / 新策略后重试）。
 *
 * - `ignored_path` / `no_adapter`：压缩包与媒体等，无适配器前不重试
 * - `oversize*`：可重试；`oversize_hard` 仅当 size 已落入当前 hardMax（或 size 未知）
 * - `empty_content`：可重试
 */
export function isRetryableSkipReason(
  reason: string | null | undefined,
  size: number,
  limits: KnowledgeFileLimits,
): boolean {
  if (!reason) return false;
  if (reason === 'empty_content') return true;
  if (!reason.startsWith('oversize')) return false;
  if (reason === 'oversize_hard') {
    // size=0 多为历史脏数据（未记录体积），允许重试一次以写入真实 size
    return size <= 0 || size <= limits.hardMaxFileBytes;
  }
  return true;
}
