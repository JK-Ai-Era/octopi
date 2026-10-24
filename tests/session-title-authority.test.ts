/**
 * OP-WEB-2 标题权威面回归 — metadata 三键权威 + save 按 titleUpdatedAt 仲裁
 *
 * 核心场景：runner 持着 run 开始时的长驻 session 对象，turn.end 整包 save
 * 不得回滚运行期间用户 renameSession 写入的标题。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';

function sessionWith(metadata: Record<string, unknown>): SessionData {
  return {
    id: 's1',
    agentId: 'default',
    meta: {
      id: 's1',
      agentId: 'default',
      channelId: 'web',
      peerId: 'web-ui',
      status: 'idle',
      createdAt: 1,
      sessionStartedAt: 1,
      lastInteractionAt: 1,
      updatedAt: 1,
    },
    messages: [],
    turns: [],
    metadata: { ...metadata },
    tasks: [],
  };
}

const OLD_TRIO = { title: '旧', titleSource: 'auto' as const, titleUpdatedAt: 1000 };
const NEW_TRIO = { title: '新', titleSource: 'user' as const, titleUpdatedAt: 2000 };

describe('JsonlSessionStore title authority', () => {
  let dir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-title-authority-'));
    store = new JsonlSessionStore({ sessionsDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('长驻 run 的整包 save 不回滚运行期间的 rename（titleUpdatedAt 仲裁）', async () => {
    await store.save('s1', sessionWith({ ...OLD_TRIO }));

    // run 进行中：rename 走 updateMetadata 通道
    await store.updateMetadata('s1', (m) => {
      m.title = NEW_TRIO.title;
      m.titleSource = NEW_TRIO.titleSource;
      m.titleUpdatedAt = NEW_TRIO.titleUpdatedAt;
    });

    // turn.end：runner 用 run 开始时的长驻对象整包 save（stale trio + 新消息）
    const stale = sessionWith({ ...OLD_TRIO });
    stale.messages.push({ role: 'user', content: '在吗', timestamp: 3000 });
    await store.save('s1', stale);

    const loaded = await store.load('s1');
    expect(loaded?.metadata?.title).toBe('新');
    expect(loaded?.metadata?.titleSource).toBe('user');
    const listed = (await store.list()).find((m) => m.id === 's1');
    expect(listed?.title).toBe('新');
    expect(listed?.titleSource).toBe('user');
  });

  it('stale save 缺标题键时不回滚（浅合并护缺键）', async () => {
    await store.save('s1', sessionWith({ ...NEW_TRIO }));

    const stale = sessionWith({});
    stale.messages.push({ role: 'user', content: '在吗', timestamp: 3000 });
    await store.save('s1', stale);

    const loaded = await store.load('s1');
    expect(loaded?.metadata?.title).toBe('新');
  });

  it('索引投影取 metadata 权威，陈旧 meta.title 不泄漏', async () => {
    const data = sessionWith({ ...NEW_TRIO });
    data.meta.title = '陈旧投影';
    data.meta.titleSource = 'snippet';
    await store.save('s1', data);

    const listed = (await store.list()).find((m) => m.id === 's1');
    expect(listed?.title).toBe('新');
    expect(listed?.titleSource).toBe('user');
  });

  it('updateMetadata 的 rename 即时投影到 list', async () => {
    await store.save('s1', sessionWith({ ...OLD_TRIO }));
    await store.updateMetadata('s1', (m) => {
      m.title = NEW_TRIO.title;
      m.titleSource = NEW_TRIO.titleSource;
      m.titleUpdatedAt = NEW_TRIO.titleUpdatedAt;
    });
    const listed = (await store.list()).find((m) => m.id === 's1');
    expect(listed?.title).toBe('新');
    expect(listed?.titleSource).toBe('user');
  });

  it('incoming 标题缺 titleUpdatedAt 时不回滚磁盘（半写/外来写视为陈旧）', async () => {
    await store.save('s1', sessionWith({ ...NEW_TRIO }));

    const stale = sessionWith({ title: '旧', titleSource: 'auto' }); // 无时间戳
    await store.save('s1', stale);

    const loaded = await store.load('s1');
    expect(loaded?.metadata?.title).toBe('新');
  });

  it('更新的 trio 正常胜出（同通道写不被误伤）', async () => {
    await store.save('s1', sessionWith({ ...OLD_TRIO }));
    const fresh = sessionWith({ ...NEW_TRIO });
    await store.save('s1', fresh);
    const loaded = await store.load('s1');
    expect(loaded?.metadata?.title).toBe('新');
  });
});

describe('InMemorySessionStore title authority', () => {
  it('长驻 run 的整包 save 不回滚运行期间的 rename（与 Jsonl 同规则）', async () => {
    const store = new InMemorySessionStore();
    await store.save('s1', sessionWith({ ...OLD_TRIO }));
    await store.updateMetadata('s1', (m) => {
      m.title = NEW_TRIO.title;
      m.titleSource = NEW_TRIO.titleSource;
      m.titleUpdatedAt = NEW_TRIO.titleUpdatedAt;
    });

    const stale = sessionWith({ ...OLD_TRIO });
    await store.save('s1', stale);

    const loaded = await store.load('s1');
    expect(loaded?.metadata?.title).toBe('新');
    // load().meta 是投影（与 Jsonl 索引后端同口径）：updateMetadata 后立即新鲜
    expect(loaded?.meta.title).toBe('新');
    expect(loaded?.meta.titleSource).toBe('user');
    const listed = (await store.list()).find((m) => m.id === 's1');
    expect(listed?.title).toBe('新');
    expect(listed?.titleSource).toBe('user');
  });
});
