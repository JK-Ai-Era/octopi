/**
 * F 类反馈环红线（arch/overflow-redesign.md §6 红线 3/4 + T2⑤）
 *
 * 红线 3（F 类真值回填）：400 文本带窗口数字 → per-model 窗口真值更新，
 *   下次前馈（resolveModel）直接用新值。
 * 红线 4（错误分类器）：rate_limit/invalid 400 不触发收敛（不乱砍）——
 *   只有长度类文本的 400 才归 context_length。
 *
 * 附加钉：T2③ 收缩上界公式、重发限 2、收缩猜测不入真值表（防持久化削窗）。
 *
 * 测试纪律（沿用）：状态级直接校验，不硬造真溢出。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyError,
  isContextLengthErrorText,
  extractContextWindowLimit,
} from '@octopi-agent/core/loop/error-classifier.js';
import {
  resolveModel,
  updateResolvedModel,
  getResolvedModel,
  withResolvedModel,
  recordWindowTruth,
  getWindowTruth,
  resetWindowTruth,
  type ResolvedModel,
} from '@octopi-agent/engine/harness/run/model/index.js';
import {
  applyContextLengthFeedback,
  computeShrunkWindowBound,
} from '@octopi-agent/engine/harness/run/reliability/context-length-feedback.js';
import { maxAttemptsFor, MODEL_ERROR_MAX_ATTEMPTS } from '@octopi-agent/engine/harness/run/reliability/model-error-policy.js';
import { DefaultErrorStrategy } from '@octopi-agent/engine/harness/agent/builder.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';

// ── 构造助手 ──

/** 带 status/message 的错误对象（provider 风格） */
function providerError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function fakeProvider(): ModelProvider {
  return {
    name: 'testprov',
    defaultModel: 'testmodel',
    getModelInfo: () => undefined,
    getModelInfos: () => [],
    isAvailable: () => true,
    chat: async () => {
      throw new Error('not_implemented: test stub');
    },
    stream: async () => {
      throw new Error('not_implemented: test stub');
    },
  } as unknown as ModelProvider;
}

function fakeSnapshot(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    ref: 'testprov/testmodel',
    providerName: 'testprov',
    modelName: 'testmodel',
    provider: fakeProvider(),
    contextWindow: 200_000,
    source: 'config',
    known: true,
    isOverride: false,
    ...overrides,
  };
}

/** 在 ResolvedModel run scope 内执行（updateResolvedModel 要求 scope 在位） */
async function inRunScope<T>(
  snapshot: ResolvedModel,
  fn: () => T,
): Promise<{ result: T; after: ResolvedModel | undefined }> {
  let result!: T;
  let after: ResolvedModel | undefined;
  const gen = (async function* () {
    result = fn();
    after = getResolvedModel();
  })();
  for await (const _ of withResolvedModel(snapshot, gen)) {
    // drain
  }
  return { result, after };
}

// ── 红线 4：错误分类器——rate_limit/invalid 400 不进收敛 ──

describe('红线 4：400 分类精确化（不乱砍）', () => {
  it('400 + rate limit 文本 → rate_limit（不触发收敛）', () => {
    const classified = classifyError(
      providerError(400, 'Rate limit reached for requests. Please slow down.'),
    );
    expect(classified.reason).toBe('rate_limit');
    expect(classified.reason).not.toBe('context_length');
  });

  it('400 + invalid_request 参数错误 → 非 context_length', () => {
    const classified = classifyError(
      providerError(400, "Invalid value for 'temperature': expected number, received string"),
    );
    // 红线 4 只要求「不进收敛路径」，不钉死具体归因（未来可能新增 invalid_request）
    expect(classified.reason).not.toBe('context_length');
  });

  it('400 + OpenAI 长度文本 → context_length', () => {
    const classified = classifyError(
      providerError(
        400,
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
      ),
    );
    expect(classified.reason).toBe('context_length');
  });

  it('400 + Anthropic 长度文本 → context_length', () => {
    const classified = classifyError(
      providerError(400, 'prompt is too long: 250000 tokens > 200000 maximum'),
    );
    expect(classified.reason).toBe('context_length');
  });

  it('400 + Gemini 长度文本 → context_length', () => {
    const classified = classifyError(
      providerError(
        400,
        'input token count (250000) exceeds the maximum number of tokens allowed (1048576)',
      ),
    );
    expect(classified.reason).toBe('context_length');
  });

  it('无状态码的长度文本 → context_length（文本回退路径）', () => {
    expect(classifyError(new Error('context_length_exceeded')).reason).toBe('context_length');
    expect(classifyError(new Error('prompt is too long')).reason).toBe('context_length');
  });

  it('isContextLengthErrorText 不误判普通文本', () => {
    expect(isContextLengthErrorText('rate limit exceeded')).toBe(false);
    expect(isContextLengthErrorText('invalid request body')).toBe(false);
  });
});

// ── 红线 3：真值回填——400 文本带窗口数字 → 下次前馈用新值 ──

describe('红线 3：F 类真值回填', () => {
  beforeEach(() => resetWindowTruth());

  it('extractContextWindowLimit 提取上限，不误抓请求体量数字', () => {
    // OpenAI：句中还有 150000（请求体量），必须取 128000（上限）
    expect(
      extractContextWindowLimit(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
      ),
    ).toBe(128000);
    // Anthropic
    expect(
      extractContextWindowLimit('prompt is too long: 250000 tokens > 200000 maximum'),
    ).toBe(200000);
    expect(
      extractContextWindowLimit(
        "input length and `max_tokens` exceed context limit: 199745 + 64000 > 199714",
      ),
    ).toBe(199714);
    // Gemini
    expect(
      extractContextWindowLimit(
        'input token count (250000) exceeds the maximum number of tokens allowed (1048576)',
      ),
    ).toBe(1048576);
  });

  it('提取不到 → undefined（走收缩，不猜）', () => {
    expect(extractContextWindowLimit('context length exceeded')).toBeUndefined();
    expect(extractContextWindowLimit('maximum context length is 500 tokens')).toBeUndefined(); // 低于合理性护栏
  });

  it('400 文本带窗口数字 → per-model 真值更新 → 下次 resolveModel 直接用新值', async () => {
    const err = classifyError(
      providerError(
        400,
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
      ),
    );
    expect(err.reason).toBe('context_length');

    const snapshot = fakeSnapshot({ contextWindow: 200_000 });
    const { result, after } = await inRunScope(snapshot, () =>
      applyContextLengthFeedback(err, {}),
    );

    // 真值回填 + run 快照即刻换 measured
    expect(result.action).toBe('backfilled');
    expect(result.measured).toBe(128_000);
    expect(after?.contextWindow).toBe(128_000);
    expect(after?.source).toBe('measured');

    // 下次前馈：全新 resolve（守门人反哺调度器）直接用真值，压过配置
    const truth = getWindowTruth('testprov/testmodel');
    expect(truth?.tokens).toBe(128_000);

    const resolved = resolveModel({
      providerName: 'testprov',
      modelName: 'testmodel',
      providers: new Map([['testprov', fakeProvider()]]),
      explicit: { contextWindow: 200_000 }, // 配置仍是旧的错值
    });
    expect(resolved?.contextWindow).toBe(128_000);
    expect(resolved?.source).toBe('measured');
    expect(resolved?.known).toBe(true);
  });

  it('收缩猜测只写 run 快照，不入真值表（防猜测持久化削窗）', async () => {
    const err = classifyError(providerError(400, 'context length exceeded'));
    expect(err.reason).toBe('context_length');

    const snapshot = fakeSnapshot({ contextWindow: 200_000 });
    const { result, after } = await inRunScope(snapshot, () =>
      applyContextLengthFeedback(err, { lastSuccessActual: 150_000 }),
    );

    expect(result.action).toBe('shrunk');
    // min(150000, 200000×0.7=140000) = 140000
    expect(result.bound).toBe(140_000);
    expect(after?.contextWindow).toBe(140_000);
    expect(after?.source).toBe('shrunk');
    // 关键红线：猜测不得进真值表
    expect(getWindowTruth('testprov/testmodel')).toBeUndefined();
  });

  it('真值可覆盖此前的收缩值（测量 > 猜测）', async () => {
    // 第一次 400 无数字 → 收缩
    const err1 = classifyError(providerError(400, 'context length exceeded'));
    await inRunScope(fakeSnapshot(), () =>
      applyContextLengthFeedback(err1, { lastSuccessActual: 100_000 }),
    );
    // 第二次 400 带真值 → 回填
    const err2 = classifyError(
      providerError(400, "This model's maximum context length is 128000 tokens."),
    );
    const { after } = await inRunScope(fakeSnapshot(), () =>
      applyContextLengthFeedback(err2, {}),
    );
    expect(after?.contextWindow).toBe(128_000);
    expect(after?.source).toBe('measured');
    expect(getWindowTruth('testprov/testmodel')?.tokens).toBe(128_000);
  });
});

// ── T2③ 收缩上界公式 ──

describe('T2③ 收缩上界（纯函数）', () => {
  it('min(上次成功实测, 已知值×0.7)', () => {
    expect(computeShrunkWindowBound({ lastSuccessActual: 150_000, knownWindow: 200_000 })).toBe(140_000);
    expect(computeShrunkWindowBound({ lastSuccessActual: 100_000, knownWindow: 200_000 })).toBe(100_000);
  });

  it('缺一边时用存在的一边', () => {
    expect(computeShrunkWindowBound({ lastSuccessActual: 150_000 })).toBe(150_000);
    expect(computeShrunkWindowBound({ knownWindow: 200_000 })).toBe(140_000);
  });

  it('全缺 → undefined（无可收缩依据）', () => {
    expect(computeShrunkWindowBound({})).toBeUndefined();
    expect(computeShrunkWindowBound({ lastSuccessActual: 0, knownWindow: -1 })).toBeUndefined();
  });
});

// ── T2⑤ 重发限 2 ──

describe('T2⑤ 重发限 2（防砍不给力连环 400）', () => {
  it('maxAttemptsFor(context_length) = 2', () => {
    expect(maxAttemptsFor('context_length')).toBe(2);
    expect(MODEL_ERROR_MAX_ATTEMPTS.context_length).toBe(2);
  });

  it('DefaultErrorStrategy：前 2 次 retry，耗尽后 abort（L3 换 session/model）', () => {
    const strategy = new DefaultErrorStrategy();
    const err = {
      reason: 'context_length' as const,
      message: 'context length exceeded',
      originalError: new Error('context length exceeded'),
    };
    expect(strategy.onModelError(err, 0)).toMatchObject({ action: 'retry' });
    expect(strategy.onModelError(err, 1)).toMatchObject({ action: 'retry' });
    const final = strategy.onModelError(err, 2);
    expect(final.action).toBe('abort');
    if (final.action === 'abort') {
      expect(final.reason).toContain('start a new session or switch to a model');
    }
  });

  it('rate_limit 等其余原因的重发上限不变（零旁改）', () => {
    expect(maxAttemptsFor('rate_limit')).toBe(3);
    expect(maxAttemptsFor('timeout')).toBe(3);
    expect(maxAttemptsFor('network')).toBe(3);
    expect(maxAttemptsFor('server')).toBe(2);
    expect(maxAttemptsFor('content_filter')).toBe(2);
    expect(maxAttemptsFor('auth')).toBe(0);
  });
});

// ── run-scope 边界（真值登记跳过语义不伪装成功） ──

describe('run-scope 边界', () => {
  beforeEach(() => resetWindowTruth());

  it('无 run 快照时反馈为 noop，不写真值表（ref 不可得，如实跳过）', () => {
    const err = classifyError(
      providerError(400, "This model's maximum context length is 128000 tokens."),
    );
    // 不在 withResolvedModel 内调用
    const result = applyContextLengthFeedback(err, {});
    expect(result.action).toBe('noop');
    expect(getWindowTruth('testprov/testmodel')).toBeUndefined();
  });

  it('recordWindowTruth/getWindowTruth 覆盖旧值（最新测量即真值）', () => {
    recordWindowTruth('p/m', 128_000);
    recordWindowTruth('p/m', 200_000);
    expect(getWindowTruth('p/m')?.tokens).toBe(200_000);
  });

  it('updateResolvedModel 在 scope 外抛错（既有语义不破）', () => {
    expect(() => updateResolvedModel(fakeSnapshot())).toThrow(/resolved Run scope/);
  });
});

// ── 评审 M1：长度类措辞漏报（改动前任何 400 都进分支，改动后不能更差） ──

describe('M1：长度类措辞变体不漏报', () => {
  it.each([
    'This model requires 200000 tokens which is more than the maximum allowed 131072 tokens',
    'input too long: please reduce the length of the messages',
    'request too large for this model',
    'maximum allowed tokens: 65536 exceeded',
    'the input is too large for the model',
  ])('变体文本归 context_length：%s', (text) => {
    expect(classifyError(providerError(400, text)).reason).toBe('context_length');
  });

  it('非长度类 400 仍不误判（红线 4 的反向保护）', () => {
    expect(classifyError(providerError(400, 'model not found')).reason).not.toBe('context_length');
    expect(
      classifyError(providerError(400, 'messages: field required')).reason,
    ).not.toBe('context_length');
  });
});

// ── 评审 M2：抽取不得抓到「输出上限」等语义错位数字 ──

describe('M2：抽取邻域约束（防语义错抓污染真值表）', () => {
  it('context 语境 + output 上限 → 不当作窗口', () => {
    expect(
      extractContextWindowLimit(
        'context length exceeded: 25000 tokens > 4096 maximum output tokens',
      ),
    ).toBeUndefined();
  });

  it('max_tokens 输出上限文本 → 不当作窗口', () => {
    expect(
      extractContextWindowLimit('max_tokens: 8192 maximum output tokens for this model'),
    ).toBeUndefined();
  });

  it('正常窗口上限仍能提取（不被邻域约束误杀）', () => {
    expect(
      extractContextWindowLimit("This model's maximum context length is 128000 tokens."),
    ).toBe(128000);
    expect(extractContextWindowLimit('prompt is too long: 250000 tokens > 200000 maximum')).toBe(
      200000,
    );
  });
});

// ── 评审 M5：对象型 provider 错误（非 Error 实例）也能回填 ──

describe('M5：文本口径与分类器同源', () => {
  beforeEach(() => resetWindowTruth());

  it('普通对象错误 {status, message} → 分类为 context_length 且真值可回填', async () => {
    const objErr = {
      status: 400,
      message: "This model's maximum context length is 128000 tokens.",
    };
    const classified = classifyError(objErr);
    expect(classified.reason).toBe('context_length');

    const { result } = await inRunScope(fakeSnapshot({ contextWindow: 200_000 }), () =>
      applyContextLengthFeedback(classified, {}),
    );
    expect(result.action).toBe('backfilled');
    expect(result.measured).toBe(128_000);
  });
});
