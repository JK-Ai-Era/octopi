/**
 * createDefaultDocumentPort — DocumentPort 工厂 / 默认路由
 *
 * @module harness/capabilities/document/port
 */

import { open, readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DocumentExtractError, isDocumentExtractError } from './errors.js';
import { LEGACY_FORMATS, formatFromMagic, isDocumentPath, resolveFormat } from './format.js';
import { docxMammothBackend } from './backends/docx.js';
import { officeParserBackend } from './backends/office-parser.js';
import { plainTextBackend } from './backends/plain.js';
import { pdfUnpdfBackend } from './backends/pdf.js';
import { sheetXlsxBackend } from './backends/sheet.js';
import { xmindBackend } from './backends/xmind.js';
import type {
  CreateDocumentPortOptions,
  DocumentCapabilities,
  DocumentExtractBackend,
  DocumentFormatHint,
  DocumentPort,
  DocumentPortConfig,
  ExtractOptions,
  ExtractResult,
  ExtractSource,
  ExtractTier,
  FormatSupportLevel,
  ProbeResult,
  ResolvedExtractSource,
} from './types.js';

const DEFAULT_CONFIG: Required<Pick<DocumentPortConfig, 'enabled' | 'timeoutMs' | 'maxFileBytes'>> =
  {
    enabled: true,
    timeoutMs: 30_000,
    maxFileBytes: 50 * 1024 * 1024,
  };

const ALL_FORMATS: DocumentFormatHint[] = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
  'rtf',
  'odt',
  'ods',
  'odp',
  'odg',
  'html',
  'md',
  'csv',
  'txt',
  'epub',
  'tex',
  'xmind',
  'unknown',
];

/**
 * 默认 T0 后端集合（依赖缺失时 isAvailable=false）
 *
 * @returns 后端列表（plain / unpdf / mammoth / sheet / office-parser）
 */
export function createDefaultBackends(): DocumentExtractBackend[] {
  return [
    plainTextBackend,
    pdfUnpdfBackend,
    docxMammothBackend,
    sheetXlsxBackend,
    officeParserBackend,
    xmindBackend,
  ];
}

function tierOrder(tier: ExtractTier | undefined): Array<'t0' | 't1' | 't2'> {
  if (tier === 't0') return ['t0'];
  if (tier === 't1') return ['t1', 't0'];
  if (tier === 't2') return ['t2', 't1', 't0'];
  return ['t0', 't1', 't2'];
}

async function resolveBytes(
  source: ExtractSource,
  config: DocumentPortConfig,
  extractOptions?: ExtractOptions,
): Promise<{ data: Uint8Array; name?: string }> {
  const maxBytes =
    extractOptions?.maxFileBytes ?? config.maxFileBytes ?? DEFAULT_CONFIG.maxFileBytes;

  if (source.data) {
    if (source.data.byteLength > maxBytes) {
      throw new DocumentExtractError(
        'FILE_TOO_LARGE',
        `document exceeds maxFileBytes (${maxBytes})`,
      );
    }
    return { data: source.data, name: source.name };
  }

  if (!source.path) {
    throw new DocumentExtractError('INVALID_SOURCE', 'extract source requires path or data');
  }

  const abs = resolve(source.path);
  if (config.allowedRoots?.length) {
    // Windows 路径比较须大小写不敏感（对齐 platform.isUnderAttachmentRoot）
    const win = process.platform === 'win32';
    const norm = (s: string) => (win ? resolve(s).toLowerCase() : resolve(s));
    const p = norm(abs);
    const ok = config.allowedRoots.some((root) => {
      const r = norm(root);
      const prefix = r.endsWith(sep) ? r : r + sep;
      return p === r || p.startsWith(prefix);
    });
    if (!ok) {
      throw new DocumentExtractError('PATH_FORBIDDEN', `path not under allowedRoots: ${abs}`);
    }
  }

  const st = await stat(abs);
  if (!st.isFile()) {
    throw new DocumentExtractError('INVALID_SOURCE', `not a file: ${abs}`);
  }
  if (st.size > maxBytes) {
    throw new DocumentExtractError('FILE_TOO_LARGE', `document exceeds maxFileBytes (${maxBytes})`);
  }

  const data = new Uint8Array(await readFile(abs));
  return { data, name: source.name ?? abs };
}

/**
 * 创建 DocumentPort
 *
 * @param options - config / backends / legacyConverter
 * @returns DocumentPort
 */
export function createDefaultDocumentPort(options: CreateDocumentPortOptions = {}): DocumentPort {
  const config: DocumentPortConfig = { ...DEFAULT_CONFIG, ...options.config };
  const backends = options.backends ?? createDefaultBackends();
  const legacy = options.legacyConverter ?? null;
  const capsTtl = options.capabilitiesTtlMs ?? 5 * 60_000;

  let capsCache: { at: number; value: DocumentCapabilities; available: Set<string> } | null = null;

  async function availableBackendIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const b of backends) {
      try {
        if (await b.isAvailable()) ids.add(b.id);
      } catch {
        // 依赖探测失败 = 该后端不可用，不阻断其它后端
      }
    }
    return ids;
  }

  async function loadCapabilities(force = false): Promise<{
    caps: DocumentCapabilities;
    available: Set<string>;
  }> {
    const now = Date.now();
    if (!force && capsCache && now - capsCache.at < capsTtl) {
      return { caps: capsCache.value, available: capsCache.available };
    }

    const available = await availableBackendIds();
    let legacyAvailable = false;
    if (legacy) {
      try {
        legacyAvailable = await legacy.isAvailable();
      } catch {
        legacyAvailable = false;
      }
    }

    const formats = {} as DocumentCapabilities['formats'];
    for (const f of ALL_FORMATS) {
      if (LEGACY_FORMATS.has(f) && f !== 'xls') {
        formats[f] = legacyAvailable
          ? { level: 'via-converter', backend: legacy?.id, notes: 'legacy gate' }
          : { level: 'none', notes: 'requires legacy-converter' };
        continue;
      }

      const match = backends.find((b) => b.formats.includes(f) && available.has(b.id));
      if (match) {
        formats[f] = {
          level: match.tier === 't0' ? 'native' : match.tier === 't1' ? 'via-enhanced' : 'via-cloud',
          backend: match.id,
        };
        continue;
      }

      // xls 可由 sheet backend 直读；若无则看转换闸门
      if (f === 'xls' && legacyAvailable) {
        formats[f] = { level: 'via-converter', backend: legacy?.id };
        continue;
      }
      formats[f] = { level: 'none' };
    }

    const caps: DocumentCapabilities = {
      formats,
      ocr: false,
      legacyConverter: legacy ? (legacyAvailable ? (legacy.id as 'soffice' | 'remote') : 'none') : 'none',
      tiers: {
        t0: true,
        t1: backends.some((b) => b.tier === 't1' && available.has(b.id)),
        t2: backends.some((b) => b.tier === 't2' && available.has(b.id)),
      },
    };

    capsCache = { at: now, value: caps, available };
    return { caps, available };
  }

  function pickBackends(
    format: DocumentFormatHint,
    available: Set<string>,
    tiers: Array<'t0' | 't1' | 't2'>,
  ): DocumentExtractBackend[] {
    const out: DocumentExtractBackend[] = [];
    for (const tier of tiers) {
      for (const b of backends) {
        if (b.tier === tier && b.formats.includes(format) && available.has(b.id)) {
          out.push(b);
        }
      }
    }
    return out;
  }

  function levelOf(backend: DocumentExtractBackend): FormatSupportLevel {
    return backend.tier === 't0' ? 'native' : backend.tier === 't1' ? 'via-enhanced' : 'via-cloud';
  }

  /** 仅读文件头做嗅探（probe 不读全文件） */
  async function readHead(path: string, n = 8): Promise<Uint8Array> {
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await handle.read(buf, 0, n, 0);
      return new Uint8Array(buf.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  return {
    async capabilities(): Promise<DocumentCapabilities> {
      const { caps } = await loadCapabilities();
      return caps;
    },

    async probe(source: ExtractSource): Promise<ProbeResult> {
      let head: Uint8Array | undefined;
      let name = source.name ?? source.path;
      if (source.data) {
        head = source.data.subarray(0, 8);
      } else if (source.path) {
        head = await readHead(resolve(source.path), 8);
        name = source.name ?? source.path;
      } else {
        throw new DocumentExtractError('INVALID_SOURCE', 'probe requires path or data');
      }

      let format = resolveFormat(source, head);
      if (format === 'unknown') format = formatFromMagic(head);
      if (format === 'unknown' && name && isDocumentPath(name)) {
        format = resolveFormat({ name }, head);
      }

      const { caps, available } = await loadCapabilities();
      if (LEGACY_FORMATS.has(format) && format !== 'xls') {
        return { format, level: caps.formats[format]?.level ?? 'none' };
      }
      const candidates = pickBackends(format, available, ['t0', 't1', 't2']);
      const first = candidates[0];
      return {
        format,
        level: first
          ? levelOf(first)
          : (caps.formats[format]?.level ?? 'none'),
      };
    },

    async extract(source: ExtractSource, extractOptions: ExtractOptions = {}): Promise<ExtractResult> {
      if (config.enabled === false) {
        throw new DocumentExtractError('BACKEND_UNAVAILABLE', 'document extract is disabled');
      }

      const { data, name } = await resolveBytes(source, config, extractOptions);
      const head = data.subarray(0, 8);
      let format = resolveFormat(source, head);
      if (format === 'unknown') {
        format = formatFromMagic(head);
      }

      const timeoutMs = extractOptions.timeoutMs ?? config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs;
      const warnings: ExtractResult['warnings'] = [];

      const needsLegacy =
        (LEGACY_FORMATS.has(format) && format !== 'xls') ||
        (format === 'xls' && !(await hasBackendFor('xls')));

      if (needsLegacy) {
        if (!legacy) {
          throw new DocumentExtractError(
            'UNSUPPORTED_LEGACY',
            `legacy format .${format} requires a converter`,
            ['legacy-converter'],
          );
        }
        let available = false;
        try {
          available = await legacy.isAvailable();
        } catch {
          // probe failure = converter unavailable
          available = false;
        }
        if (!available) {
          throw new DocumentExtractError(
            'UNSUPPORTED_LEGACY',
            `legacy converter unavailable for .${format}`,
            ['legacy-converter'],
          );
        }
        const target = format === 'doc' ? 'docx' : format === 'xls' ? 'xlsx' : 'pptx';
        const converted = await legacy.convert(
          { data, name, formatHint: format },
          target,
        );
        return runExtract({
          data: converted.data,
          name: name ? name.replace(/\.[^.]+$/, `.${target}`) : undefined,
          formatHint: target,
          password: source.password,
          extractOptions,
          timeoutMs,
          warnings,
          legacyConversion:
            converted.meta.legacyConversion ?? {
              from: format,
              converter: legacy.id,
              cached: false,
            },
        });
      }

      return runExtract({
        data,
        name,
        formatHint: format,
        password: source.password,
        extractOptions,
        timeoutMs,
        warnings,
      });

      async function hasBackendFor(fmt: DocumentFormatHint): Promise<boolean> {
        const { available } = await loadCapabilities();
        return pickBackends(fmt, available, ['t0', 't1', 't2']).length > 0;
      }

      async function runExtract(args: {
        data: Uint8Array;
        name?: string;
        formatHint: DocumentFormatHint;
        password?: string;
        extractOptions: ExtractOptions;
        timeoutMs: number;
        warnings: ExtractResult['warnings'];
        legacyConversion?: ExtractResult['meta']['legacyConversion'];
      }): Promise<ExtractResult> {
        const { available } = await loadCapabilities();
        const tiers = tierOrder(args.extractOptions.tier);
        const candidates = pickBackends(args.formatHint, available, tiers);

        if (candidates.length === 0 && args.formatHint === 'unknown') {
          throw new DocumentExtractError('UNSUPPORTED_FORMAT', 'unable to detect document format');
        }
        if (candidates.length === 0) {
          throw new DocumentExtractError(
            'UNSUPPORTED_FORMAT',
            `no available backend for format ${args.formatHint}`,
            args.formatHint === 'pdf' || args.formatHint === 'docx'
              ? ['optional:unpdf', 'optional:mammoth']
              : undefined,
          );
        }

        const resolved: ResolvedExtractSource = {
          name: args.name,
          data: args.data,
          formatHint: args.formatHint,
          password: args.password,
        };

        let lastErr: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const backend = candidates[i];
          const isFallback = i > 0;
          try {
            const result = await withTimeout(
              backend.extract(resolved, args.extractOptions),
              args.timeoutMs,
              args.extractOptions.signal,
            );
            return {
              ...result,
              degraded: isFallback ? true : result.degraded,
              warnings: [
                ...args.warnings,
                ...(isFallback
                  ? [
                      {
                        code: 'DEGRADED_BACKEND' as const,
                        message: `fell back to ${backend.id}`,
                      },
                    ]
                  : []),
                ...result.warnings,
              ],
              meta: args.legacyConversion
                ? { ...result.meta, legacyConversion: args.legacyConversion }
                : result.meta,
            };
          } catch (err) {
            lastErr = err;
            // 密码/超大等结构化错误不换后端；其余失败尝试下一档
            if (isDocumentExtractError(err) && err.code !== 'BACKEND_UNAVAILABLE') {
              if (i === candidates.length - 1) throw err;
            }
            if (i === candidates.length - 1) {
              if (isDocumentExtractError(err)) throw err;
              throw lastErr;
            }
          }
        }
        throw isDocumentExtractError(lastErr)
          ? lastErr
          : new DocumentExtractError(
              'BACKEND_UNAVAILABLE',
              lastErr instanceof Error ? lastErr.message : String(lastErr),
            );
      }
    },
  };
}

/**
 * 带超时/取消的竞速；超时后对源 promise 吞掉后续 rejection（工作无法真正取消）
 *
 * @param promise - 后端抽取
 * @param timeoutMs - 超时毫秒
 * @param signal - 可选 AbortSignal
 * @returns 结果或 TIMEOUT 错误
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new DocumentExtractError('TIMEOUT', 'extract aborted');
  }
  // 超时后 backend 仍可能 reject：挂 no-op catch 防 unhandledRejection
  promise.catch(() => {
    // abandoned after timeout — already surfaced as TIMEOUT
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => {
          reject(new DocumentExtractError('TIMEOUT', `extract timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        signal?.addEventListener(
          'abort',
          () => {
            reject(new DocumentExtractError('TIMEOUT', 'extract aborted'));
          },
          { once: true },
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

