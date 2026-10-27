/**
 * 评审回归钉（del-831357f9 对抗式评审 F1/F2）
 *
 * - F1：只读运行期提示不得经 followUp 接缝续命（否则有在途委派的父 Run 永不结束）
 * - F2：runtime.run.event 必带 sessionId/agentId 路由键（缺则 WS 流式/终态全断）
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '@octopi-agent/engine/harness/run/agent/agent.js';
import type {
  ModelProvider,
  LLMResponse,
  LLMStreamChunk,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type { ReliabilityHarness } from '@octopi-agent/core/interfaces/reliability.js';
import type { Message } from '@octopi-agent/core/types.js';
import { AgentRuntime } from '@octopi-agent/engine/harness/activation/runtime.js';
import type { Trigger } from '@octopi-agent/engine/harness/activation/types.js';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

function createProvider(responses: LLMResponse[], calls: { count: number }): ModelProvider {
  let i = 0;
  const pick = () => {
    calls.count += 1;
    return responses[Math.min(i++, responses.length - 1)];
  };
  return {
    name: 'test',
    defaultModel: 'test',
    getModelInfo: () => null,
    getModelInfos: () => [],
    async chat(): Promise<LLMResponse> {
      return pick();
    },
    async *stream(): AsyncGenerator<LLMStreamChunk> {
      const r = pick();
      if (r.toolCalls?.length) {
        for (let t = 0; t < r.toolCalls.length; t++) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: r.toolCalls[t].id,
              name: r.toolCalls[t].name,
              arguments: JSON.stringify(r.toolCalls[t].arguments),
              index: t,
            },
          };
        }
      }
      if (r.content) yield { type: 'content', content: r.content };
      yield { type: 'done', usage: r.usage, finishReason: r.finishReason };
    },
    async isAvailable() {
      return true;
    },
  };
}

function createHarness(): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
    },
  };
}

const hint: Message = {
  role: 'system',
  content: '<delegation_status>1 running</delegation_status>',
  timestamp: Date.now(),
  ephemeral: true,
};

describe('F1：只读提示不得经 followUp 续命', () => {
  it('纯文本回答 + 非空 steeringExtras：run 自然结束且只调一次 LLM', async () => {
    const calls = { count: 0 };
    const provider = createProvider(
      [{ content: 'ok', model: 'test', finishReason: 'stop' }],
      calls,
    );
    const agent = new Agent({ model: provider, harness: createHarness() });
    agent.context.messages.push({ role: 'user', content: 'hi', timestamp: Date.now() });

    const events: string[] = [];
    for await (const e of agent.run(undefined, undefined, {
      consumeMessages: async () => [],
      steeringExtras: async () => [hint],
    })) {
      events.push(e.type);
    }
    // 修复前：hint 经 followUp 恒非空 → run 被无限续命（评审探针实测 9+ 次调用）
    expect(calls.count).toBe(1);
    expect(events).toContain('agent_end');
  });

  it('工具批次后提示经 steering 注入，但 followUp 仍放行 run 结束', async () => {
    const calls = { count: 0 };
    const provider = createProvider(
      [
        {
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { n: 1 } }],
          model: 'test',
          finishReason: 'tool_calls',
        },
        { content: 'done', model: 'test', finishReason: 'stop' },
      ],
      calls,
    );
    const agent = new Agent({
      model: provider,
      harness: createHarness(),
      tools: [
        {
          name: 'echo',
          description: 'echo',
          execute: async (id, args) => ({
            toolCallId: id,
            name: 'echo',
            content: JSON.stringify(args),
          }),
        },
      ],
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });

    let ended = false;
    for await (const e of agent.run(undefined, undefined, {
      consumeMessages: async () => [],
      steeringExtras: async () => [hint],
    })) {
      if (e.type === 'agent_end') ended = true;
    }
    expect(ended).toBe(true);
    expect(calls.count).toBe(2);
    // 提示确实经 steering 接缝进了上下文（不是被悄悄丢弃）
    expect(
      agent.context.messages.some((m) => String(m.content).includes('<delegation_status>')),
    ).toBe(true);
  });
});

describe('F2：runtime.run.event 载荷必须带路由键', () => {
  it('WS 扇出判据（sessionId）在事件上成立，且内层 Run 事件齐全', async () => {
    const bus = new DefaultEventBus();
    const runtime = new AgentRuntime({ events: bus });
    await runtime.start();
    const inner: Array<string | undefined> = [];
    const envelopes: AgentEvent[] = [];
    bus.on('runtime.run.event', (e) => {
      envelopes.push(e);
      inner.push((e.data as { event?: AgentEvent }).event?.type);
    });
    runtime.registerAgent({
      agentId: 'a1',
      dispatcher: {
        async *execute() {
          yield {
            type: 'llm_stream_delta',
            timestamp: Date.now(),
            agentId: 'a1',
            sessionId: 's1',
            data: { delta: 'x' },
          } as AgentEvent;
          yield {
            type: 'turn.end',
            timestamp: Date.now(),
            agentId: 'a1',
            sessionId: 's1',
            data: { content: 'hello' },
          } as AgentEvent;
          yield {
            type: 'engine.end',
            timestamp: Date.now(),
            agentId: 'a1',
            sessionId: 's1',
            data: {},
          } as AgentEvent;
        },
      },
    });

    const trigger: Trigger = {
      id: 't1',
      type: 'message',
      agentId: 'a1',
      sessionId: 's1',
      timestamp: Date.now(),
      payload: { kind: 'user_message', content: 'hi' },
      metadata: {},
    };
    await runtime.dispatch(trigger);

    // 修复前：载荷缺 sessionId → gateway 判据恒假 → 流式与终态双双落空
    expect(envelopes.length).toBeGreaterThanOrEqual(3);
    for (const e of envelopes) {
      expect(e.sessionId).toBe('s1');
      expect(e.agentId).toBe('a1');
    }
    expect(inner).toContain('llm_stream_delta');
    expect(inner).toContain('turn.end');
    expect(inner).toContain('engine.end');
  });
});
