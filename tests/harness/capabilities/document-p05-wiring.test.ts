/**
 * DocumentPort P0.5 ?knowledge ingest / session attachments 接线
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultDocumentPort } from '../../../packages/engine/src/harness/capabilities/document/index.js';
import type {
  DocumentExtractBackend,
  ExtractResult,
  ResolvedExtractSource,
} from '../../../packages/engine/src/harness/capabilities/document/types.js';
import { KnowledgeIngest } from '../../../packages/engine/src/harness/knowledge/ingest.js';
import { KnowledgeSourceStore } from '../../../packages/engine/src/harness/knowledge/source-store.js';
import { SessionAttachmentService } from '../../../packages/engine/src/harness/session/attachments/service.js';

function stubPdfBackend(): DocumentExtractBackend {
  return {
    id: 'stub-pdf',
    tier: 't0',
    formats: ['pdf'],
    async isAvailable() {
      return true;
    },
    accepts({ format }) {
      return format === 'pdf';
    },
    async extract(_source: ResolvedExtractSource): Promise<ExtractResult> {
      return {
        markdown: '# Extracted\n\nhello from pdf',
        meta: { format: 'pdf', pages: 1 },
        warnings: [],
        backend: 'stub-pdf',
      };
    },
  };
}

describe('KnowledgeIngest + DocumentPort', () => {
  let root: string;
  let store: KnowledgeSourceStore;
  let ingest: KnowledgeIngest;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'octopi-doc-ingest-'));
    store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
  });

  afterEach(async () => {
    try {
      ingest?.dispose();
    } catch {
      // not started
    }
    store.database.close();
    await rm(root, { recursive: true, force: true });
  });

  it('indexes PDF via DocumentPort ?markdown chunks', async () => {
    const file = join(root, 'a.pdf');
    await writeFile(file, Buffer.from('%PDF-1.4 stub'));
    const src = store.register({
      kind: 'file',
      location: file,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'a.pdf',
    });
    const port = createDefaultDocumentPort({ backends: [stubPdfBackend()] });
    ingest = new KnowledgeIngest({ sourceStore: store, documentPort: port });

    const ok = await ingest.ingestFileNow(src.id, file);
    expect(ok).toBe(true);

    const rec = ingest.indexStore.getFile(src.id, file);
    expect(rec?.adapterId).toBe('document:stub-pdf');
    expect(rec?.status).toBe('indexed');
    expect(ingest.indexStore.search('hello from pdf', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
  });

  it('skips legacy doc without converter (structured skip)', async () => {
    const file = join(root, 'old.doc');
    await writeFile(file, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const src = store.register({
      kind: 'file',
      location: file,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'old.doc',
    });
    const port = createDefaultDocumentPort();
    ingest = new KnowledgeIngest({ sourceStore: store, documentPort: port });

    const ok = await ingest.ingestFileNow(src.id, file);
    expect(ok).toBe(false);
    const rec = ingest.indexStore.getFile(src.id, file);
    expect(rec?.status).toBe('skipped');
    expect(rec?.error ?? '').toMatch(/unsupported_legacy/i);
  });

  it('without documentPort still routes documents to extract (worker)', async () => {
    const file = join(root, 'a.pdf');
    await writeFile(file, Buffer.from('%PDF-1.4'));
    const src = store.register({
      kind: 'file',
      location: file,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'a.pdf',
    });
    ingest = new KnowledgeIngest({ sourceStore: store, documentPort: null });

    // 不再 BINARY 短路；走 parseDocumentFile（worker 自带 DocumentPort）
    const ok = await ingest.ingestFileNow(src.id, file);
    const rec = ingest.indexStore.getFile(src.id, file);
    // worker 成功则 indexed；失败记 error —— 禁止再静默 no_adapter skip
    if (ok) {
      expect(rec?.status).toBe('indexed');
    } else {
      expect(rec?.status).toBe('error');
      expect(rec?.error ?? '').not.toMatch(/no_adapter/i);
    }
  });
});

describe('SessionAttachmentService + DocumentPort', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-doc-att-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes .extracted.md companion for PDF', async () => {
    const port = createDefaultDocumentPort({ backends: [stubPdfBackend()] });
    const svc = new SessionAttachmentService({ sessionsDir: dir, documentPort: port });
    const item = await svc.save('sess-1', {
      name: 'report.pdf',
      data: Buffer.from('%PDF-1.4'),
    });
    expect(item.status).toBe('parsed');
    expect(item.extractPath).toBe('report.pdf.extracted.md');
    expect(item.parse?.ok).toBe(true);

    const root = svc.attachmentRoot('sess-1');
    const text = await readFile(join(root, 'report.pdf.extracted.md'), 'utf8');
    expect(text).toContain('hello from pdf');
  });

  it('records structured error for legacy without converter', async () => {
    const port = createDefaultDocumentPort();
    const svc = new SessionAttachmentService({
      sessionsDir: dir,
      documentPort: port,
      limits: { allowedExtensions: ['.doc', '.pdf', '.docx'] },
    });
    const item = await svc.save('sess-1', {
      name: 'old.doc',
      data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
    });
    expect(item.status).toBe('parse_failed');
    expect(item.parse?.error).toMatch(/UNSUPPORTED_LEGACY/i);
  });

  it('without DocumentPort marks document unextracted', async () => {
    const svc = new SessionAttachmentService({ sessionsDir: dir });
    const item = await svc.save('sess-1', {
      name: 'a.pdf',
      data: Buffer.from('%PDF'),
    });
    expect(item.status).toBe('ready');
    expect(item.parse?.ok).toBe(false);
  });
});
