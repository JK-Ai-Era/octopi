/**
 * 电子表格后端 — SheetJS `xlsx`（可选依赖，T0；覆盖 xlsx + xls）
 *
 * @module harness/context/capabilities/document/backends/sheet
 */

import { DocumentExtractError } from '../errors.js';
import type {
  DocumentExtractBackend,
  ExtractOptions,
  ExtractResult,
  ResolvedExtractSource,
} from '../types.js';

type SheetRow = Array<string | number | boolean | null | undefined>;

type XlsxModule = {
  read: (data: Uint8Array, opts?: Record<string, unknown>) => {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: {
    sheet_to_json: (sheet: unknown, opts?: { header?: 1; raw?: boolean; defval?: string }) => SheetRow[];
  };
};

let cached: XlsxModule | null | undefined;

async function loadXlsx(): Promise<XlsxModule | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import('xlsx')) as unknown as XlsxModule;
    if (typeof mod.read !== 'function' || !mod.utils?.sheet_to_json) {
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

function cellToText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  return String(v).replace(/\|/g, '\\|');
}

function sheetToMarkdown(rows: SheetRow[]): string {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const copy: string[] = [];
    for (let i = 0; i < width; i++) copy.push(cellToText(r[i]));
    return copy;
  });
  const lines = [
    `| ${norm[0].join(' | ')} |`,
    `| ${norm[0].map(() => '---').join(' | ')} |`,
    ...norm.slice(1).map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

export const sheetXlsxBackend: DocumentExtractBackend = {
  id: 'sheet-xlsx',
  tier: 't0',
  formats: ['xlsx', 'xls'],
  async isAvailable() {
    return (await loadXlsx()) !== null;
  },
  accepts({ format }) {
    return format === 'xlsx' || format === 'xls';
  },
  async extract(source: ResolvedExtractSource, _options: ExtractOptions): Promise<ExtractResult> {
    const xlsx = await loadXlsx();
    if (!xlsx) {
      throw new DocumentExtractError('BACKEND_UNAVAILABLE', 'xlsx (SheetJS) is not installed', [
        'optional:xlsx',
      ]);
    }

    let wb: ReturnType<XlsxModule['read']>;
    try {
      wb = xlsx.read(source.data, { type: 'array', cellDates: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DocumentExtractError('INVALID_SOURCE', `Spreadsheet extract failed: ${msg}`);
    }

    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
      parts.push(`## ${name}\n\n${sheetToMarkdown(rows)}`);
    }

    return {
      markdown: parts.join('\n\n'),
      meta: {
        format: source.formatHint === 'xls' ? 'xls' : 'xlsx',
      },
      warnings: [],
      backend: 'sheet-xlsx',
    };
  },
};
