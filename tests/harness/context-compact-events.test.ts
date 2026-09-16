/**
 * context.compact.* 可观测事件
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentBuilder } from '../../src/harness/agent-building/builder.js';
import { DefaultContextEngine } from '../../src/harness/context/default-context-engine.js';
import type { ContextCompactEvent } from '../../src/harness/context/types.js';
import type { ModelProvider, LLMMessage } from '../../src/core/interfaces/model-provider.js';
import type { Message } from '../../src/core/types.js';
import type { AgentEvent } from '../../src/core/primitives/event-bus.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function mockProvider(): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat() {
      return { content: '## Summary\nok', model: 'm', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() { return true; },
    getModelInfo() {
      return { name: 'm', contextWindow: 4000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 4000 }];
    },
  };
}

const summarize = async (_m: LLMMessage[]) => '## Conversation Summary\nhit';

describe('DefaultContextEngine emit', () => {
  it('主动摘要发出 start/end', async () => {
    const events: ContextCompactEvent[] = [];
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      protectFirstN: 2,
      protectLastN: 4,
    });
    const msgs: Message[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(userMsg(`c-${i} ` + 'x'.repeat(400)));
    }

    await engine.assemble({
      sessionId: 's-emit',
      messages: msgs,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
      emit: (e) => events.push(e),
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('context.compact.start');
    expect(types).toContain('context.compact.end');
    const start = events.find((e) => e.type === 'context.compact.start');
    expect(start?.reason).toBe('proactive');
    expect(start?.sessionId).toBe('s-emit');
  });

  it('缓存重建标记 cached=true', async () => {
    const events: ContextCompactEvent[] = [];
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      protectFirstN: 2,
      protectLastN: 4,
    });
    const base: Message[] = [];
    for (let i = 0; i < 30; i++) {
      base.push(userMsg('x'.repeat(400)));
    }
    const params = {
      sessionId: 's-cache-evt',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
      emit: (e: ContextCompactEvent) => events.push(e),
    };

    await engine.assemble({ ...params, messages: base });
    events.length = 0;
    await engine.assemble({ ...params, messages: [...base, userMsg('tiny')] });

    const end = events.find((e) => e.type === 'context.compact.end');
    expect(end?.cached).toBe(true);
  });
});

describe('Builder → EventBus 桥接', () => {
  it('convertToLlm 压缩时 EventBus 收到 context.compact.*', async () => {
    const provider = mockProvider();
    const builder = new AgentBuilder().model(provider).summarize(summarize);
    const { agent, events } = await builder.build();

    const busEvents: AgentEvent[] = [];
    events.onAll((e) => busEvents.push(e));

    const msgs: Message[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push(userMsg('y'.repeat(500)));
    }
    agent.setContextSessionId('sess-bridge');
    await agent.config.convertToLlm!(msgs);

    const compact = busEvents.filter((e) => e.type.startsWith('context.compact.'));
    expect(compact.length).toBeGreaterThan(0);
    expect(compact[0]?.sessionId).toBe('sess-bridge');
    expect(
      compact.some((e) => e.type === 'context.compact.start'),
    ).toBe(true);
  });
});
