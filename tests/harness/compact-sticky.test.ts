/**
 * 压缩视图粘滞 + proactiveCompactRatio=0 语义
 *
 * 红线：
 * 1. 已有压缩态后，估算回落或 ratio=0 都不得打回全量历史
 * 2. ratio=0 只禁**新** LLM 压缩，不丢弃 previousSummary 视图
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type { Message } from '@octopi-agent/core/types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function toolTurn(id: number, body: string): Message[] {
  return [
    {
      role: 'assistant',
      content: `step ${id}`,
      timestamp: Date.now(),
      toolCalls: [{ id: `tc-${id}`, name: 'file_read', arguments: { path: `f${id}.ts` } }],
    },
    {
      role: 'tool',
      timestamp: Date.now(),
      toolResults: [{ toolCallId: `tc-${id}`, name: 'file_read', result: body }],
    },
  ];
}

function bigBody(n: number): string {
  return `export const v${n} = ${JSON.stringify('x'.repeat(2000))}`;
}

describe('压缩视图粘滞 / proactiveCompactRatio=0', () => {
  it('ratio=0 时不发起新 LLM，但保留已有摘要视图（不回全量）', async () => {
    const messages: Message[] = [userMsg('do work')];
    for (let i = 0; i < 30; i++) {
      messages.push(...toolTurn(i, bigBody(i)));
    }
    messages.push(userMsg('continue'));
    for (let i = 30; i < 40; i++) {
      messages.push(...toolTurn(i, bigBody(i)));
    }

    const summarize = async () =>
      '## Conversation Summary\n### Done\n- built modules\n### Next\n- continue';

    // 第一次：允许 LLM，建立压缩态
    const warm = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      proactiveCooldownMs: 0,
      targetTokens: 1_000,
      compactFallbackRatio: 1.5,
    });
    const first = await warm.assemble({
      sessionId: 's-sticky',
      messages,
      systemPrompt: 'sys',
      tools: [],
      summarize,
      contextWindow: 1_000_000,
    });
    expect(first.messages.length).toBeLessThan(messages.length);

    // 第二次：同一引擎 + ratio 路径重建（冷却外），仍应是压缩视图
    const second = await warm.assemble({
      sessionId: 's-sticky',
      messages: [...messages, userMsg('more')],
      systemPrompt: 'sys',
      tools: [],
      summarize,
      contextWindow: 1_000_000,
    });
    expect(second.messages.length).toBeLessThan(messages.length + 2);

    // 新引擎模拟「配置 ratio=0 + 重启后 loadCompactState」
    const cold = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      proactiveCooldownMs: 0,
      targetTokens: 1_000,
      compactFallbackRatio: 1.5,
    });
    const restoredSummary = '[Conversation Summary]\n\n### Done\n- built modules\n### Next\n- continue';
    const after = await cold.assemble({
      sessionId: 's-sticky',
      messages: [...messages, userMsg('after restart')],
      systemPrompt: 'sys',
      tools: [],
      summarize,
      contextWindow: 1_000_000,
      loadCompactState: async () => ({
        summary: restoredSummary,
        lastProactiveMessageCount: messages.length,
        lastProactiveTokens: 100,
      }),
    });

    // 关键：不得打回全量（消息数远小于全量）
    expect(after.messages.length).toBeLessThan(messages.length);
    // 且不得含打码占位符主导的全量工具正文
    const text = after.messages.map((m) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    ).join('\n');
    expect(text).toContain('Conversation Summary');
  });

  it('无压缩态时 ratio=0 返回全量（不误造摘要）', async () => {
    const messages: Message[] = [userMsg('hello')];
    for (let i = 0; i < 10; i++) messages.push(...toolTurn(i, 'small'));

    const engine = new DefaultContextEngine({ proactiveCompactRatio: 0 });
    const result = await engine.assemble({
      sessionId: 's-no-compact',
      messages,
      systemPrompt: 'sys',
      tools: [],
      summarize: async () => 'should not be called',
      contextWindow: 1_000_000,
    });
    expect(result.messages.length).toBeGreaterThan(1);
  });
});

describe('方案 E：turn 内禁 LLM 摘要', () => {
  it('工具活动中不打 LLM，turn 边界才允许', async () => {
    const { isMidTurn } = await import(
      '@octopi-agent/engine/harness/context/default-context-engine.js'
    );
    const onlyUser: Message[] = [userMsg('start')];
    expect(isMidTurn(onlyUser)).toBe(false);

    const mid: Message[] = [userMsg('start'), ...toolTurn(1, 'body')];
    expect(isMidTurn(mid)).toBe(true);

    const afterNewUser: Message[] = [...mid, userMsg('next')];
    expect(isMidTurn(afterNewUser)).toBe(false);
  });

  it('turn 内超线：只机械，不调用 summarize', async () => {
    const summarize = vi.fn(async () => 'should-not-run');
    const messages: Message[] = [userMsg('long job')];
    for (let i = 0; i < 25; i++) messages.push(...toolTurn(i, bigBody(i)));

    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      proactiveCooldownMs: 0,
      targetTokens: 800,
      compactFallbackRatio: 1.5,
      protectFirstN: 2,
      protectLastN: 4,
    });

    await engine.assemble({
      sessionId: 's-mid-turn',
      messages,
      systemPrompt: 'sys',
      tools: [],
      summarize,
      contextWindow: 1_000_000,
    });
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe('审查修复：粘滞增量 / isMidTurn 注入 / 空丢弃', () => {
  it('粘滞重建保留摘要覆盖点之后的增量（不丢 tail 窗外新消息）', async () => {
    const { DefaultContextEngine: Eng } = await import(
      '@octopi-agent/engine/harness/context/default-context-engine.js'
    );
    const engine = new Eng({
      proactiveCompactRatio: 0,
      proactiveCooldownMs: 0,
      targetTokens: 1_000,
      compactFallbackRatio: 1.5,
      protectFirstN: 2,
      protectLastN: 4,
    });

    const prefix: Message[] = [userMsg('job')];
    for (let i = 0; i < 5; i++) prefix.push(...toolTurn(i, bigBody(i)));
    const coverCount = prefix.length;

    const increments: Message[] = [];
    for (let i = 10; i < 20; i++) increments.push(...toolTurn(i, `inc-${i}-` + 'y'.repeat(100)));

    const after = await engine.assemble({
      sessionId: 's-inc',
      messages: [...prefix, ...increments],
      systemPrompt: 'sys',
      tools: [],
      summarize: async () => 'should-not-run',
      contextWindow: 1_000_000,
      loadCompactState: async () => ({
        summary: '[Conversation Summary]\n### Done\n- prefix work',
        lastProactiveMessageCount: coverCount,
        lastProactiveTokens: 50,
      }),
    });

    const text = after.messages.map((m) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? m.toolResults),
    ).join('\n');
    // 粘滞视图必须含摘要 + 增量痕迹（不得退回「只有 head+旧摘要+tail」）
    expect(text).toContain('Conversation Summary');
    expect(text).toMatch(/inc-\d+-/);
    // 覆盖点之后的近期增量应可核验
    expect(text).toContain('inc-19-');
  });

  it('isMidTurn 忽略引擎注入（engineHint），不认 [System: 文案格式', async () => {
    const { isMidTurn } = await import(
      '@octopi-agent/engine/harness/context/default-context-engine.js'
    );
    const mid: Message[] = [userMsg('start'), ...toolTurn(1, 'body')];
    expect(isMidTurn(mid)).toBe(true);

    // 根因契约：来源是 engineHint 才算引擎注入（与文案前缀无关）
    const steered: Message[] = [
      ...mid,
      {
        role: 'user',
        content: 'please wrap up now',
        timestamp: Date.now(),
        metadata: { source: 'engineHint' },
      },
    ];
    expect(isMidTurn(steered)).toBe(true);

    // 真实用户发言（无 source）仍重置边界
    const realUser: Message[] = [...mid, userMsg('next human turn')];
    expect(isMidTurn(realUser)).toBe(false);
  });
});

describe('审查 P2 红线补测', () => {
  it('error 字段永不打码（HybridCompressor）', async () => {
    const { HybridCompressor } = await import(
      '@octopi-agent/engine/harness/context/hybrid-compressor.js'
    );
    const err = 'E_FILE_NOT_FOUND: missing /x.ts at line 3 ' + 'e'.repeat(400);
    const messages: Message[] = [
      userMsg('t'),
      {
        role: 'tool',
        timestamp: Date.now(),
        toolResults: [{ toolCallId: 'c1', name: 'file_read', error: err }],
      },
    ];
    const out = await new HybridCompressor().compress({
      messages,
      targetTokens: 1,
      tokenEstimator: new (await import(
        '@octopi-agent/engine/harness/context/token-estimator.js'
      )).HeuristicTokenEstimator(),
      // 不传 summarize：走机械/截断路径
    });
    const text = JSON.stringify(out.result);
    expect(text).toContain('E_FILE_NOT_FOUND');
    expect(text).not.toContain('archived in session log');
  });

  it('n≤6 时不插假「0 removed」通知', async () => {
    const { LLMSummaryCompressor } = await import(
      '@octopi-agent/engine/harness/context/llm-summarizer.js'
    );
    const { HeuristicTokenEstimator } = await import(
      '@octopi-agent/engine/harness/context/token-estimator.js'
    );
    const messages: Message[] = [userMsg('a'), userMsg('b'), userMsg('c')];
    // 无 summarize → fallbackTruncate
    const out = await new LLMSummaryCompressor().compress({
      messages,
      targetTokens: 1,
      tokenEstimator: new HeuristicTokenEstimator(),
    });
    expect(out.result).toHaveLength(3);
    expect(out.result.every((m) => !String(m.content).includes('0 earlier messages removed'))).toBe(
      true,
    );
  });

  it('fallbackTruncate 是 middle 替换体：不携带外层 head/tail 形状', async () => {
    const { LLMSummaryCompressor } = await import(
      '@octopi-agent/engine/harness/context/llm-summarizer.js'
    );
    const { HeuristicTokenEstimator } = await import(
      '@octopi-agent/engine/harness/context/token-estimator.js'
    );
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) messages.push(userMsg(`m-${i} ` + 'x'.repeat(80)));
    const out = await new LLMSummaryCompressor().compress({
      messages,
      targetTokens: 50,
      tokenEstimator: new HeuristicTokenEstimator(),
    });
    // 形状：一条截断/账本说明 + 近尾；不是把 messages[0] 当外层 head 保留
    expect(out.result[0]?.metadata?.source).toBe('contextSummary');
    expect(String(out.result[0]?.content)).toContain('Context truncated');
  });
});
