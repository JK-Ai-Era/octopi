/**
 * 中止态跨重启 — DB 权威，进程重建后不得自动续跑
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';
import { KnowledgeJobControl } from '@octopi-agent/engine/harness/knowledge/job-control.js';

describe('abort state survives process restart', () => {
  it('KnowledgeJobControl: markAborted / isAborted / beginEpoch 落库', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const ctrl = new KnowledgeJobControl(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-abort-db',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'abort-db',
    });

    expect(ctrl.isAborted(src.id)).toBe(false);
    expect(ctrl.markAborted(src.id)).toBe(true);
    expect(ctrl.isAborted(src.id)).toBe(true);
    expect(ctrl.listAbortedSourceIds()).toContain(src.id);
    expect(ctrl.allowsDispatch(src.id)).toBe(false);

    ctrl.beginEpoch(src.id);
    expect(ctrl.isAborted(src.id)).toBe(false);
    expect(ctrl.allowsDispatch(src.id)).toBe(true);
    sources.database.close();
  });

  it('同一 DB 上新建 Ingest：中止态仍生效，claim 不派发', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-abort-restart',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'abort-restart',
    });

    // 第一「进程」：中止
    const ingest1 = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_r1', ?, 'parse_file', '/tmp/kn-abort-restart/a.md', 1, 'queued', 0, ?, ?)`,
      )
      .run(src.id, Date.now(), Date.now());
    ingest1.abortJobs({ sourceId: src.id });
    ingest1.dispose();

    // 第二「进程」：同一 DB
    const ingest2 = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    try {
      expect(ingest2.jobControlState(src.id).aborted).toBe(true);

      // 中止后新任务不得被 claim（看门狗/循环）
      sources.database.raw
        .prepare(
          `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
           VALUES ('kj_r2', ?, 'parse_file', '/tmp/kn-abort-restart/b.md', 1, 'queued', 0, ?, ?)`,
        )
        .run(src.id, Date.now(), Date.now());
      await ingest2.idle(1_000).catch(() => {
        /* idle 可能因永不完成而超时——中止态下不派发是预期 */
      });
      const stillQueued = sources.database.raw
        .prepare(`SELECT status FROM knowledge_jobs WHERE id = 'kj_r2'`)
        .get() as { status: string };
      expect(stillQueued.status).toBe('queued');

      // resume 后可续跑
      ingest2.resumeJobs({ sourceId: src.id });
      expect(ingest2.jobControlState(src.id).aborted).toBe(false);
    } finally {
      ingest2.dispose();
      sources.database.close();
    }
  });

  it('resume 只复活 aborted 取消的任务，不碰 superseded', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-abort-resume',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'abort-resume',
    });
    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    try {
      const now = Date.now();
      sources.database.raw
        .prepare(
          `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
           VALUES
             ('kj_ab', ?, 'parse_file', '/a.md', 1, 'cancelled', 0, ?, ?),
             ('kj_sp', ?, 'parse_file', '/b.md', 1, 'cancelled', 0, ?, ?)`,
        )
        .run(src.id, now, now, src.id, now, now);
      sources.database.raw
        .prepare(`UPDATE knowledge_jobs SET last_error = 'aborted' WHERE id = 'kj_ab'`)
        .run();
      sources.database.raw
        .prepare(`UPDATE knowledge_jobs SET last_error = 'superseded_by_reindex' WHERE id = 'kj_sp'`)
        .run();

      ingest.abortJobs({ sourceId: src.id });
      ingest.resumeJobs({ sourceId: src.id });

      const ab = sources.database.raw
        .prepare(`SELECT status FROM knowledge_jobs WHERE id = 'kj_ab'`)
        .get() as { status: string };
      const sp = sources.database.raw
        .prepare(`SELECT status FROM knowledge_jobs WHERE id = 'kj_sp'`)
        .get() as { status: string };
      expect(ab.status).toBe('queued');
      expect(sp.status).toBe('cancelled');
    } finally {
      ingest.dispose();
      sources.database.close();
    }
  });
});
