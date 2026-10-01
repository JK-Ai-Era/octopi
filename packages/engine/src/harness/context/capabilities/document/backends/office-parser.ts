/**
 * PPTX / 长尾后端 — officeparser（可选依赖，T0 长尾）
 *
 * @module harness/context/capabilities/document/backends/office-parser
 */

import { DocumentExtractError } from '../errors.js';
import type {
  DocumentExtractBackend,
  ExtractOptions,
  ExtractResult,
  ResolvedExtractSource,
} from '../types.js';

type OfficeParserModule = {
  OfficeParser?: {
    parseOffice: (
      data: Uint8Array,
      config?: Record<string, unknown>,
    ) => Promise<{
      to: (fmt: 'md' | 'text') => Promise<{ value: string }>;
      metadata?: Record<string, unknown>;
    }>;
  };
  parseOffice?: (
    data: Uint8Array,
    config?: Record<string, unknown>,
  ) => Promise<{
    to: (fmt: 'md' | 'text') => Promise<{ value: string }>;
    metadata?: Record<string, unknown>;
  }>;
};

let cached: OfficeParserModule | null | undefined;

async function loadOfficeParser(): Promise<OfficeParserModule | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import('officeparser')) as unknown as OfficeParserModule;
    const parse = mod.OfficeParser?.parseOffice ?? mod.parseOffice;
    if (typeof parse !== 'function') {
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

const FORMATS = ['pptx', 'odt', 'ods', 'odp', 'odg', 'epub', 'tex', 'rtf'] as const;

export const officeParserBackend: DocumentExtractBackend = {
  id: 'office-parser',
  tier: 't0',
  formats: [...FORMATS],
  async isAvailable() {
    return (await loadOfficeParser()) !== null;
  },
  accepts({ format }) {
    return (FORMATS as readonly string[]).includes(format);
  },
  async extract(source: ResolvedExtractSource, options: ExtractOptions): Promise<ExtractResult> {
    const mod = await loadOfficeParser();
    const parse = mod?.OfficeParser?.parseOffice ?? mod?.parseOffice;
    if (!mod || typeof parse !== 'function') {
      throw new DocumentExtractError('BACKEND_UNAVAILABLE', 'officeparser is not installed', [
        'optional:officeparser',
      ]);
    }

    const warnings: ExtractResult['warnings'] = [];
    if (options.ocr) {
      warnings.push({
        code: 'OCR_UNAVAILABLE',
        message: 'officeparser OCR requires ocr+extractAttachments; not enabled in P0',
      });
    }

    try {
      const ast = await parse(source.data, { fileType: source.formatHint });
      const { value } = await ast.to('md');
      return {
        markdown: value,
        meta: {
          format: source.formatHint ?? 'unknown',
          title:
            ast.metadata?.title != null && typeof ast.metadata.title === 'string'
              ? ast.metadata.title
              : undefined,
        },
        warnings,
        backend: 'office-parser',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/password/i.test(msg)) {
        throw new DocumentExtractError('PASSWORD_REQUIRED', 'document requires a password');
      }
      throw new DocumentExtractError('INVALID_SOURCE', `officeparser extract failed: ${msg}`);
    }
  },
};
