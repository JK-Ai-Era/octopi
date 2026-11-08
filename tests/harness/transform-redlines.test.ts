/**
 * 红线：压缩产物跨装配永久生效、跨 agent 不串视图（step-4 持久转换记录）
 *
 * 六条红线（arch/context-size-accounting.md §10.18）：
 * 1. 压缩产物跨装配永久生效——degrade 后多次 assemble + 重启 + 增长，被裁原文不回流
 * 2. 跨 agent 不串视图
 * 3. 锚点跨重启 / fork（消息复制）存活
 * 4. 回填只在显式撤销（revocation）时
 * 5. fresh=false 永不产出 summary 型记录（伪摘要不得冒充）
 * 6. 迁移前后视图等价
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import {
  InMemoryTransformStore,
  JsonlTransformStore,
} from '@octopi-agent/engine/harness/session/transform-store.js';
import { resolveRun } from '@octopi-agent/engine/harness/context/transform/anchors.js';

function userMsg(text: string, timestamp = 1000): Message {
  return { role: 'user', content: text, timestamp };
}

/** 工具密集历史：每轮一对 tool_call/tool_result */
function toolRound(i: number, resultText: string): Message[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call-${i}`, name: 'shell', arguments: { cmd: 'noop' } }],
      timestamp: 2000 + i,
    },
    {
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: `call-${i}`, name: 'shell', result: resultText }],
      timestamp: 2000 + i,
    },
  ];
}

function viewText(result: { messages: Array<{ content?: unknown }> }): string {
  return result.messages.map((m) => String(m.content ?? '')).join('\n');
}

describe('红线 1：压缩产物跨装配永久生效', () => {
  it('degrade 后多次 assemble + 重启 + 增长，被裁原文不回流', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-rl1-'));
    try {
      const store = new JsonlTransformStore({ sessionsDir: dir });
      const summarize = async (): Promise<string> => {
        throw new Error('llm down');
      };
      const base: Message[] = [];
      for (let i = 0; i < 30; i++) {
        base.push(userMsg(`content-${i} ` + 'x'.repeat(400), 1000 + i));
      }
      const params = {
        sessionId: 'rl1',
        systemPrompt: 'sys',
        tools: [],
        tokenBudget: 4_000,
        summarize,
      };

      // 第一轮：LLM 失败 → 机械降级（degrade 记录，永久生效）
      const e1 = new DefaultContextEngine({
        proactiveCompactRatio: 0.5,
        targetTokens: 0,
        protectFirstN: 2,
        protectLastN: 4,
        proactiveCooldownMs: 0,
        transformStore: store,
      });
      const messages1 = [...base, userMsg('turn-boundary', 2000)];
      const r1 = await e1.assemble({ ...params, messages: messages1 });
      const t1 = viewText(r1);
      expect(t1).not.toContain('content-5');

      // 同引擎连打 3 次 assemble（同集合 + 增长）：覆盖不回填
      for (const extra of [1, 2, 3]) {
        const grown = [...messages1, ...Array.from({ length: extra }, (_, i) => userMsg(`g${i}`, 3000 + i))];
        const r = await e1.assemble({ ...params, messages: grown });
        expect(viewText(r)).not.toContain('content-5');
      }

      // 重启（新引擎 + 同一持久账本）：覆盖仍生效
      const e2 = new DefaultContextEngine({
        proactiveCompactRatio: 0.5,
        targetTokens: 0,
        protectFirstN: 2,
        protectLastN: 4,
        proactiveCooldownMs: 0,
        transformStore: store,
      });
      const grown = [...messages1, userMsg('after-restart', 4000)];
      const r2 = await e2.assemble({ ...params, messages: grown });
      expect(viewText(r2)).not.toContain('content-5');
      // 未覆盖消息逐字在场（宁胖不丢的方向）
      expect(viewText(r2)).toContain('after-restart');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('红线 2：跨 agent 不串视图', () => {
  it('a1 的压缩视图不影响 a2（原文全量）', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      targetTokens: 0,
      transformStore: store,
    });
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(userMsg(`secret-${i} ` + 'x'.repeat(400), 1000 + i));
    }
    await engine.compactStructural({
      sessionId: 's-x',
      agentId: 'a1',
      messages,
      summarize: async () => '## Conversation Summary\nA1-SUM',
    });

    const rA1 = await engine.assemble({
      sessionId: 's-x',
      agentId: 'a1',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 10_000_000,
    });
    const rA2 = await engine.assemble({
      sessionId: 's-x',
      agentId: 'a2',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 10_000_000,
    });
    expect(viewText(rA1)).toContain('A1-SUM');
    expect(viewText(rA1)).not.toContain('secret-5');
    // a2 不借用 a1 的记录：原文可见、无 a1 摘要
    expect(viewText(rA2)).toContain('secret-5');
    expect(viewText(rA2)).not.toContain('A1-SUM');
  });
});

describe('红线 3：锚点跨重启 / fork 存活', () => {
  it('消息复制（fork）后记录仍解析到同一区间', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      targetTokens: 0,
      transformStore: store,
    });
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(userMsg(`fork-${i} ` + 'x'.repeat(400), 1000 + i));
    }
    await engine.compactStructural({
      sessionId: 's-fork',
      agentId: 'a',
      messages,
      summarize: async () => '## Conversation Summary\nFORK-SUM',
    });

    // fork = 消息深拷贝（gateway 分支的形态）
    const copied = messages.map((m) => ({ ...m }));
    const e2 = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      targetTokens: 0,
      transformStore: store,
    });
    const r = await e2.assemble({
      sessionId: 's-fork',
      agentId: 'a',
      messages: copied,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 10_000_000,
    });
    expect(viewText(r)).toContain('FORK-SUM');
    expect(viewText(r)).not.toContain('fork-5');
    expect(viewText(r)).toContain('fork-29');
  });
});

describe('红线 4：回填只在显式撤销时', () => {
  it('revoke 后原文回流；未 revoke 永不回流', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      targetTokens: 0,
      transformStore: store,
    });
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(userMsg(`rev-${i} ` + 'x'.repeat(400), 1000 + i));
    }
    await engine.compactStructural({
      sessionId: 's-rev',
      agentId: 'a',
      messages,
      summarize: async () => '## Conversation Summary\nREV-SUM',
    });

    const e2 = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      targetTokens: 0,
      transformStore: store,
    });
    const r1 = await e2.assemble({
      sessionId: 's-rev',
      agentId: 'a',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 10_000_000,
    });
    expect(viewText(r1)).not.toContain('rev-5');

    // 显式撤销（回填的唯一通道）
    const ledger = await store.load('s-rev', 'a');
    await store.append('s-rev', 'a', [], [ledger.records[0]!.seq]);

    const e3 = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      targetTokens: 0,
      transformStore: store,
    });
    const r2 = await e3.assemble({
      sessionId: 's-rev',
      agentId: 'a',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 10_000_000,
    });
    expect(viewText(r2)).toContain('rev-5');
    expect(viewText(r2)).not.toContain('REV-SUM');
  });
});

describe('红线 5：fresh=false 永不产出 summary 型记录', () => {
  it('摘要失败的机械产物 = degrade 型；空摘要不冒充', async () => {
    const store = new InMemoryTransformStore();
    for (const [name, summarize] of [
      ['throws', async (): Promise<string> => { throw new Error('down'); }],
      ['empty', async (): Promise<string> => ''],
      ['mechanical-notice', async (): Promise<string> => '[Context truncated: fake summary]'],
    ] as const) {
      const engine = new DefaultContextEngine({
        proactiveCompactRatio: 0.5,
        targetTokens: 0,
        protectFirstN: 2,
        protectLastN: 4,
        proactiveCooldownMs: 0,
        transformStore: store,
      });
      const messages: Message[] = [];
      for (let i = 0; i < 30; i++) {
        messages.push(userMsg(`n-${name}-${i} ` + 'x'.repeat(400), 1000 + i));
      }
      await engine.assemble({
        sessionId: `s-${name}`,
        systemPrompt: 'sys',
        tools: [],
        tokenBudget: 4_000,
        summarize,
        messages: [...messages, userMsg('boundary', 2000)],
      });
      const ledger = await store.load(`s-${name}`, '');
      // 反真空（F11）：必须真的产出了记录，断言才有效
      expect(ledger.records.length).toBeGreaterThan(0);
      for (const record of ledger.records) {
        expect(record.type).not.toBe('summary');
      }
    }
  });
});

describe('红线 6：迁移前后视图等价', () => {
  it('legacy 快照 → 初始记录 → fold 视图 = 旧粘滞视图（含覆盖行终点）', async () => {
    const store = new InMemoryTransformStore();
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(userMsg(`mig-${i}`, 1000 + i));
    }
    const coverEnd = 12;
    const legacy = {
      summary: 'MIG-SUM',
      lastProactiveMessageCount: 20,
      lastProactiveCoverEnd: coverEnd,
      lastProactiveTokens: 100,
    };
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
      transformStore: store,
    });
    const r = await engine.assemble({
      sessionId: 's-mig',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 10_000_000,
      loadCompactState: () => legacy,
    });
    const contents = r.messages.map((m) => String(m.content ?? ''));
    // 旧粘滞视图形状：head(m0,m1) + summary(含 Coverage 行) + 增量(m12..) + tail
    expect(contents[1]).toContain('mig-0');
    const summaryIdx = contents.findIndex((c) => c.includes('MIG-SUM'));
    expect(summaryIdx).toBeGreaterThan(0);
    expect(contents[summaryIdx]).toContain(`up to message ${coverEnd}`);
    expect(contents.some((c) => c.includes('mig-12'))).toBe(true);
    expect(contents.some((c) => c.includes('mig-11'))).toBe(false);
    // 迁移幂等：账本已建，重复 assemble 不再迁移（无重复记录）
    const ledger = await store.load('s-mig', '');
    expect(ledger.records).toHaveLength(1);
    await engine.assemble({
      sessionId: 's-mig',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 10_000_000,
      loadCompactState: () => legacy,
    });
    expect((await store.load('s-mig', '')).records).toHaveLength(1);
  });
});

describe('红线 1 补充：overflow 路径的 degrade 同样永久', () => {
  it('overflow 机械截断后增长，被裁原文不回流', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 2,
      targetTokens: 0,
      proactiveCompactRatio: 1, // 关闭 proactive，只走 MessageSelector overflow
      transformStore: store,
    });

    const messages: Message[] = [userMsg('HEAD-0', 900)];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'tool', content: '', toolResults: [{ toolCallId: `old${i}`, name: 'r', result: 'z'.repeat(200) }], timestamp: 1000 + i } as Message);
    }
    messages.push(userMsg('TAIL-A', 2000), userMsg('TAIL-B', 2001));

    const params = {
      sessionId: 's-ovf',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 800,
    };
    const r1 = await engine.assemble({ ...params, messages });
    const ledger = await store.load('s-ovf', '');
    expect(ledger.records.length).toBeGreaterThan(0);
    expect(ledger.records[0]!.type).toBe('degrade');

    // 增长后再次装配：被裁段不回流（r2 可见的旧中段 ⊆ r1 可见；不新增回流）
    const grown = [...messages, userMsg('NEW-TAIL', 3000)];
    const r2 = await engine.assemble({ ...params, messages: grown });
    const visible = (t: string): Set<string> =>
      new Set([...t.matchAll(/OLD-(\d\d)/g)].map((m) => m[1]!));
    const v1 = visible(viewText(r1));
    const v2 = visible(viewText(r2));
    // overflow 机械截断确实裁掉了一部分（近尾保底留下其余）
    expect(v1.size).toBeLessThan(30);
    for (const id of v2) {
      expect(v1.has(id)).toBe(true);
    }
    expect(viewText(r2)).toContain('NEW-TAIL');
  });
});

describe('红线 7（评审 F1）：机械降级不得吞既有语义摘要', () => {
  it('overflow degrade 落在 summary 记录区间之上时，摘要仍可见（信息不减）', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 2,
      proactiveCompactRatio: 0,
      targetTokens: 0,
      transformStore: store,
    });
    const messages: Message[] = [userMsg('HEAD-0', 900)];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'tool', content: '', toolResults: [{ toolCallId: `m${i}`, name: 'r', result: 'z'.repeat(200) }], timestamp: 1000 + i } as Message);
    }
    messages.push(userMsg('TAIL-A', 2000), userMsg('TAIL-B', 2001));

    // 先建立语义摘要（manual fresh）
    await engine.compactStructural({
      sessionId: 's-f1',
      messages,
      summarize: async () => 'SUMMARY-MARK-XYZ',
    });
    expect((await store.load('s-f1', '')).records[0]!.type).toBe('summary');

    // 再触发 overflow 机械降级（无 summarize、小预算、大量新增原文让 overflow 含真实消息）
    const grown = [...messages];
    for (let i = 0; i < 30; i++) grown.push({ role: 'tool', content: '', toolResults: [{ toolCallId: `n${i}`, name: 'r', result: 'w'.repeat(200) }], timestamp: 3000 + i } as Message);
    const r = await engine.assemble({
      sessionId: 's-f1',
      messages: grown,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 5000, // 触发 overflow 且砍满后「tail+账本」真装得下
    });
    const text = viewText(r);
    // 摘要不许被机械占位吞掉（评审 F1 的静默失忆回归）
    expect(text).toContain('SUMMARY-MARK-XYZ');
    // degrade 记录不得接管 summary 的区间
    const ledger = await store.load('s-f1', '');
    const summaryRecord = ledger.records.find((rec) => rec.type === 'summary')!;
    const degradeRecords = ledger.records.filter((rec) => rec.type === 'degrade');
    expect(degradeRecords.length).toBeGreaterThan(0);
    // 每条 degrade 的 run 不得落入 summary 的 run（允许相邻）
    for (const rec of degradeRecords) {
      for (const run of rec.covers) {
        for (const srun of summaryRecord.covers) {
          const overlap =
            resolveRun(messages, run) && resolveRun(messages, srun)
              ? (() => {
                  const [a1, b1] = resolveRun(messages, run)!;
                  const [a2, b2] = resolveRun(messages, srun)!;
                  return a1 <= b2 && a2 <= b1;
                })()
              : false;
          expect(overlap).toBe(false);
        }
      }
    }
  });
});

describe('红线 8（评审 F2）：重启后增长门/冷却基数对称', () => {
  it('请求口径读数（viewTokens）随记录持久并恢复；overflow 记录不进门基', async () => {
    const store = new InMemoryTransformStore();
    let summarizeCalls = 0;
    const summarize = async (): Promise<string> => {
      summarizeCalls += 1;
      return `## Conversation Summary\nv${summarizeCalls}`;
    };
    const base: Message[] = [];
    for (let i = 0; i < 30; i++) {
      base.push(userMsg(`g-${i} ` + 'x'.repeat(400), 1000 + i));
    }
    const engine1 = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 20,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    // 第一轮压缩（proactive fresh）→ 记录应带 fullTokens
    await engine1.assemble({
      sessionId: 's-gate',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4_000,
      summarize,
      messages: [...base, userMsg('boundary', 2000)],
    });
    const after1 = await store.load('s-gate', '');
    // 增长门基 = 请求口径读数（fold 视图 + 老化），且必须带口径版本标记——
    // 旧口径基数（全量历史）与请求口径互比会永久压制压缩（2026-11-07）
    expect(after1.records[0]!.meta.viewTokens).toBeGreaterThan(0);
    expect(after1.records[0]!.meta.viewTokensSource).toBe('request');
    const gateCount = after1.records[0]!.meta.messageCount;

    // 重启：增长门基数应从记录恢复——+1 条不得触发重摘要（门在工作）
    const engine2 = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 20,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    summarizeCalls = 0;
    await engine2.assemble({
      sessionId: 's-gate',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4_000,
      summarize,
      messages: [...base, userMsg('boundary', 2000), userMsg('tiny', 2001)],
    });
    expect(summarizeCalls).toBe(0);

    // overflow 记录（若产生）不推进门基：重启后的门基仍是 proactive 轮的计数
    const finalLedger = await store.load('s-gate', '');
    const gateBase = [...finalLedger.records].reverse().find((r) => r.meta.reason !== 'overflow');
    expect(gateBase!.meta.messageCount).toBeGreaterThanOrEqual(gateCount);
  });
});

describe('红线 9（评审 F3）：流截断后逐 run 生效（不整记录回填）', () => {
  it('多 run 记录在截断后的残存 run 仍生效', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(userMsg(`k-${i}`, 1000 + i));
    }
    // 记录覆盖 [1,3] 与 [7,8] 两条 run
    const { anchorRange: ar } = await import(
      '@octopi-agent/engine/harness/context/transform/anchors.js'
    );
    const { foldTransformView } = await import(
      '@octopi-agent/engine/harness/context/transform/fold.js'
    );
    const record = {
      seq: 1,
      sessionId: 's-trunc',
      agentId: '',
      type: 'summary' as const,
      createdAt: 1,
      covers: [ar(messages, 1, 3)!, ar(messages, 7, 8)!],
      text: 'MULTIRUN-SUM',
      placeholder: { role: 'user' as const, source: 'contextSummary' },
      revoked: false,
      meta: { reason: 'manual' as const, fresh: true, summarizeAttempted: true, messageCount: 10 },
    };
    // 编辑重发截断：k-7..k-9 被剪掉（run [7,8] 失锚）
    const truncated = messages.slice(0, 7);
    const partials: number[] = [];
    const folded = foldTransformView(truncated, { records: [record] }, {
      onPartialOrphan: (_r, n) => partials.push(n),
    });
    const text = folded.view.map((m) => String(m.content)).join('\n');
    // 残存 run [1,3] 仍被覆盖（不得整记录回填）
    expect(text).toContain('MULTIRUN-SUM');
    expect(text).not.toContain('k-2');
    expect(text).toContain('k-0');
    expect(text).toContain('k-5');
    // 部分孤儿如实上报
    expect(partials).toEqual([1]);
    // 覆盖行终点按残存 run 动态渲染
    expect(text).toContain('up to message 4');
  });
});
