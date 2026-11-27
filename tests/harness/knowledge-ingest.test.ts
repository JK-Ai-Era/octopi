/**
 * KnowledgeIngest P2 — walk / parse / chunk / 关键词检索 / 增量
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveCanonicalLocation } from '@octopi-agent/engine/harness/knowledge/location.js';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';
import {
  markdownAdapter,
  codeAdapter,
  htmlAdapter,
  textAdapter,
  FormatAdapterRegistry,
} from '@octopi-agent/engine/harness/knowledge/adapters.js';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';

async function makeWorkspace(): Promise<{ root: string; store: KnowledgeSourceStore; ingest: KnowledgeIngest; cleanup: () => Promise<void> }> {
  const root = resolveCanonicalLocation(await mkdtemp(join(tmpdir(), 'octopi-kn-')));
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

  it('.html 归 htmlAdapter（文档可嵌入），不得被 code-tree 抢走', () => {
    const reg = new FormatAdapterRegistry();
    expect(reg.match('x.html')?.id).toBe('html');
    expect(reg.match('x.htm')?.id).toBe('html');
    expect(reg.match('x.xhtml')?.id).toBe('html');
    // code-tree 才被 EMBEDDABLE_WHERE 排除；html 必须能进向量
    expect(reg.match('x.html')?.id).not.toBe('code-tree');
  });

  it('htmlAdapter 先抽正文：script 不进 chunk，长行切开不丢弃', () => {
    const script = `<script>${'var x=1;'.repeat(500)}</script>`;
    const body = `<div>${'<p>库存管理总览产购销存</p>'.repeat(30)}</div>`;
    const html = `<html><head>${script}</head><body>${body}</body></html>`;
    const chunks = htmlAdapter.chunk(html, 'a.html');
    const all = chunks.map((c) => c.text).join('\n');
    expect(all).toContain('库存管理');
    expect(all).not.toContain('var x=1');
    // 超长单行必须拆成多段且保留尾部
    const longLine = 'Z'.repeat(5000) + 'TAILMARK';
    const parts = textAdapter.chunk(longLine, 'a.txt');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.text).join('')).toContain('TAILMARK');
  });

  it('Axure data.js 内容嗅探跳过；普通 data.js 不误伤', async () => {
    const local = await makeWorkspace();
    try {
      const dir = join(local.root, 'proj');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'axure-data.js'),
        '$axure.loadCurrentPage(\n(function(){ var b="url"; return _creator(); })());\n',
        'utf8',
      );
      await writeFile(
        join(dir, 'data.js'),
        'export const config = { title: "用户中心列表页" };\n',
        'utf8',
      );
      const src = local.store.register({
        kind: 'directory',
        location: dir,
        scopeRef: { level: 'global', key: 'global' },
        displayName: 'axure-sniff',
      });
      await local.ingest.ingestSource(src.id);
      await local.ingest.idle(10_000);

      const files = local.ingest.indexStore.listFiles(src.id);
      const axure = files.find((f) => f.path.endsWith('axure-data.js'));
      const normal = files.find((f) => /(^|\/)data\.js$/i.test(f.path));
      expect(axure?.status).toBe('skipped');
      expect(axure?.error).toBe('axure_export_sidecar');
      expect(normal?.status).toBe('indexed');
      expect(
        local.ingest.indexStore.search('用户中心', { sourceIds: [src.id] }).length,
      ).toBeGreaterThan(0);
    } finally {
      await local.cleanup();
    }
  });

  it('register 拒绝扩展名冲突（归属显式，禁止静默覆盖）', () => {
    const reg = new FormatAdapterRegistry();
    expect(() =>
      reg.register({
        id: 'hijack',
        extensions: ['.md'],
        chunk: () => [],
      }),
    ).toThrow(/conflict/);
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

  it('本地源根路径不可达 → 源级 error + 上报，绝不静默 0 文件', async () => {
    ctx = await makeWorkspace();
    const src = ctx.store.register({
      kind: 'directory',
      location: join(ctx.root, 'missing-dir'),
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'missing',
    });

    await ctx.ingest.ingestSource(src.id, { full: true });

    const after = ctx.store.get(src.id)!;
    expect(after.status).toBe('error');
    expect(after.errors?.some((e) => /location_unreachable/.test(e.message))).toBe(true);
    expect(ctx.ingest.indexStore.sourceStats(src.id).files).toBe(0);
  });

  it('根路径不可达后：error 不被统计口径覆盖回 ready，且不误清已索引文件', async () => {
    ctx = await makeWorkspace();
    const docs = join(ctx.root, 'gone');
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, 'a.md'), '# A\n\nalpha content here\n', 'utf8');
    await writeFile(join(docs, 'b.md'), '# B\n\nbeta content here\n', 'utf8');

    const src = ctx.store.register({
      kind: 'directory',
      location: docs,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'gone',
    });
    await ctx.ingest.ingestSource(src.id, { full: true });
    await ctx.ingest.idle();
    expect(ctx.ingest.indexStore.sourceStats(src.id).files).toBe(2);

    // 盘掉线 / 目录改名：根不可达
    await rm(docs, { recursive: true, force: true });
    await ctx.ingest.ingestSource(src.id, { full: true });
    expect(ctx.store.get(src.id)!.status).toBe('error');

    // 对账轮（15s reconciler：refreshCoverage + ensureParseCoverage + pruneMissingOnDisk）
    await ctx.ingest.reconcileJobs();

    // error 必须活下来（否则 UI 内联错误 15s 后消失）
    expect(ctx.store.get(src.id)!.status).toBe('error');
    // 根不可达 ≠ 文件全删：不得把整源索引清空
    expect(ctx.ingest.indexStore.sourceStats(src.id).files).toBe(2);
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
    expect(stats.sources).toBe(0);
    expect(stats.files).toBe(0);
    expect(stats.chunks).toBe(0);
    expect(stats.jobsQueued).toBe(0);
    expect(stats.jobsRunning).toBe(0);
    db.close();
  });
});

describe('R5 漂移闸行为（独立评审 MAJOR-3/4/6 锚）', () => {
  let ctx: Awaited<ReturnType<typeof makeWorkspace>>;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  async function swapRoot(docs: string): Promise<string> {
    const other = resolveCanonicalLocation(await mkdtemp(join(tmpdir(), 'octopi-kn-swap-')));
    await writeFile(join(other, 'secret.md'), '# S\n\nsecretzz content\n', 'utf8');
    await rm(docs, { recursive: true, force: true });
    await symlink(other, docs, 'dir');
    return other;
  }

  it('root 换向后 ingest 报 location_drift、不读换向目标；同文案幂等不刷屏', async () => {
    ctx = await makeWorkspace();
    const docs = join(ctx.root, 'docs');
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, 'a.md'), '# A\n\nalpha content\n', 'utf8');
    const src = ctx.store.register({
      kind: 'directory',
      location: docs,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'docs',
    });
    await ctx.ingest.ingestSource(src.id, { full: true });
    await ctx.ingest.idle();
    expect(ctx.ingest.indexStore.search('alpha', { sourceIds: [src.id] }).length).toBeGreaterThan(0);

    await swapRoot(docs);
    await ctx.ingest.ingestSource(src.id, { full: true });
    await ctx.ingest.idle();
    const after = ctx.store.get(src.id)!;
    expect(after.status).toBe('error');
    expect((after.errors ?? []).some((e) => /location_drift/.test(e.message))).toBe(true);
    // 换向目标不得被读进索引
    expect(ctx.ingest.indexStore.search('secretzz', { sourceIds: [src.id] }).length).toBe(0);

    // 幂等（MINOR-9）：再跑一轮同文案不追加
    await ctx.ingest.ingestSource(src.id, { full: true });
    expect(
      ctx.store.get(src.id)!.errors!.filter((e) => /location_drift/.test(e.message)),
    ).toHaveLength(1);
  });

  it('读取闸（MAJOR-4）：换向后 reprocessFiles 在读之前 fail-loud（不读进新 target）', async () => {
    ctx = await makeWorkspace();
    const docs = join(ctx.root, 'docs');
    await mkdir(docs, { recursive: true });
    const file = join(docs, 'a.md');
    await writeFile(file, '# A\n\nalpha content\n', 'utf8');
    const src = ctx.store.register({
      kind: 'directory',
      location: docs,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'docs',
    });
    await ctx.ingest.ingestSource(src.id, { full: true });
    await ctx.ingest.idle();

    await swapRoot(docs);
    // queued parse/reprocess 的共用归属闸（sourceOwnsPath）必须拒绝换向 root
    await expect(ctx.ingest.reprocessFiles(src.id, [file])).rejects.toThrow(/location_drift/);
  });
});
