/**
 * Wisdom 归因窗口 — 引用摘录 / 候选路由 / 判决解析 / 判官 / 晋升闭环
 *
 * 回归锁（2026-10-31 评审）：maxPairs 截断不吞窗口、空/半截判决不吞窗口、
 * 重复 pair 不双记、先标记后发事件、dryRun 非破坏。
 */

import { describe, it, expect } from 'vitest';
import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';
import { InMemoryWisdomStore } from '@octopi-agent/engine/harness/memory/wisdom.js';
import {
  buildAttributionDigest,
  extractCitations,
  parseAttributionVerdicts,
  planAttributionBatch,
  recordWisdomRunWindow,
  selectAttributionCandidates,
  verdictsToOutcomeEvents,
} from '@octopi-agent/engine/harness/memory/wisdom-attribution.js';
import type { WisdomEntry, WisdomAttributionWindow } from '@octopi-agent/engine/harness/memory/types.js';
import type { SubsystemInput } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';
import type { SubsystemLLMPort } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/think/llm-port.js';
import { handler as attributeHandler } from '@octopi-agent/engine/subsystems/wisdom-steward/attribute/handler.js';
import { handler as evaluateHandler } from '@octopi-agent/engine/subsystems/wisdom-steward/evaluate/handler.js';

function fakeLLM(json: string): SubsystemLLMPort {
  return {
    chat: async () => ({ content: json, finishReason: 'stop' }),
  } as unknown as SubsystemLLMPort;
}

function fakeBus(): { bus: EventBus; emitted: Array<{ type: string; data?: unknown }> } {
  const emitted: Array<{ type: string; data?: unknown }> = [];
  const bus = { emit: (e: { type: string; data?: unknown }) => { emitted.push(e); } } as unknown as EventBus;
  return { bus, emitted };
}

async function admitTrial(
  store: InMemoryWisdomStore,
  statement: string,
  problemTypes: string[] = ['验证型宣称'],
  origin: 'distilled' | 'factory' = 'distilled',
): Promise<WisdomEntry> {
  const r = await store.admit({
    statement,
    scenario: { problemTypes, signals: ['证据'] },
    effect: { posture: '先证伪', questions: ['证据在哪里？'] },
    derivedFrom: { memoryIds: ['m1', 'm2'] },
    kind: 'corrective',
    origin,
    ...(origin === 'factory' ? { initialStatus: 'active' as const } : {}),
  });
  expect(r.action).toBe('created');
  return (await store.get(r.id!))!;
}

describe('extractCitations', () => {
  const entry = { id: 'wis_abc', statement: '先核对契约，再改实现' };

  it('id 命中 → 提取周边摘录', () => {
    const out = extractCitations(['前文……我决定遵循 [wis_abc] 的指引，先核对再动手。'], [entry]);
    expect(out).toHaveLength(1);
    expect(out[0].wisdomId).toBe('wis_abc');
    expect(out[0].excerpt).toContain('先核对再动手');
  });

  it('statement 整句/长前缀命中也算引用；短句只认 id', () => {
    const byStmt = extractCitations(['正如「先核对契约，再改实现」所说，我先读了契约。'], [entry]);
    expect(byStmt).toHaveLength(1);
    // 长前缀（≥12 字符的部分引用）也算
    const byPrefix = extractCitations(['按「先核对契约，再改实现」的前半句精神……'], [entry]);
    expect(byPrefix).toHaveLength(1);

    const short = { id: 'wis_s', statement: '短句' };
    expect(extractCitations(['这里没有引用'], [short])).toHaveLength(0);
    expect(extractCitations(['依据 [wis_s] 行事'], [short])).toHaveLength(1);
  });

  it('未引用 → 空', () => {
    expect(extractCitations(['完全无关的文本'], [entry])).toEqual([]);
  });
});

describe('selectAttributionCandidates 路由', () => {
  it('cited > scenario；core 常驻（factory/active）只抽样', async () => {
    const store = new InMemoryWisdomStore();
    const cited = (await admitTrial(store, '被引用的范式必须优先判', ['验证型宣称'])).id;
    const scen = (await admitTrial(store, '场景命中的范式次之', ['验证型宣称'])).id;
    const coreOnly = (await admitTrial(store, '纯常驻的范式只抽样', ['范围裁剪'], 'factory')).id;

    await store.recordAttributionWindow({
      sessionId: 's1',
      query: '这是验证型宣称的处理',
      outcome: 'completed',
      injectedIds: [cited!, scen!, coreOnly!],
      citations: [{ wisdomId: cited!, excerpt: '我按它的姿态行动了' }],
    });

    const pending = await store.listPendingWindows();
    const alive = await store.listForGovern();
    const cands = selectAttributionCandidates(pending, alive, { sampleMax: 1 });

    const byId = new Map(cands.map((c) => [c.entry.id, c.route]));
    expect(byId.get(cited)).toBe('cited');
    expect(byId.get(scen)).toBe('scenario');
    expect(byId.get(coreOnly)).toBe('sampled');
    expect(cands.filter((c) => c.route === 'sampled').length).toBeLessThanOrEqual(1);
  });

  it('终态条目（superseded/retired）不进候选', async () => {
    const store = new InMemoryWisdomStore();
    const e = await admitTrial(store, '已被取代的范式不判', ['验证型宣称']);
    await store.update(e.id, { status: 'superseded', supersededBy: 'wis_other' });
    await store.recordAttributionWindow({
      sessionId: 's1',
      query: '这是验证型宣称的处理',
      outcome: 'completed',
      injectedIds: [e.id],
      citations: [{ wisdomId: e.id, excerpt: 'x' }],
    });
    const cands = selectAttributionCandidates(
      await store.listPendingWindows(),
      await store.listForGovern({ includeRetired: true }),
    );
    expect(cands).toHaveLength(0);
  });
});

describe('planAttributionBatch 窗口原子装批（F1 回归）', () => {
  it('maxPairs 裁掉的窗口保持 pending（deferred），绝不误关', async () => {
    const store = new InMemoryWisdomStore();
    const e = await admitTrial(store, '装批不能吞掉证据的范式', ['验证型宣称']);
    for (let i = 0; i < 3; i++) {
      await store.recordAttributionWindow({
        sessionId: `s${i}`,
        query: '这是验证型宣称的处理',
        outcome: 'completed',
        injectedIds: [e.id],
        citations: [{ wisdomId: e.id, excerpt: `第 ${i} 次` }],
      });
    }
    const pending = await store.listPendingWindows();
    const batch = planAttributionBatch(pending, await store.listForGovern(), { maxPairs: 2 });
    expect(batch.selected).toHaveLength(2);
    expect(batch.deferredWindowIds).toHaveLength(1);
    expect(batch.closableWindowIds).toHaveLength(0);
    // 被推迟的窗口 id 不在 selected 里
    const selectedWindows = new Set(batch.selected.map((c) => c.window.id));
    expect(batch.deferredWindowIds[0] && selectedWindows.has(batch.deferredWindowIds[0])).toBe(false);
  });
});

describe('parseAttributionVerdicts 覆盖率（F2/F3 回归）', () => {
  it('完整覆盖才通过；缺项/重复/空/非法 → null', () => {
    const expected = [1, 2];
    expect(parseAttributionVerdicts('{"items":[{"pair":1,"verdict":"assisted"},{"pair":2,"verdict":"unclear"}]}', expected)).not.toBeNull();
    // 空 items：退化输出不得当成功
    expect(parseAttributionVerdicts('{"items":[]}', expected)).toBeNull();
    // 缺项
    expect(parseAttributionVerdicts('{"items":[{"pair":1,"verdict":"assisted"}]}', expected)).toBeNull();
    // 重复 pair
    expect(parseAttributionVerdicts('{"items":[{"pair":1,"verdict":"assisted"},{"pair":1,"verdict":"contested"}]}', [1])).toBeNull();
    // 越界
    expect(parseAttributionVerdicts('{"items":[{"pair":9,"verdict":"assisted"}]}', [1])).toBeNull();
    // 非法 verdict
    expect(parseAttributionVerdicts('{"items":[{"pair":1,"verdict":"made-up"}]}', [1])).toBeNull();
  });

  it('围栏 JSON 可解析；无结构/截断 → null', () => {
    const fenced = parseAttributionVerdicts('前置\n```json\n{"items":[{"pair":1,"verdict":"unclear"}]}\n```', [1]);
    expect(fenced).not.toBeNull();
    expect(parseAttributionVerdicts('完全没有结构', [1])).toBeNull();
    expect(parseAttributionVerdicts('{"items":[{"pair":1,', [1])).toBeNull();
  });
});

describe('verdictsToOutcomeEvents', () => {
  it('unclear 不入账；ref=窗口 id；(window,wisdom,signal) 幂等', () => {
    const events = verdictsToOutcomeEvents(
      [
        { pair: 1, verdict: 'assisted', reason: '有证据' },
        { pair: 2, verdict: 'unclear' },
        { pair: 3, verdict: 'contested' },
      ],
      [
        { windowId: 'w1', wisdomId: 'wis_a' },
        { windowId: 'w2', wisdomId: 'wis_b' },
        { windowId: 'w3', wisdomId: 'wis_c' },
      ],
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ wisdomId: 'wis_a', signal: 'assisted', ref: 'w1' });
    expect(events[1]).toMatchObject({ wisdomId: 'wis_c', signal: 'contested', ref: 'w3' });
  });
});

describe('recordWisdomRunWindow', () => {
  it('无注入不落窗口；有注入落窗口并带引用摘录', async () => {
    const store = new InMemoryWisdomStore();
    const e = await admitTrial(store, 'run 收尾记账的范式');
    const none = await recordWisdomRunWindow(store, {
      sessionId: 's',
      outcome: 'completed',
      query: 'q',
      injectedIds: [],
      assistantTexts: [],
    });
    expect(none).toBeNull();

    const id = await recordWisdomRunWindow(store, {
      sessionId: 's',
      outcome: 'completed',
      query: '这是验证型宣称的处理',
      injectedIds: [e.id],
      assistantTexts: [`我参考了 [${e.id}] 的姿态`],
    });
    expect(id).toBeTruthy();
    const pending = await store.listPendingWindows();
    expect(pending).toHaveLength(1);
    expect(pending[0].citations[0].wisdomId).toBe(e.id);
  });
});

describe('wisdom.steward.attribute 判官', () => {
  async function seedWindow(store: InMemoryWisdomStore, e: WisdomEntry): Promise<void> {
    await store.recordAttributionWindow({
      sessionId: 's1',
      query: '这是验证型宣称的处理',
      outcome: 'completed',
      injectedIds: [e.id],
      citations: [{ wisdomId: e.id, excerpt: '我引用并遵循了它' }],
    });
  }

  it('批量判决 → evaluate.request 事件；窗口先标记后发（F6 顺序锁）', async () => {
    const store = new InMemoryWisdomStore();
    const e = await admitTrial(store, '判官要判的范式');
    await seedWindow(store, e);

    const emitted: Array<{ type: string; data?: unknown }> = [];
    let pendingDuringEmit: Promise<WisdomAttributionWindow[]> | null = null;
    const bus = {
      emit: (ev: { type: string; data?: unknown }) => {
        // 顺序不变量：emit 落地时窗口必须已 judged（先标记后发）
        pendingDuringEmit = store.listPendingWindows();
        emitted.push(ev);
      },
    } as unknown as EventBus;

    const out = await attributeHandler({} as SubsystemInput, {
      wisdomStore: store,
      eventBus: bus,
      llmPort: fakeLLM('{"items":[{"pair":1,"verdict":"assisted","reason":"引用处显示真实应用"}]}'),
      __subsystem_config__: {},
    });

    expect(out.act?.status).toBe('success');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('wisdom.steward.evaluate.request');
    const events = (emitted[0].data as { events: Array<{ wisdomId: string; signal: string }> }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ wisdomId: e.id, signal: 'assisted' });
    expect(await store.listPendingWindows()).toHaveLength(0);
    expect(await pendingDuringEmit!).toHaveLength(0);
  });

  it('dryRun 非破坏：不标记、不发事件、不清理（F7 回归）', async () => {
    const store = new InMemoryWisdomStore();
    const e = await admitTrial(store, 'dryRun 不得消费窗口');
    await seedWindow(store, e);
    const { bus, emitted } = fakeBus();
    await attributeHandler({} as SubsystemInput, {
      wisdomStore: store,
      eventBus: bus,
      llmPort: fakeLLM('{"items":[{"pair":1,"verdict":"assisted"}]}'),
      __subsystem_config__: { dryRun: true },
    });
    expect(emitted).toHaveLength(0);
    expect(await store.listPendingWindows()).toHaveLength(1);
  });

  it('空/半截判决 → 整批失败，窗口保持 pending（F2 回归）', async () => {
    const store = new InMemoryWisdomStore();
    const e = await admitTrial(store, '退化输出不得吞窗口');
    await seedWindow(store, e);
    const { bus, emitted } = fakeBus();
    const out = await attributeHandler({} as SubsystemInput, {
      wisdomStore: store,
      eventBus: bus,
      llmPort: fakeLLM('{"items":[]}'),
      __subsystem_config__: {},
    });
    expect(out.act?.status).toBe('failed');
    expect(emitted).toHaveLength(0);
    expect(await store.listPendingWindows()).toHaveLength(1);
  });

  it('maxPairs 裁掉的窗口保持 pending，只判装进批的（F1 回归）', async () => {
    const store = new InMemoryWisdomStore();
    const e = await admitTrial(store, '装批截断不吞窗口');
    for (let i = 0; i < 3; i++) {
      await store.recordAttributionWindow({
        sessionId: `s${i}`,
        query: '这是验证型宣称的处理',
        outcome: 'completed',
        injectedIds: [e.id],
        citations: [{ wisdomId: e.id, excerpt: `第 ${i} 次` }],
      });
    }
    const { bus, emitted } = fakeBus();
    const out = await attributeHandler({} as SubsystemInput, {
      wisdomStore: store,
      eventBus: bus,
      llmPort: fakeLLM('{"items":[{"pair":1,"verdict":"assisted"},{"pair":2,"verdict":"unclear"}]}'),
      __subsystem_config__: { maxPairs: 2 },
    });
    expect(out.act?.status).toBe('success');
    expect(emitted).toHaveLength(1);
    expect(await store.listPendingWindows()).toHaveLength(1);
  });

  it('无候选窗口直接关闭，不打 LLM', async () => {
    const store = new InMemoryWisdomStore();
    await store.recordAttributionWindow({
      sessionId: 's1',
      query: 'q',
      outcome: 'completed',
      injectedIds: ['wis_gone'],
      citations: [],
    });
    let llmCalled = false;
    const out = await attributeHandler({} as SubsystemInput, {
      wisdomStore: store,
      llmPort: {
        chat: async () => {
          llmCalled = true;
          return { content: '{}', finishReason: 'stop' };
        },
      } as unknown as SubsystemLLMPort,
      __subsystem_config__: {},
    });
    expect(out.act?.status).toBe('success');
    expect(llmCalled).toBe(false);
    expect(await store.listPendingWindows()).toHaveLength(0);
  });
});

describe('端到端：判决 → evaluate 入账 → trial 晋升 active', () => {
  it('3 次注入 + 3 次 assisted 判决后晋升（第二死锁环已接通）', async () => {
    const store = new InMemoryWisdomStore();
    const e = await admitTrial(store, '被真实引用过的范式应当挣得信任');

    for (let i = 0; i < 3; i++) {
      await store.touchApplied([e.id]);
      await store.recordAttributionWindow({
        sessionId: `s${i}`,
        query: '这是验证型宣称的处理',
        outcome: 'completed',
        injectedIds: [e.id],
        citations: [{ wisdomId: e.id, excerpt: `第 ${i} 次按它行动` }],
      });
    }

    const pending = await store.listPendingWindows();
    const alive = await store.listForGovern();
    const cands = selectAttributionCandidates(pending, alive);
    expect(cands).toHaveLength(3);

    const { text, pairRefs } = buildAttributionDigest(cands);
    expect(text).toContain('被真实引用过的范式应当挣得信任');
    const verdicts = parseAttributionVerdicts(
      '{"items":[{"pair":1,"verdict":"assisted"},{"pair":2,"verdict":"assisted"},{"pair":3,"verdict":"assisted"}]}',
      [1, 2, 3],
    )!;
    const events = verdictsToOutcomeEvents(verdicts.items, pairRefs);
    expect(events).toHaveLength(3);

    await evaluateHandler({ payload: { events } } as SubsystemInput, {
      wisdomStore: store,
    });

    const after = await store.get(e.id);
    expect(after?.status).toBe('active');
    expect(after?.outcomes.assisted).toBe(3);
  });

  it('全是 unclear 时零入账、零晋升', async () => {
    const store = new InMemoryWisdomStore();
    const e = await admitTrial(store, '证据不足的范式保持 trial');
    for (let i = 0; i < 3; i++) {
      await store.touchApplied([e.id]);
      await store.recordAttributionWindow({
        sessionId: `s${i}`,
        query: '这是验证型宣称的处理',
        outcome: 'completed',
        injectedIds: [e.id],
        citations: [],
      });
    }
    const pending = await store.listPendingWindows();
    const cands = selectAttributionCandidates(pending, await store.listForGovern());
    const { pairRefs } = buildAttributionDigest(cands);
    const verdicts = parseAttributionVerdicts(
      '{"items":[{"pair":1,"verdict":"unclear"},{"pair":2,"verdict":"unclear"},{"pair":3,"verdict":"unclear"}]}',
      [1, 2, 3],
    )!;
    const events = verdictsToOutcomeEvents(verdicts.items, pairRefs);
    expect(events).toHaveLength(0);

    await evaluateHandler({ payload: { events } } as SubsystemInput, {
      wisdomStore: store,
    });
    expect((await store.get(e.id))?.status).toBe('trial');
    expect((await store.get(e.id))?.outcomes.assisted).toBe(0);
  });

  it('重复 pair 判决不双记（F3 回归：解析层直接拒绝）', async () => {
    const store = new InMemoryWisdomStore();
    const e = await admitTrial(store, '重复判决不得双倍入账');
    await store.touchApplied([e.id]);
    await store.recordAttributionWindow({
      sessionId: 's1',
      query: '这是验证型宣称的处理',
      outcome: 'completed',
      injectedIds: [e.id],
      citations: [{ wisdomId: e.id, excerpt: 'x' }],
    });
    const cands = selectAttributionCandidates(await store.listPendingWindows(), await store.listForGovern());
    const { pairRefs } = buildAttributionDigest(cands);
    // 重复 pair → 解析失败（null），不是双事件
    expect(
      parseAttributionVerdicts('{"items":[{"pair":1,"verdict":"assisted"},{"pair":1,"verdict":"assisted"}]}', [1]),
    ).toBeNull();
    const events = verdictsToOutcomeEvents(
      [{ pair: 1, verdict: 'assisted' }],
      pairRefs,
    );
    expect(events).toHaveLength(1);
    await evaluateHandler({ payload: { events } } as SubsystemInput, { wisdomStore: store });
    expect((await store.get(e.id))?.outcomes.assisted).toBe(1);
  });
});
