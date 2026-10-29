/**
 * 内容过滤拒答韧性（content_filter）——签名识别、守卫包装、重试链路集成。
 *
 * 失效模式（2026-10-29 实测）：provider 内容安全层以 200 内联返回罐头拒答
 * 「The request was rejected because it was considered high risk」，reasoning 照常、
 * 正文被替换、finishReason=stop——成功面无感，拒答语会被当成助手回答。
 *
 * 钉住：① 签名精确识别；② guardRefusalProvider 把罐头拒答转成 content_filter
 * 模型错误（流式按前缀扣发，正常输出不受影响）；③ agentLoop 经 onError 重试后
 * 真实回答落历史、拒答语永不入历史；④ 摘要闸门把罐头拒答判为污染。
 */

import { describe, it, expect } from 'vitest';
import { agentLoop } from '@octopi-agent/core/loop/agent-loop.js';
import { classifyError } from '@octopi-agent/core/loop/error-classifier.js';
import {
  isCannedRefusalText,
  isCannedRefusalPrefix,
  ContentFilterError,
} from '@octopi-agent/core/loop/canned-refusal.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopEvent,
} from '@octopi-agent/core/loop/types.js';
import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';
import { guardRefusalProvider } from '@octopi-agent/engine/harness';
import { detectSummaryContamination } from '@octopi-agent/engine/harness';

const REFUSAL = 'The request was rejected because it was considered high risk';

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

const finalReply = (content: string): LLMResponse => ({
  content,
  model: 'test',
  finishReason: 'stop',
});

describe('罐头拒答签名识别', () => {
  it('整段恰为签名（含收尾标点/空白变体）判拒答', () => {
    expect(isCannedRefusalText(REFUSAL)).toBe(true);
    expect(isCannedRefusalText(`${REFUSAL}.`)).toBe(true);
    expect(isCannedRefusalText(`  ${REFUSAL}\n`)).toBe(true);
  });

  it('多说一句/少说一句/空文本都不算拒答', () => {
    expect(isCannedRefusalText(`${REFUSAL} Please contact support.`)).toBe(false);
    expect(isCannedRefusalText('The request was rejected')).toBe(false);
    expect(isCannedRefusalText('')).toBe(false);
    expect(isCannedRefusalText('   ')).toBe(false);
  });

  it('前缀判定：流式中途仍是签名开头时扣发', () => {
    expect(isCannedRefusalPrefix('The request was')).toBe(true);
    expect(isCannedRefusalPrefix('The requ')).toBe(true);
    expect(isCannedRefusalPrefix('The request was rejected because it was considered high risk')).toBe(true);
    expect(isCannedRefusalPrefix('The model said')).toBe(false);
    expect(isCannedRefusalPrefix('')).toBe(false);
  });
});

describe('classifyError 归类 content_filter', () => {
  it('ContentFilterError（含 name 派生）→ content_filter', () => {
    expect(classifyError(new ContentFilterError(REFUSAL)).reason).toBe('content_filter');
    const renamed = new Error(`x: ${REFUSAL}`);
    renamed.name = 'ContentFilterError';
    expect(classifyError(renamed).reason).toBe('content_filter');
  });

  it('错误消息恰为罐头拒答原文 → content_filter（包装丢 name 也能辨）', () => {
    expect(classifyError(new Error(REFUSAL)).reason).toBe('content_filter');
    expect(classifyError(new Error('connection reset')).reason).toBe('network');
  });
});

describe('guardRefusalProvider（chat）', () => {
  const request: LLMRequest = { messages: [] };

  it('正文为罐头拒答时抛 ContentFilterError', async () => {
    const guarded = guardRefusalProvider(createProvider([finalReply(REFUSAL)]));
    await expect(guarded.chat(request)).rejects.toThrow(ContentFilterError);
  });

  it('正常回答原样通过', async () => {
    const guarded = guardRefusalProvider(createProvider([finalReply('答案在这里')]));
    await expect(guarded.chat(request)).resolves.toMatchObject({ content: '答案在这里' });
  });

  it('拒答文字但带工具调用 → 保守放行（有工具调用的响应不是拒答）', async () => {
    const guarded = guardRefusalProvider(
      createProvider([
        {
          content: REFUSAL,
          toolCalls: [{ id: 'c1', name: 'shell', arguments: {} }],
          model: 'test',
          finishReason: 'tool_calls',
        },
      ]),
    );
    await expect(guarded.chat(request)).resolves.toMatchObject({ finishReason: 'tool_calls' });
  });
});

describe('guardRefusalProvider（stream）', () => {
  const request: LLMRequest = { messages: [] };

  it('流式正文落定为罐头拒答：扣发全部正文并抛错，done 不透传', async () => {
    const guarded = guardRefusalProvider(createProvider([finalReply(REFUSAL)]));
    const chunks: LLMStreamChunk[] = [];
    await expect(
      (async () => {
        for await (const c of guarded.stream(request)) chunks.push(c);
      })(),
    ).rejects.toThrow(ContentFilterError);
    expect(chunks.filter((c) => c.type === 'content')).toHaveLength(0);
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
  });

  it('正常流式回答照常流出（含 reasoning 与 done）', async () => {
    const guarded = guardRefusalProvider(createProvider([finalReply('普通回答')]));
    const chunks: LLMStreamChunk[] = [];
    for await (const c of guarded.stream(request)) chunks.push(c);
    expect(chunks.filter((c) => c.type === 'content').map((c) => c.content).join('')).toBe('普通回答');
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });

  it('以签名开头但后面还有正文的合法回答不误杀（缓冲后冲刷）', async () => {
    const guarded = guardRefusalProvider(
      createProvider([finalReply(`${REFUSAL} ——这是引用原句后的正常回答。`)]),
    );
    const text: string[] = [];
    for await (const c of guarded.stream(request)) {
      if (c.type === 'content') text.push(c.content ?? '');
    }
    expect(text.join('')).toBe(`${REFUSAL} ——这是引用原句后的正常回答。`);
  });
});

describe('agentLoop 集成（重试后真实回答落历史）', () => {
  it('首答被拦 → 自动重试（同步兜底）→ 真实回答落历史，拒答语不入历史', async () => {
    const guarded = guardRefusalProvider(
      createProvider([finalReply(REFUSAL), finalReply('真实回答')]),
    );
    const reasons: string[] = [];
    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('hi')],
      tools: [],
    };
    const config: AgentLoopConfig = {
      model: guarded,
      modelCallIdleTimeoutMs: 5_000,
      modelCallAbsoluteTimeoutMs: 10_000,
      onError: async (error) => {
        reasons.push(error.reason);
        return 'retry';
      },
    };

    const events: AgentLoopEvent[] = [];
    for await (const e of agentLoop(context, config)) events.push(e);

    // 首答被拦后 callModel 走 stream→sync 兜底（同请求重发）；兜底即过时 onError 无需介入。
    // 重试通道有两条（同步兜底 / onError 重试），任一走到都算兑现契约。
    expect(events.some((e) => e.type === 'stream.fallback_to_sync')).toBe(true);
    expect(reasons.length).toBeLessThanOrEqual(1);
    const allText = context.messages.map((m) => JSON.stringify(m.content)).join('\n');
    expect(allText).toContain('真实回答');
    expect(allText).not.toContain(REFUSAL);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
  });

  it('重试仍被拦 → abort 收口，拒答语不入历史', async () => {
    const guarded = guardRefusalProvider(
      createProvider([finalReply(REFUSAL), finalReply(REFUSAL)]),
    );
    const reasons: string[] = [];
    const context: AgentContext = {
      systemPrompt: '',
      messages: [userMsg('hi')],
      tools: [],
    };
    const config: AgentLoopConfig = {
      model: guarded,
      modelCallIdleTimeoutMs: 5_000,
      modelCallAbsoluteTimeoutMs: 10_000,
      onError: async (error) => {
        reasons.push(error.reason);
        return 'abort';
      },
    };

    const events: AgentLoopEvent[] = [];
    for await (const e of agentLoop(context, config)) events.push(e);

    expect(reasons).toEqual(['content_filter']);
    const allText = context.messages.map((m) => JSON.stringify(m.content)).join('\n');
    expect(allText).not.toContain(REFUSAL);
    expect(
      events.some((e) => e.type === 'agent_end' && (e as { reason?: string }).reason === 'error'),
    ).toBe(true);
  });
});

describe('摘要闸门（compact）', () => {
  it('罐头拒答判为污染 canned_refusal（交由一次加严重试 + 降级链路）', () => {
    expect(detectSummaryContamination(REFUSAL)).toBe('canned_refusal');
    expect(detectSummaryContamination('## 摘要\n四段式正文')).toBeNull();
  });
});
