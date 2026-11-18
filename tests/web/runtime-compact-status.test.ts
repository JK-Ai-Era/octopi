/**
 * Web Runtime Store — context.compact.* 状态 + contextSize 显示槽
 */

import { describe, it, expect, vi } from 'vitest';
import { OctopiRuntimeStore } from '@octopi-agent/gateway/web/runtime/store.js';
import type { OctopiClient, AgentEventEnvelope } from '@octopi-agent/gateway/web/sdk/client.js';
import type { ContextSizeSnapshot } from '@octopi-agent/engine';

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
    // P0-C 口径守护：tokensAfter 是报告尺（M3 统一后的全请求估算），不得混进 viewTokensEst
    //（校准后请求口径）——压缩后旧估算已知失效，清空待下轮 assemble 重算；实测单源不动
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

describe('OctopiRuntimeStore contextSize（顶栏上下文大小前段，纯镜像）', () => {
  const compactSize = (tokens: number, asOf = 1000): ContextSizeSnapshot => ({
    tokens,
    source: 'compact-est',
    asOf,
  });
  const usageSize = (tokens: number, asOf = 2000): ContextSizeSnapshot => ({
    tokens,
    source: 'usage',
    asOf,
  });

  function makeMockClient(compactResult: {
    ok: boolean;
    compacted: boolean;
    reason?: string;
    tokensBefore: number;
    tokensAfter?: number;
    contextSize?: ContextSizeSnapshot;
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
      /** test helper：触发 onEvent（按事件自带 sessionId 分发，支持多会话场景） */
      __emit(event: AgentEventEnvelope) {
        (listeners.onEvent as (s: string | undefined, e: AgentEventEnvelope) => void)?.(event.sessionId ?? 's1', event);
      },
    } as unknown as OctopiClient & { __emit(e: AgentEventEnvelope): void };
  }

  it('manual 压缩成功：镜像服务端 contextSize、不动实测槽；stale 回填不冒名（F4）', async () => {
    const client = makeMockClient({
      ok: true,
      compacted: true,
      tokensBefore: 9000,
      tokensAfter: 3000,
      contextSize: compactSize(3000),
    });
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
    // 显示槽纯镜像服务端快照；估算不得冒充实测（实测单源）
    expect(inspector.contextSize).toEqual(compactSize(3000));
    expect(inspector.promptTokensActual).toBe(54321);
    expect(inspector.viewTokensEst).toBeUndefined();
    // REST 写入点即广播（UI 靠 inspector 事件刷新，不等引擎事件）
    expect(inspectorEvents.length).toBeGreaterThan(0);

    // stale 回填（无用量、不带快照）：显示槽不动、不冒名新实测（评审 F4）
    emit({
      type: 'step.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { promptTokensActual: 54321 },
    } as AgentEventEnvelope);
    inspector = store.getState().chat.inspector;
    expect(inspector.contextSize).toEqual(compactSize(3000));
    expect(inspector.promptTokensActual).toBe(54321);

    // 真实用量快照到达：替换
    emit({
      type: 'step.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { promptTokensActual: 3456, contextSize: usageSize(3456) },
    } as AgentEventEnvelope);
    inspector = store.getState().chat.inspector;
    expect(inspector.contextSize).toEqual(usageSize(3456));
  });

  it('未压缩/失败：不镜像（无假读数）——即使响应错带快照也不采（compacted 闸门）', async () => {
    const client = makeMockClient({
      ok: true,
      compacted: false,
      reason: 'too_short',
      tokensBefore: 100,
      tokensAfter: 100,
      // 引擎 bug 形状：零覆盖轮错挂快照——REST 侧 compacted 闸门必须挡住（评审 F-1）
      contextSize: compactSize(100),
    });
    const store = new OctopiRuntimeStore(client);
    await store.openSession('s1');

    await store.compactSession();
    expect(store.getState().chat.inspector.contextSize).toBeUndefined();
  });

  it('compact.end 镜像规则：真压缩携带快照即替换；0/0（无新压缩）与 cancelled 不带则不动', async () => {
    const client = makeMockClient({ ok: true, compacted: true, tokensBefore: 9000, tokensAfter: 3000 });
    const store = new OctopiRuntimeStore(client);
    const emit = (client as unknown as { __emit(e: AgentEventEnvelope): void }).__emit.bind(client);
    await store.openSession('s1');

    // 真压缩完成（manual/proactive 同型）：携带快照即镜像（M3 后 auto 口径同为全请求）
    emit({
      type: 'context.compact.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: {
        reason: 'proactive',
        tokensBefore: 9000,
        tokensAfter: 3000,
        contextSize: compactSize(3000),
        durationMs: 120,
        cached: false,
      },
    } as AgentEventEnvelope);
    expect(store.getState().chat.inspector.contextSize).toEqual(compactSize(3000));

    // 0/0（无新压缩，复用重建）：不带快照 = 显示不动
    emit({
      type: 'context.compact.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { reason: 'proactive', tokensBefore: 0, tokensAfter: 0, durationMs: 1, cached: true },
    } as AgentEventEnvelope);
    expect(store.getState().chat.inspector.contextSize).toEqual(compactSize(3000));

    // cancelled（中止收尾，零写入）：不带快照 = 显示不动
    emit({
      type: 'context.compact.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { reason: 'proactive', durationMs: 1, cancelled: true },
    } as AgentEventEnvelope);
    expect(store.getState().chat.inspector.contextSize).toEqual(compactSize(3000));
  });

  it('F2/F5：asOf 单调摄入——迟到旧帧不回退、双序终值一致', async () => {
    const client = makeMockClient({
      ok: true,
      compacted: true,
      tokensBefore: 9000,
      tokensAfter: 3000,
      contextSize: compactSize(3000, 2000),
    });
    const store = new OctopiRuntimeStore(client);
    const emit = (client as unknown as { __emit(e: AgentEventEnvelope): void }).__emit.bind(client);
    await store.openSession('s1');

    // 新快照（asOf=2000）先到
    await store.compactSession();
    expect(store.getState().chat.inspector.contextSize).toEqual(compactSize(3000, 2000));

    // 迟到的旧帧（asOf=1000，压缩前大数）：asOf 单调守卫拒收，不回退
    emit({
      type: 'step.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { promptTokensActual: 8888, contextSize: usageSize(8888, 1000) },
    } as AgentEventEnvelope);
    expect(store.getState().chat.inspector.contextSize).toEqual(compactSize(3000, 2000));

    // 反序（真从零起）：旧帧先到被采信，新快照后到即覆盖——终值与顺序无关
    await store.openSession('s3');
    emit({
      type: 'step.end',
      timestamp: Date.now(),
      sessionId: 's3',
      data: { promptTokensActual: 8888, contextSize: usageSize(8888, 1000) },
    } as AgentEventEnvelope);
    expect(store.getState().chat.inspector.contextSize).toEqual(usageSize(8888, 1000));
    await store.compactSession();
    expect(store.getState().chat.inspector.contextSize).toEqual(compactSize(3000, 2000));
  });

  it('跨会话守卫（F1）：压缩返回时已切走 → 结果只写回发起会话缓存，不污染当前会话', async () => {
    const client = makeMockClient({
      ok: true,
      compacted: true,
      tokensBefore: 9000,
      tokensAfter: 3000,
      contextSize: compactSize(3000),
    });
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
    release({ ok: true, compacted: true, tokensBefore: 9000, tokensAfter: 3000, contextSize: compactSize(3000) });
    await pending;

    // 当前会话（s2）不被污染
    expect(store.getState().chat.inspector.contextSize).toBeUndefined();

    // 切回发起会话：结果在自己的缓存里
    await store.openSession('s1');
    expect(store.getState().chat.inspector.contextSize).toEqual(compactSize(3000));
  });

  it('后台镜像（F2）：切走后事件/用量带新快照 → 切回显示新值；stale 回填不动', async () => {
    const client = makeMockClient({
      ok: true,
      compacted: true,
      tokensBefore: 9000,
      tokensAfter: 3000,
      contextSize: compactSize(3000),
    });
    const store = new OctopiRuntimeStore(client);
    const emit = (client as unknown as { __emit(e: AgentEventEnvelope): void }).__emit.bind(client);
    await store.openSession('s1');
    await store.compactSession();
    expect(store.getState().chat.inspector.contextSize).toEqual(compactSize(3000));

    await store.openSession('s2');
    // 后台 stale 回填：不带快照 = 不动
    emit({
      type: 'step.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { promptTokensActual: 3456 },
    } as AgentEventEnvelope);
    // 后台真实用量快照：镜像进缓存
    emit({
      type: 'step.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { promptTokensActual: 2222, contextSize: usageSize(2222) },
    } as AgentEventEnvelope);

    await store.openSession('s1');
    expect(store.getState().chat.inspector.contextSize).toEqual(usageSize(2222));
    expect(store.getState().chat.inspector.promptTokensActual).toBe(2222);
  });
});
