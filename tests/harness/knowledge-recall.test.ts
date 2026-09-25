/**
 * Agent 级 knowledge.recall — off / hint / hybrid / inject
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import { KnowledgeIngest } from '../../src/harness/knowledge/ingest.js';
import { KnowledgeRetriever } from '../../src/harness/knowledge/retriever.js';
import type { Message } from '../../src/core/types.js';
import { GroundingAssembler } from '../../src/harness/knowledge/grounding.js';

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'kn-recall-'));
  const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
  const ingest = new KnowledgeIngest({ sourceStore: store });
  const dir = join(root, 'docs');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'a.md'), '# a\n\nspecific compliance retention policy text\n', 'utf8');
  const src = store.register({
    kind: 'directory',
    location: dir,
    scopeRef: { level: 'global', key: 'global' },
    displayName: 'docs',
  });
  await ingest.ingestSource(src.id);
  await ingest.idle();
  return {
    store,
    ingest,
    root,
    srcId: src.id,
    cleanup: async () => {
      ingest.dispose();
      store.database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('knowledge.recall', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('off → always none', async () => {
    ctx = await setup();
    const r = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
      recall: 'off',
      injectMinScore: 0.01,
    });
    const d = await r.autoGround('compliance retention', { agentId: 'a1' });
    expect(d.mode).toBe('none');
    expect(d.reason).toBe('recall_off');
  });

  it('hint → suppress inject，最多 hint', async () => {
    ctx = await setup();
    const r = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
      recall: 'hint',
      injectMinScore: 0.01,
      hintMinScore: 0.01,
      minCoverage: 0,
    });
    const d = await r.autoGround('compliance retention policy', { agentId: 'a1' });
    expect(d.mode).toBe('hint');
    expect(d.hits.length).toBe(0);
    expect(d.reason).toContain('hint');
    expect(d.hint).toContain('相关的材料');
  });

  it('hybrid → 高分可 inject', async () => {
    ctx = await setup();
    const r = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
      recall: 'hybrid',
      injectMinScore: 0.05,
      hintMinScore: 0.01,
      minCoverage: 0,
    });
    const d = await r.autoGround('compliance retention policy', { agentId: 'a1' });
    expect(d.mode).toBe('inject');
  });

  it('inject 模式地板更低（更积极）', async () => {
    ctx = await setup();
    const loose = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
      recall: 'inject',
      injectMinScore: 0.9, // 高名义门槛；inject 模式会下调
      hintMinScore: 0.01,
      minCoverage: 0,
    });
    const d = await loose.autoGround('compliance retention policy', { agentId: 'a1' });
    expect(['inject', 'hint']).toContain(d.mode);
  });

  it('GroundingAssembler 在 off 时无正文', async () => {
    ctx = await setup();
    const r = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
      recall: 'off',
    });
    const asm = new GroundingAssembler({
      retriever: r,
      skipIfUserTokensBelow: 0,
    });
    const pack = await asm.assemble({
      agentId: 'a1',
      sessionId: 's',
      messages: [user('compliance retention policy document')],
    });
    expect(pack.mode).toBe('none');
    expect(pack.text).toBeUndefined();
  });
});
