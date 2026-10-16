/**
 * Reasoning / thinking streaming passthrough
 *
 * Regression: long silent thinking periods starved the engine model-call
 * watchdog (`Model call idle timeout`) because reasoning deltas were dropped
 * before reaching the loop. Thinking must now surface as **separate**
 * `type: 'reasoning'` chunks so the watchdog is fed without polluting
 * `LLMResponse.content` / chat transcript.
 *
 * - OpenAI-compatible providers emit `delta.reasoning` or `delta.reasoning_content`
 * - Anthropic extended thinking emits `content_block_delta` / `thinking_delta`
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider } from '@octopi-agent/engine/integration/providers/openai.js';
import { AnthropicProvider } from '@octopi-agent/engine/integration/providers/anthropic.js';
import type {
  LLMMessage,
  LLMStreamChunk,
  LLMResponse,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type { TokenUsage } from '@octopi-agent/core/types/turn.js';

function parseOpenAIChunk(provider: OpenAIProvider, payload: Record<string, unknown>): LLMStreamChunk[] {
  return provider['parseSSELine'](
    `data: ${JSON.stringify(payload)}`,
    new Map<number, { id: string; name: string; argsBuffer: string }>(),
    { current: undefined as TokenUsage | undefined },
    { current: undefined as LLMResponse['finishReason'] | undefined },
  );
}

describe('OpenAIProvider reasoning delta passthrough', () => {
  const provider = new OpenAIProvider({ apiKey: 'key', models: ['m1'] });

  it('forwards delta.reasoning_content as reasoning chunks (not content)', () => {
    const chunks = parseOpenAIChunk(provider, {
      choices: [{ delta: { reasoning_content: '让我想想…' } }],
    });

    expect(chunks).toEqual([{ type: 'reasoning', content: '让我想想…' }]);
  });

  it('forwards delta.reasoning as reasoning chunks (not content)', () => {
    const chunks = parseOpenAIChunk(provider, {
      choices: [{ delta: { reasoning: 'thinking…' } }],
    });

    expect(chunks).toEqual([{ type: 'reasoning', content: 'thinking…' }]);
  });

  it('forwards content, reasoning and reasoning_content in one delta with split types', () => {
    const chunks = parseOpenAIChunk(provider, {
      choices: [{ delta: { content: '答案', reasoning: 'r1', reasoning_content: 'r2' } }],
    });

    expect(chunks).toEqual([
      { type: 'content', content: '答案' },
      { type: 'reasoning', content: 'r1' },
      { type: 'reasoning', content: 'r2' },
    ]);
  });

  it('usage-only chunk emits no content', () => {
    const chunks = parseOpenAIChunk(provider, {
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });

    expect(chunks).toEqual([]);
  });
});

describe('AnthropicProvider thinking_delta passthrough', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sseResponse(events: Record<string, unknown>[]): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const e of events) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
          }
          controller.close();
        },
      }),
      { status: 200 },
    );
  }

  it('forwards thinking_delta as reasoning chunks, text as content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '推理中…' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: '最终答案' } },
          { type: 'message_stop' },
        ]),
      ),
    );

    const provider = new AnthropicProvider({ apiKey: 'key', models: ['claude-sonnet-4-6'], timeoutMs: 60_000 });
    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream({
      messages: [{ role: 'user', content: 'hi' }] as LLMMessage[],
      tools: [],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({ type: 'reasoning', content: '推理中…' });
    expect(chunks).toContainEqual({ type: 'content', content: '最终答案' });
    expect(chunks.filter((c) => c.type === 'reasoning')).toHaveLength(1);
    expect(chunks.filter((c) => c.type === 'content')).toHaveLength(1);
  });
});
