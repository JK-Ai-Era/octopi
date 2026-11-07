/**
 * 评审 blocking 四条回归红线（2026-11-07 del-fa8c54e9）：
 *
 * C-1  主动路径 degrade 不得吞既有语义摘要（freshOk 保护对 raw 项同样生效）
 * M-1  中止必须发终态事件（end{cancelled}），store 的 compact.active 不得悬挂
 * M-2  overflow 中止轮零写入（摘要飞行中 abort 的残缺产物不进历史）
 * （M-5 WebUI tick 在 packages/webui/src/components/ContextRuntimePanel.test.tsx）
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { InMemoryTransformStore } from '@octopi-agent/engine/harness/session/transform-store.js';
import type { ContextCompactEvent } from '@octopi-agent/engine/harness/context/types.js';
import { resolveRun } from '@octopi-agent/engine/harness/context/transform/anchors.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function viewText(r: { messages?: unknown[] }): string {
  return JSON.stringify(r?.messages ?? []);
}

describe('C-1：主动路径 degrade 不吞既有语义摘要', () => {
  it('summary 记录在场 + 主动摘要失败降级 → 摘要仍可见，degrade 不覆盖其区间', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 2,
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    const messages: Message[] = [userMsg('HEAD-0 ' + 'h'.repeat(200))];
    for (let i = 0; i < 30; i++) {
      messages.push(userMsg(`msg-${String(i).padStart(2, '0')}-` + 'z'.repeat(300)));
    }
    messages.push(userMsg('TAIL-A'), userMsg('TAIL-B'));

    // 先建立语义摘要（manual fresh）→ summary 记录覆盖中段
    await engine.compactStructural({
      sessionId: 's-c1',
      messages,
      summarize: async () => 'SUMMARY-MARK-XYZ',
    });
    const afterManual = await store.load('s-c1', '');
    expect(afterManual.records[0]!.type).toBe('summary');

    // 主动压缩且摘要失败（抛错 → compactCore 机械降级 → degrade 记录）
    // 新增消息让视图再超线、needNewCompaction 成立
    const grown = [...messages];
    for (let i = 0; i < 10; i++) grown.push(userMsg(`new-${i}-` + 'w'.repeat(500)));
    const failingSummarize = vi.fn(async () => {
      throw new Error('provider exploded');
    });
    const r = await engine.assemble({
      sessionId: 's-c1',
      messages: grown,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 1000,
      contextWindow: 1_048_576,
      summarize: failingSummarize,
    });

    // 红线 1：旧摘要不得从视图消失
    expect(viewText(r)).toContain('SUMMARY-MARK-XYZ');

    // 红线 2：degrade 记录的区间不得与 summary 记录相交
    const ledger = await store.load('s-c1', '');
    const summaryRecord = ledger.records.find((rec) => rec.type === 'summary')!;
    const degradeRecords = ledger.records.filter((rec) => rec.type === 'degrade');
    expect(degradeRecords.length, '失败降级应产生 degrade 记录').toBeGreaterThan(0);
    for (const rec of degradeRecords) {
      for (const run of rec.covers) {
        for (const srun of summaryRecord.covers) {
          const r1 = resolveRun(grown, run);
          const r2 = resolveRun(grown, srun);
          const overlap = r1 && r2 ? r1[0] <= r2[1] && r2[0] <= r1[1] : false;
          expect(overlap, 'degrade 不得覆盖 summary 区间（静默失忆回归）').toBe(false);
        }
      }
    }
  });
});

describe('M-1：中止必须发终态事件', () => {
  it('proactive 摘要飞行中 abort → end{cancelled} 收尾（start 有配对终态）', async () => {
    const store = new InMemoryTransformStore();
    const events: ContextCompactEvent[] = [];
    const controller = new AbortController();
    const summarize = vi.fn(
      (_m: unknown, opts?: { signal?: AbortSignal }): Promise<string> =>
        new Promise<string>((_resolve, reject) => {
          if (!opts?.signal) return;
          opts.signal.addEventListener('abort', () => reject(new Error('Request aborted')), {
            once: true,
          });
        }),
    );
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 2,
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    const messages: Message[] = [userMsg('HEAD ' + 'h'.repeat(200))];
    for (let i = 0; i < 30; i++) messages.push(userMsg(`m-${i}-` + 'z'.repeat(400)));

    const pending = engine.assemble({
      sessionId: 's-m1',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 2000,
      contextWindow: 1_048_576,
      summarize,
      signal: controller.signal,
      emit: (e) => events.push(e),
    });
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    controller.abort();
    await pending;

    const starts = events.filter((e) => e.type === 'context.compact.start');
    const terminals = events.filter(
      (e) => e.type === 'context.compact.end' || e.type === 'context.compact.error',
    );
    expect(starts.length).toBeGreaterThan(0);
    // 每个 start 都必须有配对终态；中止收尾必须带 cancelled
    expect(terminals.length).toBeGreaterThanOrEqual(starts.length);
    const cancelledEnds = events.filter(
      (e) => e.type === 'context.compact.end' && e.cancelled === true,
    );
    expect(cancelledEnds.length, '中止收尾必须有 end{cancelled:true}').toBe(1);
  });
});

describe('M-2：overflow 中止轮零写入', () => {
  it('overflow 摘要飞行中 abort → 不落任何转换记录 + end{cancelled} 收尾', async () => {
    const store = new InMemoryTransformStore();
    const events: ContextCompactEvent[] = [];
    const controller = new AbortController();
    const summarize = vi.fn(
      (_m: unknown, opts?: { signal?: AbortSignal }): Promise<string> =>
        new Promise<string>((_resolve, reject) => {
          if (!opts?.signal) return;
          opts.signal.addEventListener('abort', () => reject(new Error('Request aborted')), {
            once: true,
          });
        }),
    );
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    // 溢出形态：大量长工具结果压垮小预算（走 overflow 路径）
    const messages: Message[] = [userMsg('go')];
    for (let i = 0; i < 8; i++) {
      messages.push({
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: `call_${i}`, name: 'read_file', result: 'R'.repeat(3000) }],
        timestamp: Date.now(),
      });
    }
    messages.push(userMsg('wrap up'));

    const pending = engine.assemble({
      sessionId: 's-m2',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 3000,
      contextWindow: 32000,
      summarize,
      signal: controller.signal,
      emit: (e) => events.push(e),
    });
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    controller.abort();
    await pending;

    // 红线：中止轮零写入（残缺产物不进历史）
    expect((await store.load('s-m2', '')).records).toEqual([]);
    // 中止收尾有终态事件
    const cancelledEnds = events.filter(
      (e) => e.type === 'context.compact.end' && e.cancelled === true,
    );
    expect(cancelledEnds.length, 'overflow 中止收尾必须有 end{cancelled:true}').toBe(1);
    // 且不得出现「compacted」语义的正常 end（tokensBefore/After 型）
    const normalEnds = events.filter(
      (e) => e.type === 'context.compact.end' && e.cancelled !== true && e.cached !== true,
    );
    expect(normalEnds).toEqual([]);
  });
});
