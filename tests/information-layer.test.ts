/**
 * Information 层测试
 *
 * 测试 SqliteSessionStore 生命周期管理和 SessionArchiveManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteSessionStore } from '../src/integration/storage/sqlite.js';
import { SessionArchiveManager } from '../src/integration/storage/archive-manager.js';
import type { SessionData } from '../src/core/interfaces/session-store.js';
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

// ── SqliteSessionStore 生命周期测试 ──

describe('SqliteSessionStore lifecycle', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    store = await SqliteSessionStore.create({ dbPath: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  it('should save session with default lifecycle', async () => {
    const data = createTestSession('s1');
    await store.save('s1', data);

    const loaded = await store.load('s1');
    expect(loaded).toBeTruthy();
    expect(loaded!.lifecycle).toBeTruthy();
    expect(loaded!.lifecycle!.lifecycle).toBe('active');
    expect(loaded!.lifecycle!.memoryExtraction).toBe('pending');
  });

  it('should mark session ended', async () => {
    await store.save('s1', createTestSession('s1'));
    await store.markEnded('s1');

    const loaded = await store.load('s1');
    expect(loaded!.lifecycle!.lifecycle).toBe('recent');
    expect(loaded!.lifecycle!.endedAt).toBeTruthy();
  });

  it('should update lifecycle', async () => {
    await store.save('s1', createTestSession('s1'));
    await store.updateLifecycle!('s1', {
      lifecycle: 'extracted',
      memoryExtraction: 'completed',
    });

    const loaded = await store.load('s1');
    expect(loaded!.lifecycle!.lifecycle).toBe('extracted');
    expect(loaded!.lifecycle!.memoryExtraction).toBe('completed');
  });

  it('should list by lifecycle status', async () => {
    await store.save('s1', createTestSession('s1'));
    await store.save('s2', createTestSession('s2'));
    await store.markEnded('s1');

    const active = await store.listByLifecycle!('agent-1', 'active');
    const recent = await store.listByLifecycle!('agent-1', 'recent');

    expect(active.length).toBe(1);
    expect(active[0].id).toBe('s2');
    expect(recent.length).toBe(1);
    expect(recent[0].id).toBe('s1');
  });
});

// ── SessionArchiveManager 测试 ──

describe('SessionArchiveManager', () => {
  let store: SqliteSessionStore;
  let archiveManager: SessionArchiveManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'octopi-archive-test-'));
    store = await SqliteSessionStore.create({ dbPath: join(tempDir, 'sessions.db') });
    archiveManager = new SessionArchiveManager(store, {
      archiveDir: join(tempDir, 'archives'),
      recentRetentionDays: 0, // 立即过期，方便测试
      archiveRetentionDays: 180,
      forceArchiveDays: 90,
    });
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should archive completed sessions', async () => {
    await store.save('s1', createTestSession('s1'));

    // 标记结束
    await store.markEnded('s1');

    // 标记 memory 提取完成
    await store.updateLifecycle!('s1', {
      memoryExtraction: 'completed',
    });

    // 执行归档
    const archived = await archiveManager.runArchive();
    expect(archived).toBe(1);

    // session 应该从 sessions.db 中删除
    const loaded = await store.load('s1');
    expect(loaded).toBeNull();

    // 应该可以从归档中查询到
    const archivedSession = await archiveManager.queryArchive('s1');
    expect(archivedSession).toBeTruthy();
    expect(archivedSession!.id).toBe('s1');
  });

  it('should force archive expired sessions', async () => {
    await store.save('s1', createTestSession('s1'));

    // 标记结束，但 memory 提取未完成
    await store.markEnded('s1');

    // 手动设置 endedAt 为 100 天前（超过 forceArchiveDays）
    const hundredDaysAgo = Date.now() - 100 * 24 * 60 * 60 * 1000;
    (store as any).db.prepare(
      'UPDATE sessions SET ended_at = ? WHERE id = ?'
    ).run(hundredDaysAgo, 's1');

    // 执行归档
    const archived = await archiveManager.runArchive();
    expect(archived).toBe(1);

    // 应该可以从归档中查询到
    const archivedSession = await archiveManager.queryArchive('s1');
    expect(archivedSession).toBeTruthy();
  });

  it('should not archive sessions still in retention', async () => {
    // 创建一个 retention 不为0 的 archive manager
    const manager2 = new SessionArchiveManager(store, {
      archiveDir: join(tempDir, 'archives'),
      recentRetentionDays: 30,
    });

    await store.save('s1', createTestSession('s1'));
    await store.markEnded('s1');
    await store.updateLifecycle!('s1', { memoryExtraction: 'completed' });

    // 刚结束的 session 不应该被归档
    const archived = await manager2.runArchive();
    expect(archived).toBe(0);
  });

  it('should list archived sessions', async () => {
    await store.save('s1', createTestSession('s1', 'agent-1'));
    await store.save('s2', createTestSession('s2', 'agent-2'));

    await store.markEnded('s1');
    await store.markEnded('s2');
    await store.updateLifecycle!('s1', { memoryExtraction: 'completed' });
    await store.updateLifecycle!('s2', { memoryExtraction: 'completed' });

    await archiveManager.runArchive();

    const all = await archiveManager.listArchived();
    expect(all.length).toBe(2);

    const agent1 = await archiveManager.listArchived('agent-1');
    expect(agent1.length).toBe(1);
    expect(agent1[0].sessionId).toBe('s1');
  });
});
