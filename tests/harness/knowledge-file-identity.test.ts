import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  identifyConnector,
  identifyLocalFile,
  identifyUrl,
  isPathPrefix,
  logicalPathFrom,
  normalizePathLexical,
  urlIdentityKey,
} from '@octopi-agent/engine/harness/knowledge/file-identity.js';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { MembershipStore } from '@octopi-agent/engine/harness/knowledge/membership-store.js';
import { FileIndexStore } from '@octopi-agent/engine/harness/knowledge/file-index-store.js';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('file-identity', () => {
  it('normalizes windows and posix paths', () => {
    expect(normalizePathLexical('C:\\data\\corpus\\')).toBe('C:/data/corpus');
    expect(normalizePathLexical('c:/data//corpus/./a/../b')).toBe('C:/data/corpus/b');
    expect(normalizePathLexical('/data/corpus/')).toBe('/data/corpus');
    expect(() => normalizePathLexical('./rel')).toThrow(/absolute/);
  });

  it('path prefix is segment-aware', () => {
    expect(isPathPrefix('/data/corpus', '/data/corpus/specs/a.md')).toBe(true);
    expect(isPathPrefix('/data/corpus', '/data/corpus2/a.md')).toBe(false);
    expect(isPathPrefix('C:/data', 'c:/data/x')).toBe(true);
  });

  it('url identity includes authRef and keeps query', () => {
    const q1 = urlIdentityKey('https://x.com/docs?id=1', 'cred-a');
    const q2 = urlIdentityKey('https://x.com/docs?id=2', 'cred-a');
    const b = urlIdentityKey('https://x.com/docs', 'cred-b');
    const c = urlIdentityKey('https://x.com/docs/', 'cred-a');
    expect(q1).not.toBe(q2);
    expect(q1).not.toBe(c);
    expect(c).not.toBe(b);
    expect(q1).toContain('#cred-a');
    expect(q1).toContain('id=1');
    expect(canonicalizeUrl('https://X.com:443/docs/#frag')).toBe('https://x.com/docs');
    expect(canonicalizeUrl('https://x.com/docs?q=1')).toContain('q=1');
  });

  it('local file identity is stable across mtime change', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kn-id-'));
    const p = path.join(dir, 'a.md');
    await writeFile(p, 'hello');
    const id1 = await identifyLocalFile(p);
    await utimes(p, new Date(), new Date(Date.now() + 5000));
    const id2 = await identifyLocalFile(p);
    expect(id2.key).toBe(id1.key);
    expect(id2.mtime).not.toBe(id1.mtime);
    expect(id1.kind === 'unix' || id1.kind === 'win' || id1.kind === 'path').toBe(true);
  });

  it('connector identity isolates authRef', () => {
    const a = identifyConnector('rest', 'doc:1', 'cred-a');
    const b = identifyConnector('rest', 'doc:1', 'cred-b');
    expect(a.key).not.toBe(b.key);
    expect(a.key.startsWith('connector:rest:doc:1#')).toBe(true);
  });

  it('logical path relative to root', () => {
    expect(logicalPathFrom('/data/corpus', '/data/corpus/specs/a.md')).toBe('specs/a.md');
  });

  it('identifyUrl shares same auth', async () => {
    const a = await identifyUrl('https://x.com/d', 'u');
    const b = await identifyUrl('https://x.com/d/', 'u');
    expect(a.key).toBe(b.key);
  });
});

describe('MembershipStore + FileIndexStore', () => {
  it('shares one file across two sources and purges on last unclaim', async () => {
    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const ms = new MembershipStore(db);
    const ix = new FileIndexStore(db);

    const dir = await mkdtemp(path.join(tmpdir(), 'kn-ms-'));
    const p = path.join(dir, 'a.md');
    await writeFile(p, '# t\nbody');
    const ident = await identifyLocalFile(p);
    const f1 = ms.upsertByIdentity(ident);
    const f2 = ms.upsertByIdentity(ident);
    expect(f2.fileId).toBe(f1.fileId);
    expect(f2.created).toBe(false);

    ms.claim('s1', f1.fileId, 'a.md');
    ms.claim('s2', f1.fileId, 'specs/a.md');
    expect(ms.claimCount(f1.fileId)).toBe(2);

    ix.upsertFileContent({
      fileId: f1.fileId,
      adapterId: 'markdown',
      size: ident.size,
      mtime: ident.mtime,
      chunks: [{ ordinal: 0, text: 'body', startLine: 2, endLine: 2 }],
    });

    const hits = ix.searchKeywordVisible('body', ['s1', 's2'], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].sourceIds.sort()).toEqual(['s1', 's2']);

    const purged: string[] = [];
    ms.unclaim('s1', 'a.md');
    expect(ms.claimCount(f1.fileId)).toBe(1);
    const r = ms.reconcileSource(
      's2',
      new Map(),
      (id) => {
        purged.push(id);
        ix.purgeFile(id);
      },
    );
    expect(r.removed).toBe(1);
    expect(purged).toContain(f1.fileId);
    expect(ms.getFile(f1.fileId)).toBeNull();
    db.close();
  });

  it('reconcile drops missing logical paths only', async () => {
    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const ms = new MembershipStore(db);
    const a = ms.upsertByIdentity({
      kind: 'path',
      key: 'path:/a',
      size: 1,
      mtime: 1,
      canonical: '/a',
    });
    const b = ms.upsertByIdentity({
      kind: 'path',
      key: 'path:/b',
      size: 1,
      mtime: 1,
      canonical: '/b',
    });
    ms.claim('s1', a.fileId, 'a.md');
    ms.claim('s1', b.fileId, 'b.md');
    const purged: string[] = [];
    const res = ms.reconcileSource(
      's1',
      new Map([['a.md', a.fileId]]),
      (id) => purged.push(id),
    );
    expect(res.removed).toBe(1);
    expect(purged).toEqual([b.fileId]);
    expect(ms.listBySource('s1')).toHaveLength(1);
    db.close();
  });
});
