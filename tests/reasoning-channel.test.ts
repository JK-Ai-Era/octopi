/**
 * Reasoning channel: thinking must not pollute assistant content.
 *
 * Regression: v0.82.4 mapped `delta.reasoning_content` / `thinking_delta` to
 * `type: 'content'`, so WebUI and session history received thinking as chat
 * text. Reasoning now rides `type: 'reasoning'` / `llm_thinking_delta` and is
 * kept out of `LLMResponse.content`.
 */

import { describe, it, expect } from 'vitest';
import { callModel } from '@octopi-agent/core/loop/call-model.js';
import type {
  ModelProvider,
  LLMMessage,
  LLMResponse,
  LLMStreamChunk,
  LLMToolDefinition,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type { AgentLoopEvent } from '@octopi-agent/core/loop/types.js';

function providerFromChunks(chunks: LLMStreamChunk[], final: Partial<LLMResponse> = {}): ModelProvider {
  return {
    name: 'test',
    defaultModel: 'm1',
    async chat(): Promise<LLMResponse> {
      return {
        content: final.content ?? 'sync',
        model: 'm1',
        finishReason: 'stop',
        ...final,
      };
    },
    async *stream(): AsyncGenerator<LLMStreamChunk> {
      for (const c of chunks) yield c;
    },
    async isAvailable() {
      return true;
    },
    async getModelInfo() {
      return null;
    },
  };
}

async function runCall(chunks: LLMStreamChunk[]): Promise<{ events: AgentLoopEvent[]; response: LLMResponse }> {
  const provider = providerFromChunks(chunks);
  const gen = callModel(
    provider,
    [{ role: 'user', content: 'hi' }] as LLMMessage[],
    [] as LLMToolDefinition[],
    undefined,
    { idleTimeoutMs: 5_000, absoluteTimeoutMs: 10_000 },
  );
  const events: AgentLoopEvent[] = [];
  let response: LLMResponse | undefined;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      response = next.value;
      break;
    }
    events.push(next.value);
  }
  return { events, response: response! };
}

describe('callModel reasoning/content split', () => {
  it('keeps reasoning out of content and emits llm_thinking_delta', async () => {
    const { events, response } = await runCall([
      { type: 'reasoning', content: '让我想想' },
      { type: 'reasoning', content: '…继续' },
      { type: 'content', content: '最终答案' },
      { type: 'done', finishReason: 'stop' },
    ]);

    expect(response.content).toBe('最终答案');
    expect(response.reasoning).toBe('让我想想…继续');
    const thinking = events.filter((e) => e.type === 'llm_thinking_delta');
    expect(thinking.map((e) => (e as { data: { delta: string } }).data.delta)).toEqual(['让我想想', '…继续']);
    const stream = events.filter((e) => e.type === 'llm_stream_delta');
    expect(stream.map((e) => (e as { data: { delta: string } }).data.delta)).toEqual(['最终答案']);
  });

  it('reasoning-only stream without tools still triggers empty_stream fallback path', async () => {
    // content 为空且无 tool calls → call-model 走 sync fallback（策略不变）
    const provider = providerFromChunks([
      { type: 'reasoning', content: '只有思考' },
      { type: 'done', finishReason: 'stop' },
    ], { content: 'sync-fallback' });

    const gen = callModel(
      provider,
      [{ role: 'user', content: 'hi' }] as LLMMessage[],
      [],
      undefined,
      { idleTimeoutMs: 5_000, absoluteTimeoutMs: 10_000 },
    );
    let response: LLMResponse | undefined;
    const types: string[] = [];
    while (true) {
      const next = await gen.next();
      if (next.done) {
        response = next.value;
        break;
      }
      types.push(next.value.type);
    }
    expect(types).toContain('stream.fallback_to_sync');
    expect(response!.content).toBe('sync-fallback');
  });
});
