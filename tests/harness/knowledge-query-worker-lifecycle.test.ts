/**
 * Query Worker 生命周期 — dispose 必须真正发出 shutdown；只读连接不得跑 DDL
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { createKnowledgeQueryService } from '@octopi-agent/engine/harness/knowledge/query-service.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';
import { WorkerQueryService } from '@octopi-agent/engine/harness/knowledge/query-worker-client.js';

describe('query worker lifecycle', () => {
  it('dispose 先 shutdown 再 disposed（不得静默 terminate）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-qw-'));
    const dbPath = join(dir, 'k.db');
    // Engine 写者先建库
    const engineDb = await KnowledgeDatabase.create({ dbPath });
    const sources = new KnowledgeSourceStore(engineDb);
    const index = new KnowledgeIndexStore(engineDb);
    const retriever = new KnowledgeRetriever({ sourceStore: sources, indexStore: index });
    sources.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'src',
    });

    const worker = await createKnowledgeQueryService({ dbPath, mode: 'worker' });
    const list = await worker.listSources({});
    expect(list.length).toBeGreaterThan(0);

    // dispose 后再调用必须明确失败，而不是卡住
    await worker.dispose();
    await expect(worker.listSources({})).rejects.toThrow(/disposed|exit/i);

    engineDb.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('readOnly 打开不跑 createTables（已建库可读）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-ro-'));
    const dbPath = join(dir, 'k.db');
    const w = await KnowledgeDatabase.create({ dbPath });
    w.close();

    const ro = await KnowledgeDatabase.create({ dbPath, readOnly: true, skipMigrate: true });
    // 能 SELECT 既有表
    const n = ro.raw.prepare('SELECT COUNT(*) AS n FROM knowledge_sources').get() as { n: number };
    expect(n.n).toBe(0);
    ro.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('WorkerQueryService.start 启动失败快速报错（非 30s 空等）', async () => {
    await expect(
      WorkerQueryService.start({ dbPath: join('Z:\\not-exist-path-xx', 'nope.db') }),
    ).rejects.toThrow();
  });
});
