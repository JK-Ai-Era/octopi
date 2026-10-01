/**
 * DocumentPort P0 — 格式嗅探 / 路由 / 纯文本抽取 / 错误语义
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DocumentExtractError,
  createDefaultDocumentPort,
  formatFromMagic,
  formatFromName,
  isDocumentExtractError,
  resolveFormat,
  htmlFragmentToMarkdown,
} from '../../../packages/engine/src/harness/context/capabilities/document/index.js';
import type {
  DocumentExtractBackend,
  ExtractResult,
  ResolvedExtractSource,
} from '../../../packages/engine/src/harness/context/capabilities/document/types.js';

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('document format sniffing', () => {
  it('maps extensions', () => {
    expect(formatFromName('a.pdf')).toBe('pdf');
    expect(formatFromName('a.DOCX')).toBe('docx');
    expect(formatFromName('report.md')).toBe('md');
    expect(formatFromName('noext')).toBe('unknown');
  });

  it('detects PDF magic', () => {
    expect(formatFromMagic(utf8('%PDF-1.4'))).toBe('pdf');
    expect(formatFromMagic(utf8('{\\rtf1'))).toBe('rtf');
  });

  it('prefers formatHint over name', () => {
    expect(
      resolveFormat({ name: 'a.txt', formatHint: 'pdf' }, utf8('%PDF')),
    ).toBe('pdf');
  });
});

describe('htmlFragmentToMarkdown', () => {
  it('maps headings and emphasis', () => {
    const md = htmlFragmentToMarkdown(
      '<h1>Title</h1><p>Hello <strong>world</strong> and <em>life</em></p>',
    );
    expect(md).toContain('# Title');
    expect(md).toContain('**world**');
    expect(md).toContain('*life*');
  });

  it('maps lists and tables', () => {
    const md = htmlFragmentToMarkdown(
      '<ul><li>one</li><li>two</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    expect(md).toContain('- one');
    expect(md).toContain('- two');
    expect(md).toContain('| A | B |');
    expect(md).toContain('| 1 | 2 |');
  });
});

describe('DocumentPort extract (plain + routing)', () => {
  it('extracts plain text/markdown from bytes', async () => {
    const port = createDefaultDocumentPort();
    const result = await port.extract({
      data: utf8('# Hello\n\nWorld'),
      name: 'note.md',
    });
    expect(result.markdown).toContain('# Hello');
    expect(result.meta.format).toBe('md');
    expect(result.backend).toBe('plain-text');
  });

  it('rejects missing source', async () => {
    const port = createDefaultDocumentPort();
    await expect(port.extract({})).rejects.toSatisfy(
      (e: unknown) => isDocumentExtractError(e) && e.code === 'INVALID_SOURCE',
    );
  });

  it('enforces maxFileBytes', async () => {
    const port = createDefaultDocumentPort({ config: { maxFileBytes: 8 } });
    await expect(
      port.extract({ data: utf8('this is longer than eight'), name: 'a.txt' }),
    ).rejects.toSatisfy(
      (e: unknown) => isDocumentExtractError(e) && e.code === 'FILE_TOO_LARGE',
    );
  });

  it('fails structured for unsupported legacy without converter', async () => {
    const port = createDefaultDocumentPort();
    // OLE2 magic → doc
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    try {
      await port.extract({ data: ole, name: 'old.doc', formatHint: 'doc' });
      expect.unreachable('should throw');
    } catch (e) {
      expect(isDocumentExtractError(e)).toBe(true);
      const err = e as DocumentExtractError;
      expect(err.code).toBe('UNSUPPORTED_LEGACY');
      expect(err.requires).toContain('legacy-converter');
    }
  });

  it('probe reports native for text formats', async () => {
    const port = createDefaultDocumentPort();
    const p = await port.probe({ data: utf8('hi'), name: 'a.txt' });
    expect(p.format).toBe('txt');
    expect(p.level).toBe('native');
  });

  it('reads from path under allowedRoots and rejects outside', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'octopi-docport-'));
    const file = join(dir, 'a.md');
    await writeFile(file, '# from disk');
    const port = createDefaultDocumentPort({
      config: { allowedRoots: [dir] },
    });
    const ok = await port.extract({ path: file });
    expect(ok.markdown).toContain('# from disk');

    await expect(
      port.extract({ path: join(tmpdir(), 'elsewhere.md') }),
    ).rejects.toSatisfy(
      (e: unknown) => isDocumentExtractError(e) && e.code === 'PATH_FORBIDDEN',
    );
  });
});

describe('DocumentPort custom backends and timeout', () => {
  it('uses injected backend when accepts format', async () => {
    const stub: DocumentExtractBackend = {
      id: 'stub-pdf',
      tier: 't0',
      formats: ['pdf'],
      async isAvailable() {
        return true;
      },
      accepts({ format }) {
        return format === 'pdf';
      },
      async extract(source: ResolvedExtractSource): Promise<ExtractResult> {
        return {
          markdown: 'stub-pdf-body',
          meta: { format: 'pdf', pages: 1 },
          warnings: [],
          backend: 'stub-pdf',
        };
      },
    };
    const port = createDefaultDocumentPort({ backends: [stub] });
    const result = await port.extract({ data: utf8('%PDF-1.4'), name: 'a.pdf' });
    expect(result.backend).toBe('stub-pdf');
    expect(result.markdown).toBe('stub-pdf-body');
  });

  it('times out slow backends', async () => {
    const slow: DocumentExtractBackend = {
      id: 'slow',
      tier: 't0',
      formats: ['txt'],
      async isAvailable() {
        return true;
      },
      accepts() {
        return true;
      },
      async extract() {
        await new Promise((r) => setTimeout(r, 200));
        return {
          markdown: 'late',
          meta: { format: 'txt' },
          warnings: [],
          backend: 'slow',
        };
      },
    };
    const port = createDefaultDocumentPort({
      backends: [slow],
      config: { timeoutMs: 20 },
    });
    await expect(port.extract({ data: utf8('x'), name: 'a.txt' })).rejects.toSatisfy(
      (e: unknown) => isDocumentExtractError(e) && e.code === 'TIMEOUT',
    );
  });
});
