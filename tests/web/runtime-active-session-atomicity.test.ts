/**
 * 「活动会话」的两个投影（currentSession / chat）必须原子提交。
 *
 * 历史缺陷：`openSession` 在 `getSession` 之后、其余 await 之前就写了 `currentSession`；
 * `createSession` 把三个 list* 的 await 放进了 chat 字面量内部。任一后续 await 抛错，
 * 就会留下 currentSession=新会话、chat=旧会话的双真源——UI 头部/rename/pin 补丁各认一个。
 */
import { describe, expect, it } from 'vitest';
import { OctopiRuntimeStore } from '@octopi-agent/gateway/web/runtime/store.js';
import type { OctopiClient } from '@octopi-agent/gateway/web/sdk/client.js';

type ClientOverrides = Record<string, unknown>;

function makeMockClient(overrides: ClientOverrides = {}): OctopiClient {
  return {
    on: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
    updateOptions: () => undefined,
    sendSubscribe: () => undefined,
    getAgents: async () => [],
    getModels: async () => ({ models: [], agents: [] }),
    listSessions: async () => [],
    getSession: async (sessionId: string) => ({
      meta: { id: sessionId, agentId: 'default', status: 'idle', updatedAt: Date.now() },
      messageCount: 0,
      stepCount: 0,
    }),
    getSessionTasks: async () => [],
    getSessionSchedules: async () => [],
    listApprovals: async () => [],
    listQuestions: async () => [],
    listClientToolCalls: async () => [],
    getSessionMessages: async () => ({ messages: [] }),
    getSessionContextLayers: async () => null,
    getAgentContextHealth: async () => null,
    getSessionModel: async () => null,
    createSession: async (opts: { agentId: string }) => ({
      id: 's-new',
      agentId: opts.agentId,
      status: 'idle',
      updatedAt: Date.now(),
    }),
    ...overrides,
  } as unknown as OctopiClient;
}

/** 等 currentSession/chat 都已指向某会话（供前置断言） */
function expectActive(store: OctopiRuntimeStore, sessionId: string): void {
  const state = store.getState();
  expect(state.chat.sessionId).toBe(sessionId);
  expect(state.currentSession?.meta?.id).toBe(sessionId);
}

describe('活跃会话双投影原子提交', () => {
  it('openSession 中途失败：currentSession 与 chat 一并停在旧会话', async () => {
    const client = makeMockClient({
      listApprovals: async (sessionId: string) => {
        if (sessionId === 's-b') throw new Error('approvals unavailable');
        return [];
      },
    });
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s-a');
    expectActive(store, 's-a');
    const before = store.getState();

    await expect(store.openSession('s-b')).rejects.toThrow(/approvals unavailable/);

    const after = store.getState();
    // 同一个对象引用未变：没有发生「部分切换」
    expect(after.currentSession).toBe(before.currentSession);
    expect(after.chat).toBe(before.chat);
    expectActive(store, 's-a');
  });

  it('同会话刷新中途失败：不清空也不改会话元数据', async () => {
    let failQuestions = false;
    const client = makeMockClient({
      listQuestions: async () => {
        if (failQuestions) throw new Error('questions unavailable');
        return [];
      },
    });
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s-a');
    const before = store.getState();
    failQuestions = true;

    await expect(store.openSession('s-a')).rejects.toThrow(/questions unavailable/);

    expect(store.getState().currentSession).toBe(before.currentSession);
    expectActive(store, 's-a');
  });

  it('createSession 中途失败：不会留下「新 currentSession + 旧 chat」', async () => {
    let failQuestions = false;
    const client = makeMockClient({
      listQuestions: async (sessionId: string) => {
        // 新建会话在服务端已落库，随后取 questions 失败
        if (failQuestions && sessionId === 's-new') throw new Error('questions unavailable');
        return [];
      },
    });
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s-a');
    const before = store.getState();
    failQuestions = true;

    await expect(store.createSession('default')).rejects.toThrow(/questions unavailable/);

    const after = store.getState();
    expect(after.currentSession).toBe(before.currentSession);
    expect(after.chat).toBe(before.chat);
    expectActive(store, 's-a');
  });

  it('成功切换后两投影一致指向新会话', async () => {
    const store = new OctopiRuntimeStore(makeMockClient());
    await store.openSession('s-a');
    await store.openSession('s-b');
    expectActive(store, 's-b');
  });
});
