/**
 * JsonlSessionStore.syncMessages — Run 进行中转录增量落盘（对齐式）
 *
 * 契约（SessionStore.syncMessages）：load().messages 等于给定序列；
 * 优先增量追加，漂移（旁路整包 save / 外部改动 / 前缀分歧）时整文件对齐；
 * 幂等——同一序列重复调用不产生额外写。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { Message } from '@octopi-agent/core/types.js';

function msg(n: number): Message {
  return { role: 'assistant', content: `m${n}`, timestamp: n };
}

function makeSession(id: string, messages: Message[]): SessionData {
  return {
    id,
    agentId: 'a1',
    meta: {
      id,
      agentId: 'a1',
      channelId: 'web',
      peerId: 'ui',
      status: 'idle',
      createdAt: 1,
      sessionStartedAt: 1,
      lastInteractionAt: 2,
      updatedAt: 2,
    },
    messages,
    turns: [],
    metadata: {},
    tasks: [],
  };
}

describe('JsonlSessionStore.syncMessages', () => {
  let home: string;
  let dir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-sync-'));
    dir = join(home, 'sessions');
    store = new JsonlSessionStore({ sessionsDir: dir });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('增量追加后新实例 load 得到全序列', async () => {
    const m0 = msg(0);
    const m1 = msg(1);
    await store.save('s1', makeSession('s1', [m0]));
    await store.syncMessages('s1', [m0, m1]);

    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const loaded = await fresh.load('s1');
    expect(loaded!.messages.map((m) => m.content)).toEqual(['m0', 'm1']);
  });

  it('幂等：同一序列重复 sync 不产生额外写', async () => {
    const m0 = msg(0);
    const m1 = msg(1);
    await store.save('s1', makeSession('s1', [m0]));
    await store.syncMessages('s1', [m0, m1]);
    const path = join(dir, 's1.jsonl');
    const before = await stat(path);

    await store.syncMessages('s1', [m0, m1]);
    const after = await stat(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('旁路整包 save 造成漂移后，下一次 sync 全量对齐自愈', async () => {
    const m0 = msg(0);
    const m1 = msg(1);
    const m2 = msg(2);
    await store.save('s1', makeSession('s1', [m0]));
    await store.syncMessages('s1', [m0, m1]);

    // 模拟旁路写者（title/attachments）持旧 messages 整包 save → 磁盘回退
    const bystander = new JsonlSessionStore({ sessionsDir: dir });
    await bystander.save('s1', makeSession('s1', [m0]));

    await store.syncMessages('s1', [m0, m1, m2]);
    const loaded = await store.load('s1');
    expect(loaded!.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2']);
  });

  it('序列缩短/替换（truncate 语义）也按对齐处理', async () => {
    const m0 = msg(0);
    const m1 = msg(1);
    const m2 = msg(2);
    await store.save('s1', makeSession('s1', [m0]));
    await store.syncMessages('s1', [m0, m1, m2]);
    await store.syncMessages('s1', [m0]);

    const loaded = await store.load('s1');
    expect(loaded!.messages.map((m) => m.content)).toEqual(['m0']);
  });

  it('同引用前缀的原地扩展（调用方数组可变）按增量追加', async () => {
    const m0 = msg(0);
    const m1 = msg(1);
    const arr: Message[] = [m0];
    await store.save('s1', makeSession('s1', [...arr]));
    await store.syncMessages('s1', arr);
    arr.push(m1);
    await store.syncMessages('s1', arr);

    const loaded = await store.load('s1');
    expect(loaded!.messages.map((m) => m.content)).toEqual(['m0', 'm1']);
  });

  it('会话不存在时跳过（增量通道不是创建通道）', async () => {
    await store.syncMessages('ghost', [msg(0)]);
    expect(await store.load('ghost')).toBeNull();
  });

  it('save 全量重写后 sync 增量衔接（缓存不误判漂移）', async () => {
    const m0 = msg(0);
    const m1 = msg(1);
    const m2 = msg(2);
    await store.save('s1', makeSession('s1', [m0, m1]));
    await store.save('s1', makeSession('s1', [m0, m1, m2]));
    await store.syncMessages('s1', [m0, m1, m2, msg(3)]);

    const loaded = await store.load('s1');
    expect(loaded!.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('delete 后再 sync 不复活会话', async () => {
    await store.save('s1', makeSession('s1', [msg(0)]));
    await store.delete('s1');
    await store.syncMessages('s1', [msg(0), msg(1)]);
    expect(await store.load('s1')).toBeNull();
  });

  it('truncate 形态（save 整包截短）后 sync 增量衔接（缓存不误判）', async () => {
    const m0 = msg(0);
    const m1 = msg(1);
    const m2 = msg(2);
    const m3 = msg(3);
    await store.save('s1', makeSession('s1', [m0]));
    await store.syncMessages('s1', [m0, m1, m2]);
    // 编辑重发：truncateMessagesFrom 同型——load 截短后整包 save
    const loaded = await store.load('s1');
    await store.save('s1', { ...loaded!, messages: [m0] });
    // 截短后的下一轮 run 增量同步新消息
    await store.syncMessages('s1', [m0, m3]);

    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    expect((await fresh.load('s1'))!.messages.map((m) => m.content)).toEqual(['m0', 'm3']);
  });
});

describe('InMemorySessionStore.syncMessages', () => {
  it('对齐消息数组；不存在则跳过', async () => {
    const store = new InMemorySessionStore();
    await store.save('s1', makeSession('s1', [msg(0)]));
    await store.syncMessages!('s1', [msg(0), msg(1)]);
    expect((await store.load('s1'))!.messages.map((m) => m.content)).toEqual(['m0', 'm1']);

    await store.syncMessages!('ghost', [msg(0)]);
    expect(await store.load('ghost')).toBeNull();
  });
});
