/**
 * F8R-05：自动压缩路径（proactive / overflow）透传 taskSnapshot
 *
 * 交接式摘要（拍板路线）要求摘要指令尾部带**当前**任务快照；此前只有手动
 * compactStructural 路径透传，自动路径依赖注入历史里的旧快照副本。
 * 本测试钉住 AssembleParams.taskSnapshot → applyProactiveCompact / overflow
 * → CompactOptions.taskSnapshot 的完整下沉（P2 后压缩执行唯一管道 = compact 能力）。
 */
import { describe, it, expect } from 'vitest';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type {
  MessageSelector,
  SummarizeFunction,
} from '@octopi-agent/engine/harness/context/types.js';
import type {
  CompactEngine,
  CompactOptions,
} from '@octopi-agent/engine/harness/context/capabilities/compact/index.js';
import type { Message } from '@octopi-agent/core/types.js';

function msgs(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
    content: `message ${i} ${'x'.repeat(40)}`,
    timestamp: Date.now() + i,
  }));
}

function capturingCompactEngine(calls: CompactOptions[]): CompactEngine {
  return {
    compactMessages: async (_messages, opts) => {
      calls.push(opts ?? {});
      return {
        ok: true,
        compacted: true,
        tokensBefore: 0,
        fresh: true,
        summarizeAttempted: true,
        summary: '交接摘要',
        view: [{ role: 'assistant', content: '[compact]', timestamp: Date.now() }],
      };
    },
    compactText: async () => {
      throw new Error('not_implemented: compactText is not exercised in this test');
    },
  };
}

describe('自动压缩路径透传 taskSnapshot（F8R-05）', () => {
  it('proactive 路径：compactMessages 收到 AssembleParams.taskSnapshot', async () => {
    const calls: CompactOptions[] = [];
    const engine = new DefaultContextEngine({
      compactEngine: capturingCompactEngine(calls),
      targetTokens: 50,
      proactiveCooldownMs: 0,
      protectFirstN: 2,
      protectLastN: 2,
    });
    await engine.assemble({
      sessionId: 'snap-1',
      messages: msgs(30),
      systemPrompt: 'sys',
      tools: [],
      summarize: async () => '交接摘要',
      taskSnapshot: 'TASK SNAPSHOT LIVE',
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].taskSnapshot).toBe('TASK SNAPSHOT LIVE');
  });

  it('预算分支（contextWindow 已知）：compactMessages 收到 taskSnapshot', async () => {
    // 钉独立代码点：预算路径 applyProactiveCompact 调用（与无窗口早分支不互为代表，评审 M2）
    const calls: CompactOptions[] = [];
    const engine = new DefaultContextEngine({
      compactEngine: capturingCompactEngine(calls),
      targetTokens: 50,
      proactiveCooldownMs: 0,
      protectFirstN: 2,
      protectLastN: 2,
    });
    await engine.assemble({
      sessionId: 'snap-budget',
      messages: msgs(30),
      systemPrompt: 'sys',
      tools: [],
      contextWindow: 2000,
      tokenBudget: 2000,
      summarize: async () => '交接摘要',
      taskSnapshot: 'TASK SNAPSHOT LIVE',
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].taskSnapshot).toBe('TASK SNAPSHOT LIVE');
  });

  it('真实 compact 链路：摘要请求尾部 user 带活任务快照（用户可见形状，评审 L2）', async () => {
    const captured: Array<Parameters<SummarizeFunction>[0]> = [];
    const summarize: SummarizeFunction = async (messages) => {
      captured.push(messages);
      return '交接摘要';
    };
    const engine = new DefaultContextEngine({
      targetTokens: 50,
      proactiveCooldownMs: 0,
      protectFirstN: 2,
      protectLastN: 2,
    });
    await engine.assemble({
      sessionId: 'snap-chain',
      messages: msgs(30),
      systemPrompt: 'sys',
      tools: [],
      summarize,
      taskSnapshot: 'LIVE TASK ENTRY',
    });
    expect(captured.length).toBeGreaterThan(0);
    const lastUser = captured[0].filter((m) => m.role === 'user').at(-1);
    const content = String(lastUser?.content ?? '');
    expect(content).toContain('Current session task list snapshot (live task store');
    expect(content).toContain('LIVE TASK ENTRY');
  });

  it('overflow 路径零摘要调用：compactMessages 一次都不许被调（Q1 纯机械）', async () => {
    const calls: CompactOptions[] = [];
    const events: Array<{ type: string; reason?: string }> = [];
    // 胖工具产物构造：aging 降级后仍超 limit 地板 → 确定性进入 overflow 收敛段
    const fat = (n: number): Message[] =>
      Array.from({ length: n }, (_, i) => ({
        role: 'tool' as Message['role'],
        content: '',
        toolResults: [{ toolCallId: `call_${i}`, name: 'read_file', result: `tool output ${i} ${'t'.repeat(3000)}` }],
        timestamp: Date.now() + i,
      })) as Message[];
    const engine = new DefaultContextEngine({
      compactEngine: capturingCompactEngine(calls),
      // 关闭主动路径，隔离 overflow 机制
      targetTokens: 0,
      proactiveCompactRatio: 0,
      protectFirstN: 1,
      protectLastN: 1,
    });
    await engine.assemble({
      sessionId: 'snap-2',
      messages: [{ role: 'user', content: 'go', timestamp: 1 }, ...fat(6)] as Message[],
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 200,
      contextWindow: 32000,
      summarize: async () => '交接摘要',
      taskSnapshot: 'TASK SNAPSHOT LIVE',
      emit: (event) => { events.push(event); },
    });
    // overflow 收敛全程零 LLM：没有摘要请求，taskSnapshot 无处可传（无素材可伪造）
    expect(calls.length).toBe(0);
    // 本构造 aging+三档账本都救不了（锚后 7 条全保=砍不动）→ L3 终局：
    // start 有终态配对（error 即终态，store 消费 error 清 compact.active），fail-loud
    expect(events.filter((e) => e.type === 'context.compact.start')).toHaveLength(1);
    const err = events.find((e) => e.type === 'context.compact.error') as { error?: string } | undefined;
    expect(err?.error).toContain('context_overflow_unrecoverable');
  });

  it('机械收敛路径同样零摘要调用（taskSnapshot 无处可传，评审 L1 反向钉换代）', async () => {
    const calls: CompactOptions[] = [];
    const overflowSelector: MessageSelector = {
      select: (messages) => ({
        kept: messages.slice(0, 1),
        overflow: messages.slice(1),
        tail: [],
        tailTokens: 0,
        estimatedTokens: 10,
        overflowTokens: 500,
      }),
    };
    // 工具输出重的消息 + 无 summarize：只能走机械降级（B′ 阶梯：打码→账本截断）
    const toolMsgs: Message[] = Array.from({ length: 6 }, (_, i) => ({
      role: 'tool' as Message['role'],
      content: '',
      toolResults: [{ toolCallId: `call_${i}`, name: 'read_file', result: `tool output ${i} ${'t'.repeat(2000)}` }],
      timestamp: Date.now() + i,
    })) as Message[];
    const engine = new DefaultContextEngine({
      compactEngine: capturingCompactEngine(calls),
      messageSelector: overflowSelector,
      targetTokens: 0,
      proactiveCompactRatio: 0,
      protectFirstN: 1,
      protectLastN: 1,
    });
    await engine.assemble({
      sessionId: 'snap-mech',
      messages: toolMsgs,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 200,
      contextWindow: 32000,
      taskSnapshot: 'TASK SNAPSHOT LIVE',
    });
    // Q1 纯机械：overflow 收敛全程零摘要调用——taskSnapshot 无处可传，也无需断言不传
    expect(calls.length).toBe(0);
  });

  it('未提供 taskSnapshot 时 compactMessages 收到 undefined（无伪造素材）', async () => {
    const calls: CompactOptions[] = [];
    const engine = new DefaultContextEngine({
      compactEngine: capturingCompactEngine(calls),
      targetTokens: 50,
      proactiveCooldownMs: 0,
      protectFirstN: 2,
      protectLastN: 2,
    });
    await engine.assemble({
      sessionId: 'snap-3',
      messages: msgs(30),
      systemPrompt: 'sys',
      tools: [],
      summarize: async () => '交接摘要',
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].taskSnapshot).toBeUndefined();
  });
});
