/**
 * JsonlSessionStore — tasks 等附带状态持久化
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';

function makeSession(id: string, agentId: string): SessionData {
  return {
    id,
    agentId,
    meta: {
      id,
      agentId,
      channelId: 'web',
      peerId: 'ui',
      status: 'idle',
      createdAt: 1,
      sessionStartedAt: 1,
      lastInteractionAt: 2,
      updatedAt: 2,
    },
    messages: [
      { role: 'user', content: '你好', timestamp: 1 },
      { role: 'assistant', content: '你好！', timestamp: 2 },
    ],
    steps: [],
    metadata: { source: 'test' },
    tasks: [
      {
        id: 'g1',
        description: '分析代码',
        status: 'open',
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: 's1',
        parentId: 'g1',
        description: '扫描模块',
        status: 'done',
        order: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  };
}

describe('JsonlSessionStore session state', () => {
  let home: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-jsonl-'));
    store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('save/load 保留 messages 与 tasks', async () => {
    const session = makeSession('s1', 'a1');
    await store.save('s1', session);

    const loaded = await store.load('s1');
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[1].content).toBe('你好！');
    expect(loaded!.tasks).toHaveLength(2);
    expect(loaded!.tasks![0].id).toBe('g1');
    expect(loaded!.tasks![1].parentId).toBe('g1');
    expect(loaded!.metadata).toEqual({ source: 'test' });
  });

  it('delete 同时清理 state 文件', async () => {
    await store.save('s1', makeSession('s1', 'a1'));
    await store.delete('s1');
    const loaded = await store.load('s1');
    expect(loaded).toBeNull();
  });

  it('兼容无 state 的旧会话（tasks 为空数组）', async () => {
    const session = makeSession('s1', 'a1');
    await store.save('s1', session);
    // 再写一次不带 tasks 的数据路径：模拟旧文件只有 messages
    // 通过 save 带空 tasks
    await store.save('s1', { ...session, tasks: [] });
    const loaded = await store.load('s1');
    expect(loaded?.tasks).toEqual([]);
    expect(loaded?.messages).toHaveLength(2);
  });
});

describe('JsonlSessionStore updateMetadata 字段保全', () => {
  /**
   * 2026-10-28 事故评审 B1：updateMetadata 的 state 重写曾漏掉 contextDetachIndex，
   * 仅因写一次 metadata 就静默清掉租约截断点（续跑全量历史灌进 LLM 窗口）。
   * 不变式：updateMetadata 后 state 字段集合与 save() 写入的一致。
   */
  it('updateMetadata 不清掉 save 写过的 state 字段（contextDetachIndex 等）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'octopi-jsonl-'));
    try {
      const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
      const session = makeSession('s1', 'a1');
      session.contextDetachIndex = 42;
      await store.save('s1', session);

      await store.updateMetadata('s1', (meta) => {
        meta.turnSeq = 7;
      });

      const loaded = await store.load('s1');
      expect(loaded?.contextDetachIndex).toBe(42);
      expect(loaded?.metadata).toEqual({ source: 'test', turnSeq: 7 });
      expect(loaded?.messages).toHaveLength(2);
      expect(loaded?.tasks).toHaveLength(2);
      expect(loaded?.agentId).toBe('a1');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('JsonlSessionStore spawnBy 投影与存量 backfill', () => {
  const spawnBy = {
    delegationId: 'del-abc12345',
    parentAgentId: 'a1',
    parentSessionId: 'parent-1',
    parentRunId: 'run-1',
    depth: 1,
  };

  async function withStore(fn: (dir: string, store: JsonlSessionStore) => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), 'octopi-jsonl-'));
    const dir = join(home, 'sessions');
    try {
      await fn(dir, new JsonlSessionStore({ sessionsDir: dir }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  it('save 后索引即投影 spawnBy（直接读盘，不经 backfill）；用户会话无投影；updateMetadata 不抹投影', async () => {
    await withStore(async (dir, store) => {
      const child = makeSession('child-1', 'a2');
      child.spawnBy = { ...spawnBy };
      await store.save('child-1', child);
      await store.save('parent-1', makeSession('parent-1', 'a1'));

      // 直接读 sessions.json：list() 会先跑 backfill 掩盖归因，写盘投影只认 save 路径
      const metaPath = join(dir, 'sessions.json');
      const raw = JSON.parse(await readFile(metaPath, 'utf-8')) as Record<string, Record<string, unknown>>;
      expect(raw['child-1'].spawnBy).toEqual(spawnBy);
      expect(raw['parent-1'].spawnBy).toBeUndefined();

      await store.updateMetadata('child-1', (meta) => {
        meta.turnSeq = 1;
      });
      const after = JSON.parse(await readFile(metaPath, 'utf-8')) as Record<string, Record<string, unknown>>;
      expect(after['child-1'].spawnBy).toEqual(spawnBy);
    });
  });

  it('updateMetadata 从 state 补投影（只经历 updateMetadata 的会话也同口径）', async () => {
    await withStore(async (dir, store) => {
      const child = makeSession('child-1', 'a2');
      child.spawnBy = { ...spawnBy };
      await store.save('child-1', child);

      // 剥掉索引投影，模拟"索引缺投影"的条目（state 权威仍在）
      const metaPath = join(dir, 'sessions.json');
      const raw = JSON.parse(await readFile(metaPath, 'utf-8')) as Record<string, Record<string, unknown>>;
      delete raw['child-1'].spawnBy;
      await writeFile(metaPath, JSON.stringify(raw, null, 2));

      await store.updateMetadata('child-1', (meta) => {
        meta.turnSeq = 2;
      });
      const after = JSON.parse(await readFile(metaPath, 'utf-8')) as Record<string, Record<string, unknown>>;
      expect(after['child-1'].spawnBy).toEqual(spawnBy);
    });
  });

  it('存量索引缺投影时 backfill 从 state.json 补出；再 list 不重复补写（文件内容不变）', async () => {
    await withStore(async (dir, store) => {
      const child = makeSession('child-1', 'a2');
      child.spawnBy = { ...spawnBy };
      await store.save('child-1', child);

      // 模拟升级前落盘的 sessions.json：索引条目没有 spawnBy（state.json 权威仍在）
      const metaPath = join(dir, 'sessions.json');
      const raw = JSON.parse(await readFile(metaPath, 'utf-8')) as Record<string, Record<string, unknown>>;
      expect(raw['child-1'].spawnBy).toEqual(spawnBy);
      delete raw['child-1'].spawnBy;
      await writeFile(metaPath, JSON.stringify(raw, null, 2));

      const fresh = new JsonlSessionStore({ sessionsDir: dir });
      const entries = await fresh.list();
      expect(entries.find((e) => e.id === 'child-1')?.spawnBy).toEqual(spawnBy);

      // 幂等锚：第二次 list 后索引字节不变（不再触发补写）
      const before2 = await readFile(metaPath, 'utf-8');
      await fresh.list();
      expect(await readFile(metaPath, 'utf-8')).toBe(before2);
    });
  });

  it('backfill 只补缺失：已有投影不被 state 覆盖', async () => {
    await withStore(async (dir, store) => {
      const child = makeSession('child-1', 'a2');
      child.spawnBy = { ...spawnBy };
      await store.save('child-1', child);

      // 索引里已有投影（值不同于 state）：backfill 不得回写
      const metaPath = join(dir, 'sessions.json');
      const raw = JSON.parse(await readFile(metaPath, 'utf-8')) as Record<string, Record<string, unknown>>;
      raw['child-1'].spawnBy = { ...spawnBy, delegationId: 'del-other' };
      await writeFile(metaPath, JSON.stringify(raw, null, 2));

      const fresh = new JsonlSessionStore({ sessionsDir: dir });
      const entries = await fresh.list();
      expect(entries.find((e) => e.id === 'child-1')?.spawnBy?.delegationId).toBe('del-other');
    });
  });
});
