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
import { LLMSummaryCompressor } from '@octopi-agent/engine/harness/context/llm-summarizer.js';

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
      llmPrefix: prefix,
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
      llmPrefix: prefix,
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
      llmPrefix: prefix,
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

describe('F8 模板统一：跨路同源与降级标志（评审 F1/F5/F13）', () => {
  it('两路尾部指令同源（F13 防双实现漂移）：compressor 与 compact 引擎同参同字', async () => {
    const messages = [
      userMsg('open item'),
      userMsg('middle one'),
      userMsg('middle two'),
      userMsg('middle three'),
      userMsg('middle four'),
      userMsg('tail end'),
    ];
    const shared = {
      previousSummary: 'OLD-SUM',
      foldRange: { replacedCount: 4, total: 6, preservedTail: 1 },
      taskSnapshot: '<session_tasks>T</session_tasks>',
    };

    let fromCompressor = '';
    let compressorMax = 0;
    await new LLMSummaryCompressor().compress({
      messages,
      targetTokens: 50,
      ...shared,
      // 同形状对照（都在 llmPrefix 分支比 tailUser）：compressor 无前缀走 textify 布局
      // （尾部 user 是 New content 拼接），与引擎前缀分支的 tailUser 不同形，不可比
      llmPrefix: [{ role: 'system', content: 'SYS' }],
      summarize: async (msgs, opts) => {
        fromCompressor = String(msgs[msgs.length - 1]!.content);
        compressorMax = opts?.maxTokens ?? 0;
        return CLEAN_HANDOFF;
      },
      requireSummary: true,
    });

    let fromEngine = '';
    let engineMax = 0;
    const engine = createCompactEngine();
    await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      ...shared,
      llmPrefix: [{ role: 'system', content: 'SYS' }],
      summarizeFn: async (msgs, opts) => {
        fromEngine = String(msgs[msgs.length - 1]!.content);
        engineMax = opts?.maxTokens ?? 0;
        return CLEAN_HANDOFF;
      },
    });

    expect(fromCompressor.length).toBeGreaterThan(0);
    // 逐字同源（含预算行）：预算公式两路同传参（F8R-09 修正：原 strip 是 no-op，反而掩盖预算分叉）
    expect(fromCompressor).toBe(fromEngine);
    // 预算同源：软目标/硬顶/窗口钳制推导链两侧不许分叉
    expect(compressorMax).toBe(engineMax);

    // textify 分支同源：system 指令逐字一致（user 正文由两路各自 formatter 渲染，模板块仍单源）
    let sysFromCompressor = '';
    await new LLMSummaryCompressor().compress({
      messages,
      targetTokens: 50,
      ...shared,
      summarize: async (msgs) => {
        sysFromCompressor = String(msgs[0]!.content);
        return CLEAN_HANDOFF;
      },
      requireSummary: true,
    });
    let sysFromEngine = '';
    await engine.compactMessages(messages, {
      mode: 'structure_only',
      protectHead: 0,
      protectTail: 0,
      ...shared,
      summarizeFn: async (msgs) => {
        sysFromEngine = String(msgs[0]!.content);
        return CLEAN_HANDOFF;
      },
    });
    expect(sysFromEngine.length).toBeGreaterThan(0);
    expect(sysFromCompressor).toBe(sysFromEngine);
  });

  it('机械降级不冒充新摘要（F1）：fresh=false 且 summarizeAttempted 如实', async () => {
    const compressor = new LLMSummaryCompressor();
    const messages = [userMsg('a'.repeat(200)), userMsg('b'.repeat(200))];
    const empty = await compressor.compress({
      messages,
      targetTokens: 50,
      summarize: async () => '',
      requireSummary: true,
    });
    expect(empty.fresh).toBe(false); // 空摘要按失败降级：调用方不得据此推进覆盖点
    expect(empty.summarizeAttempted).toBe(true); // 调用确实发起过 → 冷却时间戳应推进

    const noSummarizer = await compressor.compress({
      messages,
      targetTokens: 50,
      requireSummary: true,
    });
    expect(noSummarizer.fresh).toBe(false);
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
