/**
 * 手动压缩摘要请求形态回归
 *
 * 回归背景（缺陷）：compact engine 的 summarizeFn 路径把中段原始消息序列当对话转发
 * （toLlmMessages 只留 role+正文，丢 toolCalls/toolResults/tool_call_id），「只有
 * tool_calls、正文为空」的 assistant 消息被 provider sanitize 成 content:null 且无
 * tool_calls → 严格网关 400："messages[0] assistant must provide content,
 * reasoning_content or tool_calls"。
 *
 * 锚定五条：
 * 1. 摘要请求 = [system 指令, user 文本化中段]，不再裸发对话消息序列
 * 2. 请求内不存在「空正文且无 tool_calls」的 assistant 消息（严格网关可过）
 * 3. 多 agent 共线：assistant/tool 归因（Message.agentId）保留在摘要文本里
 * 4. previousSummary 随 prompt 交给 summarizeFn 迭代合并，返回值即完整摘要（不拼接）
 * 5. 失效降级：摘要抛错/无文本可摘要时保留旧摘要，不发空 content、不掺半截摘要
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message, ToolCall, ToolResult } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import { createCompactEngine } from '@octopi-agent/engine/harness/context/capabilities/compact/index.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

/** 只有 tool_calls、正文为空的 assistant 消息（真实会话常态；严格网关的 400 触发形态） */
function toolCallOnlyAssistant(id: string, name: string, agentId?: string): Message {
  const toolCalls: ToolCall[] = [{ id, name, arguments: { path: '/tmp/x' } }];
  return { role: 'assistant', content: '', toolCalls, timestamp: Date.now(), agentId };
}

function toolResultMsg(id: string, name: string, agentId?: string): Message {
  const toolResults: ToolResult[] = [{ toolCallId: id, name, result: 'ok' }];
  return { role: 'tool', content: '', toolResults, timestamp: Date.now(), agentId };
}

/** 模拟严格网关的核心校验：assistant 必须提供 content / tool_calls 之一 */
function assertStrictGatewaySafe(messages: LLMMessage[]): void {
  for (const m of messages) {
    const hasContent =
      (typeof m.content === 'string' && m.content.trim().length > 0) ||
      (Array.isArray(m.content) && m.content.length > 0);
    const hasToolCalls = (m.tool_calls?.length ?? 0) > 0;
    if (m.role === 'assistant') {
      expect(hasContent || hasToolCalls, `assistant 消息缺少 content/tool_calls: ${JSON.stringify(m)}`).toBe(true);
    } else {
      expect(hasContent, `非 assistant 消息缺少 content: ${JSON.stringify(m)}`).toBe(true);
    }
  }
}

describe('手动压缩摘要请求形态（400 回归）', () => {
  it('中段含 tool_call-only assistant 时请求为 [system 指令, user 文本]，不再裸发对话序列', async () => {
    const summarize = vi.fn(async () => 'mid-summary');
    const engine = createCompactEngine({ defaultProtectHead: 1, defaultProtectTail: 1 });
    // 中段（index 1..5）是典型工具轮次：assistant(tool_calls-only) + tool result 交替
    const messages: Message[] = [
      userMsg('open'),
      toolCallOnlyAssistant('c1', 'file_read'),
      toolResultMsg('c1', 'file_read'),
      toolCallOnlyAssistant('c2', 'file_write'),
      toolResultMsg('c2', 'file_write'),
      userMsg('continue'),
      userMsg('close'),
    ];
    await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 1,
      mode: 'structure_only',
      summarizeFn: summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    const request = summarize.mock.calls[0]![0] as LLMMessage[];
    // 形态：system 指令 + user 文本化中段，恰好两条
    expect(request).toHaveLength(2);
    expect(request[0]!.role).toBe('system');
    expect(request[0]!.content).toContain('Summarize');
    expect(request[1]!.role).toBe('user');
    // 严格网关校验：请求内不存在空正文 assistant / 空正文消息
    assertStrictGatewaySafe(request);
    // 工具明细未丢失：toLlmMessages 旧路径会丢掉 toolCalls/toolResults
    const body = String(request[1]!.content);
    expect(body).toContain('file_read');
    expect(body).toContain('file_write');
    expect(body).toContain('Tool Calls');
    expect(body).toContain('Tool Results');
  });

  it('多 agent 共线：assistant/tool 归因保留在摘要输入文本中', async () => {
    const summarize = vi.fn(async () => 'mid-summary');
    const engine = createCompactEngine({ defaultProtectHead: 1, defaultProtectTail: 1 });
    const messages: Message[] = [
      userMsg('hi'),
      { role: 'assistant', content: 'agent-a speaks', timestamp: Date.now(), agentId: 'agent-a' },
      toolCallOnlyAssistant('c1', 'file_read', 'agent-b'),
      toolResultMsg('c1', 'file_read', 'agent-b'),
      userMsg('bye'),
      userMsg('tail1'),
      userMsg('tail2'),
    ];
    await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 2,
      mode: 'structure_only',
      summarizeFn: summarize,
    });

    const request = summarize.mock.calls[0]![0] as LLMMessage[];
    const body = String(request[1]!.content);
    expect(body).toContain('(agent-a)');
    expect(body).toContain('(agent-b)');
    // 无归因消息保持干净的 [ROLE] 形态
    expect(body).toContain('[USER]');
  });

  it('previousSummary 随 prompt 迭代合并，返回值即完整摘要（不再事后拼接）', async () => {
    const summarize = vi.fn(async () => 'FULL-UPDATED-SUMMARY');
    const engine = createCompactEngine({ defaultProtectHead: 1, defaultProtectTail: 1 });
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}`));
    const out = await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 1,
      mode: 'structure_only',
      previousSummary: 'OLD-SUMMARY',
      summarizeFn: summarize,
    });

    const request = summarize.mock.calls[0]![0] as LLMMessage[];
    const body = String(request[1]!.content);
    // 旧摘要进入 prompt（迭代式更新契约）
    expect(body).toContain('OLD-SUMMARY');
    expect(body).toContain('Previous summary');
    // fn 收到 previousSummary 选项（兼容自定义实现）
    expect(summarize.mock.calls[0]![1]).toMatchObject({ previousSummary: 'OLD-SUMMARY' });
    // 返回值即完整更新摘要——不得与旧摘要拼接（修复前 mergeSummaries 会输出 'OLD-SUMMARY\n\nFULL-UPDATED-SUMMARY'）
    expect(out.summary).toBe('FULL-UPDATED-SUMMARY');
    expect(out.summary).not.toContain('OLD-SUMMARY');
  });

  it('summaryPort 路径不受影响：文本化中段带归因', async () => {
    const engine = createCompactEngine({ defaultProtectHead: 1, defaultProtectTail: 1 });
    const extract = vi.fn(async (unit: { text: string }) => ({
      text: 'port-summary',
      coverage: 'full' as const,
      tokensIn: 1,
      tokensOut: 1,
      policyId: 'conversation_default',
      kind: 'conversation' as const,
    }));
    const messages: Message[] = [
      userMsg('open'),
      toolCallOnlyAssistant('c1', 'file_read', 'agent-b'),
      toolResultMsg('c1', 'file_read', 'agent-b'),
      userMsg('continue'),
      userMsg('close'),
    ];
    const out = await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 1,
      mode: 'structure_only',
      summaryPort: { extract } as never,
    });
    expect(out.summary).toContain('port-summary');
    const unit = extract.mock.calls[0]![0] as { text: string };
    expect(unit.text).toContain('(agent-b)');
  });

  it('中段文本化为空（全无正文）→ summarizeFn 不被调用、旧摘要保留（不发空 user/占位内容）', async () => {
    const summarize = vi.fn(async () => 'never');
    const engine = createCompactEngine({ defaultProtectHead: 1, defaultProtectTail: 1 });
    // 中段两条 assistant 消息正文为空且无 toolCalls（formatMessagesAsText 的 else-if(content) 跳过 → 文本化为空串）
    const messages: Message[] = [
      userMsg('open'),
      { role: 'assistant', content: '', timestamp: Date.now() },
      { role: 'assistant', content: '', timestamp: Date.now() },
      userMsg('close'),
    ];
    const out = await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 1,
      mode: 'structure_only',
      summarizeFn: summarize,
      previousSummary: 'old summary',
    });

    // 无文本可摘要 → 不发请求（空 content/凭空占位内容都会误导上游模型）
    expect(summarize).not.toHaveBeenCalled();
    // 降级：旧摘要保留，view 为消息切片
    expect(out.summary).toBe('old summary');
    expect(Array.isArray(out.view)).toBe(true);
  });

  it('摘要失败（summarizeFn 抛错）→ 失效降级保留旧摘要，不拼接半截摘要', async () => {
    const summarize = vi.fn(async () => {
      throw new Error('provider down');
    });
    const engine = createCompactEngine({ defaultProtectHead: 1, defaultProtectTail: 1 });
    const messages: Message[] = [
      userMsg('open'),
      toolCallOnlyAssistant('c1', 'file_read'),
      toolResultMsg('c1', 'file_read'),
      userMsg('continue'),
      userMsg('close'),
    ];
    const out = await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 1,
      mode: 'structure_only',
      summarizeFn: summarize,
      previousSummary: 'old summary',
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    // 失效降级：summary 只保留旧摘要（完整），不丢失、不掺新半截内容
    expect(out.summary).toBe('old summary');
    expect(Array.isArray(out.view)).toBe(true);
  });

  it('summary_only 摘要失败 → summary 字段同样保留旧摘要', async () => {
    const summarize = vi.fn(async () => {
      throw new Error('provider down');
    });
    const engine = createCompactEngine({ defaultProtectHead: 1, defaultProtectTail: 1 });
    const messages: Message[] = [
      userMsg('open'),
      userMsg('talk about things'),
      userMsg('more'),
      userMsg('even more'),
      userMsg('close'),
    ];
    const out = await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 1,
      mode: 'summary_only',
      summarizeFn: summarize,
      previousSummary: 'old summary',
    });

    expect(out.summary).toBe('old summary');
  });
});
