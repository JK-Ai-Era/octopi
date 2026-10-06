/**
 * Document 公用能力 — 类型契约
 *
 * 读路径统一抽取为 Markdown；写路径不进本 Port。
 *
 * @module harness/capabilities/document/types
 */

/** 品牌 ID：后端名 / 转换器名 */
export type DocumentBackendId = string;

export type DocumentFormatHint =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'doc'
  | 'xls'
  | 'ppt'
  | 'rtf'
  | 'odt'
  | 'ods'
  | 'odp'
  | 'odg'
  | 'html'
  | 'md'
  | 'csv'
  | 'txt'
  | 'epub'
  | 'tex'
  | 'xmind'
  | 'unknown';

export interface ExtractSource {
  /** 本地路径（首选；调用方负责 toolIsolation / attachments root 约束） */
  path?: string;
  /** 或字节流（上传附件等） */
  data?: Uint8Array;
  /** 逻辑名（用于格式嗅探与 meta） */
  name?: string;
  /** 强制格式；缺省按扩展名 + magic */
  formatHint?: DocumentFormatHint;
  /** 加密文档密码（不落盘、不进日志） */
  password?: string;
}

export type ExtractTier = 'auto' | 't0' | 't1' | 't2';

export interface ExtractOptions {
  /** 页/表范围等；后端可忽略并 warn */
  pageRange?: string;
  /** 是否请求 OCR（无 OCR 后端时 warn 并继续文本层） */
  ocr?: boolean;
  /** 硬超时 ms */
  timeoutMs?: number;
  /** 仅用某档；默认 auto = t0 → t1 → t2 */
  tier?: ExtractTier;
  /** 取消 / 会话级 abort */
  signal?: AbortSignal;
  /** 本次调用的大小闸门（覆盖 port 配置；知识索引 partial 用） */
  maxFileBytes?: number;
  /** 部分抽取：xlsx 最大 sheet 数 */
  maxSheets?: number;
  /** 部分抽取：xlsx 每 sheet 最大行数 */
  maxRowsPerSheet?: number;
  /** 部分抽取：pdf 最大页数 */
  maxPages?: number;
  /** 部分抽取：纯文本最大字符数 */
  maxTextChars?: number;
}

export interface DocumentMeta {
  format: DocumentFormatHint;
  pages?: number;
  title?: string;
  author?: string;
  language?: string;
  /** 云/增强后端结构化字段 */
  fields?: Record<string, string>;
  /** 老格式转换记录 */
  legacyConversion?: {
    from: DocumentFormatHint;
    converter: string;
    cached: boolean;
  };
}

export type ExtractWarningCode =
  | 'OCR_UNAVAILABLE'
  | 'OCR_FAILED'
  | 'PARTIAL_EXTRACT'
  | 'LEGACY_CONVERTER_MISSING'
  | 'LEGACY_CONVERT_FAILED'
  | 'PASSWORD_REQUIRED'
  | 'PASSWORD_INCORRECT'
  | 'DEGRADED_BACKEND'
  | 'TIMEOUT'
  | 'RESOURCE_LIMIT';

export interface ExtractWarning {
  code: ExtractWarningCode;
  message: string;
}

export type ExtractErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_LEGACY'
  | 'PASSWORD_REQUIRED'
  | 'PASSWORD_INCORRECT'
  | 'FILE_TOO_LARGE'
  | 'TIMEOUT'
  | 'BACKEND_UNAVAILABLE'
  | 'INVALID_SOURCE'
  | 'PATH_FORBIDDEN';

export interface ExtractResult {
  /** 统一契约：Markdown */
  markdown: string;
  meta: DocumentMeta;
  warnings: ExtractWarning[];
  /** 实际使用的后端，便于诊断 */
  backend: DocumentBackendId;
  /** true = 降级完成（如 T1 不可用退回 T0） */
  degraded?: boolean;
}

export type FormatSupportLevel =
  | 'native'
  | 'via-converter'
  | 'via-enhanced'
  | 'via-cloud'
  | 'none';

export interface DocumentCapabilities {
  formats: Record<
    DocumentFormatHint,
    {
      level: FormatSupportLevel;
      backend?: DocumentBackendId;
      notes?: string;
    }
  >;
  ocr: boolean;
  legacyConverter?: 'soffice' | 'remote' | 'none';
  tiers: { t0: true; t1: boolean; t2: boolean };
}

export interface ProbeResult {
  format: DocumentFormatHint;
  level: FormatSupportLevel;
}

export interface DocumentPort {
  /**
   * 抽取为 Markdown。
   *
   * @param source - 路径或字节流
   * @param options - 页范围 / OCR / 超时 / 档位
   * @throws DocumentExtractError 不可用/不支持/密码错误等结构化失败
   */
  extract(source: ExtractSource, options?: ExtractOptions): Promise<ExtractResult>;

  /** 探测本部署能力（可缓存；后端变更时失效） */
  capabilities(): Promise<DocumentCapabilities>;

  /**
   * 是否接受该输入（轻量，不完整解析）。
   *
   * @param source - 路径或字节流
   * @returns 格式与建议层级；不接受则 level: 'none'
   */
  probe(source: ExtractSource): Promise<ProbeResult>;
}

/** 老格式 → 中间态转换器（P1 接入；接口先定） */
export interface LegacyConverter {
  id: 'soffice' | 'remote' | string;
  isAvailable(): Promise<boolean>;
  convert(
    source: ExtractSource,
    target: 'docx' | 'xlsx' | 'pptx' | 'pdf',
  ): Promise<{ data: Uint8Array; meta: DocumentMeta }>;
}

export type DocumentExtractBackendTier = 't0' | 't1' | 't2';

export interface BackendAcceptInput {
  format: DocumentFormatHint;
  name?: string;
  head?: Uint8Array;
}

export interface DocumentExtractBackend {
  id: DocumentBackendId;
  tier: DocumentExtractBackendTier;
  formats: DocumentFormatHint[];
  /** 运行时是否可用（依赖、二进制、凭据） */
  isAvailable(): Promise<boolean>;
  accepts(input: BackendAcceptInput): boolean;
  extract(source: ResolvedExtractSource, options: ExtractOptions): Promise<ExtractResult>;
}

/** 路由后交给后端的输入：保证有 bytes */
export interface ResolvedExtractSource {
  name?: string;
  data: Uint8Array;
  formatHint?: DocumentFormatHint;
  password?: string;
}

export interface DocumentPortConfig {
  enabled?: boolean;
  timeoutMs?: number;
  maxFileBytes?: number;
  /** 路径允许根；未设置则不限制（由调用方约束） */
  allowedRoots?: string[];
}

export interface CreateDocumentPortOptions {
  config?: DocumentPortConfig;
  backends?: DocumentExtractBackend[];
  legacyConverter?: LegacyConverter | null;
  /** 能力缓存 TTL ms（默认 5min） */
  capabilitiesTtlMs?: number;
}
