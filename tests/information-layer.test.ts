/**
 * Information 层测试
 *
 * Jsonl lifecycle 投影 + SessionArchiveManager（基于 SessionStore）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { SessionArchiveManager } from '@octopi-agent/engine/integration/storage/archive-manager.js';
import { SessionArchiveService } from '@octopi-agent/engine/integration/storage/archives/service.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
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
    steps: [],
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

// ── SessionArchiveManager（冷备读取门面：注册表 + bundle；月度写路径已删） ──

describe('SessionArchiveManager', () => {
  let store: JsonlSessionStore;
  let service: SessionArchiveService;
  let archiveManager: SessionArchiveManager;
  let tempDir: string;
  let archivesDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'octopi-archive-test-'));
    store = new JsonlSessionStore({ sessionsDir: join(tempDir, 'sessions') });
    archivesDir = join(tempDir, 'archives');
    service = new SessionArchiveService({
      sessionsDir: join(tempDir, 'sessions'),
      archivesDir,
      store,
    });
    archiveManager = new SessionArchiveManager({ archivesDir });
  });

  afterEach(async () => {
    service.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('queryArchive：封存后可读回（消息保真），热库已清空', async () => {
    await store.save('s1', markEnded(store, createTestSession('s1')));
    await service.seal({ sessionId: 's1', state: 'archived', sealedBy: 'manual' });
    expect(await store.load('s1')).toBeNull();

    const archivedSession = await archiveManager.queryArchive('s1');
    expect(archivedSession).toBeTruthy();
    expect(archivedSession!.id).toBe('s1');
    expect(archivedSession!.messages.length).toBe(createTestSession('s1').messages.length);
  });

  it('queryArchive 租户收口：越域视为不存在', async () => {
    await store.save('s1', markEnded(store, createTestSession('s1')));
    await service.seal({ sessionId: 's1', state: 'archived', sealedBy: 'manual' });
    expect(await archiveManager.queryArchive('s1', { tenantId: 'other' })).toBeNull();
    expect(await archiveManager.queryArchive('s1', { tenantId: 'default' })).toBeTruthy();
  });

  it('trashed（回收站）不在读取面：queryArchive/listArchived 均不可见', async () => {
    await store.save('s1', markEnded(store, createTestSession('s1')));
    await service.seal({ sessionId: 's1', state: 'trashed', sealedBy: 'trash' });
    expect(await archiveManager.queryArchive('s1')).toBeNull();
    expect(await archiveManager.listArchived()).toEqual([]);
  });

  it('listArchived：全量 / agent 过滤 / string 签名兼容 / 租户过滤', async () => {
    await store.save('s1', markEnded(store, createTestSession('s1', 'agent-1')));
    await store.save('s2', markEnded(store, createTestSession('s2', 'agent-2')));
    await service.seal({ sessionId: 's1', state: 'archived', sealedBy: 'manual' });
    await service.seal({ sessionId: 's2', state: 'archived', sealedBy: 'manual' });

    const all = await archiveManager.listArchived();
    expect(all.length).toBe(2);

    const agent1 = await archiveManager.listArchived({ agentId: 'agent-1' });
    expect(agent1.map((e) => e.sessionId)).toEqual(['s1']);
    // 旧 string 签名 = agentId（绝不静默放宽语义）
    const agent2 = await archiveManager.listArchived('agent-2');
    expect(agent2.map((e) => e.sessionId)).toEqual(['s2']);

    expect((await archiveManager.listArchived({ tenantId: 'default' })).length).toBe(2);
    expect(await archiveManager.listArchived({ tenantId: 'other' })).toEqual([]);
  });

  it('refuses to overwrite corrupt sessions.json on save', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(tempDir, 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sessions.json'), '{not json', 'utf-8');
    await expect(store.save('s9', createTestSession('s9'))).rejects.toThrow(/corrupt sessions\.json/);
  });
});
