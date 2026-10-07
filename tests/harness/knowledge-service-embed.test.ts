/**
 * Knowledge Service embedding 接线：models.embedding → Service → embed_source
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startKnowledgeService } from '@octopi-agent/engine/harness/knowledge/serve.js';
import { KnowledgeClient } from '@octopi-agent/engine/harness/knowledge/client.js';
import type { EmbeddingProvider } from '@octopi-agent/engine/harness/memory/sqlite/embedding.js';

function stubEmbedder(): EmbeddingProvider {
  let n = 0;
  return {
    name: 'stub',
    dimensions: 4,
    async embed() {
      n += 1;
      return [n, 0.1, 0.2, 0.3];
    },
    async embedBatch(texts: string[]) {
      return texts.map((_, i) => [i + n, 0.1, 0.2, 0.3]);
    },
  };
}

describe('Knowledge Service embedding wiring', () => {
  it('注册后 parse 并写入向量（stub provider）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kn-emb-'));
    await writeFile(join(root, 'a.md'), 'embed me please unique-phrase\n', 'utf8');
    const svc = await startKnowledgeService({
      dbPath: ':memory:',
      port: 0,
      tokens: [{ token: 't', tenantId: 'd', gatewayId: 'g' }],
      autoRegisterPrincipals: true,
      testEmbeddingStub: true,
      embed: { enabled: true, embedBatch: 8, embedConcurrency: 1 },
    });
    const client = new KnowledgeClient({
      baseUrl: `http://127.0.0.1:${svc.port}`,
      token: 't',
      timeoutMs: 5000,
    });
    try {
      await client.ensurePrincipal('a1');
      const src = await client.createSource({
        kind: 'file',
        location: join(root, 'a.md'),
        scopeRef: { level: 'global', key: 'global' },
        displayName: 'a',
        visibility: 'public',
      });
      let embeddings = 0;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const stats = (await client.stats('default')) as { embeddings?: number };
        embeddings = Number(stats.embeddings ?? 0);
        if (embeddings > 0) break;
      }
      expect(embeddings).toBeGreaterThan(0);
    } finally {
      await svc.close();
    }
  });
});
