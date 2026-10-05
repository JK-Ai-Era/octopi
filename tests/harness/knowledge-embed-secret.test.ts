/**
 * embedding 外发敏感形态策略 — redact / skip / allow
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';
import { redactSecretShapes, scanSecretShapes } from '@octopi-agent/engine/harness/knowledge/secret-scan.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-embed-sec-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeIngest(
  sources: KnowledgeSourceStore,
  index: KnowledgeIndexStore,
  policy: 'allow' | 'redact' | 'skip',
  sent: string[],
) {
  return new KnowledgeIngest({
    sourceStore: sources,
    indexStore: index,
    embedSecretPolicy: policy,
    embeddingProvider: {
      name: 'probe',
      dimensions: 2,
      async embed(text: string) {
        sent.push(text);
        return [1, 0];
      },
      async embedBatch(texts: string[]) {
        sent.push(...texts);
        return texts.map(() => [1, 0]);
      },
    },
  });
}

describe('embed secret policy', () => {
  it('redactSecretShapes 替换命中并报规则名', () => {
    const raw = 'token is sk-abcdefghijklmnopqrstuvwx and password=hunter2secret';
    const { text, hits } = redactSecretShapes(raw);
    expect(hits).toContain('openai_style_key');
    expect(hits).toContain('password_assignment');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(text).toContain('[REDACTED:');
    expect(scanSecretShapes(text).filter((h) => h !== 'password_assignment').length).toBe(0);
  });

  it('policy=redact：外发文本不含密钥原文', async () => {
    const filePath = join(root, 'sec.md');
    await writeFile(filePath, 'config: api_key=sk-abcdefghijklmnopqrstuvwx\n', 'utf8');
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'redact',
    });

    const sent: string[] = [];
    const ingest = makeIngest(sources, index, 'redact', sent);
    try {
      await ingest.ingestSource(src.id);
      await ingest.idle(10_000);

      expect(sent.length).toBeGreaterThan(0);
      for (const t of sent) {
        expect(t).not.toContain('sk-abcdefghijklmnopqrstuvwx');
      }
      expect(sent.some((t) => t.includes('[REDACTED:'))).toBe(true);

      const log = sources.database.raw
        .prepare(`SELECT action, hits_json FROM knowledge_embed_secret_log`)
        .all() as Array<{ action: string; hits_json: string }>;
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].action).toBe('redacted');
      expect(log[0].hits_json).toContain('openai_style_key');
    } finally {
      ingest.dispose();
      sources.database.close();
    }
  });

  it('policy=skip：命中不写向量（墓碑防重试），关键词仍可搜', async () => {
    const filePath = join(root, 'skip.md');
    await writeFile(filePath, 'secret material sk-abcdefghijklmnopqrstuvwx 限流策略\n', 'utf8');
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'skip',
    });

    const sent: string[] = [];
    const ingest = makeIngest(sources, index, 'skip', sent);
    try {
      await ingest.ingestSource(src.id);
      await ingest.idle(10_000);

      expect(sent.length).toBe(0);
      const emb = sources.database.raw
        .prepare(
          `SELECT dimensions FROM knowledge_chunk_embeddings e
           JOIN knowledge_chunks c ON c.id = e.chunk_id
           WHERE c.source_id = ?`,
        )
        .all(src.id) as Array<{ dimensions: number }>;
      expect(emb.length).toBeGreaterThan(0);
      expect(emb.every((r) => r.dimensions === 0)).toBe(true);

      expect(index.search('限流', { sourceIds: [src.id] }).length).toBeGreaterThan(0);

      const log = sources.database.raw
        .prepare(`SELECT action FROM knowledge_embed_secret_log`)
        .all() as Array<{ action: string }>;
      expect(log.some((r) => r.action === 'skipped')).toBe(true);
    } finally {
      ingest.dispose();
      sources.database.close();
    }
  });

  it('policy=allow：原文外发（内网/本地模型）', async () => {
    const filePath = join(root, 'allow.md');
    await writeFile(filePath, 'api_key=sk-abcdefghijklmnopqrstuvwx\n', 'utf8');
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'allow',
    });
    const sent: string[] = [];
    const ingest = makeIngest(sources, index, 'allow', sent);
    try {
      await ingest.ingestSource(src.id);
      await ingest.idle(10_000);
      expect(sent.some((t) => t.includes('sk-abcdefghijklmnopqrstuvwx'))).toBe(true);
      const log = sources.database.raw
        .prepare(`SELECT COUNT(*) AS n FROM knowledge_embed_secret_log`)
        .get() as { n: number };
      expect(log.n).toBe(0);
    } finally {
      ingest.dispose();
      sources.database.close();
    }
  });
});
