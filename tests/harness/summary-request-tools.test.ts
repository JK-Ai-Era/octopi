/**
 * 摘要请求的**工具面同形**（2026-11-12 事故锚）。
 *
 * 事故形态（生产实测）：会话主请求 384,259 input tokens，其中 383,488 命中前缀缓存；
 * 摘要请求发出 203s 后才返回，usage 为 cached 0 / uncached 375,771——前缀缓存整段失效。
 * 根因：提示缓存的前缀顺序是 **tools → system → messages**，摘要请求只对齐了
 * system+history，没有带 tools，前缀从第一字节就断开。
 *
 * 红线：
 * 1. 摘要请求必须带与会话请求**同一实例**的工具面（core `buildToolDefinitions` 产出），
 *    引擎不得裁剪/重排/二次加工；
 * 2. **不发 `toolChoice`**（2026-11-13 实测修正，推翻本条原先的 'none' 要求）：
 *    'none' 并非对所有 provider 中性的标记——DeepSeek 系收到它会把 tools 整个从 prompt
 *    渲染中剔除（实测 8117 → 6286 tokens），落入「无工具面」的另一缓存空间，与会话前缀
 *    零重叠（实测 cached 10,624 / 290,700 = 3.7%）。禁止 tool_call 改由摘要指令 +
 *    `summarize_tool_call_emitted` fail-loud 守卫承担；
 * 3. 不提供工具面时不编造 tools（缺省 = 不发送，窗口钳制相应不含工具成本）。
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';
import { buildToolDefinitions } from '@octopi-agent/core/loop/agent-loop.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type { SummarizeFunction } from '@octopi-agent/engine/harness/context/types.js';
import { createCompactEngine } from '@octopi-agent/engine/harness/context/capabilities/compact/index.js';
import { AnthropicProvider } from '@octopi-agent/engine/integration/providers/anthropic.js';
import { OpenAIProvider } from '@octopi-agent/engine/integration/providers/openai.js';

const TOOLS: LLMToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function msgs(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
    content: `message ${i} ${'x'.repeat(40)}`,
    timestamp: Date.now() + i,
  }));
}

const PREFIX: LLMMessage[] = [
  { role: 'system', content: 'SESSION-SYS-EXACT' },
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'q2' },
];

describe('摘要请求工具面同形（前缀缓存红线）', () => {
  it('llmTools 原样透传给 summarizeFn，且不带 toolChoice（provider 会按它重排前缀）', async () => {
    const engine = createCompactEngine();
    let seenTools: LLMToolDefinition[] | undefined;
    let seenOpts: Record<string, unknown> | undefined;
    let captured: LLMMessage[] = [];

    await engine.compactMessages([userMsg('q1'), userMsg('q2')], {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      targetTokens: 50,
      requestView: { messages: PREFIX, tools: TOOLS },
      summarizeFn: async (msgsIn, opts) => {
        captured = msgsIn;
        seenTools = opts?.tools;
        seenOpts = opts as Record<string, unknown> | undefined;
        return '1. Goal & status: ok.\n2. Open items: none.\n3. Conclusions: n/a.\n4. Evidence: none.';
      },
    });

    // 同一实例（不复制、不重排）：字节相同才有缓存命中可言
    expect(seenTools).toBe(TOOLS);
    // 不带 toolChoice：'none' 在 DeepSeek 系会让服务端把 tools 剔出 prompt，
    // 落到「无工具面」的另一个缓存空间（2026-11-13 实测 3.7% 命中）。回归防线。
    expect(Object.keys(seenOpts ?? {})).not.toContain('toolChoice');
    // 指令仍只挂尾部，前缀不动
    expect(captured.slice(0, PREFIX.length)).toEqual(PREFIX);
    expect(captured.length).toBe(PREFIX.length + 1);
  });

  it('未提供 llmTools 时不编造工具面、也不带 toolChoice', async () => {
    const engine = createCompactEngine();
    let seen: Record<string, unknown> | undefined;

    await engine.compactMessages([userMsg('q1'), userMsg('q2')], {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      targetTokens: 50,
      requestView: { messages: PREFIX, tools: [] },
      summarizeFn: async (_msgs, opts) => {
        seen = opts as Record<string, unknown> | undefined;
        return '1. Goal & status: ok.\n2. Open items: none.\n3. Conclusions: n/a.\n4. Evidence: none.';
      },
    });

    expect(seen?.tools).toBeUndefined();
    expect(seen?.toolChoice).toBeUndefined();
  });

  it('接线锚：proactive 路径把 assemble 收到的工具面原样带到摘要请求（事故复现防线）', async () => {
    let seenTools: LLMToolDefinition[] | undefined;
    let seenOpts: Record<string, unknown> | undefined;
    const summarize: SummarizeFunction = async (_messages, opts) => {
      seenTools = opts?.tools;
      seenOpts = opts as Record<string, unknown> | undefined;
      return '1. Goal & status: ok.\n2. Open items: none.\n3. Conclusions: n/a.\n4. Evidence: none.';
    };
    const engine = new DefaultContextEngine({
      targetTokens: 50,
      proactiveCooldownMs: 0,
      protectFirstN: 2,
      protectLastN: 2,
    });

    await engine.assemble({
      sessionId: 'tools-chain',
      messages: msgs(30),
      systemPrompt: 'sys',
      // 与 loop 同一映射：assemble 收到什么，摘要请求就必须送什么（禁二次加工）
      tools: buildToolDefinitions([
        {
          name: 'file_read',
          description: 'Read a file',
          parameters: TOOLS[0]!.function.parameters,
          execute: async (toolCallId: string) => ({
            toolCallId,
            name: 'file_read',
            content: '',
          }),
        },
      ]),
      summarize,
    });

    expect(seenTools).toEqual([
      {
        type: 'function',
        function: {
          name: 'file_read',
          description: 'Read a file',
          parameters: TOOLS[0]!.function.parameters,
        },
      },
    ]);
    expect(Object.keys(seenOpts ?? {})).not.toContain('toolChoice');
  });

  it('Anthropic wire body：tools 保留，但不再发 tool_choice', () => {
    const provider = new AnthropicProvider({ apiKey: 'test', models: ['claude-sonnet-4-6'] });
    const body = provider.wireBodyFor(
      {
        messages: [{ role: 'user', content: 'summarize this' }],
        tools: TOOLS,
      },
      'chat',
    );
    expect((body.tools as unknown[]).length).toBe(2);
    // tool_choice:'none' 在部分 provider 会把 tools 剔出 prompt，前缀缓存零重叠。
    // 既不依赖它约束模型，就一律不发（Anthropic 侧本是中性的，也一并收口为单一形态）。
    expect(body.tool_choice).toBeUndefined();
  });

  it('OpenAI wire body：tools 保留，但不再发 tool_choice', () => {
    const provider = new OpenAIProvider({ apiKey: 'test', models: ['gpt-5-mini'] });
    const body = provider.wireBodyFor(
      {
        messages: [{ role: 'user', content: 'summarize this' }],
        tools: TOOLS,
      },
      'chat',
    );
    expect((body.tools as unknown[]).length).toBe(2);
    expect(body.tool_choice).toBeUndefined();
  });
});
