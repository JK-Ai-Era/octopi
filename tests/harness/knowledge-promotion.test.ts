/**
 * P5 — hit log / promotion 候选 / 合规 purge
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';
import { KnowledgeHitLog } from '@octopi-agent/engine/harness/knowledge/hit-log.js';
import { KnowledgePurger } from '@octopi-agent/engine/harness/knowledge/purge.js';
import { GroundingAssembler } from '@octopi-agent/engine/harness/knowledge/grounding.js';
import type { Message } from '@octopi-agent/core/types.js';

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'kn5-'));
  const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
  const ingest = new KnowledgeIngest({ sourceStore: store });
  const dir = join(root, 'docs');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth.md'), '# 鉴权\n\nJWT 会话签名校验流程说明。\n', 'utf8');
  await writeFile(join(dir, 'old.md'), '# 旧\n\n待删除的敏感内容 secret-to-purge\n', 'utf8');
  const src = store.register({
    kind: 'directory',
    location: dir,
    scopeRef: { level: 'global', key: 'global' },
    displayName: 'docs',
  });
  store.update(src.id, { generatedDescription: '自动描述占位' });
  await ingest.ingestSource(src.id);
  await ingest.idle();

  const hits = new KnowledgeHitLog(store.database);
  const purger = new KnowledgePurger(store, ingest.indexStore, hits);
  return {
    root,
    store,
    ingest,
    hits,
    purger,
    srcId: src.id,
    cleanup: async () => {
      ingest.dispose();
      store.database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('KnowledgeHitLog + purge + promotion', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('inject 写入 hit log；候选达阈值', async () => {
    ctx = await setup();
    const retriever = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
      injectMinScore: 0.05,
      hintMinScore: 0.01,
      minCoverage: 0,
    });
    const asm = new GroundingAssembler({
      retriever,
      hitLog: ctx.hits,
      skipIfUserTokensBelow: 0,
      includePriorUserTurns: 0,
    });

    for (let i = 0; i < 12; i++) {
      await asm.assemble({
        agentId: 'a1',
        sessionId: `s${i % 3}`,
        messages: [user('JWT 会话鉴权')],
      });
    }

    const stats = ctx.hits.stats();
    expect(stats.total).toBeGreaterThanOrEqual(12);
    expect(stats.byPath[0].path).toContain('auth.md');

    const candidates = ctx.hits.promotionCandidates({ minSessions: 3, minHits: 10 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].meetsThreshold).toBe(true);
  });

  it('purgePath：内容不再命中，hit 痕迹清除，generatedDescription 标脏', async () => {
    ctx = await setup();
    const path = join(ctx.root, 'docs', 'old.md');
    expect(
      ctx.ingest.indexStore.search('secret-to-purge', { sourceIds: [ctx.srcId] }).length,
    ).toBeGreaterThan(0);

    ctx.hits.record({
      sourceId: ctx.srcId,
      path,
      query: 'secret',
      sessionId: 's1',
    });
    expect(ctx.hits.stats().total).toBe(1);

    const result = ctx.purger.purgePath(ctx.srcId, path);
    expect(result.purged).toBe(true);
    expect(result.describeStale).toBe(true);

    expect(
      ctx.ingest.indexStore.search('secret-to-purge', { sourceIds: [ctx.srcId] }).length,
    ).toBe(0);
    expect(ctx.hits.stats().total).toBe(0);
    expect(ctx.store.get(ctx.srcId)?.generatedDescription).toBeUndefined();
  });

  it('C2′ 定向：purge 走别名路径（symlink/realpath 形态）不得漏删', async () => {
    ctx = await setup();
    // 别名前提：alias/old.md 与 docs/old.md 是同一真实文件，但路径串不同
    await symlink(join(ctx.root, 'docs'), join(ctx.root, 'alias'), 'dir');
    const aliasPath = join(ctx.root, 'alias', 'old.md');
    const storedPath = join(ctx.root, 'docs', 'old.md');
    expect(aliasPath).not.toBe(storedPath);

    ctx.hits.record({
      sourceId: ctx.srcId,
      path: storedPath,
      query: 'secret',
      sessionId: 's1',
    });

    // 合规抹除按「真实文件身份」匹配：别名形态 purge 不得漏删内容与 hit 痕迹
    ctx.purger.purgePath(ctx.srcId, aliasPath);
    expect(
      ctx.ingest.indexStore.search('secret-to-purge', { sourceIds: [ctx.srcId] }).length,
    ).toBe(0);
    expect(ctx.hits.stats().total).toBe(0);
  });

  it('C2′ 定向：大小写变体是不同身份（不做 case-fold，防大小写敏感平台误删他人文件）', async () => {
    ctx = await setup();
    // 精确身份语义：case 变体不命中该 path（Linux 上二者是真不同文件，fold 会误删）
    ctx.purger.purgePath(ctx.srcId, join(ctx.root, 'docs', 'OLD.md'));
    expect(
      ctx.ingest.indexStore.search('secret-to-purge', { sourceIds: [ctx.srcId] }).length,
    ).toBeGreaterThan(0);
  });

  it('purgeSource 清空整源 index', async () => {
    ctx = await setup();
    expect(ctx.ingest.indexStore.sourceStats(ctx.srcId).chunks).toBeGreaterThan(0);
    ctx.purger.purgeSource(ctx.srcId);
    expect(ctx.ingest.indexStore.sourceStats(ctx.srcId).chunks).toBe(0);
    expect(ctx.hits.stats().total).toBe(0);
  });

  it('purgeAndRemoveSource：index/hits 清空且注册删除', async () => {
    ctx = await setup();
    expect(ctx.ingest.indexStore.sourceStats(ctx.srcId).chunks).toBeGreaterThan(0);
    const result = ctx.purger.purgeAndRemoveSource(ctx.srcId);
    expect(result.purged).toBe(true);
    expect(ctx.ingest.indexStore.sourceStats(ctx.srcId).chunks).toBe(0);
    expect(ctx.store.get(ctx.srcId)).toBeNull();
    expect(ctx.hits.stats().total).toBe(0);
  });

  it('索引期零提升：ingest 不写 hit log', async () => {
    ctx = await setup();
    expect(ctx.hits.stats().total).toBe(0);
  });
});
