import { describe, it, expect } from 'vitest';
import { evaluateGates } from '../../src/harness/memory/gates.js';
import { provisionalConfidence, injectFilter, hasQuoteEvidence } from '../../src/harness/memory/confidence.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import { mapLegacyType } from '../../src/harness/memory/gates.js';

describe('memory gates', () => {
  it('rejects statistical summaries without anchors/futureUse/quote', () => {
    const r = evaluateGates({
      type: 'norm',
      proposition: '用户在会话中明确表达/确认了 1 条约束或偏好',
      evidence: '用户原话',
      channel: 'model_inference',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('statistical_summary');
  });

  it('allows quantity phrases when futureUse/anchors present', () => {
    const r = evaluateGates({
      type: 'method',
      proposition: '当 retry 超过 3 次时改用 fallback provider',
      evidence: '修好了：换 fallback',
      channel: 'fail_fix',
      futureUse: 'When provider retry exceeds 3, switch to fallback',
      anchors: ['retry', 'fallback'],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects auto write without evidence', () => {
    const r = evaluateGates({
      type: 'fact',
      proposition: 'Memory 持久化使用 SqliteMemoryStore 挂在 agent.db',
      channel: 'model_inference',
      anchors: ['SqliteMemoryStore', 'agent.db'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_evidence');
  });

  it('accepts fact with anchors and evidence', () => {
    const r = evaluateGates({
      type: 'fact',
      proposition: 'Memory 持久化使用 SqliteMemoryStore 挂在 agent.db',
      evidence: '我们定过了：用 SqliteMemoryStore',
      channel: 'decision',
      anchors: ['SqliteMemoryStore', 'agent.db'],
      futureUse: 'When configuring memory backend use SqliteMemoryStore',
    });
    expect(r.ok).toBe(true);
  });

  it('allows constitution security norms that mention API key words', () => {
    const r = evaluateGates({
      type: 'norm',
      proposition: 'Do not store API keys or passwords in Memory',
      evidence: 'constitution boundary',
      channel: 'user_directive',
      anchors: ['Memory', 'API'],
      futureUse: 'When tempted to persist secrets, refuse',
    });
    expect(r.ok).toBe(true);
  });

  it('shadows user_directive without anchors but with quote', () => {
    const r = evaluateGates({
      type: 'norm',
      proposition: '回答前先联网核实再下判断',
      evidence: '"不要那么主观嘛，你通过网络先了解一下"',
      channel: 'user_directive',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('shadow');
  });
});

describe('memory confidence', () => {
  it('detects quote-shaped evidence', () => {
    expect(hasQuoteEvidence('不要那么主观')).toBe(false);
    expect(hasQuoteEvidence('"不要那么主观嘛"')).toBe(true);
    expect(hasQuoteEvidence('quote: use npm')).toBe(true);
  });

  it('user_directive with quote-like evidence is active high', () => {
    const p = provisionalConfidence({
      channel: 'user_directive',
      evidence: '"不要提交 octopi.json"',
      anchors: ['octopi.json'],
    });
    expect(p.status).toBe('active');
    expect(p.confidence).toBeGreaterThan(0.8);
  });

  it('model_inference without quote is always shadow', () => {
    const p = provisionalConfidence({
      channel: 'model_inference',
      evidence: 'paraphrase without quotation marks',
      anchors: ['x.ts'],
    });
    expect(p.status).toBe('shadow');
  });

  it('model_inference without any evidence is shadow', () => {
    const p = provisionalConfidence({
      channel: 'model_inference',
      anchors: ['x.ts'],
    });
    expect(p.status).toBe('shadow');
  });

  it('injectFilter hides shadow and low-score actives', () => {
    expect(injectFilter({ status: 'shadow', deleted: false, confidence: 0.9, importance: 0.9 })).toBe(false);
    expect(injectFilter({ status: 'active', deleted: true, confidence: 0.9, importance: 0.9 })).toBe(false);
    expect(injectFilter({ status: 'active', deleted: false, confidence: 0.8, importance: 0.8 })).toBe(true);
  });
});

describe('legacy type mapping', () => {
  it('maps old MemoryType values to fact/method/norm', () => {
    expect(mapLegacyType('preference')).toBe('norm');
    expect(mapLegacyType('decision')).toBe('norm');
    expect(mapLegacyType('lesson')).toBe('method');
    expect(mapLegacyType('discovery')).toBe('fact');
    expect(mapLegacyType('fact')).toBe('fact');
  });
});

describe('memory store soft delete + tags', () => {
  it('excludes deleted from retrieve and search path', async () => {
    const store = new InMemoryMemoryStore();
    const id = await store.store({
      type: 'fact',
      content: 'octopi config lives at ~/.octopi/octopi.json',
      source: 'test',
      confidence: 0.9,
      importance: 0.8,
      tags: ['octopi'],
      channel: 'decision',
      status: 'active',
      evidence: 'AGENTS.md',
      anchors: ['octopi.json'],
    });
    await store.softDelete(id, { by: 'test', reason: 'junk_recheck' });
    const found = await store.retrieve({ text: 'octopi.json', includeShadow: true, includeDeleted: false });
    expect(found.find((e) => e.id === id)).toBeUndefined();
    const stats = await store.stats();
    expect(stats.deletedEntries).toBe(1);
    expect(stats.totalEntries).toBe(0);
  });

  it('search can see shadow but layer path should not', async () => {
    const store = new InMemoryMemoryStore();
    await store.store({
      type: 'norm',
      content: '先联网再判断',
      source: 'test',
      confidence: 0.5,
      importance: 0.5,
      tags: [],
      channel: 'model_inference',
      status: 'shadow',
      evidence: '"quote for shadow"',
    });
    const inject = await store.retrieve({ text: '联网', includeShadow: false });
    expect(inject).toHaveLength(0);
    const search = await store.retrieve({ text: '联网', includeShadow: true });
    expect(search).toHaveLength(1);
  });

  it('filters by tags', async () => {
    const store = new InMemoryMemoryStore();
    await store.store({
      type: 'fact',
      content: 'agent.db path is under agent home',
      source: 't',
      confidence: 0.8,
      importance: 0.7,
      tags: ['octopi', 'fact'],
      channel: 'admin',
      status: 'active',
      evidence: 'e',
    });
    const hit = await store.retrieve({ text: 'agent.db', tags: ['octopi'] });
    expect(hit).toHaveLength(1);
    const miss = await store.retrieve({ text: 'agent.db', tags: ['nope'] });
    expect(miss).toHaveLength(0);
  });
});
