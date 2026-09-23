/**
 * P0/P1 — 补录失败语义、写路径去重、SUBSYSTEM.md 绑定、govern boost/晋升
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import { findDuplicate } from '../../src/harness/memory/similarity.js';
import { admitCandidates, planBoosts, planPromotionCandidates } from '../../src/subsystems/memory-steward/shared/policy.js';
import { handler as backfillHandler } from '../../src/subsystems/memory-steward/backfill/handler.js';
import { handler as governHandler } from '../../src/subsystems/memory-steward/govern/handler.js';
import { createMemoryStoreTool } from '../../src/harness/plugin-ecosystem/tools/memory.js';
import type { SubsystemLLMPort } from '../../src/harness/autonomous-subsystem/think/llm-port.js';

function mockLlm(content: string, opts?: { finishReason?: 'stop' | 'error'; cognitivePrompt?: string; throwMsg?: string }): SubsystemLLMPort {
  return {
    cognitivePrompt: opts?.cognitivePrompt ?? '',
    defaultModel: 'mini',
    providerName: 'mock',
    resolved: { primary: { model: 'mini' }, fallback: [] } as any,
    chat: async () => {
      if (opts?.throwMsg) throw new Error(opts.throwMsg);
      return {
        content,
        model: 'mini',
        finishReason: opts?.finishReason ?? 'stop',
      } as any;
    },
  };
}

const evidence = '[user] 请记住：Memory 持久化用 SqliteMemoryStore，挂在 agent.db 上。[assistant] 好的记住了。';

describe('write-path dedup (G5)', () => {
  it('findDuplicate matches normalized equality and near-duplicates', () => {
    const live = [{
      id: 'e1',
      type: 'fact' as const,
      content: 'Memory backend uses SqliteMemoryStore on agent.db',
      deleted: false,
    }];
    expect(findDuplicate(live, { type: 'fact', proposition: 'memory backend uses SqliteMemoryStore on agent.db.' })?.id).toBe('e1');
    expect(findDuplicate(live, { type: 'norm', proposition: 'Memory backend uses SqliteMemoryStore on agent.db' })).toBeNull();
    expect(findDuplicate(live, { type: 'fact', proposition: 'Do not commit octopi.json' })).toBeNull();
  });

  it('admitCandidates rejects duplicate and session_rate_limit', async () => {
    const store = new InMemoryMemoryStore();
    const prop = 'When configuring memory backend use SqliteMemoryStore on agent.db';
    const first = await admitCandidates(store, [{
      type: 'method',
      proposition: prop,
      evidence: '"用 SqliteMemoryStore"',
      future_use: 'When configuring memory use SqliteMemoryStore',
      anchors: ['SqliteMemoryStore', 'agent.db'],
      channel: 'decision',
    }], 'session:s1;via:backfill');
    expect(first.accepted).toHaveLength(1);

    const second = await admitCandidates(store, [{
      type: 'method',
      proposition: prop,
      evidence: '"用 SqliteMemoryStore"',
      future_use: 'When configuring memory use SqliteMemoryStore',
      anchors: ['SqliteMemoryStore'],
      channel: 'decision',
    }], 'session:s2;via:backfill');
    expect(second.accepted).toHaveLength(0);
    expect(second.rejected[0]?.reason).toBe('duplicate');
    expect(second.rejected[0]?.existingId).toBe(first.accepted[0]!.id);

    for (let i = 0; i < 40; i++) {
      await admitCandidates(store, [{
        type: 'fact',
        proposition: `Unique fact number ${i} about agent.db path layout`,
        evidence: `"fact ${i}"`,
        anchors: ['agent.db', `fact${i}`],
        channel: 'decision',
      }], 'session:cap;via:backfill');
    }
    const over = await admitCandidates(store, [{
      type: 'fact',
      proposition: 'Another unique fact about sessions.index.db projection',
      evidence: '"index"',
      anchors: ['sessions.index.db'],
      channel: 'decision',
    }], 'session:cap;via:backfill');
    expect(over.rejected.some((r) => r.reason === 'session_rate_limit')).toBe(true);
  });

  it('memory_store rejects near-duplicate and hints supersedes_id', async () => {
    const store = new InMemoryMemoryStore();
    const tool = createMemoryStoreTool(store);
    const args = {
      type: 'fact',
      proposition: 'Project uses npm as package manager',
      evidence: '"用 npm"',
      channel: 'decision',
      anchors: ['npm'],
    };
    const first = (await tool.handler(args, { sessionId: 's' })) as { stored: boolean; id: string };
    expect(first.stored).toBe(true);
    const second = (await tool.handler(args, { sessionId: 's' })) as {
      stored: boolean; reason?: string; existingId?: string; message?: string;
    };
    expect(second.stored).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(second.existingId).toBe(first.id);
    expect(second.message).toContain('supersedes_id');
  });
});

describe('backfill failure semantics', () => {
  it('fails when llmPort missing', async () => {
    const store = new InMemoryMemoryStore();
    const out = await backfillHandler(
      { payload: { sessionText: evidence, sessionId: 's-fail' } },
      { memoryStore: store },
    );
    expect(out.act?.status).toBe('failed');
    expect(out.signals[0]?.data).toMatchObject({ reason: 'llm_port_missing' });
  });

  it('fails on LLM throw / error finish / parse failure (not success+0)', async () => {
    const store = new InMemoryMemoryStore();
    const base = { memoryStore: store };

    const thrown = await backfillHandler(
      { payload: { sessionText: evidence } },
      { ...base, llmPort: mockLlm('', { throwMsg: 'boom' }) },
    );
    expect(thrown.act?.status).toBe('failed');
    expect(thrown.signals[0]?.data).toMatchObject({ reason: 'llm_error' });

    const errFinish = await backfillHandler(
      { payload: { sessionText: evidence } },
      { ...base, llmPort: mockLlm('oops', { finishReason: 'error' }) },
    );
    expect(errFinish.act?.status).toBe('failed');

    const badJson = await backfillHandler(
      { payload: { sessionText: evidence } },
      { ...base, llmPort: mockLlm('not json at all') },
    );
    expect(badJson.act?.status).toBe('failed');
    expect(badJson.signals[0]?.data).toMatchObject({ reason: 'parse_failed' });

    const empty = await backfillHandler(
      { payload: { sessionText: evidence } },
      { ...base, llmPort: mockLlm('   ') },
    );
    expect(empty.act?.status).toBe('failed');
    expect(empty.signals[0]?.data).toMatchObject({ reason: 'llm_empty' });
  });

  it('success only for real JSON array (including empty [])', async () => {
    const store = new InMemoryMemoryStore();
    const emptyArr = await backfillHandler(
      { payload: { sessionText: evidence } },
      { memoryStore: store, llmPort: mockLlm('[]') },
    );
    expect(emptyArr.act?.status).toBe('success');
    expect(emptyArr.signals[0]?.data).toMatchObject({ accepted: 0 });

    const one = await backfillHandler(
      { payload: { sessionText: evidence } },
      {
        memoryStore: store,
        llmPort: mockLlm(JSON.stringify([{
          type: 'fact',
          proposition: 'Memory persists via SqliteMemoryStore on agent.db',
          evidence: '"SqliteMemoryStore 挂在 agent.db"',
          future_use: 'When configuring memory use SqliteMemoryStore',
          anchors: ['SqliteMemoryStore', 'agent.db'],
          channel: 'user_directive',
        }])),
      },
    );
    expect(one.act?.status).toBe('success');
    expect(one.signals[0]?.data).toMatchObject({ accepted: 1 });
  });
});

describe('backfill binds SUBSYSTEM.md as systemPrompt', () => {
  const md = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'subsystems', 'memory-steward', 'backfill', 'SUBSYSTEM.md'),
    'utf8',
  );

  it('passes cognitivePrompt + constitution into chat systemPrompt', async () => {
    const store = new InMemoryMemoryStore();
    const chat = vi.fn(async () => ({
      content: '[]',
      model: 'mini',
      finishReason: 'stop' as const,
    }));
    const llmPort: SubsystemLLMPort = {
      cognitivePrompt: md,
      defaultModel: 'mini',
      providerName: 'mock',
      resolved: { primary: { model: 'mini' }, fallback: [] } as any,
      chat,
    };
    await backfillHandler(
      { payload: { sessionText: evidence } },
      {
        memoryStore: store,
        llmPort,
        constitution: '## Memory rules\nAlways keep quotes',
      },
    );
    expect(chat).toHaveBeenCalledOnce();
    const req = chat.mock.calls[0]![0] as { systemPrompt?: string; messages: Array<{ content: string }> };
    expect(req.systemPrompt).toContain('记忆补录助手');
    expect(req.systemPrompt).toContain('Always keep quotes');
    expect(req.messages[0]!.content).toContain('Session evidence');
  });

  it('falls back to local SUBSYSTEM.md when port has no cognitivePrompt', async () => {
    const store = new InMemoryMemoryStore();
    const chat = vi.fn(async () => ({ content: '[]', model: 'mini', finishReason: 'stop' as const }));
    const llmPort: SubsystemLLMPort = {
      cognitivePrompt: '',
      defaultModel: 'mini',
      providerName: 'mock',
      resolved: { primary: { model: 'mini' }, fallback: [] } as any,
      chat,
    };
    await backfillHandler(
      { payload: { sessionText: evidence } },
      { memoryStore: store, llmPort },
    );
    const req = chat.mock.calls[0]![0] as { systemPrompt?: string };
    expect(req.systemPrompt ?? '').toContain('记忆补录助手');
  });
});

describe('govern boosts and promotion candidates', () => {
  it('planBoosts promotes retrieved shadow and reinforces live entries', () => {
    const now = Date.now();
    const boosts = planBoosts([
      {
        id: 'sh',
        type: 'method',
        content: 'When debugging use agent.db first',
        source: 't',
        confidence: 0.4,
        importance: 0.5,
        accessCount: 3,
        lastAccessedAt: now - 86_400_000,
        createdAt: now - 10 * 86_400_000,
        decayFactor: 1,
        tags: [],
        status: 'shadow',
        channel: 'model_inference',
        deleted: false,
      },
      {
        id: 'live',
        type: 'norm',
        content: 'Never commit octopi.json',
        source: 't',
        confidence: 0.7,
        importance: 0.8,
        accessCount: 5,
        lastAccessedAt: now - 2 * 86_400_000,
        createdAt: now - 20 * 86_400_000,
        decayFactor: 1,
        tags: [],
        status: 'active',
        channel: 'user_directive',
        deleted: false,
      },
      {
        id: 'stale',
        type: 'fact',
        content: 'Old unused fact about foo bar baz qux',
        source: 't',
        confidence: 0.6,
        importance: 0.5,
        accessCount: 4,
        lastAccessedAt: now - 60 * 86_400_000,
        createdAt: now - 90 * 86_400_000,
        decayFactor: 1,
        tags: [],
        status: 'active',
        channel: 'decision',
        deleted: false,
      },
    ], now);

    expect(boosts.find((b) => b.id === 'sh')?.op).toBe('promote_shadow');
    const reinforce = boosts.find((b) => b.id === 'live');
    expect(reinforce?.op).toBe('reinforce');
    expect(reinforce?.confidence).toBeGreaterThan(0.7);
    expect(boosts.find((b) => b.id === 'stale')).toBeUndefined();
  });

  it('govern handler applies boosts and emits promotionCandidates without writing Wisdom', async () => {
    const store = new InMemoryMemoryStore();
    const id = await store.store({
      type: 'method',
      content: 'When retry exceeds 3 switch to fallback provider immediately',
      source: 'test',
      confidence: 0.75,
      importance: 0.7,
      tags: ['method'],
      channel: 'fail_fix',
      status: 'active',
      evidence: '"retry 3 次后换 fallback"',
      anchors: ['retry', 'fallback'],
      future_use: 'When retry exceeds 3 switch to fallback',
    });
    await store.update(id, { accessCount: 4, lastAccessedAt: Date.now() });

    const out = await governHandler({}, { memoryStore: store });
    const data = out.signals[0]?.data as {
      boosted?: number;
      promotionCandidates?: Array<{ id: string }>;
    };
    expect(data.boosted).toBe(1);
    expect(data.promotionCandidates?.some((p) => p.id === id)).toBe(true);
    expect(out.act?.ops?.some((o) => o.op === 'boost' && o.ids.includes(id))).toBe(true);

    const after = await store.get(id);
    expect(after?.confidence).toBeGreaterThan(0.75);
    expect(after?.reinforcedAt).toBeGreaterThan(0);
  });

  it('planPromotionCandidates only surfaces method/norm with retrieval evidence', () => {
    const now = Date.now();
    const list = planPromotionCandidates([
      {
        id: 'm',
        type: 'method',
        content: 'Do X when Y',
        source: 't',
        confidence: 0.8,
        importance: 0.7,
        accessCount: 3,
        lastAccessedAt: now,
        createdAt: now,
        decayFactor: 1,
        tags: [],
        status: 'active',
        deleted: false,
      },
      {
        id: 'f',
        type: 'fact',
        content: 'Stable fact',
        source: 't',
        confidence: 0.9,
        importance: 0.9,
        accessCount: 9,
        lastAccessedAt: now,
        createdAt: now,
        decayFactor: 1,
        tags: [],
        status: 'active',
        deleted: false,
      },
      {
        id: 'sh',
        type: 'norm',
        content: 'Shadow norm',
        source: 't',
        confidence: 0.5,
        importance: 0.5,
        accessCount: 2,
        lastAccessedAt: now,
        createdAt: now,
        decayFactor: 1,
        tags: [],
        status: 'shadow',
        deleted: false,
      },
    ]);
    expect(list.map((x) => x.id)).toEqual(['m']);
  });
});
