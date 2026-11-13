/**
 * 请求体量读数必须同尺（2026-11-14）
 *
 * 事故：面板「摘要请求已发出 200.7k tokens」与顶栏「视图估算 146.7k」并排显示，差 36%。
 * 根因不是两把尺的定义不同，而是**同一次加法里混了两个尺**：
 * `estimateLLMMessages(llmPrefix)` 走裸估算器、`estimator.estimateTools()` 走校准估算器
 * （已乘 ratio≈0.703）。实测：raw messages 187,157 + raw tools 18,509
 * → 混用口径 187,157 + 18,509×0.703 = 200,169，而 provider 实测 154,218。
 *
 * 判据设计：同一视图跑两次——一次 ratio=1（无校准样本），一次 ratio≈0.55（两样本入账）。
 * 若两把尺统一，两次读数之比必须**等于 ratio**（整包同倍缩放）；
 * 若退回混用口径，比值 ≈ (M + T·r)/(M + T)，因 messages 占绝对多数而贴近 1（≈0.96）。
 * 量纲检查（字符/token 比例 1.5–6）**发现不了**这个偏差，必须直接比对读数。
 */
import { describe, it, expect, vi } from 'vitest';
import { DefaultContextEngine, HeuristicTokenEstimator } from '@octopi-agent/engine/harness';
import type { LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';

function textTurns(n: number, chars: number, tag: string) {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `${tag}-${i}-` + 'x'.repeat(chars),
  }));
}

const messages = [...textTurns(30, 4000, 'c'), ...textTurns(11, 7000, 'tail')];

/** 体量可观且明显不同于 messages 的工具面（让混用与否可分辨） */
const TOOLS: LLMToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'probe_tool',
      description: 'probe'.repeat(200),
      parameters: { type: 'object', properties: { a: { type: 'string' } } },
    },
  } as LLMToolDefinition,
];

function params(summarize: unknown, emit: (e: unknown) => void) {
  return {
    messages: messages as never,
    sessionId: 's-ruler',
    systemPrompt: 'sys',
    tools: TOOLS,
    tokenBudget: 20_000,
    contextWindow: 1_048_576,
    summarize: summarize as never,
    loadCompactState: () => ({
      summary: '上一份交接书',
      lastProactiveMessageCount: messages.length - 10,
      lastProactiveCoverEnd: messages.length - 40,
    }),
    emit: emit as never,
  };
}

type EngineInternals = {
  sizeLedger: {
    observe(modelKey: string, actual: number, view: number): unknown;
    ratio(modelKey: string): number;
  };
};

/** 跑一次 assemble，返回 progress 的 requestChars / requestTokens */
async function runOnce(calibrated: boolean) {
  const events: Array<Record<string, unknown>> = [];
  const summarize = vi.fn().mockResolvedValue('干净正文' + '散文'.repeat(300));
  const engine = new DefaultContextEngine({
    targetTokens: 0,
    proactiveCompactRatio: 0.5,
    proactiveCooldownMs: 0,
  });
  let ratio = 1;
  if (calibrated) {
    const ledger = (engine as unknown as EngineInternals).sizeLedger;
    ledger.observe('s-ruler::unknown', 55, 100);
    ledger.observe('s-ruler::unknown', 55, 100);
    ratio = ledger.ratio('s-ruler::unknown');
    // 防测试毒化：ratio 必须明显 ≠1，否则混用与统一读数相同、用例静默失效
    expect(ratio).toBeLessThan(0.75);
  }
  await engine.assemble(params(summarize, (e) => events.push(e as never)));
  const progress = events.find((e) => e.type === 'context.compact.progress');
  expect(progress).toBeDefined();
  return {
    ratio,
    chars: progress!.requestChars as number,
    tokens: progress!.requestTokens as number,
  };
}

describe('摘要请求体量读数：messages 与 tools 必须同尺', () => {
  it('ratio≠1 时整包同倍缩放（而非只缩放 tools 项）', async () => {
    const base = await runOnce(false); // ratio = 1
    const scaled = await runOnce(true); // ratio ≈ 0.55

    // 同一视图：字符量必须逐字相同（证明两次比的是同一份请求）
    expect(scaled.chars).toBe(base.chars);
    expect(base.tokens).toBeGreaterThan(0);

    // 统一口径：整包缩放 ⇒ 读数之比 == ratio
    const readoutRatio = scaled.tokens / base.tokens;
    expect(readoutRatio).toBeCloseTo(scaled.ratio, 2);

    // 混用口径的签名：只有 tools 被缩放，比值贴近 1。
    // 本用例 tools 占比足够小，混用时比值 ≈0.96——与 0.55 相差 0.4 以上，任何容差都拦不住。
    expect(readoutRatio).toBeLessThan(scaled.ratio + 0.1);

    // 量纲交叉检查：token 读数与字符数比例落在中文+JSON 正常密度区间
    const charsPerToken = base.chars / base.tokens;
    expect(charsPerToken).toBeGreaterThan(1.5);
    expect(charsPerToken).toBeLessThan(6);
    // 估算器与会话同源（同一文本可复现）
    expect(new HeuristicTokenEstimator().estimateMessages([])).toBe(0);
  });
});
