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
