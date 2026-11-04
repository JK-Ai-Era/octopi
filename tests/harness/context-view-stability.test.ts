/**
 * 装配视图确定性 + 系统围栏（context-size-accounting.md §10.5 P0-A/P0-B）
 *
 * 红线：
 * 1. 视图消息一律原样（全回放）：信封（turn_start/turn_end）不得被语义过滤掉/剥壳——
 *    语义过滤只属于摘要素材（M1：过滤件回装视图会让相邻请求字节不一致，逐请求击穿前缀缓存）
 * 2. tail 冻结锚点：压缩态重建的视图在尾部追加时，历史部分逐字节不动（真前缀），
 *    不得因 protectLastN 滑窗让 since/tail 边界条目换血
 * 3. 反向围栏：非托管 system 一律降级为 engineHint 载体（user 形态），不进 provider system
 * 4. engineHint 不被 isTurnAnchor 认作轮锚点（否则 hint 更新会钉死老化边界）
 * 5. provider 断言：多 system 输入触发契约告警且仍可发（warn+join 容错）
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import {
  formatTurnContextXml,
  formatTurnEndContent,
  formatTurnStartContent,
} from '@octopi-agent/engine/harness/context/turn-envelope.js';
import { isTurnAnchor } from '@octopi-agent/engine/harness/context/layer-types.js';
import { computeToolResultAgingPlan } from '@octopi-agent/engine/harness/context/tool-result-aging.js';

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

function userTurnEnvelope(turnId: string, userText: string): Message {
  return {
    role: 'user',
    content: formatTurnStartContent({
      turnId,
      at: '2026-11-04T00:00:00.000Z',
      turnContextXml: formatTurnContextXml({ turnId, slotsXml: '<runtime_snapshot>x</runtime_snapshot>' }),
      userText,
    }),
    timestamp: Date.now(),
  };
}

function turnEnd(turnId: string): Message {
  return {
    role: 'user',
    content: formatTurnEndContent(turnId),
    timestamp: Date.now(),
    metadata: { source: 'turnEnd', turnId },
  };
}

/** 压缩态：summary 覆盖到 coverEnd */
function compactState(coverEnd: number, count: number) {
  return {
    summary: '[Conversation Summary]\n### Done\n- prefix work',
    lastProactiveMessageCount: count,
    lastProactiveCoverEnd: coverEnd,
    lastProactiveTokens: 50,
  };
}

function agingOpts() {
  return {
    enabled: true,
    rawWindow: 0,
    freezeBatch: 1,
    maxPointerChars: 400,
    ageToolArgs: true,
    maxAgedArgChars: 320,
  };
}

function textOf(messages: Array<Message | LLMMessage>): string {
  return messages
    .map((m) => {
      const c = (m as Message).content;
      return typeof c === 'string' ? c : JSON.stringify(c ?? (m as { toolResults?: unknown }).toolResults);
    })
    .join('\n');
}

describe('P0-A 视图确定性', () => {
  it('粘滞重建保留信封原样：turn_end 不消失、turn_start 不剥壳（M1 回归）', async () => {
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      protectFirstN: 2,
      protectLastN: 4,
    });
    const prefix: Message[] = [userTurnEnvelope('t1', 'start job')];
    for (let i = 0; i < 6; i++) prefix.push(...toolTurn(i, `body-${i}-` + 'x'.repeat(300)));
    const coverCount = prefix.length; // 摘要覆盖段（信封不放这里——被摘要替换是正确语义）
    const tailStart = coverCount; // 压缩时刻：tail 段为空锚在尾部

    // 信封都在增量/尾段：它们必须原样出现在视图里
    const increments: Message[] = [turnEnd('t1')];
    for (let i = 10; i < 16; i++) increments.push(...toolTurn(i, `inc-${i}-` + 'y'.repeat(200)));
    increments.push(userTurnEnvelope('t2', 'continue'));
    increments.push(turnEnd('t2'));

    const result = await engine.assemble({
      sessionId: 's-envelope-keep',
      messages: [...prefix, ...increments],
      systemPrompt: 'sys',
      tools: [],
      summarize: async () => 'should-not-run',
      contextWindow: 1_000_000,
      loadCompactState: async () => compactState(coverCount, coverCount),
    });

    const text = textOf(result.messages);
    // turn_end 原样保留（semanticHistory 会丢它——视图不得用它的口径）
    expect(text).toContain(formatTurnEndContent('t1'));
    expect(text).toContain(formatTurnEndContent('t2'));
    // turn_start 信封不剥壳（turn_context 槽位在视图中原样回放）
    expect(text).toContain('<turn_context');
    expect(text).toContain('start job');
  });

  it('视图字节稳定：尾部追加只动尾部（真前缀；切点对内容不可见，稳定性由原样切片保证）', async () => {
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      protectFirstN: 2,
      protectLastN: 4,
    });
    const prefix: Message[] = [userMsg('job')];
    for (let i = 0; i < 6; i++) prefix.push(...toolTurn(i, `body-${i}-` + 'x'.repeat(300)));
    const coverCount = prefix.length;

    const increments: Message[] = [];
    for (let i = 10; i < 16; i++) increments.push(...toolTurn(i, `inc-${i}-` + 'y'.repeat(200)));

    const first = await engine.assemble({
      sessionId: 's-prefix',
      messages: [...prefix, ...increments],
      systemPrompt: 'sys',
      tools: [],
      summarize: async () => 'should-not-run',
      contextWindow: 1_000_000,
      loadCompactState: async () => compactState(coverCount, coverCount),
    });

    // 尾部再追加一个工具回合
    const second = await engine.assemble({
      sessionId: 's-prefix',
      messages: [...prefix, ...increments, ...toolTurn(99, 'tail-new-' + 'z'.repeat(200))],
      systemPrompt: 'sys',
      tools: [],
      summarize: async () => 'should-not-run',
      contextWindow: 1_000_000,
      loadCompactState: async () => compactState(coverCount, coverCount),
    });

    // 历史部分是真前缀：第一次视图的每条消息逐字节出现在第二次视图开头
    expect(second.messages.length).toBeGreaterThanOrEqual(first.messages.length);
    for (let i = 0; i < first.messages.length; i++) {
      expect(JSON.stringify(second.messages[i])).toBe(JSON.stringify(first.messages[i]));
    }
    expect(textOf(second.messages)).toContain('tail-new-');
  });

  it('无摘要粘滞重建（有计数无摘要的生产形状）：视图无重复、无丢失（审查 H1 回归）', async () => {
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      protectFirstN: 2,
      protectLastN: 4,
    });
    const msgs: Message[] = [userMsg('job')];
    for (let i = 0; i < 10; i++) msgs.push(...toolTurn(i, `body-${i}-` + 'x'.repeat(300)));

    const result = await engine.assemble({
      sessionId: 's-nosummary',
      messages: msgs,
      systemPrompt: 'sys',
      tools: [],
      summarize: async () => 'unused',
      contextWindow: 1_000_000,
      // 有计数无摘要：机械降级轮 / 未配 summarize / 重启恢复快照的生产形状
      loadCompactState: async () => ({ lastProactiveMessageCount: 5, lastProactiveTokens: 50 }),
    });

    // 每条输入消息的内容在视图中恰好一次（不重复、不丢尾）。
    // LLM 视图形态 ≠ 领域形态（toolCalls→tool_calls 等），按内容特征计数；
    // 视图多一条托管 system。
    const text = textOf(result.messages);
    for (let i = 0; i < 10; i++) {
      expect(text.split(`body-${i}-`).length - 1).toBe(1);
      expect(text.split(`step ${i}`).length - 1).toBe(1);
    }
    expect(text.split('job').length - 1).toBe(1);
    expect(result.messages).toHaveLength(msgs.length + 1);
  });

  it('engineHint 不被 isTurnAnchor 认作轮锚点（hint 更新不钉死老化边界）', () => {
    const hint: Message = {
      role: 'user',
      content: '<delegation_status>1 running</delegation_status>',
      timestamp: Date.now(),
      ephemeral: true,
      metadata: { source: 'engineHint' },
    };
    expect(isTurnAnchor(hint)).toBe(false);

    // 老化边界：engineHint 追加后 crossTurn 边界不前移（lastGenuineUserIdx 不被钉死）
    const history: Message[] = [userMsg('human'), ...toolTurn(1, 'x'.repeat(600))];
    const before = computeToolResultAgingPlan(history, agingOpts());
    const afterPlan = computeToolResultAgingPlan([...history, hint], agingOpts());
    expect(afterPlan.agedIds.size).toBeGreaterThanOrEqual(before.agedIds.size);
    // 真实用户消息（无 source）仍是轮锚点
    expect(isTurnAnchor(userMsg('next'))).toBe(true);
  });
});

describe('P0-B 系统围栏', () => {
  it('反向围栏：非托管 system 在 LLM 视图中降级为 engineHint user（不进 system 字段）', async () => {
    const engine = new DefaultContextEngine({ proactiveCompactRatio: 0 });
    const managedSystem: Message = {
      role: 'system',
      content: 'You are octopi.',
      timestamp: Date.now(),
      metadata: { source: 'systemPrompt' },
    };
    const rogue: Message = {
      role: 'system',
      content: '<delegation_status>1 running</delegation_status>',
      timestamp: Date.now(),
      ephemeral: true,
    };
    const messages: Message[] = [managedSystem, rogue, userMsg('hello')];

    const result = await engine.assemble({
      sessionId: 's-fence',
      messages,
      systemPrompt: 'You are octopi.',
      tools: [],
      tokenBudget: 32000,
    });
    // 领域视图保留历史原样（不丢消息）
    expect(result.messages).toHaveLength(3);

    // LLM 视图：system 只剩托管一条；rogue 降级为 user + engineHint
    const buildLlm = (
      engine as unknown as {
        buildLlmMessages: (m: Message[], sys: string, tools: unknown[], aging?: unknown) => LLMMessage[];
      }
    ).buildLlmMessages.bind(engine);
    const llm = buildLlm(messages, 'You are octopi.', []);
    const systems = llm.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(1);
    expect(systems[0]?.content).toBe('You are octopi.');
    const carried = llm.find((m) => String(m.content).includes('<delegation_status>'));
    expect(carried).toBeDefined();
    expect(carried?.role).toBe('user');
    // 且不作为系统消息出现在 system 字段侧
    expect(systems.some((m) => String(m.content).includes('delegation_status'))).toBe(false);
  });

  it('provider 断言：多 system 输入触发契约告警且仍可发（warn + join 容错）', async () => {
    const { AnthropicProvider } = await import(
      '@octopi-agent/engine/integration/providers/anthropic.js'
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const provider = new AnthropicProvider({ apiKey: 'test-key' } as never);
      const toReq = (
        provider as unknown as {
          toAnthropicRequest: (r: unknown) => Record<string, unknown>;
        }
      ).toAnthropicRequest.bind(provider);
      const body = toReq({
        model: 'm',
        messages: [
          { role: 'system', content: 'A' },
          { role: 'system', content: 'B' },
          { role: 'user', content: 'hi' },
        ],
        max_tokens: 16,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('contract violation'));
      expect(String(body.system)).toContain('A');
      expect(String(body.system)).toContain('B');
    } finally {
      warn.mockRestore();
    }
  });
});
