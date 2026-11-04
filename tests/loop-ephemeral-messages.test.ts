/**
 * ephemeral 消息契约（run-scoped 瞬时注入）
 *
 * 语义：`ephemeral: true` 的消息本轮 LLM 可见，但不属于对话历史。
 * - Loop 内同 run 只保留最新一条（状态快照替换，不累积）
 * - Runner 写回 session 时过滤掉（不落持久层）
 *
 * 回归背景：委派状态提示 `<delegation_status>` 曾被每轮 push 进 session.messages，
 * 在真实 session 里累积 47 条（内容全为 `1 running`，但 delegation 早已结束），
 * 既占上下文又随轮数线性膨胀。
 */

import { describe, it, expect } from 'vitest';
import { agentLoop } from '@octopi-agent/core/loop/agent-loop.js';
import type { AgentContext, AgentLoopConfig, AgentLoopEvent, AgentTool } from '@octopi-agent/core/loop/types.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';

function createProvider(responses: LLMResponse[]): ModelProvider {
  let i = 0;
  const pick = () => responses[Math.min(i++, responses.length - 1)];
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

function tool(): AgentTool {
  return {
    name: 'noop',
    description: 'noop',
    execute: async (id) => ({ toolCallId: id, name: 'noop', content: 'ok' }),
  };
}

async function collect(context: AgentContext, config: AgentLoopConfig): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const e of agentLoop(context, config)) events.push(e);
  return events;
}

function ephemeralMsg(n: number): Message {
  // 夹具对齐生产形态（delegation hint = user + engineHint 载体）
  return {
    role: 'user',
    content: `<delegation_status>${n} running</delegation_status>`,
    timestamp: Date.now(),
    ephemeral: true,
    metadata: { source: 'engineHint' },
  };
}

describe('ephemeral 消息 — Loop 内不累积', () => {
  it('多次工具调用后只保留最新一条快照', async () => {
    // 3 轮工具调用 → steering 取 3 次
    const provider = createProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
      { content: '', toolCalls: [{ id: 'c2', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
      { content: '', toolCalls: [{ id: 'c3', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
      { content: 'done', model: 'test', finishReason: 'stop' },
    ]);

    let calls = 0;
    const context: AgentContext = {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'go', timestamp: Date.now() }],
      tools: [tool()],
    };

    await collect(context, {
      model: provider,
      modelCallIdleTimeoutMs: 5_000,
      modelCallAbsoluteTimeoutMs: 10_000,
      getSteeringMessages: async () => [ephemeralMsg(++calls)],
    });

    const ephemeralLeft = context.messages.filter((m) => m.ephemeral === true);
    expect(ephemeralLeft).toHaveLength(1);
    // 保留的是最新快照，不是第一次的
    expect(String(ephemeralLeft[0].content)).toContain(`${calls} running`);
  });

  it('快照更新原位替换：不把旧快照从历史中部删掉再尾插（前缀稳定）', async () => {
    const provider = createProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
      { content: '', toolCalls: [{ id: 'c2', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
      { content: 'done', model: 'test', finishReason: 'stop' },
    ]);

    let calls = 0;
    const context: AgentContext = {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'go', timestamp: Date.now() }],
      tools: [tool()],
    };

    await collect(context, {
      model: provider,
      modelCallIdleTimeoutMs: 5_000,
      modelCallAbsoluteTimeoutMs: 10_000,
      getSteeringMessages: async () => [ephemeralMsg(++calls)],
    });

    // 原位替换的直接效果：最新快照仍在**首次注入的槽位**（历史前部），
    // 其后的工具回合不动；旧实现（删旧 + 尾插）会把快照挪到数组尾部
    const idx = context.messages.findIndex((m) => m.ephemeral === true);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(context.messages.length - 1);
  });

  it('新旧快照数量交叉：2→1 合并进首槽位，1→2 尾插补位', async () => {
    // 2→1：旧两份快照被一份替换（首槽位替换 + 次槽位删除）
    {
      // steering 在每轮工具调用后消费 → 两轮工具调用才会有第二次快照更新
      const provider = createProvider([
        { content: '', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
        { content: '', toolCalls: [{ id: 'c2', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
        { content: 'done', model: 'test', finishReason: 'stop' },
      ]);
      let calls = 0;
      const context: AgentContext = {
        systemPrompt: '',
        messages: [{ role: 'user', content: 'go', timestamp: Date.now() }],
        tools: [tool()],
      };
      await collect(context, {
        model: provider,
        modelCallIdleTimeoutMs: 5_000,
        modelCallAbsoluteTimeoutMs: 10_000,
        getSteeringMessages: async () => {
          calls++;
          return calls === 1 ? [ephemeralMsg(1), ephemeralMsg(2)] : [ephemeralMsg(3)];
        },
      });
      const left = context.messages.filter((m) => m.ephemeral === true);
      expect(left).toHaveLength(1);
      expect(String(left[0].content)).toContain('3 running');
    }
    // 1→2：新快照多于旧槽位（首槽替换 + 尾插）
    {
      const provider = createProvider([
        { content: '', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
        { content: '', toolCalls: [{ id: 'c2', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
        { content: 'done', model: 'test', finishReason: 'stop' },
      ]);
      let calls = 0;
      const context: AgentContext = {
        systemPrompt: '',
        messages: [{ role: 'user', content: 'go', timestamp: Date.now() }],
        tools: [tool()],
      };
      await collect(context, {
        model: provider,
        modelCallIdleTimeoutMs: 5_000,
        modelCallAbsoluteTimeoutMs: 10_000,
        getSteeringMessages: async () => {
          calls++;
          return calls === 1 ? [ephemeralMsg(1)] : [ephemeralMsg(2), ephemeralMsg(3)];
        },
      });
      const left = context.messages.filter((m) => m.ephemeral === true);
      expect(left).toHaveLength(2);
    }
  });

  it('非 ephemeral 的 steering 正常累积（不误删普通消息）', async () => {
    const provider = createProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
      { content: '', toolCalls: [{ id: 'c2', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
      { content: 'done', model: 'test', finishReason: 'stop' },
    ]);

    let n = 0;
    const context: AgentContext = {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'go', timestamp: Date.now() }],
      tools: [tool()],
    };

    await collect(context, {
      model: provider,
      modelCallIdleTimeoutMs: 5_000,
      modelCallAbsoluteTimeoutMs: 10_000,
      getSteeringMessages: async () => [
        { role: 'system', content: `hint-${++n}`, timestamp: Date.now() },
      ],
    });

    const hints = context.messages.filter((m) => String(m.content).startsWith('hint-'));
    expect(hints.length).toBeGreaterThan(0);
    expect(context.messages.some((m) => m.ephemeral === true)).toBe(false);
  });

  it('数组引用保持不变（session 与 runContext 共享同一数组）', async () => {
    const provider = createProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
      { content: '', toolCalls: [{ id: 'c2', name: 'noop', arguments: {} }], model: 'test', finishReason: 'tool_calls' },
      { content: 'done', model: 'test', finishReason: 'stop' },
    ]);

    const original: Message[] = [{ role: 'user', content: 'go', timestamp: Date.now() }];
    const context: AgentContext = { systemPrompt: '', messages: original, tools: [tool()] };

    let n = 0;
    await collect(context, {
      model: provider,
      modelCallIdleTimeoutMs: 5_000,
      modelCallAbsoluteTimeoutMs: 10_000,
      getSteeringMessages: async () => [ephemeralMsg(++n)],
    });

    // 原地 splice：外部持有的旧引用必须看到同一份内容
    expect(context.messages).toBe(original);
  });
});
