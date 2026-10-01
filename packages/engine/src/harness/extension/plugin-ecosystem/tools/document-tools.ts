/**
 * document_read / document_probe 工具 — DocumentPort 薄封装
 *
 * 只消费 DocumentPort；业务/设计知识留在 skill。
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import { resolveReadableToolPath } from './platform.js';

type DocumentPortLike = {
  extract(
    source: { path?: string; name?: string },
    options?: { timeoutMs?: number; ocr?: boolean },
  ): Promise<{
    markdown: string;
    meta: { format: string; pages?: number; title?: string };
    warnings: Array<{ code: string; message: string }>;
    backend: string;
    degraded?: boolean;
  }>;
  capabilities(): Promise<{
    formats: Record<string, { level: string; backend?: string }>;
    ocr: boolean;
    legacyConverter?: string;
  }>;
  probe(source: { path?: string; name?: string }): Promise<{ format: string; level: string }>;
};

export interface DocumentToolOptions {
  documentPort?: DocumentPortLike | null;
  summary?: import('../../../context/capabilities/summary/index.js').ToolSummarySupport;
  /** document_read 默认截断（字符） */
  maxReturnChars?: number;
}

/**
 * document_read — 抽取 PDF/Office 为 Markdown
 *
 * @param options - documentPort / summary / maxReturnChars
 * @returns RegisteredTool
 */
export function createDocumentReadTool(options?: DocumentToolOptions): RegisteredTool {
  return {
    definition: {
      name: 'document_read',
      description:
        'Extract PDF/Office (docx/xlsx/pptx/legacy) to Markdown for reading. Prefer this over shell converters.',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to the document',
          required: true,
        },
        ocr: {
          type: 'boolean',
          description: 'Request OCR for scanned pages (if backend supports it)',
        },
        max_chars: {
          type: 'number',
          description: 'Soft cap on returned markdown (default 20000)',
        },
        summarize: {
          type: 'string',
          description: 'Summary mode after extract: auto | force | off',
          enum: ['auto', 'force', 'off'],
        },
      },
    },
    handler: async (args, context) => {
      const port = options?.documentPort;
      if (!port) {
        throw new Error(
          'document_read unavailable: DocumentPort is not configured (documents.extract.enabled)',
        );
      }
      const rawPath = String(args.path ?? '');
      const cwd = context?.cwd ?? process.cwd();
      const path = resolveReadableToolPath(rawPath, cwd, context?.attachmentRoots);

      try {
        const result = await port.extract({
          path,
          name: path,
        }, {
          ocr: args.ocr === true,
        });

        const maxChars = (args.max_chars as number) ?? options?.maxReturnChars ?? 20_000;
        let body = result.markdown;
        let truncated = false;
        if (body.length > maxChars) {
          body = body.slice(0, maxChars);
          truncated = true;
        }

        const { applyToolOutputGate, resolveSupportBinding } = await import(
          '../../../context/capabilities/summary/index.js'
        );
        const support = options?.summary;
        const binding = resolveSupportBinding('document_read', support, maxChars);
        const applied = await applyToolOutputGate({
          tool: 'document_read',
          rawBody: body,
          support: { ...support, binding },
          locator: path,
          kind: 'document',
          summarizeArg: args.summarize as 'auto' | 'force' | 'off' | undefined,
          truncateHint: 'Extract is truncated; raise max_chars or use summarize=force for an overview.',
        });

        return {
          content: applied.body,
          format: result.meta.format,
          pages: result.meta.pages,
          title: result.meta.title,
          backend: result.backend,
          degraded: result.degraded ?? false,
          warnings: result.warnings,
          truncated: truncated || applied.bodyTruncated,
          rawLength: applied.rawLength,
          summary: applied.summary,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const code =
          typeof error === 'object' && error && 'code' in error
            ? String((error as { code: unknown }).code)
            : undefined;
        const requires =
          typeof error === 'object' && error && 'requires' in error
            ? (error as { requires?: string[] }).requires
            : undefined;
        return {
          error: true,
          code,
          requires,
          message: `document_read failed for "${path}": ${msg}`,
        };
      }
    },
  };
}

/**
 * document_probe — 轻量探测格式与可读性
 *
 * @param options - documentPort
 * @returns RegisteredTool
 */
export function createDocumentProbeTool(options?: DocumentToolOptions): RegisteredTool {
  return {
    definition: {
      name: 'document_probe',
      description:
        'Detect document format and whether this deployment can extract it (without full parse).',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to the document',
          required: true,
        },
      },
    },
    handler: async (args, context) => {
      const port = options?.documentPort;
      if (!port) {
        return {
          available: false,
          reason: 'DocumentPort is not configured',
        };
      }
      const rawPath = String(args.path ?? '');
      const cwd = context?.cwd ?? process.cwd();
      const path = resolveReadableToolPath(rawPath, cwd, context?.attachmentRoots);
      try {
        const probe = await port.probe({ path, name: path });
        const caps = await port.capabilities();
        return {
          path,
          format: probe.format,
          level: probe.level,
          extractable: probe.level !== 'none',
          backend: caps.formats[probe.format]?.backend,
          ocr: caps.ocr,
          legacyConverter: caps.legacyConverter,
        };
      } catch (error) {
        return {
          error: true,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
