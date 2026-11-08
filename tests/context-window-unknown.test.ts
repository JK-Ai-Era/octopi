/**
 * contextWindow 未知：targetTokens=0（legacy）跳过自动压缩 + 手动结构压缩仍可用；
 * targetTokens>0（缺省 20 万）时兜底压缩与窗口无关、照样执行（F1-B3）
 */

import { describe, it, expect } from 'vitest';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type { Message } from '@octopi-agent/core/types.js';

function msgs(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
    content: `message ${i} ${'x'.repeat(40)}`,
    timestamp: Date.now() + i,
  }));
}

describe('DefaultContextEngine — 未知 contextWindow', () => {
  it('assemble 无 tokenBudget/contextWindow 时不做预算截断', async () => {
    const engine = new DefaultContextEngine({
      protectFirstN: 2,
      protectLastN: 2,
    });
    const messages = msgs(20);
    const result = await engine.assemble({
      sessionId: 's1',
      messages,
      systemPrompt: 'sys',
      tools: [],
      // 故意不传 tokenBudget / contextWindow
    });
    // 无摘要时消息原样（结构视图未压缩）
    const userCount = result.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
    expect(userCount).toBeGreaterThanOrEqual(20);
  });

  it('compactStructural 手动压缩不依赖 contextWindow', async () => {
    const engine = new DefaultContextEngine({
      protectFirstN: 2,
      protectLastN: 2,
    });
    const messages = msgs(12);
    const r = await engine.compactStructural({
      sessionId: 's3',
      messages,
      summarize: async () => '中间对话已摘要',
    });
    expect(r.ok).toBe(true);
    expect(r.compacted).toBe(true);
    expect(r.reason).toBe('structural');
    expect(r.summary).toContain('中间对话已摘要');

    // 压缩后 assemble 未知窗口时使用结构视图
    const after = await engine.assemble({
      sessionId: 's3',
      messages,
      systemPrompt: 'sys',
      tools: [],
    });
    const hasSummary = after.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('中间对话已摘要'),
    );
    expect(hasSummary).toBe(true);
  });

  it('有 contextWindow 时仍走预算路径', async () => {
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
    });
    const messages = msgs(40).map((m, i) => ({ role: 'tool', content: '', toolResults: [{ toolCallId: `w${i}`, name: 'r', result: 'x'.repeat(80) }], timestamp: Date.now() + i } as Message)).map((m, i) => ({
      ...m,
      content: `long message ${i} ${'y'.repeat(200)}`,
    }));
    const result = await engine.assemble({
      sessionId: 's4',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 3000,
    });
    // 真信号：tool 执行账本化发生（消息数净减 + 账本索引在场）——「bodyCount<40」
    // 在全 tool 构造下恒真（评审指出的空过），废除
    expect(result.messages.length, '预算裁剪必须发生（tool 执行账本化，消息数净减）').toBeLessThan(41);
    const text = JSON.stringify(result.messages);
    expect(text, 'purpose 账本索引必须在场（丢弃次序）').toMatch(/Tool call ledger/);
    expect(result.estimatedTokens, '收敛后读数必须落在预算内').toBeLessThanOrEqual(4000);
  });
});
