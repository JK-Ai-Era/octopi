/**
 * Web Runtime Store — 会话列表动作：运行态标识 / 置顶传播 / 订阅 / 删除
 *
 * - WS state 事件按会话记账 running（侧栏「运行中」标识的数据源）
 * - session.updated 的 pinnedAt 变更传播到列表（null=取消置顶）
 * - refreshSessions 订阅面收口（运行中 + 最近 N + 当前；批量订阅不带 agentId）
 * - 断线重连后重订 + REST 复核列表
 * - setSessionPinned / deleteSession 更新列表；删当前会话清空聊天态；session.removed 广播同步
 */

import { describe, it, expect, vi } from 'vitest';
import { OctopiRuntimeStore } from '@octopi-agent/gateway/web/runtime/store.js';
import type {
  OctopiClient,
  AgentEventEnvelope,
  SessionSummary,
} from '@octopi-agent/gateway/web/sdk/client.js';

interface MockClient extends OctopiClient {
  __emit(e: AgentEventEnvelope): void;
  __emitState(sessionId: string, state: string): void;
  __emitConnection(state: string): void;
}

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'a1',
    channelId: 'web',
    peerId: 'p',
    status: 'idle',
    createdAt: 1,
    sessionStartedAt: 1,
    lastInteractionAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function mockClient(sessions: SessionSummary[]): MockClient {
  const listeners: Record<string, unknown> = {};
  return {
    on(list: Record<string, unknown>) {
      Object.assign(listeners, list);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    updateOptions: vi.fn(),
    listSessions: vi.fn(async () => sessions),
    setSessionPinned: vi.fn(async (_id: string, pinned: boolean) =>
      session('s1', { pinnedAt: pinned ? 42 : undefined }),
    ),
    deleteSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => session('s2')),
    listApprovals: vi.fn(async () => []),
    listQuestions: vi.fn(async () => []),
    listClientToolCalls: vi.fn(async () => []),
    getSessionModel: vi.fn(async () => null),
    sendSubscribe: vi.fn(),
    __emit(e: AgentEventEnvelope) {
      (listeners.onEvent as (s: string | undefined, e: AgentEventEnvelope) => void)?.(e.sessionId, e);
    },
    __emitState(sessionId: string, state: string) {
      (listeners.onState as (s: string | undefined, st: string) => void)?.(sessionId, state);
    },
    __emitConnection(state: string) {
      (listeners.onConnectionState as (s: string) => void)?.(state);
    },
  } as unknown as MockClient;
}

/** 刷新挂起的异步任务（applyConnectionState 的 fire-and-forget 复核） */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('OctopiRuntimeStore session list actions', () => {
  it('state 事件按会话记账 running（running/tools 在途，idle 终态）', async () => {
    const client = mockClient([session('s1'), session('s2')]);
    const store = new OctopiRuntimeStore(client);
    await store.refreshSessions();

    const running = () => store.getState().sessions.find((s) => s.id === 's1')?.running;

    client.__emitState('s1', 'running');
    expect(running()).toBe(true);

    client.__emitState('s1', 'tools');
    expect(running()).toBe(true);

    client.__emitState('s2', 'running');
    expect(store.getState().sessions.find((s) => s.id === 's2')?.running).toBe(true);
    expect(running()).toBe(true);

    client.__emitState('s1', 'idle');
    expect(running()).toBe(false);
    // 其他会话的终态不得互相串写
    expect(store.getState().sessions.find((s) => s.id === 's2')?.running).toBe(true);
  });

  it('session.updated 的 pinnedAt 传播到列表；null 清除', async () => {
    const client = mockClient([session('s1')]);
    const store = new OctopiRuntimeStore(client);
    await store.refreshSessions();

    client.__emit({
      type: 'session.updated',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { sessionId: 's1', pinnedAt: 111 },
    } as unknown as AgentEventEnvelope);
    expect(store.getState().sessions.find((s) => s.id === 's1')?.pinnedAt).toBe(111);

    client.__emit({
      type: 'session.updated',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { sessionId: 's1', pinnedAt: null },
    } as unknown as AgentEventEnvelope);
    expect(store.getState().sessions.find((s) => s.id === 's1')?.pinnedAt).toBeUndefined();
  });

  it('refreshSessions 订阅列表内会话（后台运行态靠 WS 事件实时送达；批量订阅不带 agentId）', async () => {
    const client = mockClient([session('s1'), session('s2')]);
    const store = new OctopiRuntimeStore(client);
    await store.refreshSessions();

    expect(client.sendSubscribe).toHaveBeenCalledWith('s1', undefined);
    expect(client.sendSubscribe).toHaveBeenCalledWith('s2', undefined);

    // 重复刷新不重复订阅
    (client.sendSubscribe as ReturnType<typeof vi.fn>).mockClear();
    await store.refreshSessions();
    expect(client.sendSubscribe).not.toHaveBeenCalled();
  });

  it('断线重连后重订会话并以 REST 复核列表（运行态纠偏）', async () => {
    const client = mockClient([session('s1')]);
    const store = new OctopiRuntimeStore(client);
    await store.refreshSessions();
    (client.sendSubscribe as ReturnType<typeof vi.fn>).mockClear();
    (client.listSessions as ReturnType<typeof vi.fn>).mockClear();

    client.__emitConnection('disconnected');
    client.__emitConnection('connected');
    await flushAsync();

    expect(client.sendSubscribe).toHaveBeenCalledWith('s1', undefined);
    expect(client.listSessions).toHaveBeenCalled();
  });

  it('setSessionPinned 更新列表；取消置顶清除 pinnedAt', async () => {
    const client = mockClient([session('s1')]);
    const store = new OctopiRuntimeStore(client);
    await store.refreshSessions();

    await store.setSessionPinned('s1', true);
    expect(client.setSessionPinned).toHaveBeenCalledWith('s1', true);
    expect(store.getState().sessions.find((s) => s.id === 's1')?.pinnedAt).toBe(42);

    await store.setSessionPinned('s1', false);
    expect(client.setSessionPinned).toHaveBeenCalledWith('s1', false);
    expect(store.getState().sessions.find((s) => s.id === 's1')?.pinnedAt).toBeUndefined();
  });

  it('session.removed 广播（其他端删除）移出列表并清空聊天态', async () => {
    const client = mockClient([session('s1'), session('s2')]);
    const store = new OctopiRuntimeStore(client);
    await store.createSession('a1');
    expect(store.getState().chat.sessionId).toBe('s2');

    client.__emit({
      type: 'session.removed',
      timestamp: Date.now(),
      sessionId: 's2',
      data: { sessionId: 's2' },
    } as unknown as AgentEventEnvelope);

    expect(store.getState().sessions.find((s) => s.id === 's2')).toBeUndefined();
    expect(store.getState().chat.sessionId).toBeUndefined();
    expect(store.getState().currentSession).toBeNull();
  });

  it('deleteSession 移出列表；删的是当前会话时清空聊天态', async () => {
    const client = mockClient([session('s1'), session('s2')]);
    const store = new OctopiRuntimeStore(client);
    await store.createSession('a1');
    expect(store.getState().chat.sessionId).toBe('s2');

    await store.deleteSession('s1');
    expect(store.getState().sessions.find((s) => s.id === 's1')).toBeUndefined();
    // 删非当前会话不动聊天态
    expect(store.getState().chat.sessionId).toBe('s2');

    await store.deleteSession('s2');
    expect(store.getState().sessions.find((s) => s.id === 's2')).toBeUndefined();
    expect(store.getState().chat.sessionId).toBeUndefined();
    expect(store.getState().currentSession).toBeNull();
  });
});
