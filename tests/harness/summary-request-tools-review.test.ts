/**
 * 评审补钉（2026-11-12，del-e7d5670b）——覆盖首轮修复漏掉的三处：
 *
 * 1. MAJ-1：textify 旁路不得携带工具面（system 指令不同 → 缓存必 miss，带 tools 是纯
 *    成本，还会把旁路自己顶成 window_exhausted）。
 * 2. MAJ-3：manual 压缩的工具面必须过与 run 同一个漏斗（agentToolPolicy ∩ session ACL），
 *    否则摘要面是主请求面的超集，前缀照样从第一字节断开。
 * 3. MAJ-2 / MIN-3：摘要输出撞 max_tokens 或冒出 tool_call 时必须 fail loud，
 *    禁止把半截交接书当成功（静默失忆红线）。
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';
import { createCompactEngine } from '@octopi-agent/engine/harness/context/capabilities/compact/index.js';
import { createProviderSummarize } from '@octopi-agent/engine/harness/context/summarize.js';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

const TOOLS: LLMToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

/** 摘要正文足够长——避免命中「空白摘要」以外的其他守卫 */
const SUMMARY = '1. Goal & status: ok.\n2. Open items: none.\n3. Conclusions: n/a.\n4. Evidence: none.';

describe('textify 旁路不带工具面（评审 MAJ-1）', () => {
  it('无 llmPrefix → 走 textify：summarizeFn 不得收到 tools/toolChoice', async () => {
    const engine = createCompactEngine();
    let seen: { tools?: LLMToolDefinition[]; toolChoice?: string } | undefined;

    await engine.compactMessages([userMsg('a'), userMsg('b')], {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      targetTokens: 50,
      // 只给工具面、没有前缀消息 → 旁路分支（requestView.messages 为空）
      requestView: { messages: [], tools: TOOLS },
      summarizeFn: async (_msgs, opts) => {
        seen = opts;
        return SUMMARY;
      },
    });

    expect(seen?.tools).toBeUndefined();
    expect(seen?.toolChoice).toBeUndefined();
  });
});

describe('manual 工具面与 run 同漏斗（评审 MAJ-3）', () => {
  function session(id: string, agentId = 'a1'): SessionData {
    return {
      id,
      agentId,
      primaryAgentId: agentId,
      meta: {
        id,
        agentId,
        channelId: 'web',
        peerId: 'ui',
        status: 'idle',
        createdAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        updatedAt: Date.now(),
      },
      messages: [],
      steps: [],
      metadata: {},
    } as SessionData;
  }

  function agentWithTools(names: string[]): Agent {
    const tools = names.map((name) => ({
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {} },
      source: 'builtin',
      handler: async () => ({}),
    }));
    return {
      context: { systemPrompt: '', messages: [], tools },
      tools,
      toolsForSession: () => tools,
      setSystemPrompt: () => {},
      setSessionCompactState: () => {},
      getSessionCompactState: () => undefined,
      setOnAfterStep: () => {},
      notifyAfterStep: async () => {},
    } as unknown as Agent;
  }

  it('无收窄时：工具面顺序与会话可见面一致', async () => {
    const store = new InMemorySessionStore();
    await store.save('s-face', session('s-face'));
    const runner = new SessionAwareRunner(agentWithTools(['file_read', 'shell']), {} as never, store);

    const tools = await runner.resolveSessionLlmTools('s-face', 'a1');
    expect(tools.map((t) => t.function.name)).toEqual(['file_read', 'shell']);
    expect(tools[0]!.type).toBe('function');
  });

  it('agentToolPolicy deny 时工具面随之收窄（不得是主请求面的超集）', async () => {
    const store = new InMemorySessionStore();
    await store.save('s-policy', session('s-policy'));
    const runner = new SessionAwareRunner(agentWithTools(['file_read', 'shell']), {} as never, store, {
      // 只读 agent：禁用 shell
      agentToolPolicy: { deny: ['shell'] },
    } as never);

    const tools = await runner.resolveSessionLlmTools('s-policy', 'a1');
    expect(tools.map((t) => t.function.name)).toEqual(['file_read']);
  });
});

describe('摘要输出诚实性（评审 MAJ-2 / MIN-3）', () => {
  function providerReturning(finishReason: 'stop' | 'length' | 'error' | 'tool_calls', toolCalls?: unknown[]) {
    return {
      name: 'stub',
      models: ['m'],
      defaultModel: 'm',
      chat: async () => ({
        content: SUMMARY,
        model: 'm',
        finishReason,
        ...(toolCalls ? { toolCalls } : {}),
      }),
      stream: async function* () {},
      isAvailable: async () => true,
    } as unknown as Parameters<typeof createProviderSummarize>[0];
  }

  it('finishReason:length → 抛 summarize_output_truncated（禁止半截交接书）', async () => {
    const summarize = createProviderSummarize(providerReturning('length'));
    await expect(summarize([{ role: 'user', content: 'x' } as LLMMessage], {})).rejects.toThrow(
      /summarize_output_truncated/,
    );
  });

  it('意外 tool_call → 抛 summarize_tool_call_emitted（toolChoice:none 是约束不是保证）', async () => {
    const summarize = createProviderSummarize(
      providerReturning('tool_calls', [{ id: 'c1', name: 'shell', arguments: '{}' }]),
    );
    await expect(
      summarize([{ role: 'user', content: 'x' } as LLMMessage], { tools: TOOLS, toolChoice: 'none' }),
    ).rejects.toThrow(/summarize_tool_call_emitted/);
  });

  it('正常 stop → 返回正文并回传 usage', async () => {
    let outputTokens: number | undefined;
    const summarize = createProviderSummarize(providerReturning('stop'));
    const text = await summarize([{ role: 'user', content: 'x' } as LLMMessage], {
      onUsage: (u) => {
        outputTokens = u.outputTokens;
      },
    });
    expect(text).toBe(SUMMARY);
    // 无 usage 时不伪造
    expect(outputTokens).toBeUndefined();
  });
});
