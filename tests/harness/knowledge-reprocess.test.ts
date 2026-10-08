/**
 * 按路径重做 — Web「重做」不得再抛 not_implemented
 */
import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalKnowledgeWriteService } from '@octopi-agent/engine/harness/knowledge/writer-service.js';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';

describe('reprocessFiles via write service', () => {
  it('按路径入队 parse 并返回 counts；空 paths/filter 拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kreproc-'));
    const dir = join(root, 'docs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), '# a\n\nhello\n', 'utf8');
    await writeFile(join(dir, 'b.md'), '# b\n\nworld\n', 'utf8');

    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const write = new LocalKnowledgeWriteService({
      db,
      embed: { enabled: false },
    });
    const identity = { tenantId: 'default', gatewayId: 'gw-a' };
    const src = await write.registerSource(identity, {
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'docs',
      sync: { enabled: false, strategy: 'manual' },
    });

    const r = await write.reprocessFiles(src.id, [join(dir, 'a.md')]);
    expect(r.queued + r.alreadyActive).toBeGreaterThan(0);
    expect(r.rejected).toBe(0);

    // byFilter 依赖已入库 path；未索引时合法返回 0，不抛 not_implemented
    const empty = await write.reprocessByFilter(src.id, { ext: 'md' });
    expect(empty.queued).toBe(0);
    expect(empty.rejected).toBe(0);

    await write.dispose();
    db.close();
  });
});
