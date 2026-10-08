/**
 * job.file_id 贯通 — 共享 File 不双 parse；purge 清 job；入队写真实 file_id
 */
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';
import { identifyLocalFile } from '@octopi-agent/engine/harness/knowledge/file-identity.js';

describe('knowledge job file_id', () => {
  it('enqueue 写入 file_id；共享 File 只补 membership 不双 parse；purge 清 job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kn-jfid-'));
    const specs = join(root, 'specs');
    await mkdir(specs, { recursive: true });
    const file = join(specs, 'a.md');
    await writeFile(file, '# s\n\nshared\n', 'utf8');

    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);
    const ingest = new KnowledgeIngest({
      sourceStore: sources,
      indexStore: index,
      embeddingProvider: null,
    });

    const sParent = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'parent',
    });
    const sChild = sources.register({
      kind: 'directory',
      location: specs,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'child',
    });

    // 预建 File + 双 membership（模拟 identity 已解析）
    const ident = await identifyLocalFile(file);
    const logicalParent = join(specs, 'a.md').replace(/\\/g, '/');
    const logicalChild = 'a.md';
    await index.upsertFile({
      sourceId: sParent.id,
      path: logicalParent,
      contentHash: 'h',
      size: ident.size,
      mtime: ident.mtime,
      adapterId: 'markdown',
      identityKey: ident.key,
      chunks: [{ ordinal: 0, text: 'shared', startLine: 1, endLine: 1 }],
    });
    index.attachMembership(sChild.id, index.getFile(sParent.id, logicalParent)!.id, logicalChild);
    const fileId = index.getFile(sParent.id, logicalParent)!.id;

    const enqueue = (
      ingest as unknown as {
        enqueue: (
          s: string,
          k: string,
          p: string | null,
          pr: number,
        ) => Promise<boolean>;
      }
    ).enqueue.bind(ingest);

    // Parent 入队：写入 file_id
    const ok1 = await enqueue(sParent.id, 'parse_file', logicalParent, 2);
    expect(ok1).toBe(true);
    const row1 = db.raw
      .prepare(`SELECT file_id FROM knowledge_jobs WHERE source_id = ? AND kind = 'parse_file'`)
      .get(sParent.id) as { file_id: string | null };
    expect(row1.file_id).toBe(fileId);

    // Child 入队同 File：应拒绝双 parse，但补/保留 membership
    const ok2 = await enqueue(sChild.id, 'parse_file', logicalChild, 2);
    expect(ok2).toBe(false);
    const jobs = db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE kind = 'parse_file' AND status = 'queued'`,
      )
      .get() as { n: number };
    expect(jobs.n).toBe(1);
    expect(index.getFile(sChild.id, logicalChild)?.id).toBe(fileId);

    // purge 会清掉带 file_id 的 job
    const fileId2 = index.getFile(sParent.id, logicalParent)!.id;
    index.removeFile(sParent.id, logicalParent);
    index.removeFile(sChild.id, logicalChild);
    const leftover = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_jobs WHERE file_id = ?`)
      .get(fileId2) as { n: number };
    expect(leftover.n).toBe(0);

    ingest.dispose();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
});
