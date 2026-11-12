/**
 * 请求视图统一装配（P1，2026-11-12 拍板）
 *
 * 事故的结构性根因不是「某个字段漏了」，而是：会话请求与摘要请求各自拼装
 * 前缀的两半（messages 与 tools），而 `AssembleResult` 类型上只承诺 messages，
 * 于是「完整性」只能靠每个调用点的自觉。
 *
 * 本测试钉住三件事：
 * 1. `convertToLlm` 返回**请求视图**（messages + tools 同批），loop 用它而不是自推；
 * 2. 摘要前缀（proactive / manual）与同一装配出口产出，tools 与 messages 不会各走一路；
 * 3. 指纹能判定前缀同形，并指出差异来自 tools / system / messages 哪一项。
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';
import type { RequestView } from '@octopi-agent/core/loop/types.js';
import { buildToolDefinitions } from '@octopi-agent/core/loop/index.js';
import { agentLoop } from '@octopi-agent/core/loop/agent-loop.js';
import {
  fingerprintRequestView,
  diffPrefixFingerprint,
} from '@octopi-agent/engine/harness/context/prefix-fingerprint.js';

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

/** 最小 provider：记录 stream 收到的 tools（callModel 走 stream 路径） */
function recordingProvider() {
  const seen: Array<{ llmMessages: LLMMessage[]; tools: LLMToolDefinition[] }> = [];
  const provider = {
    name: 'recording',
    models: ['m'],
    defaultModel: 'm',
    chat: async () => ({ content: 'ok', model: 'm', finishReason: 'stop' as const }),
    stream: async function* (req: {
      messages: LLMMessage[];
      tools?: LLMToolDefinition[];
    }) {
      seen.push({ llmMessages: req.messages, tools: req.tools ?? [] });
      yield { type: 'content' as const, content: 'ok' };
      yield { type: 'done' as const, finishReason: 'stop' as const, model: 'm' };
    },
    isAvailable: async () => true,
  };
  return { provider, seen };
}

describe('RequestView：loop 消费装配产出的工具面（不再自推）', () => {
  it('convertToLlm 返回 RequestView 时，loop 发送的 tools 以它为准', async () => {
    const { provider, seen } = recordingProvider();
    const view: RequestView = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      tools: TOOLS,
    };

    for await (const event of agentLoop(
      { messages: [userMsg('hi')], tools: [] } as never,
      {
        model: provider as never,
        convertToLlm: async () => view,
        // context.tools 故意为空：loop 若自推就会发 0 个工具（正是本次要禁止的漂移）
      },
    )) {
      if (event.type === 'agent_end') break;
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]!.tools).toEqual(TOOLS);
    expect(seen[0]!.llmMessages[0]?.role).toBe('system');
  });

  it('convertToLlm 返回旧签名（数组）时回落到 context.tools（向后兼容）', async () => {
    const { provider, seen } = recordingProvider();
    const loopTools = [
      {
        name: 'file_read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        execute: async () => ({ content: 'x' }),
      },
    ];

    for await (const event of agentLoop(
      { messages: [userMsg('hi')], tools: loopTools } as never,
      {
        model: provider as never,
        convertToLlm: async () => [{ role: 'user', content: 'hi' }],
      },
    )) {
      if (event.type === 'agent_end') break;
    }

    expect(seen[0]!.tools).toEqual(buildToolDefinitions(loopTools as never));
  });
});

describe('前缀指纹：判定同形并指出差异项', () => {
  const base: RequestView = {
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ],
    tools: TOOLS,
  };

  it('同一视图（忽略尾部指令）指纹相同', () => {
    const withTail: RequestView = {
      messages: [...base.messages, { role: 'user', content: '请总结' }],
      tools: TOOLS,
    };
    const a = fingerprintRequestView(base);
    const b = fingerprintRequestView(withTail, { tailLength: 1 });
    expect(diffPrefixFingerprint(a, b)).toEqual([]);
  });

  it('只差 tools 时精确报 tools（2026-11-12 事故形状）', () => {
    const a = fingerprintRequestView(base);
    const b = fingerprintRequestView({ ...base, tools: [] });
    expect(diffPrefixFingerprint(a, b)).toEqual(['tools']);
  });

  it('只差 system 时报 system', () => {
    const a = fingerprintRequestView(base);
    const b = fingerprintRequestView({
      ...base,
      messages: [{ role: 'system', content: 'SYS2' }, ...base.messages.slice(1)],
    });
    expect(diffPrefixFingerprint(a, b)).toEqual(['system']);
  });

  it('只差 messages 时报 messages（tools/system 相同）', () => {
    const a = fingerprintRequestView(base);
    const b = fingerprintRequestView({
      ...base,
      messages: [...base.messages, { role: 'user', content: 'extra' }],
    });
    expect(diffPrefixFingerprint(a, b)).toEqual(['messages']);
  });

  it('尾部指令长度被正确剔除（tailLength 与实际追加条数一致）', () => {
    const withTail: RequestView = {
      messages: [...base.messages, { role: 'user', content: '请总结' }],
      tools: TOOLS,
    };
    expect(fingerprintRequestView(withTail, { tailLength: 1 }).prefixCount).toBe(3);
    expect(fingerprintRequestView(withTail).prefixCount).toBe(4);
  });
});
