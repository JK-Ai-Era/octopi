/**
 * 压缩视图粘滞 + proactiveCompactRatio=0 语义
 *
 * 红线：
 * 1. 已有压缩态后，估算回落或 ratio=0 都不得打回全量历史
 * 2. ratio=0 禁**新的路径 A 压缩**（不只禁 LLM），不丢弃 previousSummary 视图
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
      content: '',
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
    // turn 边界（最后一条是 user、其后无工具活动）：才允许新 LLM 摘要。
    // midTurn 时装配层不再做机械降级（改为等 turn 边界），故建立压缩态须靠边界。
    messages.push(userMsg('now summarize'));

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
        // 覆盖终点是粘滞增量的起点：缺失等于把 headEnd..tailStart 全当增量（视图回涨）
        lastProactiveCoverEnd: messages.length - 20,
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

  it('无压缩态时 ratio=0 返回全量（不误造摘要、不机械压扁）', async () => {
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
    // 强断言：未建压缩态时不得把 middle 机械压掉
    expect(result.messages.length).toBeGreaterThan(1);
    expect(result.messages.length).toBeGreaterThanOrEqual(messages.length - 1);
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
  it('记录覆盖点之后的增量逐字保留（不丢 tail 窗外新消息）', async () => {
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
        lastProactiveCoverEnd: coverCount,
        lastProactiveTokens: 50,
      }),
    });

    const text = after.messages.map((m) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? (m as { toolResults?: unknown }).toolResults),
    ).join('\n');
    // 记录视图必须含摘要 + 增量痕迹（不得退回「只有 head+旧摘要+tail」）
    expect(text).toContain('Conversation Summary');
    expect(text).toMatch(/inc-\d+-/);
    // 覆盖点之后的近期增量应可核验
    expect(text).toContain('inc-19-');
  });

  it('快照缺 coverEnd（覆盖未知）：不虚报覆盖，全部原文可见（宁胖不丢）', async () => {
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
      sessionId: 's-inc2',
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
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
    ).join('\n');
    // 覆盖未知 = 不得声称任何区间已覆盖：原文全量可见（含 prefix 正文与增量）
    expect(text).toContain('export const v0');
    expect(text).toContain('inc-19-');
  });

  it('isMidTurn 忽略引擎注入（engineHint），不认 [System: 文案格式', async () => {
    const { isMidTurn } = await import(
      '@octopi-agent/engine/harness/context/default-context-engine.js'
    );
    const mid: Message[] = [userMsg('start'), ...toolTurn(1, 'body')];
    expect(isMidTurn(mid)).toBe(true);

    // 根因契约：来源是 engineHint 才算引擎注入（与文案前缀无关）
    const continued: Message[] = [
      ...mid,
      {
        role: 'user',
        content: 'please wrap up now',
        timestamp: Date.now(),
        metadata: { source: 'engineHint' },
      },
    ];
    expect(isMidTurn(continued)).toBe(true);

    // 真实用户发言（无 source）仍重置边界
    const realUser: Message[] = [...mid, userMsg('next human turn')];
    expect(isMidTurn(realUser)).toBe(false);
  });
});

describe('审查 P2 红线补测（机械降级 = purpose 账本）', () => {
  it('error 永不计略（错误可追溯性优先）：账本保留失败信息', async () => {
    const { buildToolCallLedger } = await import(
      '@octopi-agent/engine/harness/context/capabilities/compact/mechanical.js'
    );
    const err = 'E_FILE_NOT_FOUND: missing /x.ts at line 3 ' + 'e'.repeat(100);
    const messages: Message[] = [
      userMsg('t'),
      {
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [{ id: 'c1', name: 'file_read', arguments: { purpose: 'Read /x.ts' } }],
      },
      {
        role: 'tool',
        content: '',
        timestamp: Date.now(),
        toolResults: [{ toolCallId: 'c1', name: 'file_read', result: null, error: err }],
      },
    ];
    const ledger = buildToolCallLedger(messages);
    expect(ledger).toContain('file_read: Read /x.ts');
    expect(ledger).toContain('E_FILE_NOT_FOUND');
  });

  it('n≤floor 时不插假「0 removed」通知', async () => {
    const { ledgerTruncate } = await import(
      '@octopi-agent/engine/harness/context/capabilities/compact/mechanical.js'
    );
    const messages: Message[] = [userMsg('a'), userMsg('b'), userMsg('c')];
    const { result, droppedCount } = ledgerTruncate(messages, { targetTokens: 1 });
    expect(droppedCount).toBe(0);
    expect(result).toHaveLength(3);
    expect(result.every((m) => !String(m.content).includes('0 earlier messages removed'))).toBe(
      true,
    );
  });

  it('账本截断是 middle 替换体：说明 + 近尾，不携带外层 head 形状', async () => {
    const { ledgerTruncate } = await import(
      '@octopi-agent/engine/harness/context/capabilities/compact/mechanical.js'
    );
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) messages.push(userMsg(`m-${i} ` + 'x'.repeat(80)));
    const { result } = ledgerTruncate(messages, { targetTokens: 50 });
    // 形状：一条账本说明 + 近尾；不是把 messages[0] 当外层 head 保留
    expect(result[0]?.metadata?.source).toBe('contextLedger');
    expect(String(result[0]?.content)).toContain('Context truncated');
    expect(result.some((m) => String(m.content).startsWith('m-19'))).toBe(true);
    expect(result.some((m) => String(m.content).startsWith('m-0 '))).toBe(false);
  });
});
