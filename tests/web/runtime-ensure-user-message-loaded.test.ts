/**
 * Web store ensureUserMessageLoaded：turn 定位轨跳转的按需向上翻页加载。
 * 覆盖：已入列即真 / 翻页找到 turn 首 / 耗尽如实 false / 会话切换作废（防旧目标
 * 翻穿新会话）/ 无进展即断（防游标缺失时千次空转）。
 */
import { describe, expect, it, vi } from 'vitest';
import { OctopiRuntimeStore } from '@octopi-agent/gateway/web/runtime/store.js';
import type { OctopiClient, MessageRecord } from '@octopi-agent/gateway/web/sdk/client.js';
import type { UserConversationItem } from '@octopi-agent/gateway/web/conversation/types.js';

/** total 条消息，每第 5 条为 user（sourceIndex 0,5,10,…）；cursor = 独占右端下标 */
function makePagedClient(
  total: number,
  options?: { delayMs?: number },
): { client: OctopiClient; callsBySession: Map<string, number> } {
  const callsBySession = new Map<string, number>();
  const client = {
    on: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
    updateOptions: () => undefined,
    sendSubscribe: () => undefined,
    getAgents: async () => [],
    getModels: async () => ({ models: [], agents: [] }),
    listSessions: async () => [],
    getSession: async (sessionId: string) => ({
      meta: { sessionId, agentId: 'default', status: 'idle', updatedAt: Date.now() },
    }),
    getSessionTasks: async () => [],
    listApprovals: async () => [],
    listClientToolCalls: async () => [],
    listQuestions: async () => [],
    getSessionMessages: async (
      sessionId: string,
      opts?: { limit?: number; cursor?: string },
    ) => {
      callsBySession.set(sessionId, (callsBySession.get(sessionId) ?? 0) + 1);
      if (options?.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const limit = opts?.limit ?? 50;
      const end = opts?.cursor ? Number(opts.cursor) : total;
      const start = Math.max(0, end - limit);
      const messages: MessageRecord[] = [];
      for (let i = start; i < end; i++) {
        messages.push({
          role: i % 5 === 0 ? 'user' : 'assistant',
          content: `msg-${i}`,
          timestamp: i,
          index: i,
        });
      }
      return { messages, nextCursor: start > 0 ? String(start) : undefined, hasMore: start > 0 };
    },
    getSessionContextLayers: async () => null,
    getAgentContextHealth: async () => null,
    getSessionModel: async () => null,
  } as unknown as OctopiClient;
  return { client, callsBySession };
}

const hasUser = (store: OctopiRuntimeStore, sourceIndex: number): boolean =>
  store
    .getState()
    .chat.conversation.some(
      (it) => it.role === 'user' && (it as UserConversationItem).sourceIndex === sourceIndex,
    );

describe('OctopiRuntimeStore ensureUserMessageLoaded', () => {
  it('目标已入列：不再翻页即返回 true', async () => {
    const { client, callsBySession } = makePagedClient(30);
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s-a');
    const before = callsBySession.get('s-a') ?? 0;
    await expect(store.ensureUserMessageLoaded(5)).resolves.toBe(true);
    expect(callsBySession.get('s-a')).toBe(before);
  });

  it('目标未加载：向前翻页直到 turn 首入列', async () => {
    const { client } = makePagedClient(250);
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s-a');
    expect(hasUser(store, 5)).toBe(false);
    await expect(store.ensureUserMessageLoaded(5)).resolves.toBe(true);
    expect(hasUser(store, 5)).toBe(true);
    // 更早的用户消息随前页一并入列
    expect(hasUser(store, 0)).toBe(true);
  });

  it('历史耗尽仍不存在：如实返回 false（250 条 = 首屏 + 2 翻页即尽）', async () => {
    const { client, callsBySession } = makePagedClient(250);
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s-a');
    await expect(store.ensureUserMessageLoaded(9999)).resolves.toBe(false);
    expect(callsBySession.get('s-a')).toBe(3);
  });

  it('会话切换即作废：不为旧目标翻穿新会话历史（S1 回归）', async () => {
    const { client, callsBySession } = makePagedClient(1000, { delayMs: 20 });
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s-a');
    const pending = store.ensureUserMessageLoaded(5);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.openSession('s-b');
    await expect(pending).resolves.toBe(false);
    // s-b 只有它自己的首屏一次请求，未被旧目标的翻页波及
    expect(callsBySession.get('s-b')).toBe(1);
  });

  it('游标缺失但 hasMore 未落：单次探测即断，不千次空转（N1 回归）', async () => {
    const { client } = makePagedClient(250);
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s-a');
    // 模拟状态不一致：historyHasMore 仍为 true 但游标已丢失
    (store as unknown as { historyCursor: string | null }).historyCursor = null;
    const spy = vi.spyOn(store, 'loadMoreHistory');
    await expect(store.ensureUserMessageLoaded(5)).resolves.toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
