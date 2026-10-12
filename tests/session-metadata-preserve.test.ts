/**
 * session.metadata 并发写回 — Runner 全量 save 不得覆盖 metadata 键
 *
 * 回归：gateway 重启后 send_file 卡片丢失（clientToolCalls / fileReleases 被
 * run 末尾 save 用陈旧 metadata 覆盖）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { SessionStore } from '@octopi-agent/core/interfaces/session-store.js';

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
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    turns: [],
    metadata: {},
    tasks: [],
  };
}

const fileRef = {
  fileId: 'f_1',
  name: 'boot.md',
  mime: 'text/markdown',
  sizeBytes: 6,
};

async function seedClientToolMetadata(store: SessionStore<SessionData>): Promise<void> {
  await store.updateMetadata!('s1', (meta) => {
    meta.clientToolCalls = [
      {
        id: 'c1',
        name: 'send_file',
        sessionId: 's1',
        state: 'succeeded',
        fileRef,
        createdAt: 10,
      },
    ];
    meta.fileReleases = [
      {
        fileId: fileRef.fileId,
        name: fileRef.name,
        mime: fileRef.mime,
        sizeBytes: fileRef.sizeBytes,
        absPath: '/tmp/boot.md',
        sourcePathDisplay: 'boot.md',
        sourceKind: 'workspace',
        toolName: 'send_file',
        createdAt: 10,
      },
    ];
  });
}

function expectSendFileMeta(loaded: SessionData | null): void {
  expect(loaded).not.toBeNull();
  const meta = loaded!.metadata as {
    clientToolCalls?: Array<{ fileRef?: { fileId: string } }>;
    fileReleases?: Array<{ fileId: string }>;
  };
  expect(meta.clientToolCalls?.[0]?.fileRef?.fileId).toBe(fileRef.fileId);
  expect(meta.fileReleases?.[0]?.fileId).toBe(fileRef.fileId);
}

describe('JsonlSessionStore metadata preserve (gateway restart)', () => {
  let home: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-meta-'));
    store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('run 末尾用陈旧空 metadata save，不得抹掉 clientToolCalls/fileReleases', async () => {
    await store.save('s1', makeSession('s1', 'a1'));
    await seedClientToolMetadata(store);

    // Runner 末尾：持有 t0 加载的会话对象（metadata 仍是 {}）
    const stale = makeSession('s1', 'a1');
    stale.messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
      {
        role: 'tool',
        content: '',
        timestamp: 11,
        toolResults: [
          {
            toolCallId: 'c1',
            name: 'send_file',
            result: { kind: 'value', data: { shown: true, ...fileRef } },
          },
        ],
      } as never,
    ];
    await store.save('s1', stale);

    // 模拟 gateway 重启：新实例、空内存
    const rebooted = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    const loaded = await rebooted.load('s1');
    expectSendFileMeta(loaded);
    // 消息也必须保住（updateMetadata 不得回滚 messages）
    expect(loaded!.messages).toHaveLength(2);
  });

  it('updateMetadata 支持删键（setSessionModel reset）', async () => {
    await store.save('s1', makeSession('s1', 'a1'));
    await store.updateMetadata!('s1', (meta) => {
      meta.model = { provider: 'p', model: 'm' };
      meta.clientToolCalls = [];
    });
    await store.updateMetadata!('s1', (meta) => {
      delete meta.model;
    });

    const loaded = await store.load('s1');
    expect(loaded!.metadata).toEqual({ clientToolCalls: [] });
  });

  it('并发 updateMetadata 与 save 串行，不丢键', async () => {
    await store.save('s1', makeSession('s1', 'a1'));

    await Promise.all([
      store.updateMetadata!('s1', (meta) => {
        meta.clientToolCalls = [{ id: 'c1' }];
      }),
      store.save('s1', {
        ...makeSession('s1', 'a1'),
        messages: [
          { role: 'user', content: 'a', timestamp: 1 },
          { role: 'assistant', content: 'b', timestamp: 2 },
        ],
      }),
      store.updateMetadata!('s1', (meta) => {
        meta.fileReleases = [{ fileId: 'f_1' }];
      }),
    ]);

    const loaded = await store.load('s1');
    expect((loaded!.metadata as { clientToolCalls?: unknown[] }).clientToolCalls).toEqual([{ id: 'c1' }]);
    expect((loaded!.metadata as { fileReleases?: unknown[] }).fileReleases).toEqual([{ fileId: 'f_1' }]);
    expect(loaded!.messages).toHaveLength(2);
  });
});

describe('InMemorySessionStore metadata preserve', () => {
  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
  });

  it('run 末尾陈旧 save 不覆盖 metadata', async () => {
    await store.save('s1', makeSession('s1', 'a1'));
    await seedClientToolMetadata(store);
    await store.save('s1', makeSession('s1', 'a1'));
    expectSendFileMeta(await store.load('s1'));
  });

  it('updateMetadata 支持删键', async () => {
    await store.save('s1', makeSession('s1', 'a1'));
    await store.updateMetadata!('s1', (meta) => {
      meta.model = { provider: 'p', model: 'm' };
    });
    await store.updateMetadata!('s1', (meta) => {
      delete meta.model;
    });
    expect((await store.load('s1'))!.metadata).toEqual({});
  });
});
