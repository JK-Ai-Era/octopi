/**
 * Cognition 形成管线 — 门控 / 合并 / 持证边 / 衰减 / 扩散激活
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  InMemoryConceptGraph,
  AgentDatabase,
  SqliteConceptGraph,
} from '@octopi-agent/engine/harness/memory/index.js';
import {
  evaluateConceptGate,
  licenseEdge,
  conceptualizeAndAdmit,
  parseConceptualizerJson,
  hebbianStrengthen,
  nextEdgeStrength,
} from '@octopi-agent/engine/harness/memory/index.js';
import type { ConceptGraphStore } from '@octopi-agent/engine/harness/memory/types.js';

describe('cognition-gates', () => {
  it('rejects empty / pseudo / secret concepts', () => {
    expect(evaluateConceptGate({ name: '  ', kind: 'entity' }).reason).toBe('empty_name');
    expect(evaluateConceptGate({ name: 'the', kind: 'entity', supportCount: 3 }).reason).toBe('pseudo_concept');
    expect(
      evaluateConceptGate({
        name: 'api_key=sk-abcdefgh12345678',
        kind: 'entity',
        supportCount: 3,
      }).reason,
    ).toBe('secret_like');
  });

  it('mdl: needs ≥2 support unless method/constraint/construct with 1', () => {
    expect(
      evaluateConceptGate({ name: 'PostgreSQL', kind: 'entity', supportCount: 1 }).reason,
    ).toBe('mdl_insufficient');
    expect(
      evaluateConceptGate({ name: '退避重试', kind: 'method', supportCount: 1 }).ok,
    ).toBe(true);
    expect(
      evaluateConceptGate({ name: 'PostgreSQL', kind: 'entity', supportCount: 2 }).ok,
    ).toBe(true);
  });

  it('capacity admit stop blocks birth', () => {
    expect(
      evaluateConceptGate(
        { name: 'PostgreSQL', kind: 'entity', supportCount: 2 },
        { capacityAdmitStop: true },
      ).reason,
    ).toBe('capacity_admit_stop');
  });

  it('causes requires causal class + multi evidence; else demotes', () => {
    const weak = licenseEdge({
      relationType: 'causes',
      evidenceClass: 'cooccur',
      cue: 'x',
      memoryIds: ['m1', 'm2'],
    });
    expect(weak.relationType).toBe('related');
    expect(weak.status).toBe('demoted');

    const single = licenseEdge({
      relationType: 'causes',
      evidenceClass: 'causal',
      cue: '导致',
      memoryIds: ['m1'],
    });
    expect(single.status).toBe('candidate_only');
    expect(single.relationType).toBe('related');

    const ok = licenseEdge({
      relationType: 'causes',
      evidenceClass: 'causal',
      cue: '导致可用性下降',
      memoryIds: ['m1', 'm2'],
    });
    expect(ok.ok).toBe(true);
    expect(ok.relationType).toBe('causes');
    expect(ok.status).toBe('active');
  });

  it('cue mismatch demotes strong relations', () => {
    const r = licenseEdge({
      relationType: 'part_of',
      evidenceClass: 'mereonymy',
      cue: '不是原文',
      evidenceText: '租约是 Session 的一部分',
      memoryIds: ['m1'],
    });
    expect(r.reason).toBe('cue_mismatch');
    expect(r.relationType).toBe('related');
    expect(r.status).toBe('demoted');
  });

  it('cooccur never escalates to causes', () => {
    const r = licenseEdge({
      relationType: 'causes',
      evidenceClass: 'cooccur',
      cue: 'A B',
      evidenceText: 'A B',
      memoryIds: ['m1', 'm2'],
    });
    expect(r.relationType).toBe('related');
  });

  it('causes strengthened exception requires fail_fix channel', () => {
    const withoutChannel = licenseEdge({
      relationType: 'causes',
      evidenceClass: 'causal',
      cue: '导致',
      memoryIds: ['m1'],
      memoryStatuses: ['strengthened'],
    });
    expect(withoutChannel.status).toBe('candidate_only');

    const withFailFix = licenseEdge({
      relationType: 'causes',
      evidenceClass: 'causal',
      cue: '导致',
      memoryIds: ['m1'],
      memoryStatuses: ['strengthened'],
      memoryChannels: ['fail_fix'],
    });
    expect(withFailFix.status).toBe('active');
    expect(withFailFix.relationType).toBe('causes');
  });

  it('opposes with single memory stays shadow not active', () => {
    const r = licenseEdge({
      relationType: 'opposes',
      evidenceClass: 'negation',
      cue: '不是',
      evidenceText: 'A 不是 B',
      memoryIds: ['m1'],
    });
    expect(r.relationType).toBe('opposes');
    expect(r.status).toBe('shadow');
  });
});

describe('cognition-decay', () => {
  it('hebbian strengthens asymptotically to 1', () => {
    let w = 0.5;
    w = hebbianStrengthen(w, 1, 0.15);
    expect(w).toBeGreaterThan(0.5);
    expect(w).toBeLessThan(1);
  });

  it('related decays faster than causes', () => {
    const related = nextEdgeStrength(0.8, 'related', 30);
    const causes = nextEdgeStrength(0.8, 'causes', 30);
    expect(related).toBeLessThan(causes);
    expect(related).toBeGreaterThanOrEqual(0.02);
  });
});

describe('conceptualizer', () => {
  it('parses JSON object from LLM text', () => {
    const parsed = parseConceptualizerJson('noise {"nodes":[],"edges":[]} tail');
    expect(parsed).toEqual({ nodes: [], edges: [] });
  });

  it('rejects when no context slice', async () => {
    const r = await conceptualizeAndAdmit(
      { nodes: [{ name: 'PostgreSQL', kind: 'entity' }] },
      {
        proposition: 'p',
        memoryId: 'm1',
        memoryType: 'fact',
        evidence: '',
        contextSlice: '',
      },
    );
    expect(r.rejected[0]?.reason).toBe('no_context_slice');
    expect(r.nodes).toHaveLength(0);
  });

  it('admits nodes and demotes unlicensed causes to related', async () => {
    const store = new InMemoryConceptGraph();
    const r = await conceptualizeAndAdmit(
      {
        nodes: [
          { name: 'SessionLease', kind: 'construct', domain: ['session'] },
          { name: 'Session', kind: 'construct', domain: ['session'] },
        ],
        edges: [
          {
            fromName: 'SessionLease',
            toName: 'Session',
            relationType: 'causes',
            evidenceClass: 'cooccur',
            cue: 'SessionLease',
          },
        ],
      },
      {
        proposition: '租约按 sessionId 互斥',
        memoryId: 'm1',
        memoryType: 'fact',
        evidence: '租约按 sessionId 互斥',
        contextSlice: 'Locking uses sessionId-level lease.',
      },
      store,
    );

    expect(r.nodes.filter((n) => n.admit.action !== 'rejected').length).toBe(2);
    const edge = r.edges[0];
    expect(edge).toBeTruthy();
    expect(edge!.license.relationType).toBe('related');
  });
});

describe.each([
  ['InMemoryConceptGraph', () => new InMemoryConceptGraph()],
  [
    'SqliteConceptGraph',
    () => {
      // holder set in beforeEach
      return null as unknown as ConceptGraphStore;
    },
  ],
] as const)('%s store behavior', (label, factory) => {
  let store: ConceptGraphStore;
  let db: AgentDatabase | null = null;

  beforeEach(async () => {
    if (label === 'SqliteConceptGraph') {
      db = await AgentDatabase.create({ dbPath: ':memory:' });
      store = new SqliteConceptGraph(db);
    } else {
      store = factory();
    }
  });

  afterEach(() => {
    db?.close();
  });

  it('merges compatible same-name concepts', async () => {
    const a = await store.admitConcept({
      name: 'PostgreSQL',
      kind: 'entity',
      domain: ['db'],
      memoryIds: ['m1'],
      supportCount: 2,
    });
    const b = await store.admitConcept({
      name: 'postgresql',
      kind: 'entity',
      domain: ['db'],
      memoryIds: ['m2'],
      supportCount: 2,
    });
    expect(a.action).toBe('created');
    expect(b.action).toBe('merged');
    expect(b.id).toBe(a.id);
  });

  it('splits polysemy on fingerprint conflict', async () => {
    const a = await store.admitConcept({
      name: '锁',
      kind: 'construct',
      domain: ['session'],
      memoryIds: ['m1'],
      supportCount: 2,
    });
    const b = await store.admitConcept({
      name: '锁',
      kind: 'entity',
      domain: ['real-estate'],
      memoryIds: ['m2'],
      supportCount: 2,
    });
    expect(a.action).toBe('created');
    expect(b.action).toBe('merge_candidate');
    expect(b.id).not.toBe(a.id);
  });

  it('admitEdge: active strong with license; shadow related', async () => {
    const a = await store.admitConcept({
      name: 'SessionLease',
      kind: 'construct',
      supportCount: 2,
    });
    const b = await store.admitConcept({
      name: 'Session',
      kind: 'construct',
      supportCount: 2,
    });
    const strong = await store.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'part_of',
      strength: 0.8,
      basis: {
        memoryIds: ['m1'],
        cue: '租约是 Session 的一部分',
        evidenceClass: 'mereonymy',
        licensedAt: Date.now(),
      },
      evidenceText: '租约是 Session 的一部分',
    });
    expect(strong.action).toBe('active');
    expect(strong.relationType).toBe('part_of');

    const weak = await store.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'related',
      strength: 0.5,
      basis: {
        memoryIds: ['m1'],
        cue: 'SessionLease Session',
        evidenceClass: 'cooccur',
        licensedAt: Date.now(),
      },
      evidenceText: 'SessionLease Session',
    });
    expect(weak.action).toBe('shadow');
    expect(weak.relationType).toBe('related');
  });

  it('causes without multi-evidence becomes causal_candidate not edge', async () => {
    const a = await store.admitConcept({ name: 'Aaa', kind: 'entity', supportCount: 2 });
    const b = await store.admitConcept({ name: 'Bbb', kind: 'entity', supportCount: 2 });
    const r = await store.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'causes',
      strength: 0.9,
      basis: {
        memoryIds: ['m1'],
        cue: '导致',
        evidenceClass: 'causal',
        licensedAt: Date.now(),
      },
      evidenceText: 'Aaa 导致 Bbb',
    });
    expect(r.action).toBe('candidate_only');

    const full = await store.getFullGraph();
    expect(full.edges.filter((e) => e.relationType === 'causes')).toHaveLength(0);
  });

  it('spreadingActivate follows strengths and respects tau', async () => {
    const a = await store.admitConcept({ name: 'Root', kind: 'construct', supportCount: 2 });
    const b = await store.admitConcept({ name: 'Near', kind: 'construct', supportCount: 2 });
    const c = await store.admitConcept({ name: 'Far', kind: 'construct', supportCount: 2 });
    await store.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'part_of',
      strength: 0.9,
      basis: {
        memoryIds: ['m1', 'm2'],
        cue: 'Root is part of Near',
        evidenceClass: 'mereonymy',
        licensedAt: Date.now(),
      },
      evidenceText: 'Root is part of Near',
    });
    await store.admitEdge({
      sourceId: b.id!,
      targetId: c.id!,
      relationType: 'related',
      strength: 0.2,
      basis: {
        memoryIds: ['m1'],
        cue: 'Near Far',
        evidenceClass: 'cooccur',
        licensedAt: Date.now(),
      },
      evidenceText: 'Near Far',
    });
    await store.promote([a.id!, b.id!, c.id!], 'active');

    const hit = await store.spreadingActivate(['Root'], { depth: 2, tau: 0.05 });
    expect(hit.seeds.length).toBeGreaterThan(0);
    expect(hit.nodes.some((n) => n.name === 'Root')).toBe(true);
    expect(hit.nodes.some((n) => n.name === 'Near')).toBe(true);
  });

  it('promote makes nodes retrievable (default status filter)', async () => {
    const a = await store.admitConcept({ name: 'Hidden', kind: 'construct', supportCount: 2 });
    let hit = await store.spreadingActivate(['Hidden']);
    expect(hit.nodes).toHaveLength(0);

    await store.promote([a.id!], 'active');
    hit = await store.spreadingActivate(['Hidden']);
    expect(hit.nodes).toHaveLength(1);
  });

  it('empty seeds return empty graph (not full scan)', async () => {
    await store.admitConcept({ name: 'Root', kind: 'construct', supportCount: 2 });
    const hit = await store.spreadingActivate([]);
    expect(hit.nodes).toHaveLength(0);
    expect(hit.seeds).toHaveLength(0);
  });

  it('does not spread into shadow neighbors', async () => {
    const a = await store.admitConcept({ name: 'ActiveNode', kind: 'construct', supportCount: 2 });
    const b = await store.admitConcept({ name: 'ShadowNode', kind: 'construct', supportCount: 2 });
    await store.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'part_of',
      strength: 0.9,
      basis: {
        memoryIds: ['m1', 'm2'],
        cue: 'ActiveNode is part of ShadowNode',
        evidenceClass: 'mereonymy',
        licensedAt: Date.now(),
      },
      evidenceText: 'ActiveNode is part of ShadowNode',
    });
    await store.promote([a.id!], 'active');
    // b 保持 shadow

    const hit = await store.spreadingActivate(['ActiveNode'], { depth: 2, tau: 0.01 });
    expect(hit.nodes.some((n) => n.name === 'ActiveNode')).toBe(true);
    expect(hit.nodes.some((n) => n.name === 'ShadowNode')).toBe(false);
  });

  it('multi-evidence across admitEdge calls licenses causes', async () => {
    const a = await store.admitConcept({ name: 'CauseA', kind: 'construct', supportCount: 2 });
    const b = await store.admitConcept({ name: 'EffectB', kind: 'construct', supportCount: 2 });

    // 第一条命题：单证据 → candidate
    const r1 = await store.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'causes',
      strength: 0.8,
      basis: {
        memoryIds: ['m1'],
        cue: 'CauseA 导致 EffectB',
        evidenceClass: 'causal',
        licensedAt: Date.now(),
      },
      evidenceText: 'CauseA 导致 EffectB',
    });
    expect(r1.action).toBe('candidate_only');

    // 第二条独立命题：累积后 ≥2 → active causes
    const r2 = await store.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'causes',
      strength: 0.8,
      basis: {
        memoryIds: ['m2'],
        cue: 'CauseA 导致 EffectB',
        evidenceClass: 'causal',
        licensedAt: Date.now(),
      },
      evidenceText: 'CauseA 导致 EffectB',
    });
    expect(r2.action).toBe('active');
    expect(r2.relationType).toBe('causes');
  });

  it('resolveMerge merge does not crash on shared neighbors', async () => {
    const left = await store.admitConcept({
      name: 'Left',
      kind: 'entity',
      domain: ['x'],
      memoryIds: ['m1'],
      supportCount: 2,
    });
    const right = await store.admitConcept({
      name: 'left',
      kind: 'entity',
      domain: ['y'],
      memoryIds: ['m2'],
      supportCount: 2,
    });
    expect(right.action).toBe('merge_candidate');

    const hub = await store.admitConcept({ name: 'Hub', kind: 'construct', supportCount: 2 });
    // 左右都连 hub 的同型边 → merge 时 UNIQUE 冲突路径
    for (const src of [left.id!, right.id!]) {
      await store.admitEdge({
        sourceId: src,
        targetId: hub.id!,
        relationType: 'part_of',
        strength: 0.5,
        basis: {
          memoryIds: ['m1'],
          cue: 'part of Hub',
          evidenceClass: 'mereonymy',
          licensedAt: Date.now(),
        },
        evidenceText: 'part of Hub',
      });
    }

    const cands = await store.listMergeCandidates();
    const cand = cands.find((c) => c.leftId === left.id || c.rightId === right.id);
    expect(cand).toBeTruthy();

    await store.resolveMerge(cand!.id, 'merge');
    const full = await store.getFullGraph();
    expect(full.nodes.some((n) => n.id === right.id)).toBe(false);
    expect(full.nodes.some((n) => n.id === left.id)).toBe(true);
  });
});
