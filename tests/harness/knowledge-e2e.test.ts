/**
 * Knowledge 端到端验收 — 挂目录 → 索引 → catalog → grounding → 工具 → 可见性/purge
 *
 * 对齐 arch/knowledge-layer.md §9 验收项；不依赖真实 LLM / 外网。
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import { KnowledgeIngest } from '../../src/harness/knowledge/ingest.js';
import { KnowledgeRetriever } from '../../src/harness/knowledge/retriever.js';
import { GroundingAssembler, stripKnowledgeGrounding } from '../../src/harness/knowledge/grounding.js';
import { KnowledgeHitLog } from '../../src/harness/knowledge/hit-log.js';
import { KnowledgePurger } from '../../src/harness/knowledge/purge.js';
import { createKnowledgeTools } from '../../src/harness/plugin-ecosystem/tools/knowledge.js';
import { createDefaultSystemPromptAssembler } from '../../src/harness/context/system-prompt-assembler.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import type { EmbeddingProvider } from '../../src/harness/memory/sqlite/embedding.js';
import type { Message } from '../../src/core/types.js';
import type { RegisteredTool } from '../../src/core/types.js';

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function fakeEmbedding(dim = 8): EmbeddingProvider {
  const embedOne = (text: string): number[] => {
    const v = Array.from({ length: dim }, () => 0);
    for (const tok of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      v[h % dim] += 1;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  };
  return {
    name: 'fake',
    dimensions: dim,
    async embed(t: string) {
      return embedOne(t);
    },
    async embedBatch(ts: string[]) {
      return ts.map(embedOne);
    },
  };
}

async function callTool(tool: RegisteredTool, args: Record<string, unknown>, context: unknown) {
  return tool.handler(args, context as never);
}

describe('Knowledge E2E 验收', () => {
  let root: string;
  let store: KnowledgeSourceStore;
  let ingest: KnowledgeIngest;
  let hits: KnowledgeHitLog;
  let purger: KnowledgePurger;
  let retriever: KnowledgeRetriever;
  let globalSrcId: string;
  let projectSrcId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'octopi-kn-e2e-'));
    store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const emb = fakeEmbedding();
    ingest = new KnowledgeIngest({ sourceStore: store, embeddingProvider: emb });
    hits = new KnowledgeHitLog(store.database);
    purger = new KnowledgePurger(store, ingest.indexStore, hits);
    retriever = new KnowledgeRetriever({
      sourceStore: store,
      indexStore: ingest.indexStore,
      embeddingProvider: emb,
      injectMinScore: 0.2,
      hintMinScore: 0.05,
      minCoverage: 0,
    });

    // Global 语料
    const gdir = join(root, 'global-docs');
    await mkdir(gdir, { recursive: true });
    await writeFile(
      join(gdir, 'auth.md'),
      '# 鉴权\n\n使用 JWT 校验会话签名与过期时间，网关负责验签。\n',
      'utf8',
    );
    await writeFile(join(gdir, 'api.ts'), 'export function rateLimit() {\n  // 100 req/min\n}\n', 'utf8');
    const g = store.register({
      kind: 'directory',
      location: gdir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'global-docs',
      description: '公共鉴权与限流说明',
      status: 'ready',
    });
    globalSrcId = g.id;
    await ingest.ingestSource(globalSrcId);
    await ingest.idle();

    // Project 语料（须显式挂载）
    const pdir = join(root, 'proj-alpha');
    await mkdir(pdir, { recursive: true });
    await writeFile(
      join(pdir, 'spec.md'),
      '# proj-alpha\n\n内部合规留存策略 retention policy 专文。\n',
      'utf8',
    );
    const p = store.register({
      kind: 'directory',
      location: pdir,
      scopeRef: { level: 'project', key: 'proj-alpha' },
      displayName: 'proj-alpha',
      description: '项目私有规格',
    });
    projectSrcId = p.id;
    await ingest.ingestSource(projectSrcId);
    await ingest.idle();
  });

  afterAll(async () => {
    ingest.dispose();
    store.database.close();
    await rm(root, { recursive: true, force: true });
  });

  it('P2：挂目录 → partial/ready，关键词与中文可搜', () => {
    expect(['partial', 'ready']).toContain(store.get(globalSrcId)!.status);
    const zh = ingest.indexStore.search('会话签名校验', { sourceIds: [globalSrcId] });
    expect(zh.length).toBeGreaterThan(0);
    expect(zh[0].text).toContain('JWT');
  });

  it('P3：hybrid + 向量写入；coverage 合理', () => {
    expect(ingest.indexStore.embeddingCoverage(globalSrcId)).toBeGreaterThan(0);
    expect(store.get(globalSrcId)!.coverage).toBeGreaterThan(0);
  });

  it('P1：catalog 进 system；Project 未挂载不可见', async () => {
    const asm = createDefaultSystemPromptAssembler({
      constitutionText: '',
      knowledgeCatalog: (ctx) =>
        store.catalogFor(ctx?.agentId ?? 'a1', { sessionId: ctx?.sessionId }),
      knowledgeMaxEntries: 10,
    });

    const beforeAssign = await asm.assemble({
      sessionId: 's1',
      agentId: 'a1',
      messages: [user('hello')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(beforeAssign.systemPrompt).toContain('Knowledge Sources');
    expect(beforeAssign.systemPrompt).toContain('global-docs');
    expect(beforeAssign.systemPrompt).toContain('公共鉴权');
    expect(beforeAssign.systemPrompt).not.toContain('proj-alpha');

    store.assignProject('proj-alpha', 'a1');
    const afterAssign = await asm.assemble({
      sessionId: 's1',
      agentId: 'a1',
      messages: [user('hello')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(afterAssign.systemPrompt).toContain('proj-alpha');

    // hide Global
    store.hideSource('a1', globalSrcId);
    const afterHide = await asm.assemble({
      sessionId: 's1',
      agentId: 'a1',
      messages: [user('hello')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(afterHide.systemPrompt).not.toContain('global-docs');
    store.unhideSource('a1', globalSrcId);
  });

  it('P4：grounding 注入不可信块 + hit log；compact 可 strip', async () => {
    const grounding = new GroundingAssembler({
      retriever,
      hitLog: hits,
      skipIfUserTokensBelow: 0,
      includePriorUserTurns: 0,
    });

    const pack = await grounding.assemble({
      agentId: 'a1',
      sessionId: 's-e2e',
      messages: [user('JWT 会话鉴权怎么校验？')],
    });
    expect(pack.mode).toBe('inject');
    expect(pack.text).toContain('knowledge-grounding');
    expect(pack.text).toContain('不是指令');
    expect(pack.hits.length).toBeGreaterThan(0);

    expect(hits.stats().total).toBeGreaterThan(0);

    const msg = {
      role: 'user' as const,
      content: pack.text!,
      timestamp: Date.now(),
      metadata: { source: 'knowledgeGrounding' },
    };
    expect(stripKnowledgeGrounding([msg, user('hi')]).length).toBe(1);
  });

  it('P4：recall=hint 压制 inject；off 不产正文', async () => {
    const hintR = new KnowledgeRetriever({
      sourceStore: store,
      indexStore: ingest.indexStore,
      embeddingProvider: fakeEmbedding(),
      recall: 'hint',
      injectMinScore: 0.01,
      hintMinScore: 0.01,
      minCoverage: 0,
    });
    const hintPack = await new GroundingAssembler({
      retriever: hintR,
      skipIfUserTokensBelow: 0,
    }).assemble({
      agentId: 'a1',
      sessionId: 's-e2e',
      messages: [user('JWT 会话鉴权')],
    });
    expect(hintPack.mode).toBe('hint');
    expect(hintPack.text).toContain('相关');

    const offR = new KnowledgeRetriever({
      sourceStore: store,
      indexStore: ingest.indexStore,
      recall: 'off',
    });
    const offPack = await new GroundingAssembler({
      retriever: offR,
      skipIfUserTokensBelow: 0,
    }).assemble({
      agentId: 'a1',
      sessionId: 's-e2e',
      messages: [user('JWT 会话鉴权')],
    });
    expect(offPack.mode).toBe('none');
  });

  it('P4：knowledge_search / read 可见性 + 不可信包装 + hit 记录', async () => {
    const tools = createKnowledgeTools({
      retriever,
      indexStore: ingest.indexStore,
      sourceStore: store,
      hitLog: hits,
    });
    const search = tools.find((t) => t.definition.name === 'knowledge_search')!;
    const read = tools.find((t) => t.definition.name === 'knowledge_read')!;

    const hitsBefore = hits.stats().total;

    // 未挂载 project 的 agent 不能读 project 源
    const sres = (await callTool(search, { query: 'retention policy' }, {
      agentId: 'a2',
      sessionId: 's-x',
    })) as { hits: Array<{ path: string; sourceId: string }>; note?: string };
    expect(sres.hits.every((h) => !h.path.includes('proj-alpha'))).toBe(true);

    // 挂载后可搜
    store.assignProject('proj-alpha', 'a2');
    const sres2 = (await callTool(search, { query: 'retention policy' }, {
      agentId: 'a2',
      sessionId: 's-x',
    })) as { hits: Array<{ path: string }> };
    expect(sres2.hits.some((h) => h.path.includes('proj-alpha'))).toBe(true);

    const chunk = ingest.indexStore.search('retention policy', {
      sourceIds: [projectSrcId],
      limit: 1,
    })[0];
    expect(chunk).toBeTruthy();

    const rres = (await callTool(read, { chunk_id: chunk!.chunkId }, {
      agentId: 'a2',
      sessionId: 's-x',
    })) as { found: boolean; text: string };
    expect(rres.found).toBe(true);
    expect(rres.text).toContain('knowledge-grounding');

    // 不可见 agent 读不到
    const rresHidden = (await callTool(read, { chunk_id: chunk!.chunkId }, {
      agentId: 'a3',
      sessionId: 's-x',
    })) as { found: boolean };
    expect(rresHidden.found).toBe(false);

    expect(hits.stats().total).toBeGreaterThan(hitsBefore);
  });

  it('P5：purge 后不可再命中，痕迹清除', () => {
    const path = ingest.indexStore
      .listFiles(projectSrcId)
      .map((f) => f.path)
      .find((p) => p.endsWith('spec.md'))!;
    expect(
      ingest.indexStore.search('retention', { sourceIds: [projectSrcId] }).length,
    ).toBeGreaterThan(0);

    purger.purgePath(projectSrcId, path);
    expect(
      ingest.indexStore.search('retention', { sourceIds: [projectSrcId] }).length,
    ).toBe(0);

    // promotion 候选只来自 hit，purge 后该 path 不应再有
    const cands = hits.promotionCandidates();
    expect(cands.every((c) => c.path !== path)).toBe(true);
  });

  it('Memory 层仍独立：reflector 不写 Knowledge（边界）', async () => {
    const mem = new InMemoryMemoryStore();
    const asm = createDefaultSystemPromptAssembler({
      constitutionText: '',
      memoryStore: mem,
      knowledgeCatalog: () => [],
    });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [user('hi')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(result.systemPrompt).toContain('You are test.');
    expect(result.systemPrompt).not.toContain('Knowledge Sources');
  });
});
