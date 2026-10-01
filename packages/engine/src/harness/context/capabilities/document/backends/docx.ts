/**
 * DOCX 后端 — mammoth（可选依赖，T0）→ HTML → Markdown
 *
 * @module harness/context/capabilities/document/backends/docx
 */

import { DocumentExtractError } from '../errors.js';
import { htmlFragmentToMarkdown } from '../html-to-md.js';
import type {
  DocumentExtractBackend,
  ExtractOptions,
  ExtractResult,
  ResolvedExtractSource,
} from '../types.js';

type MammothModule = {
  convertToHtml: (
    input: { buffer: Buffer },
    options?: Record<string, unknown>,
  ) => Promise<{ value: string; messages: Array<{ message: string }> }>;
};

let cached: MammothModule | null | undefined;

async function loadMammoth(): Promise<MammothModule | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import('mammoth')) as unknown as MammothModule;
    if (typeof mod.convertToHtml !== 'function') {
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

export const docxMammothBackend: DocumentExtractBackend = {
  id: 'docx-mammoth',
  tier: 't0',
  formats: ['docx'],
  async isAvailable() {
    return (await loadMammoth()) !== null;
  },
  accepts({ format }) {
    return format === 'docx';
  },
  async extract(source: ResolvedExtractSource, _options: ExtractOptions): Promise<ExtractResult> {
    const mammoth = await loadMammoth();
    if (!mammoth) {
      throw new DocumentExtractError('BACKEND_UNAVAILABLE', 'mammoth is not installed', [
        'optional:mammoth',
      ]);
    }

    const buffer = Buffer.from(source.data);
    try {
      const result = await mammoth.convertToHtml({ buffer });
      const markdown = htmlFragmentToMarkdown(result.value);
      const warnings: ExtractResult['warnings'] = (result.messages ?? []).map((m) => ({
        code: 'PARTIAL_EXTRACT' as const,
        message: m.message,
      }));
      return {
        markdown,
        meta: { format: 'docx' },
        warnings,
        backend: 'docx-mammoth',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/password|encrypt/i.test(msg)) {
        throw new DocumentExtractError('PASSWORD_REQUIRED', 'DOCX requires a password');
      }
      throw new DocumentExtractError('INVALID_SOURCE', `DOCX extract failed: ${msg}`);
    }
  },
};
