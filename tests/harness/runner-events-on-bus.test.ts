/**
 * 适配事件 → EventBus 通路（2026-11-04 拍板 A：子系统 trigger 对齐真实事件）
 *
 * builder eventSink 把 runner 适配事件转发到 EventBus（llm_stream_delta 高频流片除外），
 * 子系统 trigger（`filter.events: ['step.end']` 等）按事件名挂总线监听。
 *
 * 回归背景：此前 runner 事件只走 onEvent/observer 通道、**不上总线**——
 * trigger filter 命名的事件（如当时的死词 iteration.end）永远不触发。
 */

import { describe, it, expect } from 'vitest';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { ModelProvider, LLMRequest, LLMResponse } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';

function mockProvider(): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return { content: 'ok', model: 'm', finishReason: 'stop' as const };
    },
  } as unknown as ModelProvider;
}

describe('适配事件上 EventBus（子系统 trigger 通路）', () => {
  it('step.start/step.end 发上总线；llm_stream_delta 不上', async () => {
    const bus = new DefaultEventBus();
    const seen: string[] = [];
    for (const type of ['step.start', 'step.end', 'llm_stream_delta']) {
      bus.on(type, () => {
        seen.push(type);
      });
    }

    const { runner } = await new AgentBuilder()
      .model(mockProvider())
      .store(new InMemorySessionStore())
      .effectPolicy({ opsAudit: 'off' })
      .events(bus)
      .build({ autoLoadSubsystems: false });

    for await (const _event of runner.handle(
      'bus-session',
      { role: 'user', content: 'hi', timestamp: Date.now() } satisfies Message,
      { systemPrompt: '', agentId: 'bus-probe', sessionId: 'bus-session' },
    )) void _event;

    expect(seen).toContain('step.start');
    expect(seen).toContain('step.end');
    expect(seen).not.toContain('llm_stream_delta');
  });
});
