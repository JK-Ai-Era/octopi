/**
 * 契约 v2.1 §13：File identity 去重 / Membership / 零认领 purge
 */
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { identifyLocalFile } from '@octopi-agent/engine/harness/knowledge/file-identity.js';
import { MembershipStore } from '@octopi-agent/engine/harness/knowledge/membership-store.js';

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kn-share-'));
}

describe('File identity 共享与去重', () => {
  it('父子目录两 Source：同一 file_id，parse 一次', async () => {
    const root = await makeRoot();
    const specs = join(root, 'specs');
    await mkdir(specs, { recursive: true });
    const file = join(specs, 'a.md');
    await writeFile(file, '# shared\n\nshared body text\n', 'utf8');

    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);
    const ms = new MembershipStore(db);

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

    const ident = await identifyLocalFile(file);
    const { fileId } = ms.upsertByIdentity(ident);
    ms.claim(sParent.id, fileId, 'specs/a.md');
    ms.claim(sChild.id, fileId, 'a.md');

    await index.upsertFile({
      sourceId: sParent.id,
      path: 'specs/a.md',
      contentHash: 'h',
      size: ident.size,
      mtime: ident.mtime,
      adapterId: 'markdown',
      identityKey: ident.key,
      chunks: [{ ordinal: 0, text: 'shared body text', startLine: 1, endLine: 3 }],
    });

    const fParent = index.getFile(sParent.id, 'specs/a.md');
    const fChild = index.getFile(sChild.id, 'a.md');
    expect(fParent?.id).toBe(fChild?.id);
    expect(index.listFiles(sParent.id)).toHaveLength(1);
    expect(index.listFiles(sChild.id)).toHaveLength(1);

    const hits = index.search('shared', { sourceIds: [sParent.id, sChild.id] });
    expect(hits).toHaveLength(1);

    // 删 child membership：file 仍在
    index.removeFile(sChild.id, 'a.md');
    expect(index.getFile(sParent.id, 'specs/a.md')).not.toBeNull();

    // 删最后 membership：purge
    index.removeFile(sParent.id, 'specs/a.md');
    expect(index.getFile(sParent.id, 'specs/a.md')).toBeNull();
    const n = db.raw.prepare('SELECT COUNT(*) AS n FROM knowledge_files').get() as { n: number };
    expect(n.n).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

  it('同路径双 Source：一 File 两 logical path，召回去重', async () => {
    const root = await makeRoot();
    const file = join(root, 'doc.md');
    await writeFile(file, 'unique phrase here\n', 'utf8');

    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);

    const s1 = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'one',
    });
    const s2 = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'two',
    });

    const ident = await identifyLocalFile(file);
    await index.upsertFile({
      sourceId: s1.id,
      path: 'doc.md',
      contentHash: 'h',
      size: ident.size,
      mtime: ident.mtime,
      adapterId: 'markdown',
      identityKey: ident.key,
      chunks: [{ ordinal: 0, text: 'unique phrase here', startLine: 1, endLine: 1 }],
    });
    // 第二 Source 只 claim，不重 parse
    await index.upsertFile({
      sourceId: s2.id,
      path: 'doc.md',
      contentHash: 'h',
      size: ident.size,
      mtime: ident.mtime,
      adapterId: 'markdown',
      identityKey: ident.key,
      chunks: [{ ordinal: 0, text: 'unique phrase here', startLine: 1, endLine: 1 }],
    });

    const h1 = index.search('unique phrase', { sourceIds: [s1.id] });
    const h2 = index.search('unique phrase', { sourceIds: [s2.id] });
    const both = index.search('unique phrase', { sourceIds: [s1.id, s2.id] });
    expect(h1).toHaveLength(1);
    expect(h2).toHaveLength(1);
    expect(both).toHaveLength(1);
    expect(h1[0].text).toBe(h2[0].text);

    const chunkN = db.raw.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get() as {
      n: number;
    };
    expect(chunkN.n).toBe(1);

    await rm(root, { recursive: true, force: true });
  });

  it('原地改内容：同 File 覆盖，不双份', async () => {
    const root = await makeRoot();
    const file = join(root, 'u.md');
    await writeFile(file, 'old words\n', 'utf8');

    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);
    const s = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'u',
    });

    const id1 = await identifyLocalFile(file);
    await index.upsertFile({
      sourceId: s.id,
      path: 'u.md',
      contentHash: 'h1',
      size: id1.size,
      mtime: id1.mtime,
      adapterId: 'markdown',
      identityKey: id1.key,
      chunks: [{ ordinal: 0, text: 'old words', startLine: 1, endLine: 1 }],
    });

    await writeFile(file, 'new words beta\n', 'utf8');
    const id2 = await identifyLocalFile(file);
    expect(id2.key).toBe(id1.key);
    await index.upsertFile({
      sourceId: s.id,
      path: 'u.md',
      contentHash: 'h2',
      size: id2.size,
      mtime: id2.mtime,
      adapterId: 'markdown',
      identityKey: id2.key,
      chunks: [{ ordinal: 0, text: 'new words beta', startLine: 1, endLine: 1 }],
    });

    expect(index.search('beta', { sourceIds: [s.id] })).toHaveLength(1);
    expect(index.search('old', { sourceIds: [s.id] })).toHaveLength(0);
    const chunkN = db.raw.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get() as {
      n: number;
    };
    expect(chunkN.n).toBe(1);

    await rm(root, { recursive: true, force: true });
  });
});
