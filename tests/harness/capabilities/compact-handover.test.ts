/**
 * 交接式摘要（2026-10-28 拍板）行为测试
 *
 * 定位：摘要的本质是把之前会话做的事说清楚、交接给后续对话（非中段压缩编码）。
 * 锚定六条：
 * 1. 交接指令 = 四段式（①goal+状态 ②未决项与承诺 ③结论与拍板(含理由) ④证据指针）+ 反回声纪律
 * 2. llmPrefix 分支：前缀逐字保留（缓存同形），指令/task 快照只挂在尾部 user
 * 3. task 快照随指令尾部注入（B0 易变块走 content 尾部，不进 system）
 * 4. 输出闸门：对话体/工具调用形状与逐字回声判污染，加严指令重试一次
 * 5. 二次污染按摘要失败降级——不静默把坏摘要（原文续写）落盘
 * 6. 摘要软目标预算 clamp(2%, 2k, 8k)（P1c）：写进指令当软目标，禁止作 provider 硬顶
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import {
  createCompactEngine,
  summarySoftTargetTokens,
} from '@octopi-agent/engine/harness/context/capabilities/compact/engine.js';
import { renderSessionTasksInjection } from '@octopi-agent/engine/harness/session/tasks/render.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

const CLEAN_HANDOFF = [
  '1. Goal & status: batch-2 landed, standing by.',
  '2. Open items & commitments: none.',
  '3. Conclusions & decisions: handover-summary route (rationale: cache + continuity).',
  '4. Evidence pointers: tests/harness/capabilities/compact-handover.test.ts.',
].join('\n');

const CONTAMINATED = '继续干活：\n<function=file_edit><new_text>x</new_text></function>';

describe('交接式摘要：指令形态与注入', () => {
  it('llmPrefix 分支：前缀逐字保留，四段式交接指令 + task 快照只在尾部 user', async () => {
    const summarize = vi.fn(async (_m: LLMMessage[], _o?: { maxTokens?: number }) => CLEAN_HANDOFF);
    const engine = createCompactEngine();
    const prefix: LLMMessage[] = [
      { role: 'system', content: 'SYS-BYTES' },
      { role: 'user', content: 'h1' },
      { role: 'assistant', content: 'h2' },
    ];
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}-content`));
    const out = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
      requestView: { messages: prefix, tools: [] },
      taskSnapshot: '<session_tasks>\n- [t1] open | 批次2\n</session_tasks>',
      foldRange: { replacedCount: 3, total: 8, preservedTail: 3 },
    });

    const request = summarize.mock.calls[0]![0] as LLMMessage[];
    // 前缀逐字（缓存同形纪律）：原样在最前，指令不进 system、不重排历史
    expect(request.slice(0, prefix.length)).toEqual(prefix);
    expect(request).toHaveLength(prefix.length + 1);
    const tail = String(request[request.length - 1]!.content);
    expect(tail).toContain('handoff summary');
    expect(tail).toContain('Goal & status');
    expect(tail).toContain('Open items & commitments');
    expect(tail).toContain('Conclusions & decisions');
    expect(tail).toContain('Evidence pointers');
    expect(tail).toContain('keep the summary off the preserved one');
    // 折叠区间边界（评审 F7）：交接书替换到哪、哪些原样保留，模型必须先知道
    expect(tail).toContain('Fold boundary');
    expect(tail).toContain('summarizes 3 older messages of 8');
    // task 快照在指令尾部（B0：易变块走 content 尾部）
    expect(tail).toContain('<session_tasks>');
    expect(tail.indexOf('<session_tasks>')).toBeGreaterThan(tail.indexOf('Evidence pointers'));
    expect(out.summary).toBe(CLEAN_HANDOFF);
    expect(out.summarizeAttempted).toBe(true);
  });

  it('task 快照渲染 includeGuidance=false：只留状态，不带对话引导语', () => {
    const tasks = [
      { id: 'g1', status: 'open', description: '批次2 交接式摘要', createdAt: 1, order: 0 },
    ];
    const bare = renderSessionTasksInjection(tasks as never, { includeGuidance: false });
    expect(bare).toContain('批次2 交接式摘要');
    expect(bare).not.toContain('说明');
    expect(bare).not.toContain('task_complete');
    const full = renderSessionTasksInjection(tasks as never);
    expect(full).toContain('说明');
  });

  it('无 summarizeFn 机械路径：summarizeAttempted=false（冷却不得被机械降级推进）', async () => {
    const engine = createCompactEngine();
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}-content`));
    const out = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
    });
    expect(out.fresh).toBeFalsy();
    expect(out.summarizeAttempted).toBe(false);
  });

  it('empty_middle：不发空摘要请求，summarizeAttempted=false', async () => {
    const summarize = vi.fn(async () => CLEAN_HANDOFF);
    const engine = createCompactEngine();
    // 空正文消息文本化为空 → 不允许发空 user / 空 New content（严格网关红线）
    const messages = Array.from({ length: 8 }, () => userMsg(''));
    const out = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(out.summarizeAttempted).toBe(false);
  });

  it('window_exhausted：请求构造不出即返回，summarizeAttempted=false', async () => {
    const summarize = vi.fn(async () => CLEAN_HANDOFF);
    const engine = createCompactEngine();
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}-content`));
    const out = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
      // 窗口装不下文本化请求（input+output 超窗）→ providerMaxTokens<256，走 window_exhausted 守卫
      contextWindow: 200,
      maxOutputTokens: 50,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(out.summarizeAttempted).toBe(false);
  });

  it('文本化工具结果三形态（error/字符串/对象）走共享 toolResultBody 序列化', async () => {
    let body = '';
    const summarize = vi.fn(async (m: LLMMessage[]) => {
      body = String(m[m.length - 1]!.content);
      return CLEAN_HANDOFF;
    });
    const engine = createCompactEngine();
    const toolMsg: Message = {
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolResults: [
        { toolCallId: 't1', name: 'a', result: 'str-body' },
        { toolCallId: 't2', name: 'b', result: undefined, error: 'boom' },
        { toolCallId: 't3', name: 'c', result: { k: 1 } },
      ],
    };
    await engine.compactMessages([toolMsg, userMsg('tail-context')], {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
    });
    expect(body).toContain('str-body');
    expect(body).toContain('{"error":"boom"}');
    expect(body).toContain('{"k":1}');
  });
});

describe('交接式摘要：输出闸门（续写污染防护）', () => {
  it('输出带对话体/工具调用形状 → 判污染，加严指令重试一次后接受', async () => {
    const summarize = vi
      .fn(async (_m: LLMMessage[], _o?: unknown): Promise<string> => '')
      .mockResolvedValueOnce(CONTAMINATED)
      .mockResolvedValueOnce(CLEAN_HANDOFF);
    const engine = createCompactEngine();
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}-content`));
    const out = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(2);
    // 重试请求带加严指令（明确禁止回声/对话体）
    const retryRequest = summarize.mock.calls[1]![0] as LLMMessage[];
    const retryTail = String(retryRequest[retryRequest.length - 1]!.content);
    expect(retryTail).toContain('previous attempt replayed input passages');
    expect(out.summary).toBe(CLEAN_HANDOFF);
  });

  it('重试仍污染 → 按摘要失败降级：坏摘要不落盘，旧摘要保留', async () => {
    const summarize = vi.fn(async (_m: LLMMessage[], _o?: unknown) => CONTAMINATED);
    const engine = createCompactEngine();
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}-content`));
    const out = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
      previousSummary: 'old summary',
    });

    expect(summarize).toHaveBeenCalledTimes(2);
    // 不静默存坏摘要（原文续写会让折叠掉的中段信息全丢）
    expect(out.summary).toBe('old summary');
    expect(out.summary).not.toContain('<function=');
    // 失败也算发起过（成功/失败均算）：冷却推进诚实性（F8R-01）
    expect(out.summarizeAttempted).toBe(true);
    expect(Array.isArray(out.view)).toBe(true);
  });

  it('逐字回声（复读输入长行）→ verbatim_echo 判污染', async () => {
    const longLine = 'L'.repeat(150);
    const summarize = vi
      .fn(async (_m: LLMMessage[], _o?: unknown): Promise<string> => '')
      .mockResolvedValueOnce(`summary:\n${longLine}`)
      .mockResolvedValueOnce(CLEAN_HANDOFF);
    const engine = createCompactEngine();
    const messages = [
      userMsg('open'),
      ...Array.from({ length: 6 }, (_, i) => userMsg(`m${i}-content`)),
      userMsg(longLine),
    ];
    const out = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(out.summary).toBe(CLEAN_HANDOFF);
  });
});

describe('摘要软目标预算（P1c clamp(2%, 2k, 8k)）', () => {
  it('钳制公式：2% 比例、2k 下限、8k 上限', () => {
    expect(summarySoftTargetTokens(500_000)).toBe(8000); // 2%=10k → 上限 8k
    expect(summarySoftTargetTokens(200_000)).toBe(4000); // 2%=4k
    expect(summarySoftTargetTokens(50_000)).toBe(2000); // 2%=1k → 下限 2k
  });

  it('规格即三参数 clamp（评审 F13：无「不超过输入」等未记录规则）；ratio/min/max 可配置', () => {
    expect(summarySoftTargetTokens(1_000)).toBe(2000); // 2% < 下限 2k → 下限生效（软目标，不整形）
    expect(summarySoftTargetTokens(100_000, { ratioPct: 5, minTokens: 100, maxTokens: 3000 })).toBe(3000);
    expect(summarySoftTargetTokens(2_000, { ratioPct: 10, minTokens: 100, maxTokens: 5000 })).toBe(200);
  });

  it('软目标写进指令；provider 硬顶取 4 倍保险丝（禁硬截断/静默半截）', async () => {
    const summarize = vi.fn(async (_m: LLMMessage[], _o?: { maxTokens?: number }) => CLEAN_HANDOFF);
    const engine = createCompactEngine();
    // 8 × 1200 字符 ≈ 2400+ tokens → 软目标 = clamp(2%, 2k, 8k) = 2000
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}-${'x'.repeat(1200)}`));
    await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
    });

    const request = summarize.mock.calls[0]![0] as LLMMessage[];
    const system = String(request[0]!.content);
    expect(system).toContain('under 2000 tokens');
    // 硬顶是软目标的 4 倍保险丝，不是整形工具
    expect(summarize.mock.calls[0]![1]).toMatchObject({ maxTokens: 8000 });
  });
});

describe('闸门判据边界与窗口护栏（评审 F2/F3/F4/F5）', () => {
  it('llmPrefix 分支回声比对源含 head/tail（F2）：复读前缀长行同样判污染', async () => {
    const longLine = 'H'.repeat(150);
    const summarize = vi
      .fn(async (_m: LLMMessage[], _o?: unknown): Promise<string> => '')
      .mockResolvedValueOnce(`handoff draft:\n${longLine}`)
      .mockResolvedValueOnce(CLEAN_HANDOFF);
    const engine = createCompactEngine();
    const prefix: LLMMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: longLine },
    ];
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}-content`));
    const out = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
      requestView: { messages: prefix, tools: [] },
    });
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(out.summary).toBe(CLEAN_HANDOFF);
  });

  it('成段短行复读（每行 <120 字符）→ 多行判据命中（F3）', async () => {
    const replay = [
      '- alpha point being replayed verbatim from the conversation history',
      '- beta point being replayed verbatim from the conversation history',
      '- gamma point being replayed verbatim from the conversation history',
    ].join('\n');
    const summarize = vi
      .fn(async (_m: LLMMessage[], _o?: unknown): Promise<string> => '')
      .mockResolvedValueOnce(replay)
      .mockResolvedValueOnce(CLEAN_HANDOFF);
    const engine = createCompactEngine();
    const messages = [userMsg('open'), userMsg(replay), userMsg('close')];
    const out = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
    });
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(out.summary).toBe(CLEAN_HANDOFF);
  });

  it('单条证据行引用不判污染（F4：引用≠回声）', async () => {
    const decision = 'D'.repeat(150);
    const quoted = [
      '1. Goal & status: batch work underway.',
      '2. Open items & commitments: none pending.',
      `3. Conclusions & decisions: adopted "${decision}" as the ruling.`,
      '4. Evidence pointers: changelog entry.',
    ].join('\n');
    const summarize = vi.fn(async (_m: LLMMessage[], _o?: unknown) => quoted);
    const engine = createCompactEngine();
    const messages = [userMsg('open'), userMsg(decision), userMsg('more talk here'), userMsg('close')];
    const out = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
    });
    // 单行引用不触发闸门：不重试、不降级（四段式天然要引用拍板原话/报错行）
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(out.summary).toBe(quoted);
  });

  it('窗口护栏（F5）：保险丝被窗口钳制；前缀放不下时回退文本化旁路', async () => {
    const summarize = vi.fn(async (_m: LLMMessage[], _o?: unknown) => CLEAN_HANDOFF);
    const engine = createCompactEngine();
    // 20 条 ×~1k 字符 ≈ 5k tokens；尾部保护 18 → 中段仅 2 条（文本化旁路输入很小）
    const messages = Array.from({ length: 20 }, (_, i) => userMsg(`m${i}-${'x'.repeat(990)}`));
    const prefix: LLMMessage[] = [
      { role: 'system', content: 'SYS' },
      ...messages.map((m) => ({ role: 'user' as const, content: String(m.content) })),
    ];
    await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 18,
      summarizeFn: summarize,
      requestView: { messages: prefix, tools: [] },
      contextWindow: 3000,
    });

    const request = summarize.mock.calls[0]![0] as LLMMessage[];
    // 前缀 + 保险丝放不下窗口 → 文本化中段旁路（如实 cache-miss，不再顶窗 400）
    expect(request).toHaveLength(2);
    const cap = (summarize.mock.calls[0]![1] as { maxTokens: number }).maxTokens;
    expect(cap).toBeLessThan(2000 * 4); // 保险丝被 0.1×window 钳制
    expect(cap).toBeGreaterThanOrEqual(256);
  });
});

describe('F8 模板统一：降级标志与可观测（评审 F1/F5/F22）', () => {
  it('空白摘要（纯空白）不冒充 fresh：按失败降级且 summarizeAttempted 如实', async () => {
    // 旧 trim 守卫随三件套删除后的收口钉：'   ' 若冒充 fresh 会写空前摘要并推进覆盖点
    const blankMsgs = Array.from({ length: 6 }, (_, i) => userMsg(`${'abcdef'[i]}${'x'.repeat(200)}`));
    const blankEngine = createCompactEngine();
    const out = await blankEngine.compactMessages(blankMsgs, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: async () => '   \n\n ',
    });
    expect(out.fresh).toBeFalsy();
    expect(out.summarizeAttempted).toBe(true); // 调用发起过 → 冷却推进
    expect(out.summary).toBeUndefined(); // 空白不得进 summary 字段
  });

  it('机械降级不冒充新摘要（F1）：fresh 如实且 summarizeAttempted 如实', async () => {
    // P2 后 manual/proactive/overflow 唯一执行管道 = compact 引擎（原 F13「双实现漂移」
    // 对照随 LLMSummaryCompressor 退休——单管道天然同源）
    const messages = Array.from({ length: 6 }, (_, i) => userMsg(`${'abcdef'[i]}${'x'.repeat(200)}`));
    const engine = createCompactEngine();
    const empty = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: async () => '',
    });
    expect(empty.fresh).toBeFalsy(); // 空摘要按失败降级：调用方不得据此推进覆盖点
    expect(empty.summarizeAttempted).toBe(true); // 调用确实发起过 → 冷却时间戳应推进

    const noSummarizer = await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
    });
    expect(noSummarizer.fresh).toBeFalsy();
    expect(noSummarizer.summarizeAttempted).toBe(false); // 未发起调用：冷却不推进
  });

  it('cache-miss 旁路发出可观测事件（F5/F22）', async () => {
    const events: Array<{ type: string; reason?: string }> = [];
    const engine = createCompactEngine();
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}-content`));
    await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: async () => CLEAN_HANDOFF,
      emit: (e) => events.push(e),
    });
    expect(
      events.some((e) => e.type === 'compact.summarize_fallback' && e.reason === 'no_prefix'),
    ).toBe(true);
  });
});

describe('M-4：textify 旁路素材 = 未覆盖新消息（评审 del-fa8c54e9）', () => {
  it('有 previousSummary + freshMessages：只发新消息，已覆盖 raw 历史不复发', async () => {
    const summarize = vi.fn(async (_m: LLMMessage[], _o?: { maxTokens?: number }) => CLEAN_HANDOFF);
    const engine = createCompactEngine();
    const middle = [
      userMsg('COVERED-OLD-SECRET-A'),
      userMsg('COVERED-OLD-SECRET-B'),
      userMsg('FRESH-NEW-CONTENT'),
    ];
    const out = await engine.compactMessages(middle, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
      previousSummary: 'PREVIOUS-HANDOFF-TXT',
      freshMessages: [userMsg('FRESH-NEW-CONTENT')],
    });
    const request = summarize.mock.calls[0]![0] as LLMMessage[];
    const body = request.map((m) => String(m.content)).join('\n');
    // 合并契约：previousSummary 仍是完整更新的合并输入
    expect(body).toContain('PREVIOUS-HANDOFF-TXT');
    expect(body).toContain('FRESH-NEW-CONTENT');
    // 已覆盖历史不得以 raw middle 复发（2.13MB 事故形状的残留口）
    expect(body).not.toContain('COVERED-OLD-SECRET');
    expect(out.summarizeAttempted).toBe(true);
    expect(out.summary).toBe(CLEAN_HANDOFF);
  });

  it('无 previousSummary 兜底：textify 仍发全量 middle（无合并输入时完整性优先）', async () => {
    const summarize = vi.fn(async (_m: LLMMessage[], _o?: { maxTokens?: number }) => CLEAN_HANDOFF);
    const engine = createCompactEngine();
    const middle = [userMsg('COVERED-OLD-SECRET-A'), userMsg('FRESH-NEW-CONTENT')];
    await engine.compactMessages(middle, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      summarizeFn: summarize,
    });
    const request = summarize.mock.calls[0]![0] as LLMMessage[];
    const body = request.map((m) => String(m.content)).join('\n');
    expect(body).toContain('COVERED-OLD-SECRET-A');
    expect(body).toContain('FRESH-NEW-CONTENT');
  });
});
