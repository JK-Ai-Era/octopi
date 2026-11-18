/**
 * cognition.steward.conceptualize handler — contextSlice 回补 / 语境门控前置
 *
 * 回归背景：contextSlice 无生产者时 170 次运行 100% 被 admit 门以
 * no_context_slice 打回，且 LLM 调用发生在门控之前（白烧）。
 */

import { describe, it, expect } from 'vitest';
import conceptualizeHandler from '@octopi-agent/engine/subsystems/cognition-steward/conceptualize/handler.js';
import { InMemoryConceptGraph } from '@octopi-agent/engine/harness/memory/cognition.js';
import {
  DEP_LLM_PORT,
  type SubsystemLLMPort,
  type SubsystemLLMPortChatRequest,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/think/llm-port.js';

// handler 的注入键（与 config.yaml runtimeInject.requires 对齐）
const DEP_CONCEPT_GRAPH_KEY = 'conceptGraphStore';
const DEP_SESSION_STORE_KEY = 'sessionStore';

const CONCEPT_JSON = JSON.stringify({
  nodes: [
    {
      name: '会话租约',
      kind: 'construct',
      description: 'sessionId 级互斥租约',
      domain: ['session'],
    },
  ],
  edges: [],
  rejected: [],
});

function mockLlm(content: string, requests: SubsystemLLMPortChatRequest[] = []): SubsystemLLMPort {
  return {
    cognitivePrompt: '',
    defaultModel: 'mini',
    providerName: 'mock',
    resolved: { primary: { model: 'mini' }, fallback: [] },
    chat: async (request: SubsystemLLMPortChatRequest) => {
      requests.push(request);
      return { content, model: 'mini', finishReason: 'stop' };
    },
  } as unknown as SubsystemLLMPort;
}

function userText(request: SubsystemLLMPortChatRequest): string {
  return String((request.messages[0] as { content?: unknown })?.content ?? '');
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    memoryId: 'mem-1',
    proposition: '会话租约是 sessionId 级互斥',
    evidence: '拍板原话',
    memoryType: 'method',
    ...overrides,
  };
}

describe('conceptualize handler contextSlice', () => {
  it('payload 自带 contextSlice 时直接采用并成功入库', async () => {
    const requests: SubsystemLLMPortChatRequest[] = [];
    const store = new InMemoryConceptGraph();
    const out = await conceptualizeHandler(
      { payload: basePayload({ contextSlice: '[user] 咱们用 sessionId 租约' }) },
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_LLM_PORT]: mockLlm(CONCEPT_JSON, requests),
      },
    );
    expect(requests).toHaveLength(1);
    expect(userText(requests[0])).toContain('contextSlice: [user] 咱们用 sessionId 租约');
    expect(out.act?.status).toBe('success');
    const graph = await store.getFullGraph();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].name).toBe('会话租约');
  });

  it('缺 contextSlice 时从 sessionStore 回补 ±N 窗口', async () => {
    const requests: SubsystemLLMPortChatRequest[] = [];
    const store = new InMemoryConceptGraph();
    const sessionStore = {
      load: async () => ({
        messages: [
          { role: 'user', content: '前置议题甲甲甲甲甲甲甲甲' },
          { role: 'assistant', content: '我们拍板：会话租约用 sessionId 级互斥锁实现' },
          { role: 'user', content: '后置议题乙乙乙乙乙乙乙乙' },
          { role: 'assistant', content: '远端消息丙丙丙丙丙丙丙丙' },
        ],
      }),
    };
    const out = await conceptualizeHandler(
      {
        payload: basePayload({
          evidence: '拍板原话：「会话租约用 sessionId 级互斥锁实现…」',
          sessionId: 'sess-1',
        }),
      },
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_SESSION_STORE_KEY]: sessionStore,
        [DEP_LLM_PORT]: mockLlm(CONCEPT_JSON, requests),
        __subsystem_config__: { contextWindowMessages: 1 },
      },
    );
    expect(requests).toHaveLength(1);
    const text = userText(requests[0]);
    expect(text).toContain('[user] 前置议题甲甲甲甲甲甲甲甲');
    expect(text).toContain('[assistant] 我们拍板：会话租约用 sessionId 级互斥锁实现');
    expect(text).toContain('[user] 后置议题乙乙乙乙乙乙乙乙');
    expect(text).not.toContain('远端消息丙丙丙丙丙丙丙丙');
    expect(out.act?.status).toBe('success');
  });

  it('无锚点时显式失败 no_context_slice 且不烧 LLM', async () => {
    const requests: SubsystemLLMPortChatRequest[] = [];
    const store = new InMemoryConceptGraph();
    const sessionStore = {
      load: async () => ({
        messages: [{ role: 'user', content: '完全无关的会话内容' }],
      }),
    };
    const out = await conceptualizeHandler(
      { payload: basePayload({ evidence: '另一处的原话片段足够长', sessionId: 'sess-2' }) },
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_SESSION_STORE_KEY]: sessionStore,
        [DEP_LLM_PORT]: mockLlm(CONCEPT_JSON, requests),
      },
    );
    expect(requests).toHaveLength(0);
    expect(out.act?.status).toBe('failed');
    expect(JSON.stringify(out)).toContain('no_context_slice');
    const graph = await store.getFullGraph();
    expect(graph.nodes).toHaveLength(0);
  });

  it('sessionStore 缺失是装配故障：throw 且不烧 LLM', async () => {
    const requests: SubsystemLLMPortChatRequest[] = [];
    const store = new InMemoryConceptGraph();
    await expect(
      conceptualizeHandler(
        { payload: basePayload({ sessionId: 'sess-3' }) },
        {
          [DEP_CONCEPT_GRAPH_KEY]: store,
          [DEP_LLM_PORT]: mockLlm(CONCEPT_JSON, requests),
        },
      ),
    ).rejects.toThrow(/sessionStore not injected/);
    expect(requests).toHaveLength(0);
  });

  it('session load 抛错转显式 session_load_failed 且不烧 LLM', async () => {
    const requests: SubsystemLLMPortChatRequest[] = [];
    const store = new InMemoryConceptGraph();
    const sessionStore = {
      load: async () => {
        throw new Error('disk gone');
      },
    };
    const out = await conceptualizeHandler(
      { payload: basePayload({ sessionId: 'sess-4' }) },
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_SESSION_STORE_KEY]: sessionStore,
        [DEP_LLM_PORT]: mockLlm(CONCEPT_JSON, requests),
      },
    );
    expect(requests).toHaveLength(0);
    expect(out.act?.status).toBe('failed');
    expect(JSON.stringify(out)).toContain('session_load_failed');
    expect(JSON.stringify(out)).toContain('disk gone');
  });

  it('session 不存在归 no_context_slice（数据层缺语境）', async () => {
    const requests: SubsystemLLMPortChatRequest[] = [];
    const store = new InMemoryConceptGraph();
    const sessionStore = { load: async () => null };
    const out = await conceptualizeHandler(
      { payload: basePayload({ sessionId: 'sess-5' }) },
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_SESSION_STORE_KEY]: sessionStore,
        [DEP_LLM_PORT]: mockLlm(CONCEPT_JSON, requests),
      },
    );
    expect(requests).toHaveLength(0);
    expect(out.act?.status).toBe('failed');
    expect(JSON.stringify(out)).toContain('no_context_slice');
  });

  it('无 sessionId 时无法回补，归 no_context_slice 且不烧 LLM', async () => {
    const requests: SubsystemLLMPortChatRequest[] = [];
    const store = new InMemoryConceptGraph();
    const out = await conceptualizeHandler(
      { payload: basePayload() },
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_LLM_PORT]: mockLlm(CONCEPT_JSON, requests),
      },
    );
    expect(requests).toHaveLength(0);
    expect(out.act?.status).toBe('failed');
    expect(JSON.stringify(out)).toContain('no_context_slice');
  });

  it('payload.contextSlice 非字符串时不被采信', async () => {
    const requests: SubsystemLLMPortChatRequest[] = [];
    const store = new InMemoryConceptGraph();
    const sessionStore = {
      load: async () => ({ messages: [{ role: 'user', content: '无关会话内容啊' }] }),
    };
    const out = await conceptualizeHandler(
      { payload: basePayload({ contextSlice: { evil: true }, sessionId: 'sess-6' }) },
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_SESSION_STORE_KEY]: sessionStore,
        [DEP_LLM_PORT]: mockLlm(CONCEPT_JSON, requests),
      },
    );
    expect(requests).toHaveLength(0);
    expect(out.act?.status).toBe('failed');
    expect(JSON.stringify(out)).not.toContain('[object Object]');
    expect(JSON.stringify(out)).toContain('no_context_slice');
  });
});
