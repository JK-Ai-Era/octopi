/**
 * doctor 归档/删除残留扫描与清除（P3，ARC001–ARC007）——污染夹具验收
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import {
  applyArchiveResidueFixes,
  collectLiveSessionRoster,
  detectArchiveResidue,
} from '../src/cli/doctor/archive-residue.js';
import { knowledgeDbPath } from '../src/cli/doctor/data.js';

const prevHome = process.env.OCTOPI_HOME;
let home: string;

async function seedPollutedFixture(): Promise<void> {
  // 在世会话 live-1（jsonl + 元索引 + 派生品 + dump）
  mkdirSync(join(home, 'sessions', 'live-1', 'derived'), { recursive: true });
  writeFileSync(join(home, 'sessions', 'live-1.jsonl'), '{"id":"live-1"}\n');
  writeFileSync(join(home, 'sessions', 'sessions.json'), JSON.stringify({ 'live-1': {} }));
  writeFileSync(join(home, 'sessions', 'live-1', 'derived', 'keep.png'), 'live');
  mkdirSync(join(home, 'logs', 'llm-requests', 'live-1'), { recursive: true });
  writeFileSync(join(home, 'logs', 'llm-requests', 'live-1', 'req.json'), 'x'.repeat(100));

  // 残留面：孤儿 dump / _unscoped / 孤儿会话目录（含 derived 残留 + 纯空）/ 旧月度 gz / staging
  mkdirSync(join(home, 'logs', 'llm-requests', 'gone-1'), { recursive: true });
  writeFileSync(join(home, 'logs', 'llm-requests', 'gone-1', 'req.json'), 'y'.repeat(200));
  mkdirSync(join(home, 'logs', 'llm-requests', '_unscoped'), { recursive: true });
  writeFileSync(join(home, 'logs', 'llm-requests', '_unscoped', 'u.json'), 'z');
  mkdirSync(join(home, 'sessions', 'gone-2', 'derived'), { recursive: true });
  writeFileSync(join(home, 'sessions', 'gone-2', 'derived', 'left.png'), 'r');
  mkdirSync(join(home, 'sessions', 'gone-3'), { recursive: true });
  mkdirSync(join(home, 'archives', '.staging'), { recursive: true });
  writeFileSync(join(home, 'archives', '.staging', 'x.seal.json'), '{}');
  writeFileSync(join(home, 'archives', '2026-09.sessions.jsonl.gz'), 'legacy');

  // knowledge：live-1 与 gone-9 各一份 session 源 + visibility + hits
  const db = await KnowledgeDatabase.create({ dbPath: knowledgeDbPath() });
  try {
    const ins = db.raw.prepare(
      `INSERT INTO knowledge_sources (id, kind, location, scope_level, scope_key, display_name, created_at, updated_at)
       VALUES (?, 'dir', ?, 'session', ?, ?, 1, 1)`,
    );
    ins.run('src-live', '/tmp/a', 'live-1', 'live src');
    ins.run('src-gone', '/tmp/b', 'gone-9', 'gone src');
    const vis = db.raw.prepare(
      `INSERT INTO knowledge_session_visibility (local_session_id, target_type, target_id, op, created_at)
       VALUES (?, 'source', ?, 'include', 1)`,
    );
    vis.run('live-1', 'src-live');
    vis.run('gone-9', 'src-gone');
    const hit = db.raw.prepare(
      `INSERT INTO knowledge_hits (id, source_id, path, query, session_id, created_at)
       VALUES (?, ?, '/p.md', 'q', ?, 1)`,
    );
    hit.run('h1', 'src-live', 'live-1');
    hit.run('h2', 'src-gone', 'gone-9');
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'octopi-doctor-residue-'));
  process.env.OCTOPI_HOME = home;
  await seedPollutedFixture();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('doctor 归档/删除残留（ARC001–ARC007）', () => {
  it('污染夹具上七个残留面全命中；live 面（会话/dump/源/行）不报', async () => {
    const findings = await detectArchiveResidue();
    const byId = new Map(findings.map((f) => [f.id, f]));
    expect([...byId.keys()].sort()).toEqual([
      'ARC001', 'ARC002', 'ARC003', 'ARC004', 'ARC005', 'ARC006', 'ARC007',
    ]);
    expect(byId.get('ARC001')!.message).toContain('1 dir(s)');
    expect(byId.get('ARC001')!.fixable).toBe(true);
    expect(byId.get('ARC003')!.message).toContain('2 dir(s)');
    expect(byId.get('ARC003')!.message).toContain('1 still hold residue');
    expect(byId.get('ARC004')!.message).toContain('gone src');
    expect(byId.get('ARC004')!.message).not.toContain('live src');
    expect(byId.get('ARC005')!.message).toContain('session_visibility=1, hits=1');
    expect(byId.get('ARC006')!.fixable).toBe(false);
    expect(byId.get('ARC007')!.fixable).toBe(false);
  });

  it('roster 双源并集：元索引与文件名都算在世', () => {
    const roster = collectLiveSessionRoster(home);
    expect(roster.ids.has('live-1')).toBe(true);
    expect(roster.ids.has('gone-2')).toBe(false);
    expect(roster.names.has('live-1')).toBe(true);
  });
});

describe('applyArchiveResidueFixes（--fix）', () => {
  it('清尽孤儿面、live 面原样、ARC006/007 不动手；重跑幂等', async () => {
    const result = await applyArchiveResidueFixes();
    expect(result.notes.some((n) => n.includes('wire-dump dir deleted'))).toBe(true);
    expect(result.notes.some((n) => n.includes('orphan session dir deleted'))).toBe(true);
    expect(result.notes.some((n) => n.includes('unscoped dump dir deleted'))).toBe(true);
    expect(result.notes.some((n) => n.includes('gone src'))).toBe(true);
    expect(result.notes.some((n) => n.includes('session_visibility=1, hits=1'))).toBe(true);

    // 孤儿面清尽
    expect(existsSync(join(home, 'logs', 'llm-requests', 'gone-1'))).toBe(false);
    expect(existsSync(join(home, 'logs', 'llm-requests', '_unscoped'))).toBe(false);
    expect(existsSync(join(home, 'sessions', 'gone-2'))).toBe(false);
    expect(existsSync(join(home, 'sessions', 'gone-3'))).toBe(false);
    // live 面原样
    expect(existsSync(join(home, 'logs', 'llm-requests', 'live-1', 'req.json'))).toBe(true);
    expect(existsSync(join(home, 'sessions', 'live-1', 'derived', 'keep.png'))).toBe(true);
    // ARC006/ARC007 永不动手（唯一正文可能只在源文件 / reconcile 有收尾语义）
    expect(existsSync(join(home, 'archives', '2026-09.sessions.jsonl.gz'))).toBe(true);
    expect(existsSync(join(home, 'archives', '.staging', 'x.seal.json'))).toBe(true);

    // knowledge：gone 源与行删尽、live 保留
    const db = await KnowledgeDatabase.create({ dbPath: knowledgeDbPath() });
    try {
      const srcIds = (db.raw.prepare('SELECT id FROM knowledge_sources ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
      expect(srcIds).toEqual(['src-live']);
      const vis = db.raw.prepare('SELECT COUNT(*) AS n FROM knowledge_session_visibility').get() as { n: number };
      const hits = db.raw.prepare('SELECT COUNT(*) AS n FROM knowledge_hits').get() as { n: number };
      expect(vis.n).toBe(1);
      expect(hits.n).toBe(1);
    } finally {
      db.close();
    }

    // 幂等重跑：只剩 ARC006/ARC007 报告项
    const again = await detectArchiveResidue();
    expect(again.map((f) => f.id).sort()).toEqual(['ARC006', 'ARC007']);
    const second = await applyArchiveResidueFixes();
    expect(second.notes).toEqual(['no archive residue to clean']);
  });

  it('dry-run 只描述不动盘', async () => {
    const result = await applyArchiveResidueFixes({ dryRun: true });
    expect(result.notes.some((n) => n.includes('[dry-run] would delete 1 orphan wire-dump'))).toBe(true);
    expect(result.notes.some((n) => n.includes('would unregister 1 orphan session knowledge source'))).toBe(true);
    expect(existsSync(join(home, 'logs', 'llm-requests', 'gone-1', 'req.json'))).toBe(true);
    expect(existsSync(join(home, 'sessions', 'gone-2', 'derived', 'left.png'))).toBe(true);
  });
});
