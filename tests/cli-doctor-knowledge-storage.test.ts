/**
 * A13/A15 — doctor knowledge.db 存储健康：空页回收（VACUUM）+ embed 墓碑报告。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prevHome = process.env.OCTOPI_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'octopi-doctor-storage-'));
  mkdirSync(join(home, 'knowledge'), { recursive: true });
  process.env.OCTOPI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

async function seedKnowledgeDb(): Promise<void> {
  const { KnowledgeDatabase } = await import(
    '../packages/engine/src/harness/knowledge/db.js'
  );
  const db = await KnowledgeDatabase.create({
    dbPath: join(home, 'knowledge', 'knowledge.db'),
    sqliteVec: false,
  });
  try {
    // 墓碑：embedSecretPolicy=skip 的写形态（dimensions=0）
    db.raw
      .prepare(
        `INSERT INTO knowledge_chunk_embeddings (chunk_id, dimensions, embedding, bucket, created_at)
         VALUES ('c1', 0, x'', -1, 0)`,
      )
      .run();
    // 制造空页：临时大表后 DROP
    db.raw.exec('CREATE TABLE IF NOT EXISTS junk (v BLOB)');
    for (let i = 0; i < 200; i += 1) {
      db.raw.prepare('INSERT INTO junk (v) VALUES (?)').run(Buffer.alloc(1024, 7));
    }
    db.raw.exec('DROP TABLE junk');
  } finally {
    db.close();
  }
}

describe('detectKnowledgeStorageHealth', () => {
  it('reports embed tombstones (KN009) and free pages over threshold (KN008)', async () => {
    await seedKnowledgeDb();
    const { detectKnowledgeStorageHealth } = await import('../src/cli/doctor/data.js');
    const findings = await detectKnowledgeStorageHealth({ vacuumMinReclaimBytes: 1024 });
    const ids = findings.map((f) => f.id);
    expect(ids).toContain('KN008');
    expect(ids).toContain('KN009');
    expect(findings.find((f) => f.id === 'KN009')?.message).toContain('1 embed tombstone');
  });

  it('quiet when under threshold and no tombstones', async () => {
    const { detectKnowledgeStorageHealth } = await import('../src/cli/doctor/data.js');
    // 库不存在 → 无 findings
    expect(await detectKnowledgeStorageHealth()).toEqual([]);
  });
});

describe('vacuumKnowledgeDatabaseIfWorthwhile', () => {
  it('reclaims free pages when over threshold and skips when under', async () => {
    await seedKnowledgeDb();
    const { vacuumKnowledgeDatabaseIfWorthwhile } = await import('../src/cli/doctor/data.js');
    const note = await vacuumKnowledgeDatabaseIfWorthwhile({ vacuumMinReclaimBytes: 1024 });
    expect(note).toMatch(/VACUUM reclaimed/);
    // 第二次：空页已回收（低于 1KB 阈值）→ null
    const again = await vacuumKnowledgeDatabaseIfWorthwhile({ vacuumMinReclaimBytes: 1024 });
    expect(again).toBeNull();
  });
});
