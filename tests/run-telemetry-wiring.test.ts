/**
 * RunTelemetry 装配 — Builder.trace() 一行启用观测
 *
 * 验证：注册工厂后 trace() 接上 LoopObserver + Runner eventSink；
 * 未注册且无 observer 时显式失败。
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import {
  setRunTelemetryFactory,
  getRunTelemetryFactory,
} from '@octopi-agent/engine/harness/observability/run-telemetry.js';
import { createRunTelemetry } from '@octopi-agent/engine/integration/observability/run-telemetry.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';
import type { ModelProvider, LLMStreamChunk } from '@octopi-agent/core/index.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

function mockProvider(): ModelProvider {
  return {
    name: 'mock',
    chat: async () => ({
      message: { role: 'assistant' as const, content: 'hi' },
      usage: {
        inputUncachedTokens: 1,
        inputCachedTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 2,
      },
      finishReason: 'stop' as const,
    }),
    stream: async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { type: 'text_delta' as const, delta: 'hi' };
      yield {
        type: 'done' as const,
        message: { role: 'assistant' as const, content: 'hi' },
        usage: {
          inputUncachedTokens: 1,
          inputCachedTokens: 0,
          inputCacheWriteTokens: 0,
          outputTokens: 2,
        },
      };
    },
    isAvailable: async () => true,
    getModelInfo: () => ({ name: 'mock', contextWindow: 8000 }),
  };
}

describe('RunTelemetry + AgentBuilder.trace()', () => {
  it('registers factory and traces LLM events via LoopObserver', async () => {
    setRunTelemetryFactory((opts) => createRunTelemetry(opts));
    expect(getRunTelemetryFactory()).toBeTruthy();

    const seen: string[] = [];
    const telemetry = createRunTelemetry({ captureToolArgs: true, enableMetrics: true });
    const origOnEvent = telemetry.onEvent?.bind(telemetry);
    telemetry.onEvent = (event: AgentEvent, ctx) => {
      seen.push(event.type);
      origOnEvent?.(event, ctx);
    };

    setRunTelemetryFactory(() => telemetry);

    const built = await new AgentBuilder()
      .model(mockProvider())
      .store(new InMemorySessionStore())
      .trace({ captureToolArgs: true, enableMetrics: true })
      .build({ mode: 'core' });

    expect(built.agent).toBeTruthy();

    // LoopObserver 已挂上（config.observer 存在）
    expect(built.agent.config.observer).toBeTruthy();

    setRunTelemetryFactory(undefined);
  });

  it('throws when trace() without factory and without observer', async () => {
    setRunTelemetryFactory(undefined);
    await expect(
      new AgentBuilder()
        .model(mockProvider())
        .store(new InMemorySessionStore())
        .trace({ captureToolArgs: true })
        .build({ mode: 'core' }),
    ).rejects.toThrow(/RunTelemetryFactory/);
  });

  it('trace() with explicit observer does not require factory', async () => {
    setRunTelemetryFactory(undefined);
    const built = await new AgentBuilder()
      .model(mockProvider())
      .store(new InMemorySessionStore())
      .trace({})
      .observer({
        recordMetric: () => {},
        startSpan: () => ({
          id: 's',
          name: 's',
          startTime: Date.now(),
          setStatus: () => {},
          setAttribute: () => {},
          setAttributes: () => {},
          end: () => {},
        }),
        log: () => {},
      })
      .build({ mode: 'core' });
    expect(built.agent.config.observer).toBeTruthy();
  });
});
