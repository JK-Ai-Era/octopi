/**
 * JsonlSessionStore — tasks 等附带状态持久化
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionStore } from '../src/integration/storage/jsonl.js';
import type { SessionData } from '../src/harness/session-types.js';

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
    turns: [],
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
