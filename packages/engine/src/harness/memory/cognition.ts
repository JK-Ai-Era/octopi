/**
 * InMemoryConceptGraph — 内存认知图谱（测试/轻量）
 *
 * 实现与 SqliteConceptGraph 同一 `ConceptGraphStore` 契约：
 * 结构同一性合并、持证边、衰减、扩散激活。无正则 extractFromText。
 *
 * @module harness/memory/cognition
 */

import { randomUUID } from 'node:crypto';
import type {
  ActivatedGraph,
  AdmitConceptInput,
  AdmitConceptResult,
  AdmitEdgeInput,
  AdmitEdgeResult,
  BirthCandidate,
  ConceptEdge,
  ConceptGraph,
  ConceptGraphStats,
  ConceptGraphStore,
  ConceptKind,
  ConceptNode,
  ConceptRelationType,
  ConceptStatus,
  DecayResult,
  EdgeBasis,
  MergeCandidate,
  SpreadingActivateOptions,
} from './cognition-types.js';
import {
  counterEvidenceWeaken,
  DEFAULT_EDGE_DECAY_FLOOR,
  DEFAULT_RETRIEVE_STATUSES,
  hebbianStrengthen,
  nextEdgeStrength,
} from './cognition-decay.js';
import { BIRTH_CANDIDATE_TTL_MS, evaluateConceptGate, licenseEdge } from './cognition-gates.js';
import { createSeedMatcher, normName } from './cognition-seeds.js';

function daysBetween(a: number, b: number): number {
  return Math.max(0, (b - a) / 86_400_000);
}

export class InMemoryConceptGraph implements ConceptGraphStore {
  private nodes = new Map<string, ConceptNode>();
  private edges = new Map<string, ConceptEdge>();
  private mergeCandidates = new Map<string, MergeCandidate>();
  private birthCandidates = new Map<string, BirthCandidate>();
  private causalCandidates: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    memoryIds: string[];
    cue: string;
    note?: string;
    createdAt: number;
  }> = [];

  private get capacityStop(): boolean {
    return this.nodes.size >= 10_000 || this.edges.size >= 40_000;
  }

  async admitConcept(input: AdmitConceptInput): Promise<AdmitConceptResult> {
    const isDefinition = input.birthChannel === 'definition';
    const gate = evaluateConceptGate(input, {
      capacityAdmitStop: this.capacityStop,
      skipMdl: isDefinition,
    });
    if (!gate.ok) {
      // 票不够（非定义直生）→ 出生候选区投票；满 2 票转正（R7′ 复现计票）
      if (gate.reason === 'mdl_insufficient') {
        return this.parkOrPromoteBirthCandidate(input);
      }
      return { action: 'rejected', reason: gate.reason, message: gate.message };
    }

    const key = normName(input.name);
    const sameNames = [...this.nodes.values()].filter((n) => normName(n.name) === key);

    const conflicts: Array<{ node: ConceptNode; reason: string }> = [];
    for (const sameName of sameNames) {
      const conflict = this.fingerprintConflict(sameName, input);
      if (conflict) {
        conflicts.push({ node: sameName, reason: conflict });
        continue;
      }
      // 指纹兼容 → 合并
      sameName.updatedAt = Date.now();
      for (const mid of input.memoryIds ?? []) {
        if (!sameName.memoryIds.includes(mid)) sameName.memoryIds.push(mid);
      }
      // frequency = 票数派生（与 insertNode 同口径）；无票调用回退计次
      sameName.frequency =
        sameName.memoryIds.length > 0 ? sameName.memoryIds.length : sameName.frequency + 1;
      for (const d of input.domain ?? []) {
        if (!sameName.domain.includes(d)) sameName.domain.push(d);
      }
      if (input.description && sameName.description == null) {
        sameName.description = input.description;
      }
      return { action: 'merged', id: sameName.id, reason: 'ok' };
    }

    if (conflicts.length) {
      const id = this.insertNode(input);
      const candidateId = this.pushMergeCandidate(conflicts[0]!.node.id, id, conflicts[0]!.reason);
      return { action: 'merge_candidate', id, candidateId, reason: 'fingerprint_conflict' };
    }

    // 无 embedding 注入的近邻候选不在此实现（有向量的近邻路径在 SqliteConceptGraph）
    const id = this.insertNode(input);
    return { action: 'created', id, reason: 'ok' };
  }

  private insertNode(input: AdmitConceptInput): string {
    const id = `cpt_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const memIds = [...new Set(input.memoryIds ?? [])];
    this.nodes.set(id, {
      id,
      name: input.name.trim(),
      kind: input.kind,
      description: input.description,
      // 出生即 active（R7′/R5′）；frequency = 票数
      frequency: Math.max(1, memIds.length),
      memoryIds: memIds,
      domain: [...new Set(input.domain ?? [])],
      status: 'active',
      embedding: null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  /**
   * 复现计票（R7′）：1 票入出生候选区，满 2 票转正出生（与 SqliteConceptGraph 同构）。
   * 候选按 (nameKey, kind) 分桶；TTL 为固定出生窗口，到期仍 <2 票即遗忘。
   */
  private async parkOrPromoteBirthCandidate(input: AdmitConceptInput): Promise<AdmitConceptResult> {
    const now = Date.now();
    const nameKey = normName(input.name);
    const incoming = new Set(input.memoryIds ?? []);
    if (incoming.size === 0) {
      return { action: 'rejected', reason: 'mdl_insufficient', message: 'no vote (empty memoryIds)' };
    }

    // 过期票作废，新票重新起算窗口
    for (const [id, c] of this.birthCandidates) {
      if (c.nameKey === nameKey && c.kind === input.kind && c.expiresAt <= now) {
        this.birthCandidates.delete(id);
      }
    }

    const existing = [...this.birthCandidates.values()].find(
      (c) => c.nameKey === nameKey && c.kind === input.kind,
    );
    const memIds = new Set([...(existing?.memoryIds ?? []), ...incoming]);
    const domains = new Set([...(existing?.domain ?? []), ...(input.domain ?? [])]);

    // 满票转正：先出生、成功后才删候选（失败票回写候选，不静默丢票——fail loud）
    if (memIds.size >= 2) {
      const result = await this.admitConcept({
        ...input,
        description: input.description ?? existing?.description ?? undefined,
        domain: [...domains],
        memoryIds: [...memIds],
        supportCount: memIds.size,
      });
      if (result.action === 'rejected') {
        if (existing) {
          existing.memoryIds = [...memIds];
          existing.domain = [...domains];
          if (input.description && !existing.description) existing.description = input.description;
          existing.updatedAt = now;
          return {
            action: 'candidate_parked',
            candidateId: existing.id,
            reason: result.reason,
            message: `birth_deferred: ${result.message ?? ''} votes=${memIds.size}`,
          };
        }
        return result;
      }
      if (existing) this.birthCandidates.delete(existing.id);
      return result;
    }

    if (existing) {
      existing.memoryIds = [...memIds];
      for (const d of domains) {
        if (!existing.domain.includes(d)) existing.domain.push(d);
      }
      if (input.description && !existing.description) existing.description = input.description;
      existing.updatedAt = now;
      return { action: 'candidate_parked', candidateId: existing.id, reason: 'ok', message: `votes=${memIds.size}` };
    }

    const id = `cbc_${randomUUID().slice(0, 8)}`;
    this.birthCandidates.set(id, {
      id,
      nameKey,
      name: input.name.trim(),
      kind: input.kind,
      description: input.description,
      domain: [...domains],
      aliases: [],
      memoryIds: [...incoming],
      createdAt: now,
      updatedAt: now,
      expiresAt: now + BIRTH_CANDIDATE_TTL_MS,
    });
    return { action: 'candidate_parked', candidateId: id, reason: 'ok', message: 'votes=1' };
  }

  async listBirthCandidates(limit = 100): Promise<BirthCandidate[]> {
    // 只列未过期（在册 = 未满票、未到期）
    return [...this.birthCandidates.values()]
      .filter((c) => c.expiresAt > Date.now())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((c) => ({ ...c, domain: [...c.domain], aliases: [...c.aliases], memoryIds: [...c.memoryIds] }));
  }

  async expireBirthCandidates(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const [id, c] of this.birthCandidates) {
      if (c.expiresAt <= now) {
        this.birthCandidates.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** 义项指纹冲突：仅 kind 不同。domain 是多值标签不参与义项判定（同名同 kind 合并且 domain 取并集） */
  private fingerprintConflict(
    existing: ConceptNode,
    input: AdmitConceptInput,
  ): string | null {
    if (existing.kind !== input.kind) return `kind:${existing.kind}≠${input.kind}`;
    return null;
  }

  private pushMergeCandidate(
    existingId: string,
    newId: string,
    reason: string,
  ): string {
    const id = `mrg_${randomUUID().slice(0, 8)}`;
    this.mergeCandidates.set(id, {
      id,
      leftId: existingId,
      rightId: newId,
      reason,
      distance: null,
      fingerprintDiff: [reason],
      status: 'open',
      createdAt: Date.now(),
    });
    return id;
  }

  private collectPairMemoryIds(sourceId: string, targetId: string): string[] {
    const ids = new Set<string>();
    for (const e of this.edges.values()) {
      const pair =
        (e.sourceId === sourceId && e.targetId === targetId) ||
        (e.sourceId === targetId && e.targetId === sourceId);
      if (!pair) continue;
      for (const mid of e.basis.memoryIds) ids.add(mid);
    }
    for (const c of this.causalCandidates) {
      const pair =
        (c.sourceId === sourceId && c.targetId === targetId) ||
        (c.sourceId === targetId && c.targetId === sourceId);
      if (!pair) continue;
      for (const mid of c.memoryIds) ids.add(mid);
    }
    return [...ids];
  }

  async admitEdge(input: AdmitEdgeInput): Promise<AdmitEdgeResult> {
    const priorIds = this.collectPairMemoryIds(input.sourceId, input.targetId);
    const memoryIds = [...new Set([...priorIds, ...(input.basis.memoryIds ?? [])])];

    const license = licenseEdge({
      relationType: input.relationType,
      evidenceClass: input.basis.evidenceClass,
      cue: input.basis.cue,
      evidenceText: input.evidenceText,
      memoryIds,
    });

    if (license.status === 'rejected') {
      return {
        action: 'rejected',
        reason: license.reason,
        message: license.message,
      };
    }
    if (license.status === 'candidate_only') {
      await this.addCausalCandidate({
        sourceId: input.sourceId,
        targetId: input.targetId,
        memoryIds: input.basis.memoryIds,
        cue: input.basis.cue,
        note: license.message,
      });
      return {
        action: 'candidate_only',
        reason: license.reason,
        message: license.message,
      };
    }

    const source = this.nodes.get(input.sourceId);
    const target = this.nodes.get(input.targetId);
    if (!source || !target) {
      return { action: 'rejected', reason: 'invalid_relation', message: 'endpoint missing' };
    }

    const relationType = license.relationType;
    const status: ConceptStatus =
      license.status === 'active' ? 'active' : 'shadow';

    const existingKey = [...this.edges.entries()].find(
      ([, e]) =>
        e.sourceId === input.sourceId &&
        e.targetId === input.targetId &&
        e.relationType === relationType,
    );

    const now = Date.now();
    if (existingKey) {
      const [, edge] = existingKey;
      edge.strength = Math.max(edge.strength, input.strength);
      edge.updatedAt = now;
      for (const mid of input.basis.memoryIds) {
        if (!edge.basis.memoryIds.includes(mid)) edge.basis.memoryIds.push(mid);
      }
      if (status === 'active' && edge.status === 'shadow') edge.status = 'active';
      return {
        action: license.status === 'demoted' ? 'demoted' : status,
        edgeId: edge.id,
        relationType,
        reason: license.reason,
      };
    }

    const edgeId = `edge_${randomUUID().slice(0, 8)}`;
    const basis: EdgeBasis = {
      memoryIds: [...input.basis.memoryIds],
      cue: input.basis.cue,
      evidenceClass: input.basis.evidenceClass,
      licensedAt: input.basis.licensedAt ?? now,
    };
    this.edges.set(edgeId, {
      id: edgeId,
      sourceId: input.sourceId,
      targetId: input.targetId,
      relationType,
      strength: Math.min(1, Math.max(0, input.strength)),
      description: input.description,
      status,
      basis,
      createdAt: now,
      updatedAt: now,
    });

    return {
      action: license.status === 'demoted' ? 'demoted' : status,
      edgeId,
      relationType,
      reason: license.reason,
    };
  }

  async addCausalCandidate(input: {
    sourceId: string;
    targetId: string;
    memoryIds: string[];
    cue: string;
    note?: string;
  }): Promise<void> {
    this.causalCandidates.push({
      id: `causal_${randomUUID().slice(0, 8)}`,
      ...input,
      createdAt: Date.now(),
    });
  }

  async listMergeCandidates(limit = 50): Promise<MergeCandidate[]> {
    return [...this.mergeCandidates.values()]
      .filter((c) => c.status === 'open')
      .slice(0, limit);
  }

  /** 无向量能力（InMemory 不注 embedding）：语义种子恒空，调用方据 supportsSemanticSeeds 降级纯词面 */
  readonly supportsSemanticSeeds = false;

  /**
   * 与 ConceptGraphStore 契约同签名：query/k 收下但不使用（无向量能力，调用方据 supportsSemanticSeeds 降级）。
   * @returns 恒空数组——InMemory 无向量，语义种子不可用（能力缺失，非数据为空）
   */
  async semanticSeeds(_query: string, _k?: number): Promise<string[]> {
    return [];
  }

  async resolveMerge(
    id: string,
    action: 'merge' | 'keep_split' | 'drop',
    options?: { canonicalKind?: ConceptKind },
  ): Promise<void> {
    const cand = this.mergeCandidates.get(id);
    if (!cand) return;

    if (action !== 'merge') {
      cand.status = action === 'keep_split' ? 'kept_split' : 'dropped';
      cand.resolvedAt = Date.now();
      cand.resolvedAction = action;
      return;
    }

    const left = this.nodes.get(cand.leftId);
    const right = this.nodes.get(cand.rightId);
    if (!left || !right || left.id === right.id) {
      // 与 Sqlite 同构：端点缺失/悬空记 drop_missing_endpoint，不假记 merged
      cand.status = 'dropped';
      cand.resolvedAt = Date.now();
      cand.resolvedAction = 'drop_missing_endpoint';
      return;
    }

    cand.status = 'merged';
    cand.resolvedAt = Date.now();
    cand.resolvedAction = 'merge';

    left.frequency += right.frequency;
    for (const mid of right.memoryIds) {
      if (!left.memoryIds.includes(mid)) left.memoryIds.push(mid);
    }
    for (const d of right.domain) {
      if (!left.domain.includes(d)) left.domain.push(d);
    }
    if (left.description == null && right.description) {
      left.description = right.description;
    }
    if (options?.canonicalKind && left.kind !== options.canonicalKind) {
      left.kind = options.canonicalKind;
    }
    // 迁移边；同 pair 同类型去重，丢自环
    const seen = new Set<string>();
    for (const e of [...this.edges.values()]) {
      if (e.sourceId === right.id) e.sourceId = left.id;
      if (e.targetId === right.id) e.targetId = left.id;
      if (e.sourceId === e.targetId) {
        this.edges.delete(e.id);
        continue;
      }
      const key = `${e.sourceId}|${e.targetId}|${e.relationType}`;
      if (seen.has(key)) {
        this.edges.delete(e.id);
      } else {
        seen.add(key);
      }
    }
    this.nodes.delete(right.id);
  }

  async reinforce(input: {
    nodeIds?: string[];
    edgeIds?: string[];
    evidenceStrength?: number;
  }): Promise<void> {
    const e = Math.min(1, Math.max(0, input.evidenceStrength ?? 0.5));
    for (const id of input.nodeIds ?? []) {
      const n = this.nodes.get(id);
      if (n) {
        n.frequency += 1;
        n.updatedAt = Date.now();
      }
    }
    for (const id of input.edgeIds ?? []) {
      const edge = this.edges.get(id);
      if (edge) {
        edge.strength = hebbianStrengthen(edge.strength, e);
        edge.updatedAt = Date.now();
      }
    }
  }

  async counterEvidence(input: {
    edgeId: string;
    memoryId?: string;
    markOpposes?: boolean;
  }): Promise<void> {
    const edge = this.edges.get(input.edgeId);
    if (!edge) return;
    edge.strength = counterEvidenceWeaken(edge.strength);
    if (input.markOpposes) edge.relationType = 'opposes';
    if (input.memoryId && edge.basis.memoryIds.includes(input.memoryId)) {
      edge.basis.memoryIds = edge.basis.memoryIds.filter((m) => m !== input.memoryId);
    }
    edge.updatedAt = Date.now();
  }

  async promote(ids: string[], to: 'active' | 'strengthened'): Promise<void> {
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (n) {
        n.status = to;
        n.updatedAt = Date.now();
      }
      const e = this.edges.get(id);
      if (e) {
        e.status = to;
        e.updatedAt = Date.now();
      }
    }
  }

  async demote(ids: string[], to: 'shadow'): Promise<void> {
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (n) {
        n.status = to;
        n.updatedAt = Date.now();
      }
      const e = this.edges.get(id);
      if (e) {
        e.status = to;
        e.updatedAt = Date.now();
      }
    }
  }

  async applyDecay(now = Date.now()): Promise<DecayResult> {
    let decayedEdges = 0;
    for (const edge of this.edges.values()) {
      const days = daysBetween(edge.updatedAt, now);
      if (days < 1) continue;
      const next = nextEdgeStrength(edge.strength, edge.relationType, days);
      if (next < edge.strength - 1e-6) {
        edge.strength = next;
        edge.updatedAt = now;
        decayedEdges += 1;
      }
    }

    // GC：无 memory 支撑且无边
    const connected = new Set<string>();
    for (const e of this.edges.values()) {
      if (e.strength > DEFAULT_EDGE_DECAY_FLOOR) {
        connected.add(e.sourceId);
        connected.add(e.targetId);
      }
    }
    let gcNodes = 0;
    for (const n of [...this.nodes.values()]) {
      if (!connected.has(n.id) && n.memoryIds.length === 0) {
        this.nodes.delete(n.id);
        gcNodes += 1;
      }
    }
    let gcEdges = 0;
    for (const e of [...this.edges.values()]) {
      if (!this.nodes.has(e.sourceId) || !this.nodes.has(e.targetId)) {
        this.edges.delete(e.id);
        gcEdges += 1;
      }
    }
    return { decayedEdges, gcNodes, gcEdges };
  }

  async spreadingActivate(
    seeds: string[],
    options?: SpreadingActivateOptions,
  ): Promise<ActivatedGraph> {
    const depth = options?.depth ?? 2;
    const delta = options?.delta ?? 0.55;
    const tau = options?.tau ?? 0.08;
    const limit = options?.limit ?? 40;
    const statuses = new Set(options?.statuses ?? DEFAULT_RETRIEVE_STATUSES);

    const seedIds: string[] = [];
    const activation = new Map<string, number>();
    const seedMatcher = createSeedMatcher(seeds);

    for (const n of this.nodes.values()) {
      if (!statuses.has(n.status)) continue;
      if (seedMatcher(n.name, n.description)) {
        seedIds.push(n.id);
        activation.set(n.id, 1);
      }
    }

    // 扩散
    const adj = new Map<string, Array<{ to: string; w: number }>>();
    for (const e of this.edges.values()) {
      if (!this.nodes.has(e.sourceId) || !this.nodes.has(e.targetId)) continue;
      const src = this.nodes.get(e.sourceId)!;
      const tgt = this.nodes.get(e.targetId)!;
      if (!statuses.has(src.status) || !statuses.has(tgt.status)) continue;
      if (!adj.has(e.sourceId)) adj.set(e.sourceId, []);
      if (!adj.has(e.targetId)) adj.set(e.targetId, []);
      adj.get(e.sourceId)!.push({ to: e.targetId, w: e.strength });
      adj.get(e.targetId)!.push({ to: e.sourceId, w: e.strength });
    }

    let frontier = [...seedIds];
    for (let d = 1; d <= depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const a = activation.get(id) ?? 0;
        for (const { to, w } of adj.get(id) ?? []) {
          const v = a * w * Math.pow(delta, d);
          const prev = activation.get(to) ?? 0;
          if (v > prev && v >= tau) {
            activation.set(to, Math.max(prev, v));
            next.push(to);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }

    const kept = [...activation.entries()]
      .filter(([, a]) => a >= tau)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    const nodeIds = new Set(kept.map(([id]) => id));
    const nodes = [...nodeIds]
      .map((id) => this.nodes.get(id)!)
      .filter(Boolean);
    const edges = [...this.edges.values()].filter(
      (e) => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId),
    );

    return {
      nodes,
      edges,
      activation: Object.fromEntries(kept),
      seeds: seedIds,
    };
  }

  async getFullGraph(): Promise<ConceptGraph> {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }

  async stats(): Promise<ConceptGraphStats> {
    const byStatus: Record<ConceptStatus, number> = {
      shadow: 0,
      active: 0,
      strengthened: 0,
    };
    const byKind = {
      entity: 0,
      construct: 0,
      method: 0,
      problem: 0,
      constraint: 0,
    } as Record<ConceptKind, number>;
    for (const n of this.nodes.values()) {
      byStatus[n.status] += 1;
      byKind[n.kind] += 1;
    }
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      byStatus,
      byKind,
      openMergeCandidates: [...this.mergeCandidates.values()].filter(
        (c) => c.status === 'open',
      ).length,
      causalCandidates: this.causalCandidates.length,
      birthCandidates: this.birthCandidates.size,
    };
  }
}
