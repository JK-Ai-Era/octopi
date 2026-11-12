/**
 * 契约护栏钉（评审 del-b5ffc13a 补钉）
 *
 * 评审指出的绿区漏洞：把 `builder` 的 `tools: requestTools` 改成 `tools: []`、
 * 或把 compact 的 `requestView` 改回可选拆分参数，全部测试仍然通过。
 * 这里补两条**穿过 AgentBuilder / 跨边界**的断言，让那两类回归立刻变红。
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { withRunScope } from '@octopi-agent/engine/harness/run/run-scope.js';
import { createCompactEngine } from '@octopi-agent/engine/harness/context/capabilities/compact/index.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

const TOOLS: LLMToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
];

/** 记录 wire 请求的 provider（callModel 走 stream） */
function recordingProvider() {
  const seen: Array<{ messages: LLMMessage[]; tools: LLMToolDefinition[] }> = [];
  return {
    seen,
    provider: {
      name: 'recording',
      models: ['m'],
      defaultModel: 'm',
      chat: async () => ({ content: 'ok', model: 'm', finishReason: 'stop' as const }),
      stream: async function* (req: { messages: LLMMessage[]; tools?: LLMToolDefinition[] }) {
        seen.push({ messages: req.messages, tools: req.tools ?? [] });
        yield { type: 'content' as const, content: 'ok' };
        yield { type: 'done' as const, finishReason: 'stop' as const, model: 'm' };
      },
      isAvailable: async () => true,
    },
  };
}

describe('MAJ-1：引擎返回空工具面不得静默吞掉工具能力', () => {
  it('注册了工具而装配返回 tools: [] → 显式告警', async () => {
    const { provider } = recordingProvider();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const builder = new AgentBuilder().model(provider as never);
    builder.tools({
      definition: {
        name: 'file_read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
      },
      handler: async () => ({ content: 'x' }),
    } as never);
    // 只改一半迁移的引擎：消息照给，工具面留空
    builder.contextEngine({
      info: { id: 'half-migrated', name: 'half-migrated' },
      assemble: async (params: never) => ({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        estimatedTokens: 1,
        systemPrompt: (params as { systemPrompt: string }).systemPrompt,
      }),
    });

    const { agent } = await builder.buildAgent();
    // 工具面权威在 RunScope（实例面不参与 run 估算口径）；无 scope 时装配面本就是空，
    // 因此必须在 run 作用域里触发守卫。
    const registered = [
      { name: 'file_read', description: 'Read a file', parameters: { type: 'object', properties: {} } } as never,
    ];
    await withRunScope(
      { sessionId: 's-guard', agentId: 'default', runId: 'r-guard', tools: registered } as never,
      (async function* () {
        yield await agent.config.convertToLlm!([userMsg('hi')]);
      })(),
    ).next();

    const warned = warn.mock.calls.some((c) => String(c[0]).includes('empty tool face'));
    warn.mockRestore();
    expect(warned).toBe(true);
  });
});

describe('MIN-3：compact 边界只收原子视图（拆成两半在类型层不成立）', () => {
  it('requestView.tools 与 requestView.messages 同源透传', async () => {
    const engine = createCompactEngine();
    let seen: { tools?: LLMToolDefinition[]; messages?: LLMMessage[] } = {};
    const view = {
      messages: [
        { role: 'system' as const, content: 'SYS' },
        { role: 'user' as const, content: 'q1' },
      ],
      tools: TOOLS,
    };

    await engine.compactMessages([userMsg('q1')], {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      targetTokens: 50,
      requestView: view,
      summarizeFn: async (msgs, opts) => {
        seen = { messages: msgs, tools: opts?.tools };
        return '1. Goal & status: ok.\n2. Open items: none.\n3. Conclusions: n/a.\n4. Evidence: none.';
      },
    });

    // 前缀逐条字节不变（缓存同形），工具面同实例
    expect(seen.messages!.slice(0, view.messages.length)).toEqual(view.messages);
    expect(seen.tools).toBe(TOOLS);
  });
});
