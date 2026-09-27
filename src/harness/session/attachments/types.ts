/**
 * 会话附件类型 — Session 资产（非 Knowledge source）
 *
 * 规格：arch/knowledge-session-attachments.md
 */

export type AttachmentStatus =
  | 'ready'
  | 'parsing'
  | 'parsed'
  | 'parse_failed'
  | 'promoted';

export type AttachmentKind = 'document' | 'image' | 'text' | 'code' | 'other';

export interface AttachmentParseInfo {
  ok: boolean;
  chars?: number;
  error?: string;
}

/** 单条会话附件（manifest 条目） */
export interface SessionAttachment {
  id: string;
  /** 展示名（已消毒后的安全文件名） */
  name: string;
  mime: string;
  sizeBytes: number;
  /** sha256 hex */
  contentHash: string;
  /** attachments 目录内相对路径 */
  path: string;
  /** 抽取文本相对路径；文本类可与 path 相同 */
  extractPath?: string;
  status: AttachmentStatus;
  kind: AttachmentKind;
  createdAt: number;
  parse?: AttachmentParseInfo;
  /** 升为可检索后绑定的 Knowledge source（scopeRef: session） */
  searchableSourceId?: string;
  promoted?: {
    projectKey: string;
    targetSourceId?: string;
    at: number;
  };
}

export interface AttachmentManifest {
  sessionId: string;
  version: 1;
  items: SessionAttachment[];
}

export interface AttachmentUploadInput {
  /** 原始文件名（将消毒） */
  name: string;
  mime?: string;
  /** 文件内容 */
  data: Buffer | Uint8Array | string;
}

export interface AttachmentLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  allowedExtensions: string[];
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFiles: 8,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  allowedExtensions: [
    '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.yaml', '.yml',
    '.pdf', '.docx', '.xlsx', '.pptx',
    '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
    '.c', '.cc', '.cpp', '.h', '.hpp', '.html', '.css', '.sql', '.sh', '.bash', '.ps1',
  ],
};

/** 注入计划（意图初判产物；arch §6.3.1） */
export type AttachmentInjectMode =
  | 'full'
  | 'structure_tools'
  | 'recall_tools'
  | 'overview_tools';

export interface AttachmentInjectPlan {
  mode: AttachmentInjectMode;
  focus?: string;
  targets?: string[];
  reason: string;
}
