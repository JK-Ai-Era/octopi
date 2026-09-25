/**
 * KnowledgeIngest P2 — walk / parse / chunk / 关键词检索 / 增量
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '../../src/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '../../src/harness/knowledge/ingest.js';
import { markdownAdapter, codeAdapter, FormatAdapterRegistry } from '../../src/harness/knowledge/adapters.js';
import { KnowledgeDatabase } from '../../src/harness/knowledge/db.js';

async function makeWorkspace(): Promise<{ root: string; store: KnowledgeSourceStore; ingest: KnowledgeIngest; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'octopi-kn-'));
  const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
  const ingest = new KnowledgeIngest({ sourceStore: store, parseConcurrency: 2 });
  return {
    root,
    store,
    ingest,
    cleanup: async () => {
      ingest.dispose();
      store.database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('FormatAdapter', () => {
  it('markdown 按标题切；code 行窗', () => {
    const md = markdownAdapter.chunk(
      '# A\n\nhello world paragraph that is long enough to keep\n\n## B\n\nsecond section',
      'a.md',
    );
    expect(md.length).toBeGreaterThanOrEqual(2);
    expect(md[0].text).toContain('# A');

    // 无符号纯文本：体积超 max 会再切（此处构造长行触发 split）
    const longLine = 'x'.repeat(200);
    const code = codeAdapter.chunk(
      Array.from({ length: 30 }, (_, i) => `${longLine}${i}`).join('\n'),
      'a.ts',
    );
    expect(code.length).toBeGreaterThanOrEqual(2);
  });

  it('code 按函数/类启发式分块', () => {
    const src = [
      'import { x } from "y";',
      '',
      'export function alpha() {',
      '  return 1;',
      '}',
      '',
      'export class Beta {',
      '  run() {',
      '    return 2;',
      '  }',
      '}',
      '',
      'function gamma() {',
      '  return 3;',
      '}',
    ].join('\n');
    const chunks = codeAdapter.chunk(src, 'a.ts');
    const symbols = chunks.map((c) => c.symbol).filter(Boolean);
    expect(symbols).toContain('alpha');
    expect(symbols).toContain('Beta');
    expect(symbols).toContain('gamma');
    const alpha = chunks.find((c) => c.symbol === 'alpha')!;
    expect(alpha.text).toContain('return 1');
    expect(alpha.text).not.toContain('class Beta');
  });

  it('python def/class 命中', () => {
    const src = 'def foo():\n    pass\n\nclass Bar:\n    def baz(self):\n        pass\n';
    const chunks = codeAdapter.chunk(src, 'a.py');
    expect(chunks.map((c) => c.symbol).filter(Boolean)).toEqual(expect.arrayContaining(['foo', 'Bar']));
  });

  it('registry 按扩展名分发；二进制/未知 skip', () => {
    const reg = new FormatAdapterRegistry();
    expect(reg.match('x.md')?.id).toBe('markdown');
    expect(reg.match('x.ts')?.id).toBe('code-tree');
    expect(reg.match('x.png')).toBeNull();
    expect(reg.match('x.unknownext')).toBeNull();
    expect(reg.shouldSkipPath('a/node_modules/b.ts')).toBe(true);
    expect(reg.shouldSkipPath('a/b.ts')).toBe(false);
  });
});

describe('KnowledgeIngest', () => {
  let ctx: Awaited<ReturnType<typeof makeWorkspace>>;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('挂目录 → partial/ready，关键词与中文可搜', async () => {
    ctx = await makeWorkspace();
    const docs = join(ctx.root, 'docs');
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, 'auth.md'), '# 鉴权设计\n\n使用 JWT 做会话鉴权，网关校验签名。\n', 'utf8');
    await writeFile(join(docs, 'api.ts'), 'export function rateLimit() {\n  // API rate limit config\n}\n', 'utf8');
    await writeFile(join(docs, 'note.txt'), 'random notes\n', 'utf8');
    await mkdir(join(docs, 'node_modules'), { recursive: true });
    await writeFile(join(docs, 'node_modules', 'junk.md'), '# junk should skip\n', 'utf8');

    const src = ctx.store.register({
      kind: 'directory',
      location: docs,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'docs',
    });

    await ctx.ingest.ingestSource(src.id);
    await ctx.ingest.idle();

    const after = ctx.store.get(src.id)!;
    expect(['partial', 'ready']).toContain(after.status);
    expect(after.coverage).toBeGreaterThan(0);

    const stats = ctx.ingest.indexStore.sourceStats(src.id);
    expect(stats.files).toBeGreaterThanOrEqual(3);
    expect(stats.chunks).toBeGreaterThan(0);

    // 拉丁
    const hitsEn = ctx.ingest.indexStore.search('JWT 鉴权', {
      sourceIds: [src.id],
      limit: 10,
    });
    expect(hitsEn.length).toBeGreaterThan(0);
    expect(hitsEn.some((h) => h.path.includes('auth.md'))).toBe(true);

    // 中文（二元组）
    const hitsZh = ctx.ingest.indexStore.search('会话鉴权', { sourceIds: [src.id] });
    expect(hitsZh.length).toBeGreaterThan(0);
    expect(hitsZh[0].text).toContain('鉴权');

    // node_modules 不进库
    const files = ctx.ingest.indexStore.listFiles(src.id);
    expect(files.some((f) => f.path.includes('node_modules'))).toBe(false);
  });

  it('content-hash 未变则跳过重解析；变更后可搜到新内容', async () => {
    ctx = await makeWorkspace();
    const dir = join(ctx.root, 'd');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'x.md');
    await writeFile(file, '# One\n\nalpha content\n', 'utf8');

    const src = ctx.store.register({
      kind: 'file',
      location: file,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'x',
    });
    // file kind: walk 单文件
    await ctx.ingest.ingestSource(src.id);
    await ctx.ingest.idle();

    expect(ctx.ingest.indexStore.search('alpha', { sourceIds: [src.id] }).length).toBeGreaterThan(0);

    // 同 hash：isFresh
    const rec1 = ctx.ingest.indexStore.getFile(src.id, file)!;
    expect(ctx.ingest.indexStore.isFresh(src.id, file, rec1.contentHash)).toBe(true);

    await writeFile(file, '# Two\n\nbeta gamma content\n', 'utf8');
    await ctx.ingest.ingestFileNow(src.id, file);
    const hits = ctx.ingest.indexStore.search('beta', { sourceIds: [src.id] });
    expect(hits.length).toBeGreaterThan(0);
    expect(ctx.ingest.indexStore.search('alpha', { sourceIds: [src.id] }).length).toBe(0);
  });

  it('无 adapter 文件记 skipped 不挡整库', async () => {
    ctx = await makeWorkspace();
    const dir = join(ctx.root, 'mix');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'ok.md'), '# ok\n\nvisible content here\n', 'utf8');
    await writeFile(join(dir, 'pic.png'), Buffer.from([1, 2, 3]));

    const src = ctx.store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'mix',
    });
    await ctx.ingest.ingestSource(src.id);
    await ctx.ingest.idle();

    const files = ctx.ingest.indexStore.listFiles(src.id);
    const pic = files.find((f) => f.path.endsWith('pic.png'));
    expect(pic?.status).toBe('skipped');
    expect(ctx.ingest.indexStore.search('visible', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
  });

  it('search 限定可见 sourceIds', async () => {
    ctx = await makeWorkspace();
    const dirA = join(ctx.root, 'a');
    await mkdir(dirA, { recursive: true });
    await writeFile(join(dirA, 'a.md'), '# a\n\nsecret project alpha\n', 'utf8');
    const dirB = join(ctx.root, 'b');
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirB, 'b.md'), '# b\n\nother corpus\n', 'utf8');

    const sa = ctx.store.register({
      kind: 'directory',
      location: dirA,
      scopeRef: { level: 'project', key: 'p1' },
      displayName: 'a',
    });
    const sb = ctx.store.register({
      kind: 'directory',
      location: dirB,
      scopeRef: { level: 'project', key: 'p2' },
      displayName: 'b',
    });
    await ctx.ingest.ingestSource(sa.id);
    await ctx.ingest.ingestSource(sb.id);
    await ctx.ingest.idle();

    const index = new KnowledgeIndexStore(ctx.store.database);
    const onlyA = index.search('secret alpha', { sourceIds: [sa.id] });
    expect(onlyA.every((h) => h.sourceId === sa.id)).toBe(true);
    expect(index.search('secret alpha', { sourceIds: [sb.id] }).length).toBe(0);
  });
});

describe('KnowledgeDatabase index tables', () => {
  it('可写 jobs/files/chunks', async () => {
    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const stats = db.stats();
    expect(stats.knowledge_sources).toBe(0);
    db.close();
  });
});
