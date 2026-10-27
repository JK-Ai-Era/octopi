import { describe, test, expect } from 'vitest';
import type {
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ModelProvider,
} from '@octopi-agent/core/interfaces/model-provider.js';
import {
  FallbackProvider,
  DEFAULT_FALLBACK_ATTEMPT_TTFT_MS,
  readAttemptBudgetExhausted,
} from '@octopi-agent/engine/harness/run/reliability/fallback-provider.js';
import { checkTimeoutCoherence, UNDICI_DEFAULT_TIMEOUT_MS } from '@octopi-agent/engine/integration/providers/timeout-coherence.js';
import { classifyError } from '@octopi-agent/core/loop/error-classifier.js';

/** 可编排的假 provider：记录每次调用，按脚本行为 */
class ScriptedProvider implements ModelProvider {
  readonly models = ['m'];
  chatCalls = 0;
  streamCalls = 0;
  /** 本次调用看到的 signal，用于断言「预算耗尽会 abort 子 signal」 */
  lastSignal?: AbortSignal;

  constructor(
    readonly name: string,
    private readonly behavior: {
      /** 首个 chunk 前进/等待多久；`'hang'` = 等到 abort */
      ttft: number | 'hang';
      /** 首个内容 */
      content?: string;
      /** 直接抛错 */
      throws?: Error;
    },
    readonly defaultModel = 'm',
  ) {}

  private async waitFirstChunk(signal?: AbortSignal): Promise<void> {
    if (this.behavior.throws) throw this.behavior.throws;
    if (this.behavior.ttft === 'hang') {
      await new Promise<void>((_resolve, reject) => {
        if (!signal) return; // 无 signal 则永远挂起（测试会靠预算兜住）
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return;
    }
    if (typeof this.behavior.ttft === 'number' && this.behavior.ttft > 0) {
      await new Promise((r) => setTimeout(r, this.behavior.ttft as number));
    }
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    this.chatCalls++;
    this.lastSignal = request.signal;
    await this.waitFirstChunk(request.signal);
    return { content: this.behavior.content ?? 'ok', model: 'm', finishReason: 'stop' };
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    this.streamCalls++;
    this.lastSignal = request.signal;
    await this.waitFirstChunk(request.signal);
    yield { type: 'content', content: this.behavior.content ?? 'ok' };
    yield { type: 'done', finishReason: 'stop' };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getModelInfo() {
    return null;
  }

  getModelInfos() {
    return [];
  }
}

function buildChain(
  primary: ModelProvider,
  fallbacks: Array<{ provider: ModelProvider; model: string }>,
  options: {
    attemptTtftTimeoutMs?: number;
    attemptChatTimeoutMs?: number;
    degradeTtlMs?: number;
    now?: () => number;
  } = {},
) {
  const map = new Map<string, ModelProvider>();
  for (const fb of fallbacks) map.set(fb.provider.name, fb.provider);
  return new FallbackProvider(
    primary,
    primary.defaultModel ?? 'm',
    fallbacks.map((fb) => ({ provider: fb.provider.name, model: fb.model })) as never,
    map,
    options,
  );
}

describe('FallbackProvider — 单节点首块预算', () => {
  test('主节点不产首块时按预算切到备选（流式）', async () => {
    const primary = new ScriptedProvider('slow', { ttft: 'hang' });
    const backup = new ScriptedProvider('fast', { ttft: 0, content: 'from-backup' });
    const chain = buildChain(primary, [{ provider: backup, model: 'm' }], { attemptTtftTimeoutMs: 30 });

    const chunks: LLMStreamChunk[] = [];
    for await (const c of chain.stream({ messages: [] })) chunks.push(c);

    expect(primary.streamCalls).toBe(1);
    expect(backup.streamCalls).toBe(1);
    expect(chunks.some((c) => c.type === 'content' && c.content === 'from-backup')).toBe(true);
    // 预算耗尽必须真正取消挂起的 HTTP，而不是只放弃 generator
    expect(primary.lastSignal?.aborted).toBe(true);
  });

  test('主节点不产首块时按预算切到备选（同步）', async () => {
    const primary = new ScriptedProvider('slow', { ttft: 'hang' });
    const backup = new ScriptedProvider('fast', { ttft: 0, content: 'from-backup' });
    const chain = buildChain(primary, [{ provider: backup, model: 'm' }], {
      attemptTtftTimeoutMs: 30,
      attemptChatTimeoutMs: 30,
    });

    const res = await chain.chat({ messages: [] });
    expect(res.content).toBe('from-backup');
    expect(primary.lastSignal?.aborted).toBe(true);
  });

  test('预算只在还有下一候选时生效：最后一棒不受首块预算约束', async () => {
    const only = new ScriptedProvider('only', { ttft: 60, content: 'slow-but-fine' });
    const chain = buildChain(only, [], { attemptTtftTimeoutMs: 10 });

    // 单节点无备选：慢首块不得被预算掐断（否则把「慢」误判成「坏」）
    const res = await chain.chat({ messages: [] });
    expect(res.content).toBe('slow-but-fine');
  });

  test('全部节点失败时抛出错误，且预算耗尽的节点已被 abort', async () => {
    const a = new ScriptedProvider('a', { ttft: 'hang' });
    const b = new ScriptedProvider('b', { ttft: 0, throws: new Error('backup down') });
    const chain = buildChain(a, [{ provider: b, model: 'm' }], {
      attemptTtftTimeoutMs: 20,
      attemptChatTimeoutMs: 20,
    });

    // 最后一棒没有首块预算（无备选可切），因此这里让 b 直接抛错来收尾；
    // a 的挂起必须已经被预算 abort 掉，否则整条链会永久悬挂
    await expect(chain.chat({ messages: [] })).rejects.toThrow('backup down');
    expect(a.lastSignal?.aborted).toBe(true);
  });

  test('预算耗尽错误带可读的预算标记', () => {
    // 直接构造与 provider 内部一致的错误形状，锁定读取契约
    const err = new Error('budget exhausted');
    (err as unknown as Record<symbol, unknown>)[Symbol.for('@octopi-agent/engine.provider.attemptBudgetExhausted')] = 1234;
    expect(readAttemptBudgetExhausted(err)).toBe(1234);
    expect(readAttemptBudgetExhausted(new Error('plain'))).toBeUndefined();
  });

  test('默认预算为 90s（可被配置覆盖）', () => {
    const p = new ScriptedProvider('p', { ttft: 0 });
    const chain = buildChain(p, []);
    // 通过行为间接断言默认值存在且为正
    expect(DEFAULT_FALLBACK_ATTEMPT_TTFT_MS).toBe(90_000);
    expect(chain).toBeInstanceOf(FallbackProvider);
  });
});

describe('FallbackProvider — 失败节点降级（使重试不再原地重撞）', () => {
  test('预算耗尽的节点在降级窗口内被排到最后', async () => {
    let nowTs = 1_000_000;
    const slow = new ScriptedProvider('slow', { ttft: 'hang' });
    const fast = new ScriptedProvider('fast', { ttft: 0, content: 'fast' });
    const chain = buildChain(slow, [{ provider: fast, model: 'm' }], {
      attemptTtftTimeoutMs: 20,
      attemptChatTimeoutMs: 20,
      now: () => nowTs,
    });

    // 第一次：主节点被预算掐断 → 降级
    expect((await chain.chat({ messages: [] })).content).toBe('fast');
    const slowCallsAfterFirst = slow.chatCalls;

    // 第二次：主节点已降级，应直接先走 fast，不再白等一个预算窗口
    expect((await chain.chat({ messages: [] })).content).toBe('fast');
    expect(slow.chatCalls).toBe(slowCallsAfterFirst);

    // 降级窗口过期后主节点重新获得优先权
    nowTs += 10_000;
    await chain.chat({ messages: [] });
    expect(slow.chatCalls).toBe(slowCallsAfterFirst + 1);
  });

  test('成功一次即解除降级', async () => {
    let nowTs = 1_000_000;
    let failFirst = true;
    const flaky: ModelProvider = {
      name: 'flaky',
      defaultModel: 'm',
      models: ['m'],
      async chat() {
        if (failFirst) {
          failFirst = false;
          throw new Error('boom');
        }
        return { content: 'ok', model: 'm', finishReason: 'stop' };
      },
      async *stream() {
        yield { type: 'done', finishReason: 'stop' };
      },
      async isAvailable() {
        return true;
      },
      getModelInfo() {
        return null;
      },
      getModelInfos() {
        return [];
      },
    } as ModelProvider;
    const backup = new ScriptedProvider('backup', { ttft: 0, content: 'backup' });
    const chain = buildChain(flaky, [{ provider: backup, model: 'm' }], {
      attemptTtftTimeoutMs: 20,
      degradeTtlMs: 60_000,
      now: () => nowTs,
    });

    await chain.chat({ messages: [] }); // flaky 抛错 → 降级 → backup 成功
    await chain.chat({ messages: [] }); // flaky 降级中 → 直接 backup
    // 窗口过期后 flaky 重新优先，且这次成功 → 解除降级
    nowTs += 120_000;
    expect((await chain.chat({ messages: [] })).content).toBe('ok');
    // 再调一次确认已回到主节点优先（不是隔一次才轮到）
    expect((await chain.chat({ messages: [] })).content).toBe('ok');
  });

  test('流中途父级 abort 必须真正取消底层请求（不得因切节点丢失监听）', async () => {
    // 首块立即产出，随后挂起等待 abort：模拟「已切到本节点后用户取消」
    let sawAbort = false;
    const streaming: ModelProvider = {
      name: 'streaming',
      defaultModel: 'm',
      models: ['m'],
      async chat() {
        return { content: 'x', model: 'm', finishReason: 'stop' };
      },
      async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
        yield { type: 'content', content: 'first' };
        await new Promise<void>((_resolve, reject) => {
          const sig = request.signal;
          if (!sig) return;
          if (sig.aborted) {
            sawAbort = true;
            return reject(new Error('aborted'));
          }
          sig.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          }, { once: true });
        });
      },
      async isAvailable() {
        return true;
      },
      getModelInfo() {
        return null;
      },
      getModelInfos() {
        return [];
      },
    } as ModelProvider;

    const chain = buildChain(streaming, [{ provider: new ScriptedProvider('b', { ttft: 0 }), model: 'm' }], {
      attemptTtftTimeoutMs: 5_000,
    });
    const parent = new AbortController();

    const consume = (async () => {
      for await (const _c of chain.stream({ messages: [], signal: parent.signal })) {
        // 拿到首块后由外部 abort
      }
    })();

    await new Promise((r) => setTimeout(r, 20));
    parent.abort();
    await expect(consume).rejects.toThrow();
    expect(sawAbort).toBe(true);
  });

  test('预算耗尽错误按 timeout 归类（否则会落 unknown 而直接中止）', async () => {
    const a = new ScriptedProvider('a', { ttft: 'hang' });
    const b = new ScriptedProvider('b', { ttft: 'hang' });
    const chain = buildChain(a, [{ provider: b, model: 'm' }], { attemptTtftTimeoutMs: 20 });

    // 让最后一棒也抛错来收尾，取其前一个节点的预算耗尽错误路径：这里直接构造同类错误
    const budgetError = new Error(
      'FallbackProvider: a/m first-chunk timeout after 20ms (no content received)',
    );
    expect(classifyError(budgetError).reason).toBe('timeout');
    expect(chain).toBeInstanceOf(FallbackProvider);
  });

  test('chat 不复用 TTFT 预算：合法长响应不得被判为故障', async () => {
    // 150ms 才返回：超过 TTFT 预算(30ms)，但低于 chat 预算(5s)
    const slowButLegit = new ScriptedProvider('legit', { ttft: 150, content: 'long-but-fine' });
    const backup = new ScriptedProvider('backup', { ttft: 0, content: 'backup' });
    const chain = buildChain(slowButLegit, [{ provider: backup, model: 'm' }], {
      attemptTtftTimeoutMs: 30,
      attemptChatTimeoutMs: 5_000,
    });

    const res = await chain.chat({ messages: [] });
    expect(res.content).toBe('long-but-fine');
    expect(backup.chatCalls).toBe(0);
  });

  test('节点健康类错误才降级：鉴权失败不应把主节点排后', async () => {
    let nowTs = 1_000_000;
    let attempts = 0;
    const authFailing: ModelProvider = {
      name: 'authfail',
      defaultModel: 'm',
      models: ['m'],
      async chat() {
        attempts++;
        const err = new Error('unauthorized') as Error & { status?: number };
        err.status = 401;
        throw err;
      },
      async *stream() {
        const err = new Error('unauthorized') as Error & { status?: number };
        err.status = 401;
        throw err;
      },
      async isAvailable() {
        return true;
      },
      getModelInfo() {
        return null;
      },
      getModelInfos() {
        return [];
      },
    } as ModelProvider;
    const backup = new ScriptedProvider('backup', { ttft: 0, content: 'backup' });
    const chain = buildChain(authFailing, [{ provider: backup, model: 'm' }], {
      attemptTtftTimeoutMs: 20,
      degradeTtlMs: 60_000,
      now: () => nowTs,
    });

    await chain.chat({ messages: [] });
    const afterFirst = attempts;
    await chain.chat({ messages: [] });
    // 401 与节点健康无关：主节点仍应被优先尝试（不是降级后被跳过）
    expect(attempts).toBe(afterFirst + 1);
  });

  test('父级 abort 不降级、不切下一个节点', async () => {
    const primary = new ScriptedProvider('primary', { ttft: 'hang' });
    const backup = new ScriptedProvider('backup', { ttft: 0, content: 'backup' });
    const chain = buildChain(primary, [{ provider: backup, model: 'm' }], { attemptTtftTimeoutMs: 5_000 });

    const parent = new AbortController();
    parent.abort();
    await expect(chain.chat({ messages: [], signal: parent.signal })).rejects.toThrow();
    // 用户主动中止不是节点故障：备选不应被启动
    expect(backup.chatCalls).toBe(0);
  });
});

describe('超时口径一致性检查', () => {
  test('provider 超时超过 undici 默认值 → 报「被截断」', () => {
    const issues = checkTimeoutCoherence({
      idleTimeoutMs: 300_000,
      providerTimeouts: { volc: 900 },
    });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('provider_timeout_capped');
    expect(issues.find((i) => i.code === 'provider_timeout_capped')?.message).toContain('900');
  });

  test('provider 超时大于引擎 watchdog → 报「引擎先断」', () => {
    const issues = checkTimeoutCoherence({ idleTimeoutMs: 120_000, providerTimeouts: { p: 300 } });
    expect(issues.map((i) => i.code)).toContain('provider_timeout_exceeds_engine');
  });

  test('idle 超过 undici 默认值 → 提示两者同级会先被 undici 断', () => {
    const issues = checkTimeoutCoherence({ idleTimeoutMs: UNDICI_DEFAULT_TIMEOUT_MS + 1, providerTimeouts: {} });
    expect(issues.map((i) => i.code)).toContain('idle_above_undici_default');
  });

  test('缺省 idle（=300s）不告警：否则每次默认启动都刷一条，告警会被忽略', () => {
    const issues = checkTimeoutCoherence({ idleTimeoutMs: UNDICI_DEFAULT_TIMEOUT_MS, providerTimeouts: {} });
    expect(issues.map((i) => i.code)).not.toContain('idle_above_undici_default');
  });

  test('回退链最坏耗时超过 idle → 报最后一个候选拿不到机会', () => {
    const issues = checkTimeoutCoherence({
      idleTimeoutMs: 300_000,
      providerTimeouts: {},
      fallbackAttemptTtftMs: 200_000,
      maxFallbackChainLength: 2,
    });
    expect(issues.map((i) => i.code)).toContain('fallback_chain_exceeds_idle');
  });

  test('自洽配置不产生告警', () => {
    const issues = checkTimeoutCoherence({
      idleTimeoutMs: 240_000,
      providerTimeouts: { p: 60 },
      fallbackAttemptTtftMs: 90_000,
      maxFallbackChainLength: 2,
    });
    expect(issues).toEqual([]);
  });
});
