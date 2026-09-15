/**
 * Loop 层 P0 契约测试（直接打 agentLoop，不依赖 Reliability）
 *
 * 覆盖：
 * - terminate：批次全 true → agent_end(should_stop)
 * - finishReason=length（流式透传）→ 截断工具错误回灌
 * - 串行中止：tool_results 与 tool_calls 一一对应
 * - tool_end 携带真实 arguments
 */

import { describe, it, expect } from 'vitest';
import { agentLoop } from '../src/loop/agent-loop.js';
import { callModel } from '../src/loop/call-model.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopEvent,
  AgentTool,
} from '../src/loop/types.js';
import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '../src/core/interfaces/model-provider.js';
import type { Message } from '../src/core/types.js';

function userMsg(content: string): Message {
  return { role: 'user', content, timestamp: Date.now() };
}

function createProvider(responses: LLMResponse[]): ModelProvider {
  let i = 0;
  const pick = () => responses[Math.min(i++, responses.length - 1)];
  return {
    name: 'test',
    defaultModel: 'test',
    getModelInfo: () => null,
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return pick();
    },
    async *stream(_req: LLMRequest): AsyncGenerator<LLMStreamChunk> {
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
    async isAvailable() { return true; },
  };
}

function baseConfig(model: ModelProvider, extra?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model,
    modelCallIdleTimeoutMs: 5_000,
    modelCallAbsoluteTimeoutMs: 10_000,
    ...extra,
  };
}

async function collect(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const e of agentLoop(context, config, signal)) {
    events.push(e);
  }
  return events;
}

describe('terminate 契约', () => {
  it('批次内全部 terminate=true 时以 should_stop 结束', async () => {
    const tool: AgentTool = {
      name: 'stopper',
      description: 'always terminate',
      execute: async (id) => ({
        toolCallId: id,
        name: 'stopper',
        content: 'done',
        terminate: true,
      }),
    };

    const provider = createProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'stopper', arguments: {} }],
        model: 'test',
        finishReason: 'tool_calls',
      },
      // 若 terminate 未生效会走到这里
      { content: 'should not reach', model: 'test', finishReason: 'stop' },
    ]);

    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('go')],
      tools: [tool],
    };

    const events = await collect(context, baseConfig(provider));
    const agentEnd = events.find(e => e.type === 'agent_end');
    expect(agentEnd).toBeDefined();
    expect((agentEnd as any).reason).toBe('should_stop');
    // 不应发起第二轮 LLM
    expect(events.filter(e => e.type === 'assistant_message').length).toBe(1);
  });

  it('仅部分 terminate 时不停止，继续下一轮', async () => {
    const tools: AgentTool[] = [
      {
        name: 'a',
        description: 'a',
        execute: async (id) => ({ toolCallId: id, name: 'a', content: 'ok', terminate: true }),
      },
      {
        name: 'b',
        description: 'b',
        execute: async (id) => ({ toolCallId: id, name: 'b', content: 'ok' }),
      },
    ];

    const provider = createProvider([
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'a', arguments: {} },
          { id: 'c2', name: 'b', arguments: {} },
        ],
        model: 'test',
        finishReason: 'tool_calls',
      },
      { content: 'final', model: 'test', finishReason: 'stop' },
    ]);

    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('go')],
      tools,
    };

    const events = await collect(context, baseConfig(provider));
    const agentEnd = events.find(e => e.type === 'agent_end');
    expect((agentEnd as any).reason).toBe('completed');
  });

  it('beforeToolCall block + terminate 时批次结束后停止', async () => {
    const tool: AgentTool = {
      name: 'danger',
      description: 'blocked',
      execute: async (id) => ({ toolCallId: id, name: 'danger', content: 'ran' }),
    };

    const provider = createProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'danger', arguments: {} }],
        model: 'test',
        finishReason: 'tool_calls',
      },
    ]);

    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('go')],
      tools: [tool],
    };

    const events = await collect(
      context,
      baseConfig(provider, {
        beforeToolCall: async () => ({ block: true, reason: 'denied', terminate: true }),
      }),
    );

    const agentEnd = events.find(e => e.type === 'agent_end');
    expect((agentEnd as any).reason).toBe('should_stop');
  });
});

describe('finishReason=length 截断回灌', () => {
  it('流式 done 携带 length + tool_calls 时生成 isError 占位结果', async () => {
    const tool: AgentTool = {
      name: 't',
      description: 't',
      execute: async (id) => ({ toolCallId: id, name: 't', content: 'ok' }),
    };

    const provider = createProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 't', arguments: { x: 1 } }],
        model: 'test',
        finishReason: 'length',
      },
      { content: 'recovered', model: 'test', finishReason: 'stop' },
    ]);

    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('go')],
      tools: [tool],
    };

    const events = await collect(context, baseConfig(provider));
    const toolEnds = events.filter(e => e.type === 'tool_end');
    expect(toolEnds.length).toBeGreaterThan(0);
    expect((toolEnds[0] as any).result.isError).toBe(true);
    expect(String((toolEnds[0] as any).result.content)).toContain('truncated');

    // 占位工具不应真正执行
    const agentEnd = events.find(e => e.type === 'agent_end');
    expect((agentEnd as any).reason).toBe('completed');
  });

  it('callModel 优先使用 done.finishReason 而非合成值', async () => {
    const provider: ModelProvider = {
      name: 'test',
      defaultModel: 'test',
      getModelInfo: () => null,
      async chat(): Promise<LLMResponse> {
        return { content: 'x', model: 'test', finishReason: 'stop' };
      },
      async *stream(): AsyncGenerator<LLMStreamChunk> {
        yield { type: 'tool_call', toolCall: { id: 'c1', name: 't', arguments: '{"a":1}', index: 0 } };
        yield { type: 'done', finishReason: 'length' };
      },
      async isAvailable() { return true; },
    };

    const gen = callModel(provider, [], [], undefined, {
      idleTimeoutMs: 5_000,
      absoluteTimeoutMs: 10_000,
    });
    let result = await gen.next();
    while (!result.done) result = await gen.next();
    expect(result.value.finishReason).toBe('length');
    expect(result.value.toolCalls?.length).toBe(1);
  });
});

describe('串行中止补全 tool_results', () => {
  it('中止后未执行的调用有 isError 占位，数量与 tool_calls 一致', async () => {
    const controller = new AbortController();
    let executed = 0;
    const slow: AgentTool = {
      name: 'slow',
      description: 'slow',
      executionMode: 'sequential',
      execute: async (id) => {
        executed++;
        if (executed === 1) {
          // 在第一个工具执行中途 abort，后续调用应补占位
          controller.abort();
        }
        return { toolCallId: id, name: 'slow', content: `ok-${executed}` };
      },
    };

    const provider = createProvider([
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'slow', arguments: {} },
          { id: 'c2', name: 'slow', arguments: {} },
          { id: 'c3', name: 'slow', arguments: {} },
        ],
        model: 'test',
        finishReason: 'tool_calls',
      },
    ]);

    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('go')],
      tools: [slow],
    };

    const events: AgentLoopEvent[] = [];
    for await (const e of agentLoop(
      context,
      baseConfig(provider, { toolExecution: 'sequential' }),
      controller.signal,
    )) {
      events.push(e);
    }

    const toolEnds = events.filter(e => e.type === 'tool_end');
    expect(toolEnds.length).toBe(3);
    expect(executed).toBe(1);

    const lastToolMsg = [...context.messages].reverse().find(m => m.role === 'tool');
    expect(lastToolMsg?.toolResults?.length).toBe(3);
    expect(lastToolMsg?.toolResults?.[0]?.error).toBeUndefined();
    expect(lastToolMsg?.toolResults?.[1]?.error).toContain('aborted');
    expect(lastToolMsg?.toolResults?.[2]?.error).toContain('aborted');
  });
});

describe('turn_end.phase 显式时序', () => {
  it('有工具时为 pre_tools，纯文本时为 final', async () => {
    const tool: AgentTool = {
      name: 't',
      description: 't',
      execute: async (id) => ({ toolCallId: id, name: 't', content: 'ok' }),
    };
    const provider = createProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
        model: 'test',
        finishReason: 'tool_calls',
      },
      { content: 'done', model: 'test', finishReason: 'stop' },
    ]);

    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('go')],
      tools: [tool],
    };

    const events = await collect(context, baseConfig(provider));
    const turns = events.filter(e => e.type === 'turn_end') as Array<
      Extract<AgentLoopEvent, { type: 'turn_end' }>
    >;
    expect(turns.length).toBe(2);
    expect(turns[0].phase).toBe('pre_tools');
    expect(turns[0].hasToolCalls).toBe(true);
    expect(turns[1].phase).toBe('final');
    expect(turns[1].hasToolCalls).toBe(false);
  });
});

describe('tool_end 携带真实 toolCall', () => {
  it('tool_end.toolCall.arguments 与发起时一致', async () => {
    const seen: unknown[] = [];
    const tool: AgentTool = {
      name: 'echo',
      description: 'echo',
      execute: async (id, args) => {
        seen.push(args);
        return { toolCallId: id, name: 'echo', content: JSON.stringify(args) };
      },
    };

    const provider = createProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { path: '/tmp/x', n: 3 } }],
        model: 'test',
        finishReason: 'tool_calls',
      },
      { content: 'ok', model: 'test', finishReason: 'stop' },
    ]);

    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('go')],
      tools: [tool],
    };

    const events = await collect(context, baseConfig(provider));
    const toolEnd = events.find(e => e.type === 'tool_end') as Extract<AgentLoopEvent, { type: 'tool_end' }>;
    expect(toolEnd).toBeDefined();
    expect(toolEnd.toolCall.id).toBe('c1');
    expect(toolEnd.toolCall.name).toBe('echo');
    expect(toolEnd.toolCall.arguments).toEqual({ path: '/tmp/x', n: 3 });
  });
});

describe('消息边界规范化', () => {
  it('发给 provider 的 tool 消息已展开为独立 LLMMessage', async () => {
    let captured: LLMRequest['messages'] | undefined;
    const tool: AgentTool = {
      name: 't',
      description: 't',
      execute: async (id) => ({ toolCallId: id, name: 't', content: 'ok' }),
    };

    const provider: ModelProvider = {
      name: 'test',
      defaultModel: 'test',
      getModelInfo: () => null,
      async chat(req) {
        captured = req.messages;
        return { content: 'done', model: 'test', finishReason: 'stop' };
      },
      async *stream(req) {
        captured = req.messages;
        yield { type: 'content', content: 'done' };
        yield { type: 'done', finishReason: 'stop' };
      },
      async isAvailable() { return true; },
    };

    const context: AgentContext = {
      systemPrompt: 'sys',
      messages: [userMsg('go')],
      tools: [tool],
    };

    // 第一轮 tool_calls，第二轮纯文本
    let call = 0;
    const seq: ModelProvider = {
      ...provider,
      async chat(req) {
        call++;
        if (call === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 't', arguments: { a: 1 } }],
            model: 'test',
            finishReason: 'tool_calls',
          };
        }
        return provider.chat(req);
      },
      async *stream(req) {
        call++;
        if (call === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'c1', name: 't', arguments: '{"a":1}', index: 0 },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        yield* provider.stream(req);
      },
    };

    await collect(context, baseConfig(seq));

    expect(captured).toBeDefined();
    const toolMsgs = captured!.filter(m => m.role === 'tool');
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].tool_call_id).toBe('c1');
    const assistantWithTools = captured!.find(m => m.role === 'assistant' && m.tool_calls);
    expect(assistantWithTools?.tool_calls?.[0].function.arguments).toBe('{"a":1}');
  });
});

describe('system 托管与 abort 入口', () => {
  it('无 metadata.source 的 system 不会被摘除', async () => {
    const provider = createProvider([
      { content: 'ok', model: 'test', finishReason: 'stop' },
    ]);
    const context: AgentContext = {
      systemPrompt: '', // 空 persona：只应摘除 managed
      messages: [
        { role: 'system', content: 'user-owned system', timestamp: Date.now() },
        userMsg('hi'),
      ],
    };
    await collect(context, baseConfig(provider));
    expect(context.messages.some(m => m.role === 'system' && m.content === 'user-owned system')).toBe(true);
  });

  it('已 aborted 时不 yield agent_start，直接 agent_end', async () => {
    const provider = createProvider([
      { content: 'should not run', model: 'test', finishReason: 'stop' },
    ]);
    const controller = new AbortController();
    controller.abort();
    const context: AgentContext = { systemPrompt: '', messages: [userMsg('x')] };
    const events = await collect(context, baseConfig(provider), controller.signal);
    expect(events.some(e => e.type === 'agent_start')).toBe(false);
    expect((events.find(e => e.type === 'agent_end') as any)?.reason).toBe('aborted');
  });
});

describe('非法 tool arguments', () => {
  it('JSON 解析失败时工具不执行，得到 isError 结果', async () => {
    let executed = false;
    let streamed = 0;
    const tool: AgentTool = {
      name: 't',
      description: 't',
      execute: async (id) => {
        executed = true;
        return { toolCallId: id, name: 't', content: 'ran' };
      },
    };

    const provider: ModelProvider = {
      name: 'test',
      defaultModel: 'test',
      getModelInfo: () => null,
      async chat() {
        return { content: 'x', model: 'test', finishReason: 'stop' };
      },
      async *stream() {
        streamed++;
        if (streamed === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'c1', name: 't', arguments: '{not-json', index: 0 },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        yield { type: 'content', content: 'ok' };
        yield { type: 'done', finishReason: 'stop' };
      },
      async isAvailable() { return true; },
    };

    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('go')],
      tools: [tool],
    };

    const events = await collect(context, baseConfig(provider));
    const toolEnd = events.find(e => e.type === 'tool_end') as Extract<AgentLoopEvent, { type: 'tool_end' }>;
    expect(executed).toBe(false);
    expect(toolEnd?.result.isError).toBe(true);
    expect(String(toolEnd?.result.content)).toContain('Invalid JSON');
  });
});

describe('prepareNextTurn 不替换 context 引用', () => {
  it('传入新 context 对象时字段合并回原引用', async () => {
    const tool: AgentTool = {
      name: 't',
      description: 't',
      execute: async (id) => ({ toolCallId: id, name: 't', content: 'ok' }),
    };
    const provider = createProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
        model: 'test',
        finishReason: 'tool_calls',
      },
      { content: 'done', model: 'test', finishReason: 'stop' },
    ]);

    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('go')],
      tools: [tool],
    };
    const originalRef = context;

    await collect(context, baseConfig(provider, {
      prepareNextTurn: async (ctx) => ({
        context: {
          systemPrompt: 'updated',
          messages: ctx.context.messages,
          tools: ctx.context.tools,
        },
      }),
    }));

    expect(context).toBe(originalRef);
    expect(context.systemPrompt).toBe('updated');
  });
});
