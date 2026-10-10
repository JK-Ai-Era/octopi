/**
 * 模型调用 watchdog / 错误分类契约
 *
 * 覆盖本次线上故障链：
 * - undici `TypeError: terminated`（对端断连）必须归为 network（可重试）
 * - 同步 fallback 必须有引擎超时，不能干等对端
 * - 放弃流式时必须 abort 底层 signal，不能只 return() generator
 */

import { describe, it, expect } from 'vitest';
import { callModel } from '@octopi-agent/core/loop/call-model.js';
import { classifyError } from '@octopi-agent/core/loop/error-classifier.js';
import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '@octopi-agent/core/interfaces/model-provider.js';

function undiciTerminated(): Error {
  const err = new TypeError('terminated');
  (err as { cause?: unknown }).cause = Object.assign(new Error('other side closed'), {
    code: 'UND_ERR_SOCKET',
    name: 'SocketError',
  });
  return err;
}

describe('classifyError 对端断连归类', () => {
  it('undici TypeError: terminated（cause other side closed）→ network', () => {
    const classified = classifyError(undiciTerminated());
    expect(classified.reason).toBe('network');
    expect(classified.message).toBe('terminated');
  });

  it('socket hang up → network', () => {
    expect(classifyError(new Error('socket hang up')).reason).toBe('network');
  });

  it('ECONNRESET / connection reset → network', () => {
    expect(classifyError(new Error('read ECONNRESET')).reason).toBe('network');
    expect(classifyError(new Error('connection reset by peer')).reason).toBe('network');
  });

  it('premature close → network', () => {
    expect(classifyError(new Error('premature close')).reason).toBe('network');
  });

  it('Model call idle timeout 仍归 timeout（保持可重试）', () => {
    const classified = classifyError(
      new Error('Model call idle timeout: no data received from provider within timeout window'),
    );
    expect(classified.reason).toBe('timeout');
  });

  it('Model call sync timeout 归 timeout', () => {
    const classified = classifyError(
      new Error('Model call sync timeout: no response from provider within timeout window'),
    );
    expect(classified.reason).toBe('timeout');
  });

  it('已 abort 的请求仍归 timeout（不与断连混淆）', () => {
    expect(classifyError(new Error('Aborted')).reason).toBe('timeout');
    expect(classifyError(new Error('Request aborted')).reason).toBe('timeout');
  });

  it('未知错误保持 unknown', () => {
    expect(classifyError(new Error('something else entirely')).reason).toBe('unknown');
  });
});

type StreamProbe = {
  streamSignal?: AbortSignal;
  streamStarted: boolean;
  chatCalls: number;
  chatSignal?: AbortSignal;
};

function hangingProvider(probe: StreamProbe, chatImpl?: (req: LLMRequest) => Promise<LLMResponse>): ModelProvider {
  return {
    name: 'hanging',
    defaultModel: 'hanging',
    getModelInfo: () => null,
    async chat(req: LLMRequest): Promise<LLMResponse> {
      probe.chatCalls++;
      probe.chatSignal = req.signal;
      if (chatImpl) return chatImpl(req);
      return { content: 'from-chat', model: 'hanging', finishReason: 'stop' };
    },
    async *stream(req: LLMRequest): AsyncGenerator<LLMStreamChunk> {
      probe.streamStarted = true;
      probe.streamSignal = req.signal;
      // 挂起直到 abort：模拟 provider 不吐首包
      await new Promise<void>((_resolve, reject) => {
        const signal = req.signal;
        if (signal?.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
      yield { type: 'content', content: 'unreachable' };
    },
    async isAvailable() {
      return true;
    },
  };
}

async function drain(gen: AsyncGenerator<unknown, LLMResponse>) {
  const events: unknown[] = [];
  let result = await gen.next();
  while (!result.done) {
    events.push(result.value);
    result = await gen.next();
  }
  return { events, value: result.value };
}

describe('callModel 同步 fallback watchdog', () => {
  it('stream 空闲超时后 fallback；chat 也超时时抛 sync timeout 而非悬挂', async () => {
    const probe: StreamProbe = { streamStarted: false, chatCalls: 0 };
    const provider = hangingProvider(probe, async () => {
      // chat 永不返回，验证引擎 watchdog 会打断
      await new Promise(() => {});
      return { content: 'never', model: 'hanging', finishReason: 'stop' };
    });

    const gen = callModel(provider, [], [], undefined, {
      idleTimeoutMs: 40,
      absoluteTimeoutMs: 200,
    });

    const started = Date.now();
    await expect(drain(gen)).rejects.toThrow(/sync timeout/i);
    const elapsed = Date.now() - started;

    expect(probe.streamStarted).toBe(true);
    expect(probe.chatCalls).toBe(1);
    // 不应等到进程级挂死；budget ≈ max(idle, remaining) ≤ absolute+idle
    expect(elapsed).toBeLessThan(1000);
  });

  it('stream 空闲超时后 chat 成功时返回 chat 结果', async () => {
    const probe: StreamProbe = { streamStarted: false, chatCalls: 0 };
    const provider = hangingProvider(probe);

    const gen = callModel(provider, [], [], undefined, {
      idleTimeoutMs: 30,
      absoluteTimeoutMs: 500,
    });
    const { events, value } = await drain(gen);

    const fallback = events.find(
      (e) => (e as { type?: string }).type === 'stream.fallback_to_sync',
    ) as { data?: { reason?: string } } | undefined;
    expect(fallback?.data?.reason).toMatch(/idle timeout/i);
    expect(probe.chatCalls).toBe(1);
    expect(value.content).toBe('from-chat');
  });
});

describe('callModel 放弃流式时真正 abort 底层 signal', () => {
  it('idle timeout 后 stream 收到的 signal 已 aborted，且不误伤 chat', async () => {
    const probe: StreamProbe = { streamStarted: false, chatCalls: 0 };
    const provider = hangingProvider(probe);
    const parent = new AbortController();

    const gen = callModel(provider, [], [], parent.signal, {
      idleTimeoutMs: 30,
      absoluteTimeoutMs: 500,
    });
    await drain(gen);

    expect(probe.streamSignal).toBeDefined();
    expect(probe.streamSignal?.aborted).toBe(true);
    // chat 走独立请求，用的是 parent signal，不应被 stream 的 abort 误伤
    expect(probe.chatSignal).toBe(parent.signal);
    expect(probe.chatSignal?.aborted).toBe(false);
  });
});
