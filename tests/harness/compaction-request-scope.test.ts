/**
 * 压缩决策口径（2026-11-07 事故回归）：**触发读数与摘要请求都必须按实际请求形状**。
 *
 * 事故现场：会话视图 118,935 tokens（已压缩），而全量历史 621,088 tokens。
 * 旧实现用「老化后的全量历史」当触发读数，于是压缩把视图压小、却压不动读数——
 * 只要历史再涨 25% 阈值就必然重压一次，且每次重压都把 1.76M 字符的原文整段再发一遍
 * （实测 2.13MB 非流式请求，provider 20+ 分钟不返回）。
 *
 * 红线：
 * - 触发线/增长门只度量 fold 视图（+老化）= 实际发给 LLM 的 messages
 * - 摘要请求前缀 = 同一 fold 视图（含既有摘要占位），不是全量历史
 * - 口径版本不符的旧记录不得当作增长门基数（否则永久压制压缩）
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { anchorRange } from '@octopi-agent/engine/harness/context/transform/anchors.js';
import { HeuristicTokenEstimator } from '@octopi-agent/engine/harness/context/token-estimator.js';
import { InMemoryTransformStore } from '@octopi-agent/engine/harness/session/transform-store.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text, timestamp: Date.now() };
}

/** 成对的 user/assistant 长文本轮次（老化不动纯文本，确保「全量读数」确实很大） */
function textTurns(count: number, chars: number, tag: string): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i++) {
    out.push(userMsg(`question ${tag}-${i} ${'q'.repeat(40)}`));
    out.push(assistantMsg(`${tag}-${i} ${'a'.repeat(chars)}`));
  }
  return out;
}

describe('压缩决策口径 = 实际请求（P1）', () => {
  it('已压缩会话：全量历史远超触发线但视图很小 → 不得再次触发压缩', async () => {
    const summarize = vi.fn(async () => '## Conversation Summary\nshould-not-run');
    const engine = new DefaultContextEngine({ proactiveCooldownMs: 0 });
    // 400 轮 × ~8000 字符 ≈ 800k token 全量；视图 = 5 头 + 占位 + 20 尾 ≈ 50k
    const messages = textTurns(400, 8000, 'hist');
    const coverEnd = messages.length - 20;

    const result = await engine.assemble({
      messages,
      sessionId: 's-view-small',
      systemPrompt: 'sys',
      tools: [],
      contextWindow: 1_048_576,
      tokenBudget: 1_048_576,
      summarize,
      // 已压缩态：摘要覆盖 [headEnd, coverEnd)，尾部 20 条原样保留
      loadCompactState: () => ({
        summary: '## 交接摘要\n既有摘要正文',
        lastProactiveMessageCount: messages.length - 10,
        lastProactiveCoverEnd: coverEnd,
      }),
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.estimatedTokens).toBeLessThan(600_000);
    expect(result.summary).toContain('既有摘要正文');
  });

  it('视图本身超线时仍照常压缩（口径修正不等于关闭压缩）', async () => {
    const summarize = vi.fn(async () => '## Conversation Summary\ncompacted');
    // targetTokens=0 → 只挂窗口比例线；tokenBudget 小 → 视图必然超线
    const engine = new DefaultContextEngine({
      targetTokens: 0,
      proactiveCompactRatio: 0.5,
      proactiveCooldownMs: 0,
    });
    const messages = textTurns(30, 4000, 'live');

    await engine.assemble({
      messages,
      sessionId: 's-view-over',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 20_000,
      contextWindow: 1_048_576,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
  });
  it('视图超线但中段已被全部覆盖 → 零 LLM 复用，不得退化成摘要风暴', async () => {
    const summarize = vi.fn(async () => '## Conversation Summary\nshould-not-run');
    const engine = new DefaultContextEngine({
      targetTokens: 0,
      proactiveCompactRatio: 0.5,
      proactiveCooldownMs: 0,
    });
    // 视图超线（尾部很大），但中段全在既有摘要覆盖内：重压只会原样复述上一份交接书
    const messages = [...textTurns(30, 4000, 'allcovered'), ...textTurns(11, 7000, 'tail')];

    await engine.assemble({
      messages,
      sessionId: 's-no-new-content',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 20_000,
      contextWindow: 1_048_576,
      summarize,
      loadCompactState: () => ({
        summary: '## 交接摘要\n既有摘要正文',
        lastProactiveMessageCount: messages.length - 10,
        lastProactiveCoverEnd: messages.length - 20,
      }),
    });

    expect(summarize).not.toHaveBeenCalled();
  });
});

describe('摘要请求前缀 = 折叠视图（P2）', () => {
  /** 中段大部分已被摘要覆盖、尾部很大 —— 视图超线，且仍有未覆盖的新消息可并入 */
  function foldedSession(tag: string): { messages: Message[]; coverEnd: number } {
    const covered = textTurns(30, 4000, tag);
    const tail = textTurns(11, 7000, 'tail');
    const messages = [...covered, ...tail];
    // 覆盖到尾部 40 条之前：既保留「上一份摘要」，又留下 20 条未覆盖的新消息
    return { messages, coverEnd: messages.length - 40 };
  }

  it('前缀含既有摘要占位、不含已覆盖原文；请求体量随视图而非全量历史', async () => {
    const captured: Array<{ role?: string; content?: unknown }> = [];
    const summarize = vi.fn(async (msgs: Array<{ role?: string; content?: unknown }>) => {
      captured.push(...msgs);
      return '## Conversation Summary\nfresh-handoff';
    });
    const engine = new DefaultContextEngine({
      targetTokens: 0,
      proactiveCompactRatio: 0.5,
      proactiveCooldownMs: 0,
    });
    const { messages, coverEnd } = foldedSession('RAW-COVERED-MARKER');

    await engine.assemble({
      messages,
      sessionId: 's-prefix-shape',
      systemPrompt: 'SYS-EXACT',
      tools: [],
      tokenBudget: 20_000,
      contextWindow: 1_048_576,
      summarize,
      loadCompactState: () => ({
        summary: 'PREV-SUMMARY-9f3a 既有交接书正文',
        lastProactiveMessageCount: messages.length - 10,
        lastProactiveCoverEnd: coverEnd,
      }),
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    const joined = JSON.stringify(captured);
    expect(joined).toContain('PREV-SUMMARY-9f3a');
    // 已覆盖中段不得出现在摘要请求里（旧实现把全部历史当前缀）；
    // 头部 5 条受保护、尾部未覆盖段原样保留，故只断言被覆盖的早期中段
    expect(joined).not.toContain('RAW-COVERED-MARKER-10');
    expect(joined).not.toContain('RAW-COVERED-MARKER-15');
    // 形状 = system + 折叠视图 + 一条尾部指令，远小于原始条数
    expect(captured[0]?.role).toBe('system');
    expect(captured.length).toBeLessThan(messages.length);
    // 尾部指令承载交接要求，且说明是「并入上一份交接书」
    const tailInstruction = String(captured[captured.length - 1]?.content);
    expect(tailInstruction).toContain('Fold boundary');
    expect(tailInstruction).toContain('previous handoff');
  });

  it('模型沿用上一份交接书措辞不得被判为复读污染', async () => {
    const prevSummary = [
      'Goal & status: ship the compaction reading-scope fix with tests.',
      'Open items: none outstanding, waiting on review before commit.',
      'Conclusions: trigger reading must measure the request view only.',
      'Evidence pointers: packages/engine/src/harness/context/default-context-engine.ts',
    ].join('\n');
    // 输出 = 旧摘要原文 + 一行新增 → 旧实现命中 ≥3 行判 verbatim_echo，二次重试后降级
    const summarize = vi.fn(async () => `${prevSummary}\nOpen items: review pending.`);
    const engine = new DefaultContextEngine({
      targetTokens: 0,
      proactiveCompactRatio: 0.5,
      proactiveCooldownMs: 0,
    });
    const { messages, coverEnd } = foldedSession('echo');

    await engine.assemble({
      messages,
      sessionId: 's-echo-prev-summary',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 20_000,
      contextWindow: 1_048_576,
      summarize,
      loadCompactState: () => ({
        summary: prevSummary,
        lastProactiveMessageCount: messages.length - 10,
        lastProactiveCoverEnd: coverEnd,
      }),
    });

    // 污染检测会触发一次加严重试 → 两次调用；未被误判则只有一次
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});

describe('增长门基数只随压缩完成推进', () => {
  it('早退（增长门不足）不得刷新基数，否则压缩永久饿死', async () => {
    const estimator = new HeuristicTokenEstimator();
    /** 收敛到目标 token 的等长消息（比例迭代，误差 <2%） */
    function fitMsgs(target: number, count: number, tag: string): Message[] {
      let chars = 200;
      for (let attempt = 0; attempt < 24; attempt++) {
        const out = Array.from({ length: count }, (_, k) =>
          assistantMsg(`${tag}-${k} ${'x'.repeat(chars)}`),
        );
        const tokens = estimator.estimateMessages(out);
        if (Math.abs(tokens - target) <= target * 0.02) return out;
        chars = Math.max(1, Math.round((chars * target) / Math.max(1, tokens)));
      }
      throw new Error(`fitMsgs(${target}) 未能收敛`);
    }

    const sessionId = 's-gate-advance';
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      targetTokens: 20_000, // 触发线 60k，25% 增长门 = 15k
      proactiveCompactRatio: 0.5,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    const summarize = vi.fn(async () => '## 交接摘要\ncompressed');

    const head = fitMsgs(250, 5, 'head');
    const middle = fitMsgs(12_000, 12, 'mid');
    const tail = fitMsgs(60_000, 20, 'tail');
    let messages = [...head, ...middle, ...tail];

    // 种一条 summary 记录：覆盖中段前 10 条，留 2 条未覆盖（绕过「零新内容」守卫）；
    // 基数 = 55k（视图口径），故视图需 ≥70k 才允许再压。
    await store.append(sessionId, '', [
      {
        sessionId,
        agentId: '',
        type: 'summary',
        createdAt: Date.now(),
        covers: [anchorRange(messages, 5, 14)!],
        text: '## 交接摘要\nbase',
        placeholder: { role: 'user', source: 'contextSummary' },
        meta: {
          reason: 'proactive',
          fresh: true,
          summarizeAttempted: true,
          messageCount: 5,
          viewTokens: 55_000,
          viewTokensSource: 'request',
        },
      },
    ]);

    const run = () =>
      engine.assemble({
        messages,
        sessionId,
        systemPrompt: 'sys',
        tools: [],
        tokenBudget: 1_048_576,
        contextWindow: 1_048_576,
        summarize,
      });

    // 轮 1：视图 ≈62k < 70k → 早退。若此处刷新基数（62k），门槛会抬到 77k。
    await run();
    expect(summarize).not.toHaveBeenCalled();

    // 轮 2：视图 ≈74k。基数仍是 55k → 74k ≥ 70k → 必须压缩；
    // 若轮 1 刷新过基数，74k < 77k 会再次早退（永久饿死）。
    messages = [...head, ...middle, ...fitMsgs(12_000, 4, 'more'), ...tail];
    await run();
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});

describe('增长门口径版本（自愈）', () => {
  it('旧引擎写的全量口径基数不得压制压缩（无 viewTokensSource）', async () => {
    const summarize = vi.fn(async () => '## Conversation Summary\nself-healed');
    // targetTokens=20k → 触发线 60k；视图（5 头 + 占位 + 20 尾 × 12800）≈ 80k → 超线
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      targetTokens: 20_000,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    const messages = textTurns(100, 12_800, 'heal');
    const coverEnd = messages.length - 60;
    const sessionId = 's-gate-version';

    // 旧引擎写下的记录形状：fullTokens = 全量口径 621k，viewTokens = 118k，无口径标记。
    // 旧代码会把 118k 当增长门基数（要求再涨 25% 阈值才允许压缩），于是永远压不动。
    await store.append(sessionId, '', [
      {
        sessionId,
        agentId: '',
        type: 'summary',
        createdAt: Date.now(),
        covers: [anchorRange(messages, 5, coverEnd - 1)!],
        text: '## 交接摘要\nlegacy-summary',
        placeholder: { role: 'user', source: 'contextSummary' },
        meta: {
          reason: 'proactive',
          fresh: true,
          summarizeAttempted: true,
          messageCount: messages.length - 10,
          fullTokens: 621_088,
          viewTokens: 118_935,
        },
      },
    ]);

    await engine.assemble({
      messages,
      sessionId,
      systemPrompt: 'sys',
      tools: [],
      contextWindow: 1_048_576,
      tokenBudget: 1_048_576,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
