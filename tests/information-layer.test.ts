/**
 * Information 层测试
 *
 * Jsonl lifecycle 投影 + SessionArchiveManager（基于 SessionStore）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonlSessionStore } from '../src/integration/storage/jsonl.js';
import { SessionArchiveManager } from '../src/integration/storage/archive-manager.js';
import type { SessionData } from '../src/harness/session-types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createTestSession(id: string, agentId = 'agent-1'): SessionData {
  return {
    id,
    agentId,
    meta: {
      id,
      agentId,
      channelId: 'test',
      peerId: 'user',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [
      { role: 'user', content: 'hello', timestamp: Date.now() },
      { role: 'assistant', content: 'hi there', timestamp: Date.now() },
    ],
    turns: [],
    metadata: {},
  };
}

function markEnded(store: JsonlSessionStore, session: SessionData, endedAt = Date.now()): SessionData {
  const next: SessionData = {
    ...session,
    lifecycle: { lifecycle: 'recent', endedAt },
  };
  return next;
}

// ── Jsonl lifecycle 投影 ──

describe('JsonlSessionStore lifecycle projection', () => {
  let tempDir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'octopi-jsonl-lifecycle-'));
    store = new JsonlSessionStore({ sessionsDir: join(tempDir, 'sessions') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists lifecycle into meta index and listByLifecycle', async () => {
    const s1 = createTestSession('s1');
    await store.save('s1', s1);
    await store.save('s2', createTestSession('s2'));

    const ended = markEnded(store, s1);
    await store.save('s1', ended);

    const active = await store.listByLifecycle('active');
    expect(active.map((m) => m.id)).toEqual(['s2']);

    const recent = await store.listByLifecycle('recent');
    expect(recent.map((m) => m.id)).toEqual(['s1']);
    expect(recent[0].endedAt).toBeTruthy();
    expect(recent[0].lifecycle).toBe('recent');

    const loaded = await store.load('s1');
    expect(loaded?.lifecycle?.lifecycle).toBe('recent');
    expect(loaded?.lifecycle?.endedAt).toBe(ended.lifecycle!.endedAt);
  });

  it('list() exposes lifecycle projection without opening state', async () => {
    await store.save('s1', markEnded(store, createTestSession('s1'), 123));
    const metas = await store.list();
    expect(metas.find((m) => m.id === 's1')?.lifecycle).toBe('recent');
    expect(metas.find((m) => m.id === 's1')?.endedAt).toBe(123);
  });
});

// ── SessionArchiveManager（SessionStore 底座） ──

describe('SessionArchiveManager', () => {
  let store: JsonlSessionStore;
  let archiveManager: SessionArchiveManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'octopi-archive-test-'));
    store = new JsonlSessionStore({ sessionsDir: join(tempDir, 'sessions') });
    archiveManager = new SessionArchiveManager(store, {
      archiveDir: join(tempDir, 'archives'),
      recentRetentionDays: 0, // 立即过期，方便测试
      archiveRetentionDays: 180,
      forceArchiveDays: 90,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should archive ended sessions past retention', async () => {
    await store.save('s1', markEnded(store, createTestSession('s1')));

    const archived = await archiveManager.runArchive();
    expect(archived).toBe(1);

    // session 应该从热库删除
    const loaded = await store.load('s1');
    expect(loaded).toBeNull();

    // 应该可以从归档中查询到
    const archivedSession = await archiveManager.queryArchive('s1');
    expect(archivedSession).toBeTruthy();
    expect(archivedSession!.id).toBe('s1');
  });

  it('should force archive sessions past forceArchiveDays', async () => {
    const oldEnded = Date.now() - 100 * 24 * 60 * 60 * 1000;
    await store.save('s1', markEnded(store, createTestSession('s1'), oldEnded));

    const manager2 = new SessionArchiveManager(store, {
      archiveDir: join(tempDir, 'archives'),
      recentRetentionDays: 30,
      forceArchiveDays: 90,
    });
    const archived = await manager2.runArchive();
    expect(archived).toBe(1);
  });

  it('should not archive sessions still in retention', async () => {
    const manager2 = new SessionArchiveManager(store, {
      archiveDir: join(tempDir, 'archives'),
      recentRetentionDays: 30,
      forceArchiveDays: 90,
    });

    await store.save('s1', markEnded(store, createTestSession('s1')));

    const archived = await manager2.runArchive();
    expect(archived).toBe(0);
    expect(await store.load('s1')).toBeTruthy();
  });

  it('should not archive active sessions', async () => {
    await store.save('s1', createTestSession('s1'));
    const archived = await archiveManager.runArchive();
    expect(archived).toBe(0);
  });

  it('refuses to overwrite corrupt sessions.json on save', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(tempDir, 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sessions.json'), '{not json', 'utf-8');
    await expect(store.save('s9', createTestSession('s9'))).rejects.toThrow(/corrupt sessions\.json/);
  });

  it('should not archive sessions without endedAt', async () => {
    const noEnded = createTestSession('s1');
    noEnded.lifecycle = { lifecycle: 'recent' };
    await store.save('s1', noEnded);

    const archived = await archiveManager.runArchive();
    expect(archived).toBe(0);
    expect(await store.load('s1')).toBeTruthy();
  });

  it('should list archived sessions', async () => {
    await store.save('s1', markEnded(store, createTestSession('s1', 'agent-1')));
    await store.save('s2', markEnded(store, createTestSession('s2', 'agent-2')));

    await archiveManager.runArchive();

    const all = await archiveManager.listArchived();
    expect(all.length).toBe(2);

    const agent1 = await archiveManager.listArchived('agent-1');
    expect(agent1.length).toBe(1);
    expect(agent1[0].sessionId).toBe('s1');
  });
});
