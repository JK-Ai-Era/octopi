/**
 * 纯文本 / Markdown / CSV 后端（无外部依赖）
 *
 * @module harness/context/capabilities/document/backends/plain
 */

import type {
  DocumentExtractBackend,
  ExtractOptions,
  ExtractResult,
  ResolvedExtractSource,
} from '../types.js';

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(data);
}

function looksLikeBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8000);
  for (let i = 0; i < n; i++) {
    if (data[i] === 0) return true;
  }
  return false;
}

export const plainTextBackend: DocumentExtractBackend = {
  id: 'plain-text',
  tier: 't0',
  formats: ['txt', 'md', 'csv', 'html'],
  async isAvailable() {
    return true;
  },
  accepts({ format }) {
    return format === 'txt' || format === 'md' || format === 'csv' || format === 'html';
  },
  async extract(source: ResolvedExtractSource, options: ExtractOptions): Promise<ExtractResult> {
    if (looksLikeBinary(source.data)) {
      const { DocumentExtractError } = await import('../errors.js');
      throw new DocumentExtractError('INVALID_SOURCE', 'plain-text backend received binary data');
    }
    let text = decodeUtf8(source.data);
    const warnings: ExtractResult['warnings'] = [];
    const maxChars = options.maxTextChars && options.maxTextChars > 0 ? options.maxTextChars : 0;
    if (maxChars > 0 && text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n\n…[truncated: ${text.length - maxChars} chars omitted]`;
      warnings.push({
        code: 'PARTIAL_EXTRACT',
        message: `text truncated to maxTextChars=${maxChars}`,
      });
    }
    const format = source.formatHint ?? 'txt';
    // html 原样保留标签交给 knowledge htmlAdapter；此处仅保证可读文本
    return {
      markdown: text,
      meta: { format },
      warnings,
      backend: 'plain-text',
    };
  },
};
