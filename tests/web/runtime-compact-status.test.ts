/**
 * Web Runtime Store — context.compact.* 状态
 */

import { describe, it, expect, vi } from 'vitest';
import { OctopiRuntimeStore } from '@octopi-agent/gateway/web/runtime/store.js';
import type { OctopiClient, AgentEventEnvelope } from '@octopi-agent/gateway/web/sdk/client.js';

function mockClient(): OctopiClient {
  const listeners: Record<string, unknown> = {};
  return {
    on(list: Record<string, unknown>) {
      Object.assign(listeners, list);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    updateOptions: vi.fn(),
    /** test helper：触发 onEvent */
    __emit(event: AgentEventEnvelope) {
      (listeners.onEvent as (s: string | undefined, e: AgentEventEnvelope) => void)?.('s1', event);
    },
  } as unknown as OctopiClient & { __emit(e: AgentEventEnvelope): void };
}

describe('OctopiRuntimeStore context.compact', () => {
  it('start → compact.active=true；end → false 写 compact tokens 且清空 viewTokensEst', () => {
    const client = mockClient();
    const store = new OctopiRuntimeStore(client);
    const emit = (client as unknown as { __emit(e: AgentEventEnvelope): void }).__emit.bind(client);

    // 压缩前已有实测与视图估算（建立可观察的清空语义）
    emit({
      type: 'step.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { promptTokensActual: 54321, viewTokensEst: 9999, rawTokens: 777, contextWindow: 8000 },
    } as AgentEventEnvelope);

    emit({
      type: 'context.compact.start',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { reason: 'proactive', tokensBefore: 9000, threshold: 5000 },
    } as AgentEventEnvelope);

    let compact = store.getState().chat.inspector.compact;
    expect(compact?.active).toBe(true);
    expect(compact?.reason).toBe('proactive');

    emit({
      type: 'context.compact.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { reason: 'proactive', tokensBefore: 9000, tokensAfter: 3000, durationMs: 120, cached: false },
    } as AgentEventEnvelope);

    compact = store.getState().chat.inspector.compact;
    expect(compact?.active).toBe(false);
    expect(compact?.tokensAfter).toBe(3000);
    // P0-C 口径守护：tokensAfter 是压缩器 messages 口径，不得混进 viewTokensEst（校准后请求口径）——
    // 压缩后旧估算已知失效，清空待下轮 assemble 重算；实测单源不动
    expect(store.getState().chat.inspector.viewTokensEst).toBeUndefined();
    expect(store.getState().chat.inspector.promptTokensActual).toBe(54321);
  });

  it('error → active=false 且带 error', () => {
    const client = mockClient();
    const store = new OctopiRuntimeStore(client);
    (client as unknown as { __emit(e: AgentEventEnvelope): void }).__emit({
      type: 'context.compact.error',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { error: 'boom', reason: 'overflow' },
    } as AgentEventEnvelope);

    const compact = store.getState().chat.inspector.compact;
    expect(compact?.active).toBe(false);
    expect(compact?.error).toBe('boom');
  });
});

describe('OctopiRuntimeStore postCompactContextSize（顶栏上下文大小前段）', () => {
  function makeMockClient(compactResult: {
    ok: boolean;
    compacted: boolean;
    reason?: string;
    tokensBefore: number;
    tokensAfter?: number;
    summary?: string;
  }): OctopiClient {
    const listeners: Record<string, unknown> = {};
    return {
      on(list: Record<string, unknown>) {
        Object.assign(listeners, list);
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
      updateOptions: vi.fn(),
      sendSubscribe: vi.fn(),
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
      compactSession: vi.fn(async () => compactResult),
      /** test helper：触发 onEvent */
      __emit(event: AgentEventEnvelope) {
        (listeners.onEvent as (s: string | undefined, e: AgentEventEnvelope) => void)?.('s1', event);
      },
    } as unknown as OctopiClient & { __emit(e: AgentEventEnvelope): void };
  }

  it('manual 压缩成功：写压缩后大小、不动实测槽；下一次实测到达即让位', async () => {
    const client = makeMockClient({ ok: true, compacted: true, tokensBefore: 9000, tokensAfter: 3000 });
    const store = new OctopiRuntimeStore(client);
    const emit = (client as unknown as { __emit(e: AgentEventEnvelope): void }).__emit.bind(client);
    await store.openSession('s1');

    // 压缩前：有实测、有视图估算
    emit({
      type: 'step.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { promptTokensActual: 54321, viewTokensEst: 9999 },
    } as AgentEventEnvelope);

    const inspectorEvents: unknown[] = [];
    store.addEventListener('inspector', ((e: CustomEvent) => {
      inspectorEvents.push(e.detail.inspector);
    }) as EventListener);

    await store.compactSession();
    let inspector = store.getState().chat.inspector;
    // 顶栏前段换显压缩后大小（报告尺），但估算不得冒充实测（实测单源）
    expect(inspector.postCompactContextSize).toBe(3000);
    expect(inspector.promptTokensActual).toBe(54321);
    expect(inspector.viewTokensEst).toBeUndefined();
    // REST 写入点即广播（UI 靠 inspector 事件刷新，不等引擎事件）
    expect(inspectorEvents.length).toBeGreaterThan(0);

    // 下一次实测到达：压缩后估算让位
    emit({
      type: 'step.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { promptTokensActual: 3456 },
    } as AgentEventEnvelope);
    inspector = store.getState().chat.inspector;
    expect(inspector.postCompactContextSize).toBeUndefined();
    expect(inspector.promptTokensActual).toBe(3456);
  });

  it('未压缩/失败：不写压缩后大小（无假读数）', async () => {
    const client = makeMockClient({ ok: true, compacted: false, reason: 'too_short', tokensBefore: 100, tokensAfter: 100 });
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s1');

    await store.compactSession();
    expect(store.getState().chat.inspector.postCompactContextSize).toBeUndefined();
  });

  it('auto 压缩（proactive/overflow）不写该槽：tokensAfter 是 messages 口径，不得冒充全请求大小（M3 边界）', async () => {
    const client = makeMockClient({ ok: true, compacted: true, tokensBefore: 9000, tokensAfter: 3000 });
    const store = new OctopiRuntimeStore(client);
    const emit = (client as unknown as { __emit(e: AgentEventEnvelope): void }).__emit.bind(client);
    await store.openSession('s1');

    emit({
      type: 'context.compact.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { reason: 'proactive', tokensBefore: 9000, tokensAfter: 3000, durationMs: 120, cached: false },
    } as AgentEventEnvelope);

    expect(store.getState().chat.inspector.postCompactContextSize).toBeUndefined();
  });

  it('跨会话守卫（F1）：压缩返回时已切走 → 结果只写回发起会话缓存，不污染当前会话', async () => {
    const client = makeMockClient({ ok: true, compacted: true, tokensBefore: 9000, tokensAfter: 3000 });
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s1');

    // 压缩排队模拟：REST 在切走之后才返回
    let release!: (r: unknown) => void;
    (client.compactSession as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = store.compactSession(); // 发起于 s1
    await store.openSession('s2'); // 切走
    release({ ok: true, compacted: true, tokensBefore: 9000, tokensAfter: 3000 });
    await pending;

    // 当前会话（s2）不被污染
    expect(store.getState().chat.inspector.postCompactContextSize).toBeUndefined();

    // 切回发起会话：结果在自己的缓存里
    await store.openSession('s1');
    expect(store.getState().chat.inspector.postCompactContextSize).toBe(3000);
  });

  it('后台让位（F2）：切走后 step.end 新实测到达 → 切回时压缩后估算已让位', async () => {
    const client = makeMockClient({ ok: true, compacted: true, tokensBefore: 9000, tokensAfter: 3000 });
    const store = new OctopiRuntimeStore(client);
    const emit = (client as unknown as { __emit(e: AgentEventEnvelope): void }).__emit.bind(client);
    await store.openSession('s1');
    await store.compactSession();
    expect(store.getState().chat.inspector.postCompactContextSize).toBe(3000);

    await store.openSession('s2');
    // 后台会话的新实测（run 还在跑）：缓存同样要让位，切回不能显示过期压缩估算
    emit({
      type: 'step.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { promptTokensActual: 3456 },
    } as AgentEventEnvelope);

    await store.openSession('s1');
    expect(store.getState().chat.inspector.postCompactContextSize).toBeUndefined();
    expect(store.getState().chat.inspector.promptTokensActual).toBe(3456);
  });

  it('F3：auto 压缩完成作废旧压缩估算；manual 事件不误清（单写者=REST）', async () => {
    const client = makeMockClient({ ok: true, compacted: true, tokensBefore: 9000, tokensAfter: 3000 });
    const store = new OctopiRuntimeStore(client);
    const emit = (client as unknown as { __emit(e: AgentEventEnvelope): void }).__emit.bind(client);
    await store.openSession('s1');

    // manual 事件（reason:'manual'）不写不清——REST 是唯一写者，事件/REST 任意顺序终值一致
    await store.compactSession();
    emit({
      type: 'context.compact.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { reason: 'manual', tokensBefore: 9000, tokensAfter: 3000, durationMs: 120, cached: false },
    } as AgentEventEnvelope);
    expect(store.getState().chat.inspector.postCompactContextSize).toBe(3000);

    // auto 压缩完成：旧压缩估算已失效（内容又变了），清槽
    emit({
      type: 'context.compact.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { reason: 'proactive', tokensBefore: 3100, tokensAfter: 800, durationMs: 120, cached: false },
    } as AgentEventEnvelope);
    expect(store.getState().chat.inspector.postCompactContextSize).toBeUndefined();
  });
});
