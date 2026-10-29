/**
 * 工具部分输出通道（onToolUpdate → tool.exec.update 的上游半段）。
 *
 * 钉住 Loop 契约：`AgentTool.execute` 的 `onUpdate` 参数被真实传入，
 * 部分输出按序转发到 `AgentLoopConfig.onToolUpdate`（串行/并行两条路径），
 * 回调异常不中断工具；未配置回调时工具拿到 undefined（不给假通道）。
 */

import { describe, it, expect } from 'vitest';
import { agentLoop } from '@octopi-agent/core/loop/agent-loop.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentTool,
} from '@octopi-agent/core/loop/types.js';
import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';

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
    getModelInfos: () => [],
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
    async isAvailable() {
      return true;
    },
  };
}

/** 流式工具：调用 onUpdate 两次后返回定形结果 */
function streamingTool(
  onExecute?: (gotUpdater: boolean) => void,
  updateImpl?: (partial: { content?: unknown }) => void,
): AgentTool {
  return {
    name: 'streamer',
    description: 'streams partial output',
    execute: async (id, _args, _signal, onUpdate) => {
      onExecute?.(typeof onUpdate === 'function');
      const emit = updateImpl ?? onUpdate;
      emit?.({ content: 'partial-1' });
      emit?.({ content: 'partial-2' });
      return { toolCallId: id, name: 'streamer', content: 'final' };
    },
  };
}

function toolCallThenFinal(): [LLMResponse, LLMResponse] {
  return [
    {
      content: '',
      toolCalls: [{ id: 'c1', name: 'streamer', arguments: {} }],
      model: 'test',
      finishReason: 'tool_calls',
    },
    { content: 'ok', model: 'test', finishReason: 'stop' },
  ];
}

async function runLoop(context: AgentContext, config: AgentLoopConfig): Promise<void> {
  for await (const _e of agentLoop(context, config)) {
    // drain
  }
}

describe('工具部分输出通道（AgentTool.execute onUpdate）', () => {
  for (const toolExecution of ['sequential', 'parallel'] as const) {
    it(`${toolExecution} 路径：onUpdate 按序转发到 onToolUpdate（带 toolCall 身份）`, async () => {
      const received: Array<{ toolCallId: string; content: unknown }> = [];
      const [first, second] = toolCallThenFinal();
      const provider = createProvider([first, second]);
      const context: AgentContext = {
        systemPrompt: '',
        messages: [userMsg('hi')],
        tools: [streamingTool()],
      };

      await runLoop(context, {
        model: provider,
        toolExecution,
        onToolUpdate: ({ toolCall, partial }) => {
          received.push({ toolCallId: toolCall.id, content: partial.content });
        },
      });

      expect(received).toEqual([
        { toolCallId: 'c1', content: 'partial-1' },
        { toolCallId: 'c1', content: 'partial-2' },
      ]);
      // 定形结果不受部分输出影响
      const toolMsg = context.messages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
    });
  }

  it('未配置 onToolUpdate 时 execute 收到 undefined（不给假通道）', async () => {
    let gotUpdater: boolean | undefined;
    const [first, second] = toolCallThenFinal();
    const provider = createProvider([first, second]);
    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('hi')],
      tools: [
        streamingTool((has) => {
          gotUpdater = has;
        }),
      ],
    };

    await runLoop(context, { model: provider });

    expect(gotUpdater).toBe(false);
  });

  it('onToolUpdate 抛异常不中断工具执行', async () => {
    const [first, second] = toolCallThenFinal();
    const provider = createProvider([first, second]);
    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('hi')],
      tools: [streamingTool()],
    };

    await runLoop(context, {
      model: provider,
      onToolUpdate: () => {
        throw new Error('display channel exploded');
      },
    });

    const toolMsg = context.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolResults?.[0]?.result).toBe('final');
  });
});
