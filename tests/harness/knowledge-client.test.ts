/**
 * KnowledgeClient ↔ startKnowledgeService 端到端
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startKnowledgeService } from '@octopi-agent/engine/harness/knowledge/serve.js';
import { KnowledgeClient } from '@octopi-agent/engine/harness/knowledge/client.js';

describe('KnowledgeClient + serve', () => {
  it('health / createSource / search / delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kn-cli-'));
    await writeFile(join(root, 'a.md'), 'client search target phrase\n', 'utf8');

    const svc = await startKnowledgeService({
      dbPath: ':memory:',
      port: 0,
      tokens: [{ token: 't1', tenantId: 'acme', gatewayId: 'gw1' }],
      autoRegisterPrincipals: true,
    });
    const client = new KnowledgeClient({
      baseUrl: `http://127.0.0.1:${svc.port}`,
      token: 't1',
      timeoutMs: 3000,
    });

    try {
      const h = await client.health();
      expect(h.ok).toBe(true);

      await client.ensurePrincipal('coder');
      const src = await client.createSource({
        kind: 'file',
        location: join(root, 'a.md'),
        scopeRef: { level: 'global', key: 'global' },
        displayName: 'a',
        visibility: 'public',
      });
      expect(src.id).toBeTruthy();
      // 不调 reindex：注册必须自动开索引
      await new Promise((r) => setTimeout(r, 300));

      const found = await client.search('coder', 'client search');
      expect(Array.isArray(found.hits)).toBe(true);
      expect(found.hits.length).toBeGreaterThan(0);

      await client.deleteSource(String(src.id));
      const list = await client.listSources();
      expect(list.some((s) => s.id === src.id)).toBe(false);
    } finally {
      await svc.close();
    }
  });
});
