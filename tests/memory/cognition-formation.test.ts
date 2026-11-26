/**
 * Cognition 形成管线 — 门控 / 合并 / 持证边 / 衰减 / 扩散激活
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('mdl: recurrence voting — 1 vote parks for any kind (no kind bypass)', () => {
    // R7′：kind 不得成为出生旁路——1 票任何 kind 一律候选区
    expect(
      evaluateConceptGate({ name: 'PostgreSQL', kind: 'entity', supportCount: 1 }).reason,
    ).toBe('mdl_insufficient');
    expect(
      evaluateConceptGate({ name: '退避重试', kind: 'method', supportCount: 1 }).reason,
    ).toBe('mdl_insufficient');
    expect(
      evaluateConceptGate({ name: 'PostgreSQL', kind: 'entity', supportCount: 2 }).ok,
    ).toBe(true);
    // 定义直生通道（birthChannel='definition'）跳过计票门槛
    expect(
      evaluateConceptGate(
        { name: 'run', kind: 'construct', supportCount: 1, birthChannel: 'definition' },
        { skipMdl: true },
      ).ok,
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

  it('1-vote nodes park in birth candidates; unlicensed causes demote to related', async () => {
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

    // R7′ 复现计票：1 票入候选区，不进图（曾为「非 rejected 恒真」的 vacuous 断言）
    expect(r.nodes.every((n) => n.admit.action === 'candidate_parked')).toBe(true);
    expect((await store.getFullGraph()).nodes).toHaveLength(0);
    const edge = r.edges[0];
    expect(edge).toBeTruthy();
    expect(edge!.license.relationType).toBe('related');
    // 端点尚在候选区：如实归因，不冒充 cue 问题
    expect(edge!.license.reason).toBe('endpoint_not_admitted');
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

  it('splits polysemy on kind fingerprint conflict', async () => {
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
    const candidates = await store.listMergeCandidates(10);
    expect(candidates.find((c) => c.id === b.candidateId)?.reason).toBe('kind:construct≠entity');
  });

  it('同名同 kind 跨 domain 合并且 domain 取并集（B1：domain 多值不拆行）', async () => {
    const a = await store.admitConcept({
      name: '版本重放验证',
      kind: 'method',
      domain: ['cognition'],
      memoryIds: ['m1'],
      supportCount: 2,
    });
    const b = await store.admitConcept({
      name: '版本重放验证',
      kind: 'method',
      domain: ['release'],
      memoryIds: ['m2'],
      supportCount: 2,
    });
    expect(a.action).toBe('created');
    expect(b.action).toBe('merged');
    expect(b.id).toBe(a.id);
    const node = (await store.getFullGraph()).nodes.find((n) => n.id === a.id)!;
    expect(node.frequency).toBe(2);
    expect([...node.memoryIds].sort()).toEqual(['m1', 'm2']);
    expect([...node.domain].sort()).toEqual(['cognition', 'release']);
    expect(await store.listMergeCandidates(10)).toHaveLength(0);
  });

  it('同名多义项：与 kind 兼容的行合并（不被其他义项挡住）', async () => {
    await store.admitConcept({ name: '锁', kind: 'construct', supportCount: 2, memoryIds: ['m1'] });
    const b = await store.admitConcept({ name: '锁', kind: 'entity', supportCount: 2, memoryIds: ['m2'] });
    const c = await store.admitConcept({ name: '锁', kind: 'entity', supportCount: 2, memoryIds: ['m3'] });
    expect(b.action).toBe('merge_candidate');
    expect(c.action).toBe('merged');
    expect(c.id).toBe(b.id);
    // n2：合并只 +1、不重复累加
    const node = (await store.getFullGraph()).nodes.find((n) => n.id === b.id)!;
    expect(node.frequency).toBe(2);
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

  it('born active is retrievable; demote hides and promote restores (default status filter)', async () => {
    const a = await store.admitConcept({ name: 'Hidden', kind: 'construct', supportCount: 2 });
    // 出生即 active（R7′/R5′）：满票出生立即可召回
    let hit = await store.spreadingActivate(['Hidden']);
    expect(hit.nodes).toHaveLength(1);

    await store.demote([a.id!], 'shadow');
    hit = await store.spreadingActivate(['Hidden']);
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
    // b 出生即 active；显式降 shadow 验证扩散不进 shadow 邻居
    await store.demote([b.id!], 'shadow');

    const hit = await store.spreadingActivate(['ActiveNode'], { depth: 2, tau: 0.01 });
    expect(hit.nodes.some((n) => n.name === 'ActiveNode')).toBe(true);
    expect(hit.nodes.some((n) => n.name === 'ShadowNode')).toBe(false);
  });

  it('R7′ recurrence voting: 1 vote parks, 2nd vote births; same-memory vote is idempotent', async () => {
    // 1 票 → 出生候选区（不进图）
    const r1 = await store.admitConcept({ name: '复现计票', kind: 'method', memoryIds: ['m1'] });
    expect(r1.action).toBe('candidate_parked');
    expect((await store.getFullGraph()).nodes).toHaveLength(0);
    expect((await store.listBirthCandidates()).some((c) => c.name === '复现计票')).toBe(true);

    // 同一命题重复提案（同 memoryId）→ 幂等，不凑第二票
    const r2 = await store.admitConcept({ name: '复现计票', kind: 'method', memoryIds: ['m1'] });
    expect(r2.action).toBe('candidate_parked');
    expect((await store.getFullGraph()).nodes).toHaveLength(0);

    // 不同 memoryId 第二票 → 满票转正出生；出生即 active、票数与支撑并集
    const r3 = await store.admitConcept({ name: '复现计票', kind: 'method', memoryIds: ['m2'] });
    expect(r3.action).toBe('created');
    const born = await store.getFullGraph();
    expect(born.nodes).toHaveLength(1);
    expect(born.nodes[0]!.memoryIds.sort()).toEqual(['m1', 'm2']);
    expect(born.nodes[0]!.status).toBe('active');
    expect(born.nodes[0]!.frequency).toBe(2);
    expect(await store.listBirthCandidates()).toHaveLength(0);
    // 出生即 active → 立即可召回
    const hit = await store.spreadingActivate(['复现计票']);
    expect(hit.nodes.some((n) => n.name === '复现计票')).toBe(true);
  });

  it('R7′ birth candidate TTL: expired single-vote candidates are forgotten', async () => {
    await store.admitConcept({ name: '一次性教训', kind: 'constraint', memoryIds: ['m1'] });
    expect(await store.listBirthCandidates()).toHaveLength(1);
    const removed = await store.expireBirthCandidates(Date.now() + 15 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(await store.listBirthCandidates()).toHaveLength(0);
  });

  it('R7′ entity/problem kind births by voting (no kind bypass)', async () => {
    const r1 = await store.admitConcept({ name: 'PostgreSQL', kind: 'entity', memoryIds: ['m1'] });
    expect(r1.action).toBe('candidate_parked');
    const r2 = await store.admitConcept({ name: 'PostgreSQL', kind: 'entity', memoryIds: ['m2'] });
    expect(r2.action).toBe('created');
    expect((await store.getFullGraph()).nodes[0]!.kind).toBe('entity');
  });

  it('R7′ same-name different-kind candidates vote in separate buckets (M2)', async () => {
    const r1 = await store.admitConcept({ name: '口径词', kind: 'construct', memoryIds: ['m1'] });
    const r2 = await store.admitConcept({ name: '口径词', kind: 'constraint', memoryIds: ['m2'] });
    expect(r1.action).toBe('candidate_parked');
    expect(r2.action).toBe('candidate_parked');
    // 两桶各 1 票互不合并；kind 不被最后一票篡改
    const candidates = await store.listBirthCandidates();
    expect(candidates.filter((c) => c.name === '口径词')).toHaveLength(2);
    expect((await store.getFullGraph()).nodes).toHaveLength(0);
  });

  it('R7′ birth failure keeps votes in candidate (birth_deferred, no silent loss) (M3)', async () => {
    await store.admitConcept({ name: '容量压测', kind: 'construct', memoryIds: ['m1'] });
    // 第二票转正时人为制造出生失败（模拟 capacity_admit_stop）
    const orig = store.admitConcept.bind(store);
    const spy = vi.spyOn(store, 'admitConcept').mockImplementation(async (input) => {
      if ((input.supportCount ?? 0) >= 2) {
        return { action: 'rejected', reason: 'capacity_admit_stop', message: 'nodes full' };
      }
      return orig(input);
    });
    const r2 = await store.admitConcept({ name: '容量压测', kind: 'construct', memoryIds: ['m2'] });
    expect(r2.action).toBe('candidate_parked');
    expect(r2.message).toContain('birth_deferred');
    // 票没丢：候选仍在、票已并入
    const parked = (await store.listBirthCandidates()).find((c) => c.name === '容量压测');
    expect(parked?.memoryIds.sort()).toEqual(['m1', 'm2']);
    // 容量恢复后满票转正成功
    spy.mockRestore();
    const r3 = await store.admitConcept({ name: '容量压测', kind: 'construct', memoryIds: ['m3'] });
    expect(r3.action).toBe('created');
    expect((await store.getFullGraph()).nodes[0]!.memoryIds.sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('R7′ promotion keeps first-vote description/domain when 2nd vote lacks them (M4)', async () => {
    await store.admitConcept({
      name: '活口径',
      kind: 'construct',
      memoryIds: ['m1'],
      description: '首票释义',
      domain: ['d1'],
    });
    const r2 = await store.admitConcept({ name: '活口径', kind: 'construct', memoryIds: ['m2'] });
    expect(r2.action).toBe('created');
    const node = (await store.getFullGraph()).nodes[0]!;
    expect(node.description).toBe('首票释义');
    expect(node.domain).toContain('d1');
  });

  it('R7′ two distinct memoryIds in one call birth directly (votes = memoryIds) (m1)', async () => {
    const r = await store.admitConcept({
      name: '一次两票',
      kind: 'method',
      memoryIds: ['m1', 'm2'],
      supportCount: 1,
    });
    expect(r.action).toBe('created');
    expect((await store.getFullGraph()).nodes[0]!.memoryIds.sort()).toEqual(['m1', 'm2']);
  });

  it('R7′ definition channel births at 1 vote; without memoryIds it is rejected (m2)', async () => {
    const r = await store.admitConcept({
      name: 'run',
      kind: 'construct',
      memoryIds: ['m1'],
      birthChannel: 'definition',
      description: '一次 Agent.run() 执行',
    });
    expect(r.action).toBe('created');
    expect((await store.getFullGraph()).nodes[0]!.status).toBe('active');

    const bad = await store.admitConcept({ name: 'turn', kind: 'construct', birthChannel: 'definition' });
    expect(bad.action).toBe('rejected');
    expect(bad.reason).toBe('mdl_insufficient');
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
      kind: 'construct',
      domain: ['y'],
      memoryIds: ['m2'],
      description: '右描述',
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
    const survivor = full.nodes.find((n) => n.id === left.id)!;
    expect(survivor).toBeTruthy();
    // M1：合并语义完整——domain 并集、description 空侧吸收、frequency 累加（禁静默丢数据）
    expect([...survivor.domain].sort()).toEqual(['x', 'y']);
    expect(survivor.description).toBe('右描述');
    expect(survivor.frequency).toBe(2);
  });
});
