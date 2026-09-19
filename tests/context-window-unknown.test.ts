/**
 * contextWindow 未知：自动压缩跳过 + 手动结构压缩仍可用
 */

import { describe, it, expect } from 'vitest';
import { DefaultContextEngine } from '../src/harness/context/default-context-engine.js';
import type { Message } from '../src/core/types.js';

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

  it('compact 非 force 且无预算 → 跳过自动压缩', async () => {
    const engine = new DefaultContextEngine();
    await engine.assemble({
      sessionId: 's2',
      messages: msgs(10),
      systemPrompt: 'sys',
      tools: [],
      contextWindow: 100000,
    });
    const r = await engine.compact({ sessionId: 's2' });
    expect(r.compacted).toBe(false);
    expect(r.reason).toMatch(/auto compact disabled|unknown/i);
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
    const messages = msgs(40).map((m, i) => ({
      ...m,
      content: `long message ${i} ${'y'.repeat(200)}`,
    }));
    const result = await engine.assemble({
      sessionId: 's4',
      messages,
      systemPrompt: 'sys',
      tools: [],
      contextWindow: 500,
      tokenBudget: 500,
    });
    const bodyCount = result.messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant',
    ).length;
    // 极小预算：应发生截断/压缩
    expect(bodyCount).toBeLessThan(40);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});
