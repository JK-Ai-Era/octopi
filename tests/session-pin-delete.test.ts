/**
 * 会话置顶 / 删除 — pinnedAt（metadata 权威 + 索引投影）与 deleteSession 守卫
 *
 * - setSessionPinned：写/清 metadata.pinnedAt 并投影到 listSessions
 * - 长驻 run 对象式「陈旧整包 save」不得抹掉置顶（丢更新回归钉）
 * - listSessions：标注 running（活跃 Run 在途为 true）
 * - deleteSession：幂等；Run 在途拒绝且不删数据；广播 session.removed
 * - JsonlSessionStore：pinnedAt 投影真落盘往返（updateMetadata 写/删 + 陈旧 save 不抹）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { GatewayConfig } from '@octopi-agent/core/types.js';

function makeGateway(store: InMemorySessionStore): Gateway {
  return new Gateway(
    {
      agents: [{ id: 'a1', model: { provider: 'mock', model: 'm' } }],
    } as unknown as GatewayConfig,
    store,
  );
}

/** 模拟 runner 的在途会话对象（turn 开始时 load，结束时整包 save） */
function staleSession(id: string): SessionData {
  const now = Date.now();
  return {
    id,
    agentId: 'a1',
    meta: {
      id,
      agentId: 'a1',
      channelId: 'web',
      peerId: 'p',
      status: 'processing',
      createdAt: now,
      sessionStartedAt: now,
      lastInteractionAt: now,
      updatedAt: now,
    },
    messages: [],
    turns: [],
    metadata: {},
  };
}

describe('session pin & delete', () => {
  let store: InMemorySessionStore;
  let gateway: Gateway;

  beforeEach(() => {
    store = new InMemorySessionStore();
    gateway = makeGateway(store);
  });

  it('setSessionPinned 写 pinnedAt，取消置顶清除；listSessions 同步可见', async () => {
    const created = await gateway.createSession({ agentId: 'a1' });

    const pinned = await gateway.setSessionPinned(created.id, true);
    expect(pinned.pinnedAt).toBeTypeOf('number');

    let [item] = await gateway.listSessions();
    expect(item.pinnedAt).toBeTypeOf('number');
    expect(item.running).toBe(false);

    const unpinned = await gateway.setSessionPinned(created.id, false);
    expect(unpinned.pinnedAt).toBeUndefined();

    [item] = await gateway.listSessions();
    expect(item.pinnedAt).toBeUndefined();
  });

  it('置顶不被长驻 run 对象的陈旧整包 save 回写抹掉（丢更新回归钉）', async () => {
    const created = await gateway.createSession({ agentId: 'a1' });
    // runner 语义：turn 开始 load 的对象，turn 结束整包 save（陈旧 meta 无 pinnedAt）
    const stale = staleSession(created.id);

    await gateway.setSessionPinned(created.id, true);
    await store.save(created.id, stale);

    const [item] = await gateway.listSessions();
    expect(item.pinnedAt).toBeTypeOf('number');
  });

  it('setSessionPinned 对不存在的会话抛 not found', async () => {
    await expect(gateway.setSessionPinned('nope', true)).rejects.toThrow(/not found/);
  });

  it('listSessions 标注 running（活跃 Run 在途为 true）', async () => {
    const created = await gateway.createSession({ agentId: 'a1' });
    // 活跃 Run 由 AgentRuntime 登记；此处以桩注入在途，验证标注投影
    const runtime = (gateway as unknown as {
      runtime: { hasActiveRunForSession(id: string): boolean };
    }).runtime;
    const original = runtime.hasActiveRunForSession.bind(runtime);
    runtime.hasActiveRunForSession = (id: string) => id === created.id;

    try {
      const [item] = await gateway.listSessions();
      expect(item.running).toBe(true);
    } finally {
      runtime.hasActiveRunForSession = original;
    }
  });

  it('deleteSession 幂等删除并广播 session.removed；Run 在途拒绝且不删数据', async () => {
    const created = await gateway.createSession({ agentId: 'a1' });
    const removed: string[] = [];
    gateway.on((e) => {
      if (e.type === 'session.removed') {
        removed.push((e.data as { sessionId?: string })?.sessionId ?? e.sessionId);
      }
    });
    expect(await gateway.listSessions()).toHaveLength(1);

    await gateway.deleteSession(created.id);
    expect(await gateway.listSessions()).toHaveLength(0);
    expect(removed).toContain(created.id);

    // 幂等：再次删除视为成功（多端并发删除不互相报错）
    await expect(gateway.deleteSession(created.id)).resolves.toBeUndefined();

    // Run 在途拒绝且不删数据
    const second = await gateway.createSession({ agentId: 'a1' });
    const runtime = (gateway as unknown as {
      runtime: { hasActiveRunForSession(id: string): boolean };
    }).runtime;
    const original = runtime.hasActiveRunForSession.bind(runtime);
    runtime.hasActiveRunForSession = () => true;
    await expect(gateway.deleteSession(second.id)).rejects.toThrow(/session_running/);
    expect(await gateway.listSessions()).toHaveLength(1);

    runtime.hasActiveRunForSession = original;
    await gateway.deleteSession(second.id);
  });
});

describe('JsonlSessionStore pinnedAt 投影', () => {
  let dir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-pin-'));
    store = new JsonlSessionStore({ sessionsDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('updateMetadata 写/删 pinnedAt 投影到 list；陈旧整包 save 不抹', async () => {
    await store.save('s1', staleSession('s1'));

    // runner 语义的陈旧对象：置顶前 load
    const stale = await store.load('s1');
    expect(stale).not.toBeNull();

    await store.updateMetadata('s1', (meta) => {
      meta.pinnedAt = 111;
    });
    let [item] = await store.list();
    expect(item?.pinnedAt).toBe(111);

    await store.save('s1', stale!);
    [item] = await store.list();
    expect(item?.pinnedAt).toBe(111);

    await store.updateMetadata('s1', (meta) => {
      delete meta.pinnedAt;
    });
    [item] = await store.list();
    expect(item?.pinnedAt).toBeUndefined();
  });
});
