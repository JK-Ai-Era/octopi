/**
 * document_read / document_probe 工具 — DocumentPort 薄封装行为
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultDocumentPort } from '../../../packages/engine/src/harness/capabilities/document/index.js';
import type {
  DocumentExtractBackend,
  ExtractResult,
} from '../../../packages/engine/src/harness/capabilities/document/types.js';
import {
  createDocumentProbeTool,
  createDocumentReadTool,
} from '../../../packages/engine/src/harness/extension/plugin-ecosystem/tools/document-tools.js';
import { getBuiltinTools } from '../../../packages/engine/src/harness/extension/plugin-ecosystem/tools/builtin.js';

function stubBackend(): DocumentExtractBackend {
  return {
    id: 'stub',
    tier: 't0',
    formats: ['pdf'],
    async isAvailable() {
      return true;
    },
    accepts: ({ format }) => format === 'pdf',
    async extract(): Promise<ExtractResult> {
      return {
        markdown: '# Doc body\n\ncontent here',
        meta: { format: 'pdf', pages: 2 },
        warnings: [],
        backend: 'stub',
      };
    },
  };
}

describe('document tools', () => {
  it('are registered only when documentPort is provided', () => {
    const without = getBuiltinTools();
    expect(without.some((t) => t.definition.name === 'document_read')).toBe(false);
    const withPort = getBuiltinTools({
      documentPort: createDefaultDocumentPort({ backends: [stubBackend()] }),
    });
    expect(withPort.some((t) => t.definition.name === 'document_read')).toBe(true);
    expect(withPort.some((t) => t.definition.name === 'document_probe')).toBe(true);
  });

  it('document_read returns markdown via port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'octopi-doc-tool-'));
    try {
      const file = join(dir, 'a.pdf');
      await writeFile(file, Buffer.from('%PDF-1.4'));
      const port = createDefaultDocumentPort({ backends: [stubBackend()] });
      const tool = createDocumentReadTool({ documentPort: port });
      const result = (await tool.handler(
        { path: file },
        { cwd: dir } as never,
      )) as Record<string, unknown>;
      expect(result.error).toBeUndefined();
      expect(String(result.content)).toContain('Doc body');
      expect(result.backend).toBe('stub');
      expect(result.pages).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('document_probe reports format and level', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'octopi-doc-tool-'));
    try {
      const file = join(dir, 'a.pdf');
      await writeFile(file, Buffer.from('%PDF-1.4'));
      const port = createDefaultDocumentPort({ backends: [stubBackend()] });
      const tool = createDocumentProbeTool({ documentPort: port });
      const result = (await tool.handler(
        { path: file },
        { cwd: dir } as never,
      )) as Record<string, unknown>;
      expect(result.format).toBe('pdf');
      expect(result.extractable).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
