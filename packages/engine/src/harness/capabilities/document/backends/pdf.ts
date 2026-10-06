/**
 * PDF 后端 — unpdf（可选依赖，T0）
 *
 * @module harness/capabilities/document/backends/pdf
 */

import { DocumentExtractError } from '../errors.js';
import type {
  DocumentExtractBackend,
  ExtractOptions,
  ExtractResult,
  ResolvedExtractSource,
} from '../types.js';

type UnpdfModule = {
  getDocumentProxy: (
    data: Uint8Array,
    options?: { password?: string },
  ) => Promise<unknown>;
  extractText: (
    pdf: unknown,
    opts?: { mergePages?: boolean },
  ) => Promise<{ totalPages: number; text: string | string[] }>;
  getMeta: (pdf: unknown) => Promise<{ info: Record<string, unknown> }>;
};

let cached: UnpdfModule | null | undefined;

async function loadUnpdf(): Promise<UnpdfModule | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import('unpdf')) as unknown as UnpdfModule;
    if (typeof mod.getDocumentProxy !== 'function' || typeof mod.extractText !== 'function') {
      cached = null;
      return null;
    }
    cached = mod;
    return mod;
  } catch {
    // 可选依赖未安装 —— 缓存 null，调用方走 BACKEND_UNAVAILABLE
    cached = null;
    return null;
  }
}

export const pdfUnpdfBackend: DocumentExtractBackend = {
  id: 'pdf-unpdf',
  tier: 't0',
  formats: ['pdf'],
  async isAvailable() {
    return (await loadUnpdf()) !== null;
  },
  accepts({ format }) {
    return format === 'pdf';
  },
  async extract(source: ResolvedExtractSource, options: ExtractOptions): Promise<ExtractResult> {
    const unpdf = await loadUnpdf();
    if (!unpdf) {
      throw new DocumentExtractError('BACKEND_UNAVAILABLE', 'unpdf is not installed', [
        'optional:unpdf',
      ]);
    }

    const warnings: ExtractResult['warnings'] = [];
    if (options.ocr) {
      warnings.push({
        code: 'OCR_UNAVAILABLE',
        message: 'pdf-unpdf extracts text layer only; enable enhanced OCR backend if needed',
      });
    }

    try {
      const pdf = await unpdf.getDocumentProxy(source.data, {
        ...(source.password ? { password: source.password } : {}),
      });
      // mergePages:false → 按页数组，便于 maxPages 截断
      const { totalPages, text } = await unpdf.extractText(pdf, { mergePages: false });
      let title: string | undefined;
      let author: string | undefined;
      try {
        const meta = await unpdf.getMeta(pdf);
        title = meta.info?.Title != null ? String(meta.info.Title) : undefined;
        author = meta.info?.Author != null ? String(meta.info.Author) : undefined;
      } catch {
        // metadata is optional; extraction result remains usable
      }

      const pages = Array.isArray(text) ? text : [text];
      const maxPages =
        options.maxPages && options.maxPages > 0 ? options.maxPages : pages.length;
      const usedPages = pages.slice(0, Math.min(maxPages, pages.length));
      if (usedPages.length < totalPages) {
        warnings.push({
          code: 'PARTIAL_EXTRACT',
          message: `pages truncated: ${usedPages.length}/${totalPages} (maxPages=${options.maxPages})`,
        });
      }

      const markdown = usedPages.join('\n\n');
      return {
        markdown,
        meta: {
          format: 'pdf',
          pages: totalPages,
          title,
          author,
        },
        warnings,
        backend: 'pdf-unpdf',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/password/i.test(msg)) {
        throw new DocumentExtractError('PASSWORD_REQUIRED', 'PDF requires a password');
      }
      throw new DocumentExtractError('INVALID_SOURCE', `PDF extract failed: ${msg}`);
    }
  },
};
