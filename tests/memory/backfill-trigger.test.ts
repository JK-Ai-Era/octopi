/**
 * BackfillTrigger — 硬收敛 / idle 漂移 / 覆盖表
 */
import { describe, it, expect } from 'vitest';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import {
  InMemoryBackfillCoverageStore,
  measureSessionDensity,
  passesPrefilter,
  shouldAttempt,
} from '../../src/harness/memory/backfill-coverage.js';
import { BackfillTrigger, BACKFILL_REQUEST_EVENT } from '../../src/harness/memory/backfill-trigger.js';
import { findDuplicate } from '../../src/harness/memory/similarity.js';
import { handler as backfillHandler } from '../../src/subsystems/memory-steward/backfill/handler.js';
import { admitCandidates } from '../../src/subsystems/memory-steward/shared/policy.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import type { SubsystemLLMPort } from '../../src/harness/autonomous-subsystem/think/llm-port.js';
import type { SessionData } from '../../src/harness/session-types.js';

function makeSession(id: string, turns = 3): SessionData {
  const messages = [] as SessionData['messages'];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: 'user',
      content: `用户消息 ${i}：请记住 Memory 后端用 SqliteMemoryStore 挂在 agent.db 上，约定不要改。`,
      timestamp: 1000 + i * 1000,
    });
    messages.push({
      role: 'assistant',
      content: `好的，已记录约定 ${i}。后续配置 memory 时使用 SqliteMemoryStore。`,
      timestamp: 1500 + i * 1000,
    });
  }
  return {
    id,
    agentId: 'agent-1',
    meta: {
      agentId: 'agent-1',
      sessionId: id,
      status: 'idle',
      createdAt: 1000,
      updatedAt: 9000,
      sessionStartedAt: 1000,
      lastInteractionAt: 9000,
    },
    messages,
    turns: [],
    metadata: {},
  } as SessionData;
}

describe('memory.backfill.enabled config', () => {
  it('schema accepts backfill knobs and defaults open when omitted', async () => {
    const { MemoryConfigSchema } = await import('../../src/config-schema.js');
    expect(MemoryConfigSchema.parse({}).backfill).toBeUndefined();
    expect(MemoryConfigSchema.parse({ backfill: { enabled: false } }).backfill?.enabled).toBe(false);
    expect(MemoryConfigSchema.parse({ backfill: { enabled: true } }).backfill?.enabled).toBe(true);

    const knobs = MemoryConfigSchema.parse({
      backfill: {
        enabled: true,
        idleDelayMs: 1_200_000,
        gapScanMs: 21_600_000,
        minUserTurns: 3,
        minTotalChars: 400,
      },
    }).backfill!;
    expect(knobs.idleDelayMs).toBe(1_200_000);
    expect(knobs.gapScanMs).toBe(21_600_000);
    expect(knobs.minUserTurns).toBe(3);
    expect(knobs.minTotalChars).toBe(400);

    // builder 语义：undefined === enabled
    const cfg = MemoryConfigSchema.parse({ profile: 'embedded_headless' });
    expect(cfg.backfill?.enabled !== false).toBe(true);
  });

  it('BackfillTrigger honors prefilter minUserTurns override', async () => {
    const events = new DefaultEventBus();
    const coverage = new InMemoryBackfillCoverageStore();
    const thin = makeSession('sess-thin', 1); // 1 user turn
    const trigger = new BackfillTrigger({
      events,
      coverage,
      prefilter: { minUserTurns: 2 },
      idleScanMs: 10_000,
      gapScanMs: 10_000,
    });
    const r = await trigger.requestHardConverge({ sessionId: thin.id, session: thin });
    expect(r.emitted).toBe(false);
    expect(r.reason).toBe('too_few_user_turns');
  });
});

describe('type-aware decay + semantic conflict + health', () => {
  it('decay applies per-type idle/factor', async () => {
    const { InMemoryMemoryStore } = await import('../../src/harness/memory/store.js');
    const store = new InMemoryMemoryStore();
    const now = Date.now();
    const methodId = await store.store({
      type: 'method',
      content: 'When retry exceeds 3 switch to fallback provider immediately',
      source: 't',
      confidence: 0.8,
      importance: 0.7,
      tags: [],
      channel: 'fail_fix',
      evidence: '"retry"',
      anchors: ['retry'],
      futureUse: 'When retry exceeds 3 switch',
    });
    const normId = await store.store({
      type: 'norm',
      content: 'Never commit octopi.json to the repository',
      source: 't',
      confidence: 0.9,
      importance: 0.8,
      tags: [],
      channel: 'user_directive',
      evidence: '"不要提交"',
      anchors: ['octopi.json'],
      futureUse: 'When tempted to commit octopi.json refuse',
    });
    // method idle 25d（默认 21d 会衰）；norm idle 25d（默认 45d 不衰）
    await store.update(methodId, { lastAccessedAt: now - 25 * 86_400_000, decayFactor: 1 });
    await store.update(normId, { lastAccessedAt: now - 25 * 86_400_000, decayFactor: 1 });

    const n = await store.decay();
    expect(n).toBe(1);
    const m = await store.get(methodId);
    const nr = await store.get(normId);
    expect(m!.decayFactor).toBeLessThan(1);
    expect(nr!.decayFactor).toBe(1);
  });

  it('findDuplicate marks exact vs near', () => {
    const live = [{
      id: 'old',
      type: 'fact' as const,
      content: 'Project uses npm as package manager',
      deleted: false,
    }];
    const exact = findDuplicate(live, { type: 'fact', proposition: 'project uses npm as package manager.' });
    expect(exact?.id).toBe('old');
    expect(exact?.exact).toBe(true);
    const near = findDuplicate(live, {
      type: 'fact',
      proposition: 'Project uses npm as package managers',
    }, { similarity: 0.8 });
    expect(near?.id).toBe('old');
    expect(near?.exact).toBe(false);
  });

  it('weak channel near-duplicate is rejected as duplicate', async () => {
    const store = new InMemoryMemoryStore();
    await admitCandidates(store, [{
      type: 'fact',
      proposition: 'Project uses npm as package manager for all builds',
      evidence: '"用 npm"',
      anchors: ['npm'],
      channel: 'decision',
    }], 's1');
    const r = await admitCandidates(store, [{
      type: 'fact',
      proposition: 'Project uses npm as package manager for all builds now',
      evidence: '"npm again"',
      anchors: ['npm'],
      channel: 'model_inference',
    }], 's2');
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]?.reason).toBe('duplicate');
  });

  it('strong channel supersedes near-duplicate instead of rejecting', async () => {
    const store = new InMemoryMemoryStore();
    const first = await admitCandidates(store, [{
      type: 'fact',
      proposition: 'Project uses npm as package manager for all builds',
      evidence: '"用 npm"',
      anchors: ['npm'],
      channel: 'decision',
    }], 's1');
    expect(first.accepted).toHaveLength(1);
    const oldId = first.accepted[0]!.id;

    const second = await admitCandidates(store, [{
      type: 'fact',
      proposition: 'Project uses npm as package manager for all builds now',
      evidence: '"确认用 npm，写进约定"',
      anchors: ['npm'],
      channel: 'user_directive',
    }], 's2');
    expect(second.accepted).toHaveLength(1);
    const old = await store.get(oldId);
    expect(old?.deleted).toBe(true);
    expect(old?.deletedReason).toBe('superseded');
  });

  it('MemoryHealthProbe emits high_count and shadow_backlog', async () => {
    const events = new DefaultEventBus();
    const store = new InMemoryMemoryStore();
    for (let i = 0; i < 3; i++) {
      await store.store({
        type: 'method',
        content: `When handling case ${i} prefer early returns in module alpha`,
        source: 't',
        confidence: 0.5,
        importance: 0.5,
        tags: [],
        channel: 'model_inference',
        status: 'shadow',
        evidence: `"case ${i}"`,
        anchors: [`case${i}`],
        futureUse: `When case ${i} prefer early returns`,
      });
    }
    const types: string[] = [];
    events.onAll((e) => types.push(e.type));
    const { MemoryHealthProbe } = await import('../../src/harness/memory/health-probe.js');
    const probe = new MemoryHealthProbe({
      events,
      memoryStore: store,
      limits: { fact: 0, method: 0, norm: 0 },
      shadowBacklogLimit: 2,
    });
    await probe.check();
    expect(types).toContain('memory.health.high_count');
    expect(types).toContain('memory.health.shadow_backlog');
    probe.stop();
  });
});

describe('density prefilter + coverage decision', () => {
  it('measures fingerprint and rejects thin sessions', () => {
    const thin = measureSessionDensity([
      { role: 'user', content: 'hi', timestamp: 1 },
    ]);
    expect(passesPrefilter(thin).pass).toBe(false);

    const rich = measureSessionDensity(makeSession('s').messages as never);
    expect(passesPrefilter(rich).pass).toBe(true);
    expect(rich.fingerprint).toHaveLength(16);
  });

  it('shouldAttempt respects success / pending / fingerprint change', () => {
    const fp = 'abc';
    expect(shouldAttempt(null, fp).attempt).toBe(true);
    expect(shouldAttempt({ sessionId: 's', fingerprint: fp, status: 'success', attemptedAt: 0 }, fp).attempt).toBe(false);
    expect(shouldAttempt({ sessionId: 's', fingerprint: 'old', status: 'success', attemptedAt: 0 }, fp).attempt).toBe(true);
    expect(
      shouldAttempt({ sessionId: 's', fingerprint: fp, status: 'pending', attemptedAt: Date.now() }, fp).attempt,
    ).toBe(false);
    expect(
      shouldAttempt({ sessionId: 's', fingerprint: fp, status: 'failed', attemptedAt: Date.now() - 31 * 60_000 }, fp, {
        failedRetryMs: 30 * 60_000,
      }).attempt,
    ).toBe(true);
  });
});

describe('BackfillTrigger emit paths', () => {
  it('hard converge emits request with sessionText and marks pending', async () => {
    const events = new DefaultEventBus();
    const coverage = new InMemoryBackfillCoverageStore();
    const received: Array<{ type: string; data?: Record<string, unknown> }> = [];
    events.onAll((e) => received.push({ type: e.type, data: e.data }));

    const trigger = new BackfillTrigger({
      events,
      coverage,
      idleDelayMs: 1000,
      idleScanMs: 10_000,
      gapScanMs: 10_000,
    });
    trigger.start();

    const session = makeSession('sess-hard');
    const r = await trigger.requestHardConverge({
      sessionId: session.id,
      agentId: 'agent-1',
      session,
      trigger: 'hard_converge',
    });
    expect(r.emitted).toBe(true);

    const req = received.find((e) => e.type === BACKFILL_REQUEST_EVENT);
    expect(req?.data?.sessionId).toBe('sess-hard');
    expect(String(req?.data?.sessionText ?? '')).toContain('SqliteMemoryStore');

    const cov = await coverage.get('sess-hard');
    expect(cov?.status).toBe('pending');

    await coverage.put({ ...cov!, status: 'success', attemptedAt: Date.now() });
    const again = await trigger.requestHardConverge({ sessionId: session.id, session });
    expect(again.emitted).toBe(false);
    expect(again.reason).toBe('already_covered');
    trigger.dispose();
  });

  it('lifecycle recent fires hard converge via event bus', async () => {
    const events = new DefaultEventBus();
    const coverage = new InMemoryBackfillCoverageStore();
    const types: string[] = [];
    events.onAll((e) => types.push(e.type));
    const trigger = new BackfillTrigger({ events, coverage, idleScanMs: 10_000, gapScanMs: 10_000 });
    trigger.start();

    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'agent-1',
      sessionId: 'sess-ev',
      data: {
        lifecycle: 'recent',
        sessionText:
          '[user] 请记住约定 SqliteMemoryStore agent.db，后续配置 memory 都按这个约定执行，不要再用其他后端，这条长期有效直到明确推翻\n[assistant] 好的，已记录 SqliteMemoryStore 挂 agent.db 的约定，后续 memory 配置一律照此执行\n[user] 明确一下：以后所有 agent 的 memory 都用 SqliteMemoryStore 写在 agent.db，这条要长期生效，禁止再引入 Redis 等其他记忆后端',
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(types).toContain(BACKFILL_REQUEST_EVENT);
    trigger.dispose();
  });

  it('sessionText snapshot: fingerprint + prefilter use text even when store messages empty', async () => {
    const events = new DefaultEventBus();
    const coverage = new InMemoryBackfillCoverageStore();
    const emptySession = makeSession('sess-snap', 0);
    emptySession.messages = [];
    const store = {
      async load(id: string) {
        return id === 'sess-snap' ? emptySession : null;
      },
      async list() {
        return [];
      },
    };
    const received: Array<{ type: string; data?: Record<string, unknown> }> = [];
    events.onAll((e) => received.push({ type: e.type, data: e.data }));
    const trigger = new BackfillTrigger({
      events,
      coverage,
      sessionStore: store as never,
      idleScanMs: 10_000,
      gapScanMs: 10_000,
    });
    trigger.start();

    const snap1 =
      '[user] 请记住 Memory 用 SqliteMemoryStore 挂 agent.db，这是本项目长期约定，后续所有记忆后端配置都按此执行，不要再引入其他存储方案\n[assistant] 好的，约定 Memory 用 SqliteMemoryStore 写在 agent.db，已记下长期生效，后续配置会遵守\n[user] 补充：配置 memory backend 时一律 SqliteMemoryStore on agent.db，不要用 Redis 或其他方案，违者视为错误配置';
    const r1 = await trigger.requestHardConverge({
      sessionId: 'sess-snap',
      sessionText: snap1,
      trigger: 'hard_converge',
    });
    expect(r1.emitted).toBe(true);
    const cov1 = await coverage.get('sess-snap');
    // 非空内容指纹（不是 measureSessionDensity([]) 恒定值）
    expect(cov1?.fingerprint).toBeTruthy();
    expect(cov1?.fingerprint).not.toBe(measureSessionDensity([]).fingerprint);

    await coverage.put({ ...cov1!, status: 'success', attemptedAt: Date.now() });
    // 同文本再收敛：已覆盖
    const r2 = await trigger.requestHardConverge({ sessionId: 'sess-snap', sessionText: snap1 });
    expect(r2.emitted).toBe(false);
    expect(r2.reason).toBe('already_covered');

    // 文本变更：指纹变化 → 再补
    const snap2 = snap1 + '\n[user] 改用 SqliteMemoryStore 不用 Redis';
    const r3 = await trigger.requestHardConverge({ sessionId: 'sess-snap', sessionText: snap2 });
    expect(r3.emitted).toBe(true);
    expect(received.filter((e) => e.type === BACKFILL_REQUEST_EVENT)).toHaveLength(2);
    trigger.dispose();
  });

  it('idle drift emits after delay using sessionStore', async () => {
    const events = new DefaultEventBus();
    const coverage = new InMemoryBackfillCoverageStore();
    const session = makeSession('sess-idle');
    const store = {
      async load(id: string) {
        return id === 'sess-idle' ? session : null;
      },
      async list() {
        return [];
      },
    };
    const types: string[] = [];
    events.onAll((e) => types.push(e.type));

    let now = Date.now();
    const trigger = new BackfillTrigger({
      events,
      coverage,
      sessionStore: store as never,
      idleDelayMs: 50,
      idleScanMs: 10,
      gapScanMs: 10_000,
      now: () => now,
    });
    trigger.start();
    trigger.noteActivity('sess-idle', 'agent-1', now - 10);

    now += 100;
    const n = await trigger.scanIdle();
    expect(n).toBe(1);
    expect(types).toContain(BACKFILL_REQUEST_EVENT);
    trigger.dispose();
  });

  it('gap scan picks uncovered active sessions', async () => {
    const events = new DefaultEventBus();
    const coverage = new InMemoryBackfillCoverageStore();
    const session = makeSession('sess-gap');
    const store = {
      async load(id: string) {
        return id === 'sess-gap' ? session : null;
      },
      async list() {
        return [{ id: 'sess-gap', lifecycle: 'active' }];
      },
    };
    let emitted = 0;
    events.on(BACKFILL_REQUEST_EVENT, () => {
      emitted++;
    });
    const trigger = new BackfillTrigger({
      events,
      coverage,
      sessionStore: store as never,
      idleScanMs: 10_000,
      gapScanMs: 10_000,
    });
    const n = await trigger.scanGaps();
    expect(n).toBe(1);
    expect(emitted).toBe(1);
    trigger.dispose();
  });
});

describe('handler writes coverage', () => {
  function mockLlm(content: string): SubsystemLLMPort {
    return {
      cognitivePrompt: 'extract rules',
      defaultModel: 'mini',
      providerName: 'mock',
      resolved: { primary: { model: 'mini' }, fallback: [] } as any,
      chat: async () => ({ content, model: 'mini', finishReason: 'stop' as const }),
    };
  }

  it('success marks coverage success with accepted count', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const coverage = new InMemoryBackfillCoverageStore();
    const evidence = '[user] 请记住 Memory 用 SqliteMemoryStore 挂 agent.db [assistant] 好的记住了';
    await backfillHandler(
      { payload: { sessionText: evidence, sessionId: 's-cov', fingerprint: 'fp1', reason: 'hard_converge' } },
      {
        memoryStore,
        backfillCoverage: coverage,
        llmPort: mockLlm(
          JSON.stringify([
            {
              type: 'fact',
              proposition: 'Memory persists via SqliteMemoryStore on agent.db',
              evidence: '"SqliteMemoryStore 挂 agent.db"',
              future_use: 'When configuring memory use SqliteMemoryStore',
              anchors: ['SqliteMemoryStore', 'agent.db'],
              channel: 'user_directive',
            },
          ]),
        ),
      },
    );
    const cov = await coverage.get('s-cov');
    expect(cov?.status).toBe('success');
    expect(cov?.accepted).toBe(1);
    expect(cov?.fingerprint).toBe('fp1');
    expect(cov?.trigger).toBe('hard_converge');
  });

  it('failure marks coverage failed', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const coverage = new InMemoryBackfillCoverageStore();
    await backfillHandler(
      { payload: { sessionText: 'x'.repeat(300), sessionId: 's-fail', fingerprint: 'fp2' } },
      {
        memoryStore,
        backfillCoverage: coverage,
        llmPort: {
          cognitivePrompt: '',
          defaultModel: 'mini',
          providerName: 'mock',
          resolved: { primary: { model: 'mini' }, fallback: [] } as any,
          chat: async () => {
            throw new Error('down');
          },
        },
      },
    );
    const cov = await coverage.get('s-fail');
    expect(cov?.status).toBe('failed');
  });
});
