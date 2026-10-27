/**
 * Web Runtime Store — 模型重试状态（用户可见角标）
 *
 * 事故背景（2026-10-27）：一次 52 分钟停滞期间，前端唯一可见的是「等待响应」，
 * 因为重试不产生任何事件。engine 侧补了 `engine.model_retry` 后，
 * store 必须把它变成用户能看到的状态，并在恢复/终态时立刻清掉。
 */

import { describe, it, expect, vi } from 'vitest';
import { OctopiRuntimeStore } from '@octopi-agent/gateway/web/runtime/store.js';
import type { OctopiClient, AgentEventEnvelope } from '@octopi-agent/gateway/web/sdk/client.js';

function mockClient() {
  const listeners: Record<string, unknown> = {};
  return {
    on(list: Record<string, unknown>) {
      Object.assign(listeners, list);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    updateOptions: vi.fn(),
    __emit(event: AgentEventEnvelope) {
      (listeners.onEvent as (s: string | undefined, e: AgentEventEnvelope) => void)?.('s1', event);
    },
  } as unknown as OctopiClient & { __emit(e: AgentEventEnvelope): void };
}

function retryEvent(attempt: number, maxAttempts = 3, reason = 'timeout'): AgentEventEnvelope {
  return {
    type: 'engine.model_retry',
    timestamp: Date.now(),
    sessionId: 's1',
    data: { attempt, maxAttempts, reason, delayMs: 2000, error: 'upstream timeout' },
  } as AgentEventEnvelope;
}

describe('modelRetry 状态机', () => {
  it('收到 engine.model_retry 后写入用户可见状态并派发事件', () => {
    const client = mockClient();
    const store = new OctopiRuntimeStore(client);
    const dispatched: Array<unknown> = [];
    store.addEventListener('modelRetry', ((e: CustomEvent) => {
      dispatched.push(e.detail.retry);
    }) as EventListener);

    client.__emit(retryEvent(2));

    const retry = store.getState().chat.modelRetry;
    expect(retry).not.toBeNull();
    expect(retry?.attempt).toBe(2);
    expect(retry?.maxAttempts).toBe(3);
    expect(retry?.reason).toBe('timeout');
    expect(retry?.error).toContain('upstream timeout');
    expect(dispatched).toHaveLength(1);
  });

  it('重试期间 runStatus 保持 waiting（重试是子状态，不覆盖阶段语义）', () => {
    const client = mockClient();
    const store = new OctopiRuntimeStore(client);

    client.__emit({ type: 'iteration.start', timestamp: Date.now(), sessionId: 's1', data: {} } as AgentEventEnvelope);
    client.__emit(retryEvent(1));

    expect(store.getState().chat.runStatus).toBe('waiting');
    expect(store.getState().chat.modelRetry?.attempt).toBe(1);
  });

  it('模型重新产出内容后角标立即消失（不能让用户以为还在重试）', () => {
    const client = mockClient();
    const store = new OctopiRuntimeStore(client);
    const dispatched: Array<unknown> = [];
    store.addEventListener('modelRetry', ((e: CustomEvent) => {
      dispatched.push(e.detail.retry);
    }) as EventListener);

    client.__emit(retryEvent(1));
    expect(store.getState().chat.modelRetry).not.toBeNull();

    client.__emit({
      type: 'llm_stream_delta',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { content: 'hello' },
    } as AgentEventEnvelope);

    expect(store.getState().chat.modelRetry).toBeNull();
    // 必须派发「已清空」，否则 UI 会留着旧角标
    expect(dispatched[dispatched.length - 1]).toBeNull();
  });

  it('run 终态（engine.error / aborted / engine.end）清除角标', () => {
    for (const type of ['engine.error', 'aborted', 'engine.end'] as const) {
      const client = mockClient();
      const store = new OctopiRuntimeStore(client);
      client.__emit(retryEvent(3));
      expect(store.getState().chat.modelRetry).not.toBeNull();

      client.__emit({
        type,
        timestamp: Date.now(),
        sessionId: 's1',
        data: { error: 'down', reason: 'error' },
      } as AgentEventEnvelope);

      expect(store.getState().chat.modelRetry, `${type} 应清除重试角标`).toBeNull();
    }
  });

  it('连续多次重试时 attempt 递增覆盖（不是累加多条）', () => {
    const client = mockClient();
    const store = new OctopiRuntimeStore(client);

    client.__emit(retryEvent(1));
    client.__emit(retryEvent(2));
    client.__emit(retryEvent(3));

    expect(store.getState().chat.modelRetry?.attempt).toBe(3);
    expect(store.getState().chat.modelRetry?.maxAttempts).toBe(3);
  });

  it('写入独立的 inspector.lastModelRetryLabel，不污染 planner 重试的 lastRetryLabel', () => {
    const client = mockClient();
    const store = new OctopiRuntimeStore(client);

    client.__emit(retryEvent(2));

    expect(store.getState().chat.inspector.lastModelRetryLabel).toBe('Model retry 2/3 (timeout)');
    // lastRetryLabel 属于 planner/empty_response 重试机制，不得被模型重试覆盖
    expect(store.getState().chat.inspector.lastRetryLabel).toBeUndefined();
  });

  it('缺字段的畸形事件不得崩溃，退化为安全默认值', () => {
    const client = mockClient();
    const store = new OctopiRuntimeStore(client);

    client.__emit({ type: 'engine.model_retry', timestamp: Date.now(), sessionId: 's1', data: {} } as AgentEventEnvelope);

    const retry = store.getState().chat.modelRetry;
    expect(retry).not.toBeNull();
    expect(retry?.attempt).toBe(1);
    expect(retry?.maxAttempts).toBe(1);
    expect(retry?.reason).toBe('unknown');
  });
});
