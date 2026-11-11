/**
 * OP-TOOL-1：降级标记拒收（执行边界统一设防）
 *
 * 事故形态：上下文老化产生的降级标记（`…[N chars]` 等）被当作真实工具参数执行——
 * file_edit 把标记写进文件、git_commit 用标记当提交信息、shell 把标记当命令执行。
 *
 * 防线契约：
 * 1. 检测器（core/elision.findElisionMarkers）识别新旧全词汇的降级标记；
 * 2. Loop 在派发前对最终参数统一扫描，命中即 fail-loud 拒绝执行（不挑工具）；
 * 3. 正文中「提及」标记的合法内容（讨论本缺陷的文档/测试）不得被误拒。
 */

import { describe, it, expect } from 'vitest';
import { agentLoop } from '@octopi-agent/core/loop/agent-loop.js';
import {
  ELIDED_MARK,
  TRUNCATED_MARK,
  describeElisionHits,
  elidedCharsMarker,
  elidedCommandTail,
  findElisionMarkers,
} from '@octopi-agent/core/elision.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopEvent,
  AgentTool,
} from '@octopi-agent/core/loop/types.js';
import type {
  LLMResponse,
  LLMStreamChunk,
  ModelProvider,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';

describe('findElisionMarkers — 旧词汇（存量污染形态）', () => {
  it('整值旧标记：…[N chars]', () => {
    const hits = findElisionMarkers({ new_text: '…[183 chars]' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'arguments.new_text', form: 'whole' });
  });

  it('命令尾旧标记：head…[+N chars]', () => {
    const command = "cd /repo && sed -n '2010,2040p' packages/engine/src/harness/context/default-cont…[+30 chars]";
    const hits = findElisionMarkers({ command });
    expect(hits).toHaveLength(1);
    expect(hits[0].form).toBe('suffix');
  });

  it('旧轮廓族：…[truncated] / …[truncated: N chars omitted] / …[preview omitted] / [... truncated]', () => {
    for (const v of ['…[truncated]', '…[truncated: 12 chars omitted]', '…[preview omitted]', '[... truncated]', '[truncated JSON] {"a":1}']) {
      expect(findElisionMarkers({ v }), v).toHaveLength(1);
    }
  });

  it('B1：尾随空白不得绕过 suffix 拒收（评审 B1 回归）', () => {
    for (const v of [
      `head…[+30 chars]\n`,
      'head[octopi:elided +30 chars] ',
      `head[octopi:elided 5 chars]\r\n`,
    ]) {
      const hits = findElisionMarkers({ command: v });
      expect(hits, JSON.stringify(v)).toHaveLength(1);
      expect(hits[0].form).toBe('suffix');
    }
  });

  it('旧客户端形态：…[N chars, assetId=…]', () => {
    const hits = findElisionMarkers({ html: '…[65540 chars, assetId=a1]' });
    expect(hits).toHaveLength(1);
    expect(hits[0].form).toBe('whole');
  });
});

describe('findElisionMarkers — 当前词汇（octopi: 命名空间）', () => {
  it('生成端产物恰好被检测端识别（双向一致）', () => {
    for (const v of [
      elidedCharsMarker(183),
      elidedCharsMarker(65_540, 'assetId=a1'),
      elidedCommandTail(30),
      TRUNCATED_MARK,
      ELIDED_MARK,
    ]) {
      expect(findElisionMarkers({ v }), v).toHaveLength(1);
    }
  });

  it('命令头 + 当前尾标记按 suffix 命中', () => {
    const hits = findElisionMarkers({ command: `cd /repo && ${'x'.repeat(100)}${elidedCommandTail(30)}` });
    expect(hits[0].form).toBe('suffix');
  });

  it('结构性降级兜底对象（_aged 键）按 structure 命中', () => {
    const hits = findElisionMarkers({ args: { _aged: 'shell arguments elided', outline: 'head…' } });
    expect(hits).toHaveLength(1);
    expect(hits[0].form).toBe('structure');
  });
});

describe('findElisionMarkers — 前缀形降级载体', () => {
  it('老化结果指针整段命中', () => {
    const hits = findElisionMarkers({
      note: '[aged tool result · pointer] tool: shell; args: …; full output kept in session log',
    });
    expect(hits).toHaveLength(1);
  });

  it('摘要截断告知与压缩机械占位命中', () => {
    for (const v of [
      '[truncated: showing first 10 of 900 chars] (hint)',
      '[truncated input for summary] some text',
      '[Context truncated: 3 earlier entries replaced by a tool-call ledger to fit context window]',
    ]) {
      expect(findElisionMarkers({ v }), v).toHaveLength(1);
    }
  });
});

describe('findElisionMarkers — 不误伤合法内容', () => {
  it('正文中提及标记（中间位置）不拒收', () => {
    const hits = findElisionMarkers({
      new_text: '修复后占位符形态由 `…[N chars]` 变为 `[octopi:elided N chars]`，见 OP-TOOL-1。',
    });
    expect(hits).toHaveLength(0);
  });

  it('省略号 + 方括号的普通内容不拒收', () => {
    const hits = findElisionMarkers({ description: 'ratio 夹取边界…[0.25, 4.0]' });
    expect(hits).toHaveLength(0);
  });

  it('普通参数与嵌套结构无命中；嵌套命中带路径', () => {
    expect(findElisionMarkers({ command: 'npm test', purpose: 'run' })).toHaveLength(0);
    const hits = findElisionMarkers({ steps: ['写基线', '…[217 chars]'] });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('arguments.steps[1]');
  });

  it('错误文案包含路径、标记与自愈指引', () => {
    const text = describeElisionHits(findElisionMarkers({ new_text: '…[183 chars]' }));
    expect(text).toContain('arguments.new_text');
    expect(text).toContain('never be executed');
    expect(text).toContain('Re-derive the full value');
  });
});

// ── Loop 行为：派发前统一拒收 ──

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

/** 记录 execute 是否被调用的探针工具 */
function probeTool(executed: string[]): AgentTool {
  return {
    name: 'probe',
    description: 'probe',
    execute: async (id, args) => {
      executed.push(JSON.stringify(args));
      return { toolCallId: id, name: 'probe', content: 'executed' };
    },
  };
}

function toolCallResponse(args: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id: 'c1', name: 'probe', arguments: args }],
    model: 'test',
    finishReason: 'tool_calls',
  };
}

const FINAL: LLMResponse = { content: 'done', model: 'test', finishReason: 'stop' };

async function runOnce(responses: LLMResponse[], executed: string[]): Promise<AgentLoopEvent[]> {
  const messages: Message[] = [{ role: 'user', content: 'go', timestamp: 1 }];
  const context: AgentContext = { systemPrompt: '', messages, tools: [probeTool(executed)] };
  const config: AgentLoopConfig = {
    model: createProvider(responses),
    modelCallIdleTimeoutMs: 5_000,
    modelCallAbsoluteTimeoutMs: 10_000,
  };
  const events: AgentLoopEvent[] = [];
  for await (const e of agentLoop(context, config)) events.push(e);
  return events;
}

describe('Loop 降级标记拒收（fail-loud，不挑工具）', () => {
  it('整值旧标记参数：不执行、错误结果、循环可继续', async () => {
    const executed: string[] = [];
    const events = await runOnce(
      [toolCallResponse({ new_text: '…[183 chars]', old_text: 'x' }), FINAL],
      executed,
    );
    expect(executed).toHaveLength(0);
    const err = events.find((e) => e.type === 'tool_end' && e.result.isError);
    expect(err).toBeDefined();
    // 模型可自愈：错误文案含回源重构指引
    const toolEvent = events.find(
      (e): e is Extract<AgentLoopEvent, { type: 'tool_end' }> => e.type === 'tool_end',
    );
    expect(String(toolEvent?.result.content)).toContain('Re-derive the full value');
    // 循环继续并正常收尾
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
  });

  it('命令尾标记参数：不执行', async () => {
    const executed: string[] = [];
    await runOnce(
      [
        toolCallResponse({
          command: `cd /repo && sed -n '1,2p' ${'x'.repeat(90)}${elidedCommandTail(30)}`,
        }),
        FINAL,
      ],
      executed,
    );
    expect(executed).toHaveLength(0);
  });

  it('合法长参数照常执行；正文中提及标记不误拒', async () => {
    const executed: string[] = [];
    await runOnce(
      [
        toolCallResponse({
          new_text: `修复后占位符形态由 \`…[N chars]\` 变为 \`[octopi:elided N chars]\`。${'长'.repeat(500)}`,
        }),
        FINAL,
      ],
      executed,
    );
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('octopi:elided N chars');
  });

  it('变换后注入的标记同样被拦（守卫在 prepareArguments 之后）', async () => {
    const executed: string[] = [];
    const tool: AgentTool = {
      name: 'probe',
      description: 'probe',
      prepareArguments: () => ({ command: `head…[+30 chars]` }),
      execute: async (id, args) => {
        executed.push(JSON.stringify(args));
        return { toolCallId: id, name: 'probe', content: 'executed' };
      },
    };
    const messages: Message[] = [{ role: 'user', content: 'go', timestamp: 1 }];
    const context: AgentContext = { systemPrompt: '', messages, tools: [tool] };
    const config: AgentLoopConfig = {
      model: createProvider([toolCallResponse({ command: 'ls -la' }), FINAL]),
      modelCallIdleTimeoutMs: 5_000,
      modelCallAbsoluteTimeoutMs: 10_000,
    };
    const events: AgentLoopEvent[] = [];
    for await (const e of agentLoop(context, config)) events.push(e);
    expect(executed).toHaveLength(0);
    expect(
      events.find((e) => e.type === 'tool_end' && e.result.isError),
    ).toBeDefined();
  });

  it('结构性降级对象（_aged 兜底）在 loop 层同样被拒', async () => {
    const executed: string[] = [];
    const events = await runOnce(
      [
        toolCallResponse({ args: { _aged: 'probe arguments elided', outline: 'head…' } } as never),
        FINAL,
      ],
      executed,
    );
    expect(executed).toHaveLength(0);
    expect(events.find((e) => e.type === 'tool_end' && e.result.isError)).toBeDefined();
  });

  it('同批混合：污染调用被拒、干净调用照常执行（并行路径）', async () => {
    const executed: string[] = [];
    const messages: Message[] = [{ role: 'user', content: 'go', timestamp: 1 }];
    const context: AgentContext = { systemPrompt: '', messages, tools: [probeTool(executed)] };
    const config: AgentLoopConfig = {
      model: createProvider([
        {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'probe', arguments: { note: '…[900 chars]' } },
            { id: 'c2', name: 'probe', arguments: { note: 'clean value' } },
          ],
          model: 'test',
          finishReason: 'tool_calls',
        },
        FINAL,
      ]),
      modelCallIdleTimeoutMs: 5_000,
      modelCallAbsoluteTimeoutMs: 10_000,
    };
    const events: AgentLoopEvent[] = [];
    for await (const e of agentLoop(context, config)) events.push(e);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('clean value');
    const ends = events.filter((e) => e.type === 'tool_end');
    expect(ends).toHaveLength(2);
    expect(ends.filter((e) => e.type === 'tool_end' && e.result.isError)).toHaveLength(1);
  });
});
