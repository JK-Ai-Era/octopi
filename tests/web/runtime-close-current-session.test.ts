/**
 * Web store closeCurrentSession：切换 agent 场景退回「未选中会话」空态
 * （与 dropSessionLocal 的 wasCurrent 分支同语义，但不删会话本身、不清缓存）。
 */
import { describe, expect, it } from 'vitest';
import { OctopiRuntimeStore } from '@octopi-agent/gateway/web/runtime/store.js';
import type { OctopiClient } from '@octopi-agent/gateway/web/sdk/client.js';

function makeMockClient(): OctopiClient {
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
      meta: { sessionId, agentId: 'default', status: 'idle', updatedAt: Date.now() },
    }),
    getSessionTasks: async () => [],
    listApprovals: async () => [],
    listClientToolCalls: async () => [],
    listQuestions: async () => [],
    getSessionMessages: async () => ({ messages: [] }),
    getSessionContextLayers: async () => null,
    getAgentContextHealth: async () => null,
    getSessionModel: async () => null,
  } as unknown as OctopiClient;
}

describe('OctopiRuntimeStore closeCurrentSession', () => {
  it('当前会话退回空态：id 清空 + 重置事件广播 + 二次调用 no-op', async () => {
    const store = new OctopiRuntimeStore(makeMockClient());
    await store.openSession('s-a');
    expect(store.getState().chat.sessionId).toBe('s-a');

    const events: string[] = [];
    store.addEventListener('session', () => events.push('session'));
    store.addEventListener('chat', () => events.push('chat'));
    store.addEventListener('runStatus', () => events.push('runStatus'));

    store.closeCurrentSession();
    const chat = store.getState().chat;
    expect(chat.sessionId).toBeUndefined();
    expect(chat.agentId).toBeUndefined();
    expect(chat.conversation).toEqual([]);
    expect(chat.runStatus).toBe('idle');
    expect(events).toContain('session');
    expect(events).toContain('chat');
    expect(events).toContain('runStatus');

    // 二次调用 no-op（无会话可关；不重复广播）
    events.length = 0;
    store.closeCurrentSession();
    expect(events).toEqual([]);
  });

  it('close 后 sendMessage 拒绝（No active session）；重新 openSession 可恢复', async () => {
    const store = new OctopiRuntimeStore(makeMockClient());
    await store.openSession('s-a');
    store.closeCurrentSession();
    await expect(store.sendMessage('hello')).rejects.toThrow(/No active session/);

    await store.openSession('s-a');
    expect(store.getState().chat.sessionId).toBe('s-a');
  });

  it('M4：close 后后台会话的流式事件落缓存，不污染空态（原守卫在空态整体失守）', async () => {
    const store = new OctopiRuntimeStore(makeMockClient());
    await store.openSession('s-a');
    store.closeCurrentSession();
    expect(store.getState().chat.sessionId).toBeUndefined();

    // 后台会话 s-a 的 run 仍在跑，流式事件继续到达
    (
      store as unknown as { applyEvent: (sid: string | undefined, e: unknown) => void }
    ).applyEvent('s-a', { type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: 'hi' } });

    // live 空态不被污染（会话未选中，对话流必须保持空）
    expect(store.getState().chat.conversation).toEqual([]);
    expect(store.getState().chat.streamingContent).toBe('');
  });

  it('M4：close 后后台 aborted 不把空态 runStatus 打成 aborted', async () => {
    const store = new OctopiRuntimeStore(makeMockClient());
    await store.openSession('s-a');
    store.closeCurrentSession();
    (
      store as unknown as { applyExternalState: (sid: string | undefined, state: string) => void }
    ).applyExternalState('s-a', 'aborted');
    expect(store.getState().chat.runStatus).toBe('idle');
  });

  it('M4：close 后后台 HITL 审批卡片不进空态（否则可被误点）', async () => {
    const store = new OctopiRuntimeStore(makeMockClient());
    await store.openSession('s-a');
    store.closeCurrentSession();
    (
      store as unknown as { applyApprovalEvent: (e: unknown) => void }
    ).applyApprovalEvent({
      type: 'approval.pending',
      timestamp: Date.now(),
      data: { approval: { id: 'apr-1', sessionId: 's-a', toolName: 'shell' } },
    });
    expect(store.getState().chat.approvals).toEqual([]);
  });
});
