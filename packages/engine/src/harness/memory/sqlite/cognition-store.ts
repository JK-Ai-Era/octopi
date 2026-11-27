/**
 * SqliteConceptGraph — SQLite 认知图谱（生产路径）
 *
 * 契约见 arch/cognition-graph-formation.md：
 * 结构同一性合并、持证边、衰减、扩散激活、merge_candidates、causal_candidate。
 *
 * @module
 */

import type {
  ActivatedGraph,
  AdmitConceptInput,
  AdmitConceptResult,
  AdmitEdgeInput,
  AdmitEdgeResult,
  BirthCandidate,
  ConceptDescriptionRevision,
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
} from '../cognition-types.js';
import {
  counterEvidenceWeaken,
  DEFAULT_EDGE_DECAY_FLOOR,
  DEFAULT_RETRIEVE_STATUSES,
  hebbianStrengthen,
  nextEdgeStrength,
} from '../cognition-decay.js';
import {
  BIRTH_CANDIDATE_TTL_MS,
  DESCRIPTION_HISTORY_CAP,
  evaluateConceptGate,
  licenseEdge,
  normalizeForCue,
} from '../cognition-gates.js';
import { createSeedMatcher, normName } from '../cognition-seeds.js';
import { AgentDatabase } from './agent-db.js';
import type { EmbeddingProvider } from './embedding.js';
import { cosineDistance, parseEmbedding, serializeEmbedding } from './vector-search.js';

export interface SqliteConceptGraphOptions {
  embeddingProvider?: EmbeddingProvider | null;
  /** 强同义距离：≤ 此值的近邻候选在 fingerprintDiff 落 `strong_near`（供裁决优先）；不再触发自动合并（跨名一律候选） */
  mergeThreshold?: number;
  /** 语义种子距离带（相关性域：查询→概念名，实测相关对 0.41–0.59）；默认 0.65，与 merge 同一性带不同域 */
  semanticSeedMaxDistance?: number;
  /** 语义种子查询嵌入超时（毫秒；热路径防无界延迟，超时降级空种子）；默认 5000 */
  semanticSeedEmbedTimeoutMs?: number;
  /** 近阈带上界；[lo, hi) 写 merge_candidates，默认 0.35 */
  candidateBandHi?: number;
  /** capacity 软顶 */
  warnNodes?: number;
  warnEdges?: number;
  stopNodes?: number;
  stopEdges?: number;
  decayFloor?: number;
  /** causes 最少独立命题（默认 2） */
  causesMinIndependentMemories?: number;
}

interface BirthCandidateRow {
  id: string;
  name_key: string;
  name: string;
  kind: string;
  description: string | null;
  domain: string;
  aliases: string;
  memory_ids: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

function daysBetween(a: number, b: number): number {
  return Math.max(0, (b - a) / 86_400_000);
}

/** 增强路径限时：超时拒绝；内层 Promise 终态经 then 兜底，无悬挂未处理拒绝 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

interface ConceptRow {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  description_history: string;
  aliases: string;
  frequency: number;
  memory_ids: string;
  domain: string;
  status: string;
  embedding: string | null;
  created_at: number;
  updated_at: number;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  strength: number;
  description: string | null;
  status: string;
  basis: string;
  created_at: number;
  updated_at: number;
}

export class SqliteConceptGraph implements ConceptGraphStore {
  private db: AgentDatabase;
  private embedding: EmbeddingProvider | null;
  private mergeThreshold: number;
  private candidateBandHi: number;
  private semanticSeedMaxDistance: number;
  private semanticSeedEmbedTimeoutMs: number;
  /** 已解析向量缓存：key=概念 id，value=updated_at 指纹 + 向量（写入即换指纹，天然失效） */
  private parsedVectorCache = new Map<string, { stamp: string; vec: number[] } | null>();
  private stopNodes: number;
  private stopEdges: number;
  private decayFloor: number;
  private causesMinIndependentMemories: number;

  constructor(db: AgentDatabase, options?: SqliteConceptGraphOptions) {
    this.db = db;
    this.embedding = options?.embeddingProvider ?? null;
    this.mergeThreshold = options?.mergeThreshold ?? 0.2;
    this.candidateBandHi = options?.candidateBandHi ?? 0.35;
    this.semanticSeedMaxDistance = options?.semanticSeedMaxDistance ?? 0.65;
    this.semanticSeedEmbedTimeoutMs = options?.semanticSeedEmbedTimeoutMs ?? 5000;
    this.stopNodes = options?.stopNodes ?? 10_000;
    this.stopEdges = options?.stopEdges ?? 40_000;
    this.decayFloor = options?.decayFloor ?? DEFAULT_EDGE_DECAY_FLOOR;
    this.causesMinIndependentMemories = options?.causesMinIndependentMemories ?? 2;
  }

  private get capacityStop(): boolean {
    const n = (this.db.raw.prepare('SELECT COUNT(*) AS c FROM concepts').get() as { c: number }).c;
    const e = (this.db.raw.prepare('SELECT COUNT(*) AS c FROM concept_edges').get() as { c: number }).c;
    return n >= this.stopNodes || e >= this.stopEdges;
  }

  private rowToNode(row: ConceptRow): ConceptNode {
    return {
      id: row.id,
      name: row.name,
      kind: (row.kind as ConceptKind) ?? 'construct',
      description: row.description ?? undefined,
      descriptionHistory: (() => {
        // 空历史归一为 undefined（两后端一致，F10）
        const parsed = safeJsonRevisions(row.description_history);
        return parsed.length > 0 ? parsed : undefined;
      })(),
      aliases: (() => {
        const a = safeJsonArray(row.aliases);
        return a.length > 0 ? a : undefined;
      })(),
      frequency: row.frequency,
      memoryIds: safeJsonArray(row.memory_ids),
      domain: safeJsonArray(row.domain),
      status: (row.status as ConceptStatus) ?? 'shadow',
      embedding: row.embedding ? parseEmbedding(row.embedding) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToEdge(row: EdgeRow): ConceptEdge {
    let basis: EdgeBasis = {
      memoryIds: [],
      cue: '',
      evidenceClass: 'cooccur',
      licensedAt: row.created_at,
    };
    try {
      const parsed = JSON.parse(row.basis) as Partial<EdgeBasis>;
      if (parsed && typeof parsed === 'object') {
        basis = {
          memoryIds: Array.isArray(parsed.memoryIds) ? parsed.memoryIds : [],
          cue: typeof parsed.cue === 'string' ? parsed.cue : '',
          evidenceClass: (parsed.evidenceClass as EdgeBasis['evidenceClass']) ?? 'cooccur',
          licensedAt: typeof parsed.licensedAt === 'number' ? parsed.licensedAt : row.created_at,
        };
      }
    } catch {
      // basis 解析失败用默认弱证件
    }
    return {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      relationType: (row.relation_type as ConceptRelationType) ?? 'related',
      strength: row.strength,
      description: row.description ?? undefined,
      status: (row.status as ConceptStatus) ?? 'shadow',
      basis,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async admitConcept(input: AdmitConceptInput): Promise<AdmitConceptResult> {
    const isDefinition = input.birthChannel === 'definition';
    // 同名已出生概念（同 kind）收新票 = 合并支撑，不是延迟出生——候选区只为未出生者。
    // 口径与下方 existing 查找一致（SQL LOWER 谓词，避免 JS/SQLite 双归一化漏判——M-3）。
    const nameKey = normName(input.name);
    const sameNameBorn = (
      this.db.raw
        .prepare('SELECT 1 AS hit FROM concepts WHERE LOWER(name) = ? AND kind = ? LIMIT 1')
        .get(nameKey, input.kind) as { hit: number } | undefined
    )?.hit === 1;
    const gate = evaluateConceptGate(input, {
      // 合并不新增节点，不受容量门拦（m-14）
      capacityAdmitStop: this.capacityStop && !sameNameBorn,
      skipMdl: isDefinition || sameNameBorn,
    });
    if (!gate.ok) {
      // 票不够（非定义直生、且无同名已出生概念）→ 出生候选区投票；满 2 票转正（R7′ 复现计票）
      if (gate.reason === 'mdl_insufficient') {
        return this.parkOrPromoteBirthCandidate(input);
      }
      return { action: 'rejected', reason: gate.reason, message: gate.message };
    }

    // 注意：SQLite LOWER() 仅折 ASCII，与 JS toLowerCase 的 Unicode 折叠有别（CJK 无碍）——
    // 归一根治（name_key 列）见 arch/open-problems OP-9R 遗留
    const existing = this.db.raw
      .prepare('SELECT * FROM concepts WHERE LOWER(name) = ? ORDER BY created_at ASC, id ASC')
      .all(nameKey) as unknown as ConceptRow[];

    // 同名多义项：指纹兼容则合并，冲突则新建 + merge_candidate
    const conflicts: Array<{ node: ConceptNode; reason: string }> = [];
    for (const row of existing) {
      const node = this.rowToNode(row);
      const conflict = this.fingerprintConflict(node, input);
      if (conflict) {
        conflicts.push({ node, reason: conflict });
        continue;
      }

      const memIds = new Set([...node.memoryIds, ...(input.memoryIds ?? [])]);
      const domains = new Set([...node.domain, ...(input.domain ?? [])]);
      const aliases = new Set([...(node.aliases ?? []), ...(input.aliases ?? [])]);
      // frequency = 票数派生（与 insertConcept 同口径）；无票调用回退计次，不破坏 supportCount 表意的调用方
      const mergedFreq = memIds.size > 0 ? memIds.size : node.frequency + 1;
      if (input.birthChannel === 'definition' && input.description) {
        // 活口径（R7′）：定义新口径胜，旧口径入版本链（最近旧版在前，cap 5）。
        // 同值重申幂等（F3）：口径未变不入链，不挤掉真实旧版
        const unchanged = node.description === input.description;
        const history = node.description && !unchanged
          ? [{ text: node.description, memoryId: input.memoryIds?.[0], at: Date.now() }, ...(node.descriptionHistory ?? [])].slice(0, DESCRIPTION_HISTORY_CAP)
          : (node.descriptionHistory ?? []);
        this.db.raw
          .prepare(
            'UPDATE concepts SET frequency = ?, memory_ids = ?, domain = ?, aliases = ?, description = ?, description_history = ?, updated_at = ? WHERE id = ?',
          )
          .run(mergedFreq, JSON.stringify([...memIds]), JSON.stringify([...domains]), JSON.stringify([...aliases]), input.description, JSON.stringify(history), Date.now(), node.id);
      } else {
        this.db.raw
          .prepare(
            'UPDATE concepts SET frequency = ?, memory_ids = ?, domain = ?, aliases = ?, description = COALESCE(description, ?), updated_at = ? WHERE id = ?',
          )
          .run(mergedFreq, JSON.stringify([...memIds]), JSON.stringify([...domains]), JSON.stringify([...aliases]), input.description ?? null, Date.now(), node.id);
      }
      this.clearBirthCandidate(nameKey, input.kind, node.id);
      return { action: 'merged', id: node.id, reason: 'ok' };
    }

    // embedding 近邻
    if (this.embedding) {
      const vec = await this.embedding.embed(input.name);
      const near = await this.findSimilarConcept(vec);
      if (near) {
        // 跨名一律退候选、不自动合并（拍板 2026-11-19）：自动合并会静默吞名、无审计、支撑虚高
        const conflict = this.fingerprintConflict(near.node, input);
        const id = this.insertConcept(input, vec);
        const fingerprintDiff = conflict ? [conflict] : [];
        if (!conflict && near.distance <= this.mergeThreshold) {
          fingerprintDiff.push('strong_near');
        }
        const candidateId = this.insertMergeCandidate(
          near.node.id,
          id,
          conflict ?? 'embedding_band',
          near.distance,
          fingerprintDiff,
        );
        return {
          action: 'merge_candidate',
          id,
          candidateId,
          reason: conflict ? 'fingerprint_conflict' : 'ok',
        };
      }
      const id = this.insertConcept(input, vec);
      if (conflicts.length) {
        const candidateId = this.insertMergeCandidate(
          conflicts[0]!.node.id,
          id,
          conflicts[0]!.reason,
          null,
          [conflicts[0]!.reason],
        );
        this.clearBirthCandidate(nameKey, input.kind, id);
        return { action: 'merge_candidate', id, candidateId, reason: 'fingerprint_conflict' };
      }
      this.clearBirthCandidate(nameKey, input.kind, id);
      return { action: 'created', id, reason: 'ok' };
    }

    const id = this.insertConcept(input, null);
    if (conflicts.length) {
      const candidateId = this.insertMergeCandidate(
        conflicts[0]!.node.id,
        id,
        conflicts[0]!.reason,
        null,
        [conflicts[0]!.reason],
      );
      this.clearBirthCandidate(nameKey, input.kind, id);
      return { action: 'merge_candidate', id, candidateId, reason: 'fingerprint_conflict' };
    }
    this.clearBirthCandidate(nameKey, input.kind, id);
    return { action: 'created', id, reason: 'ok' };
  }

  /**
   * 复现计票（R7′）：1 票入出生候选区，满 2 票转正出生。
   * 票 = 不同 memoryIds（同命题重复提案幂等去重）；候选按 (name_key, kind) 分桶——
   * 同名不同 kind 各自计票（义项指纹冲突交出生侧 merge_candidate 机制）。
   * TTL 为固定出生窗口（不随投票续期）：到期仍 <2 票即遗忘（压缩不了就忘）。
   */
  private async parkOrPromoteBirthCandidate(input: AdmitConceptInput): Promise<AdmitConceptResult> {
    const now = Date.now();
    const nameKey = normName(input.name);
    const incoming = new Set(input.memoryIds ?? []);
    if (incoming.size === 0) {
      return { action: 'rejected', reason: 'mdl_insufficient', message: 'no vote (empty memoryIds)' };
    }

    // 清掉本桶过期候选（过期票作废，新票重新起算窗口）
    this.db.raw
      .prepare('DELETE FROM concept_birth_candidates WHERE name_key = ? AND kind = ? AND expires_at <= ?')
      .run(nameKey, input.kind, now);

    const rows = this.db.raw
      .prepare(
        'SELECT * FROM concept_birth_candidates WHERE name_key = ? AND kind = ? ORDER BY created_at ASC, id ASC',
      )
      .all(nameKey, input.kind) as unknown as BirthCandidateRow[];

    const row = rows[0];
    const memIds = new Set([...(row ? safeJsonArray(row.memory_ids) : []), ...incoming]);
    const domains = new Set([...(row ? safeJsonArray(row.domain) : []), ...(input.domain ?? [])]);

    // 满票转正：先出生、成功后才删候选（失败票回写候选，不静默丢票——fail loud）
    if (memIds.size >= 2) {
      const result = await this.admitConcept({
        ...input,
        description: input.description ?? row?.description ?? undefined,
        domain: [...domains],
        aliases: [...new Set([...(row ? safeJsonArray(row.aliases) : []), ...(input.aliases ?? [])])],
        memoryIds: [...memIds],
        supportCount: memIds.size,
      });
      if (result.action === 'rejected') {
        // 出生失败（如 capacity_admit_stop）：票并入候选保留，等容量释放后重试
        if (row) {
          this.db.raw
            .prepare(
              'UPDATE concept_birth_candidates SET memory_ids = ?, domain = ?, aliases = ?, description = COALESCE(?, description), updated_at = ? WHERE id = ?',
            )
            .run(JSON.stringify([...memIds]), JSON.stringify([...domains]), JSON.stringify([...new Set([...safeJsonArray(row.aliases), ...(input.aliases ?? [])])]), input.description ?? null, now, row.id);
          return {
            action: 'candidate_parked',
            candidateId: row.id,
            reason: result.reason,
            message: `birth_deferred: ${result.message ?? ''} votes=${memIds.size}`,
          };
        }
        return result;
      }
      if (row) this.db.raw.prepare('DELETE FROM concept_birth_candidates WHERE id = ?').run(row.id);
      return result;
    }

    if (row) {
      this.db.raw
        .prepare(
          'UPDATE concept_birth_candidates SET memory_ids = ?, domain = ?, aliases = ?, description = COALESCE(?, description), updated_at = ? WHERE id = ?',
        )
        .run(JSON.stringify([...memIds]), JSON.stringify([...domains]), JSON.stringify([...new Set([...safeJsonArray(row.aliases), ...(input.aliases ?? [])])]), input.description ?? null, now, row.id);
      return { action: 'candidate_parked', candidateId: row.id, reason: 'ok', message: `votes=${memIds.size}` };
    }

    const id = AgentDatabase.generateId('cbc');
    this.db.raw
      .prepare(
        `INSERT INTO concept_birth_candidates (id, name_key, name, kind, description, domain, aliases, memory_ids, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        nameKey,
        input.name.trim(),
        input.kind,
        input.description ?? null,
        JSON.stringify([...domains]),
        JSON.stringify([...new Set(input.aliases ?? [])]),
        JSON.stringify([...incoming]),
        now,
        now,
        now + BIRTH_CANDIDATE_TTL_MS,
      );
    return { action: 'candidate_parked', candidateId: id, reason: 'ok', message: 'votes=1' };
  }

  /**
   * 概念出生/合并成功后清同键出生候选（m-6 幽灵候选）：候选攒的票与别名并入概念再删行。
   */
  private clearBirthCandidate(nameKey: string, kind: string, bornId: string): void {
    const rows = this.db.raw
      .prepare('SELECT * FROM concept_birth_candidates WHERE name_key = ? AND kind = ?')
      .all(nameKey, kind) as unknown as BirthCandidateRow[];
    for (const row of rows) {
      const node = this.db.raw.prepare('SELECT * FROM concepts WHERE id = ?').get(bornId) as ConceptRow | undefined;
      if (node) {
        const memIds = new Set([...safeJsonArray(node.memory_ids), ...safeJsonArray(row.memory_ids)]);
        const aliases = new Set([...safeJsonArray(node.aliases), ...safeJsonArray(row.aliases)]);
        this.db.raw
          .prepare('UPDATE concepts SET memory_ids = ?, aliases = ? WHERE id = ?')
          .run(JSON.stringify([...memIds]), JSON.stringify([...aliases]), bornId);
      }
      this.db.raw.prepare('DELETE FROM concept_birth_candidates WHERE id = ?').run(row.id);
    }
  }

  async listBirthCandidates(limit = 100): Promise<BirthCandidate[]> {
    // 只列未过期（在册 = 未满票、未到期）
    const rows = this.db.raw
      .prepare(
        'SELECT * FROM concept_birth_candidates WHERE expires_at > ? ORDER BY updated_at DESC, id ASC LIMIT ?',
      )
      .all(Date.now(), limit) as unknown as BirthCandidateRow[];
    return rows.map((row) => ({
      id: row.id,
      nameKey: row.name_key,
      name: row.name,
      kind: (row.kind as ConceptKind) ?? 'construct',
      description: row.description ?? undefined,
      domain: safeJsonArray(row.domain),
      aliases: safeJsonArray(row.aliases),
      memoryIds: safeJsonArray(row.memory_ids),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    }));
  }

  async expireBirthCandidates(now = Date.now()): Promise<number> {
    const info = this.db.raw
      .prepare('DELETE FROM concept_birth_candidates WHERE expires_at <= ?')
      .run(now);
    return Number(info.changes ?? 0);
  }

  /** 义项指纹冲突：仅 kind 不同。domain 是多值标签不参与义项判定（同名同 kind 合并且 domain 取并集） */
  private fingerprintConflict(existing: ConceptNode, input: AdmitConceptInput): string | null {
    if (existing.kind !== input.kind) return `kind:${existing.kind}≠${input.kind}`;
    return null;
  }

  private insertConcept(input: AdmitConceptInput, vec: number[] | null): string {
    const id = AgentDatabase.generateId('cpt');
    const now = Date.now();
    // 出生即 active（R7′/R5′：计票出生与定义出生都是「挣来的记住」，不再是 shadow 永冻）
    const memIds = [...new Set(input.memoryIds ?? [])];
    this.db.raw
      .prepare(
        `INSERT INTO concepts (id, name, kind, description, description_history, aliases, frequency, memory_ids, domain, status, embedding, created_at, updated_at)
         VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.kind,
        input.description ?? null,
        JSON.stringify([...new Set(input.aliases ?? [])]),
        Math.max(1, memIds.length),
        JSON.stringify(memIds),
        JSON.stringify([...new Set(input.domain ?? [])]),
        vec ? serializeEmbedding(vec) : null,
        now,
        now,
      );
    return id;
  }

  private insertMergeCandidate(
    leftId: string,
    rightId: string,
    reason: string,
    distance: number | null,
    fingerprintDiff: string[],
  ): string {
    const id = AgentDatabase.generateId('mrg');
    this.db.raw
      .prepare(
        `INSERT INTO concept_merge_candidates
         (id, left_id, right_id, reason, distance, fingerprint_diff, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, leftId, rightId, reason, distance, JSON.stringify(fingerprintDiff), Date.now());
    return id;
  }

  private async findSimilarConcept(
    embedding: number[],
  ): Promise<{ node: ConceptNode; distance: number } | null> {
    const rows = this.db.raw
      .prepare('SELECT * FROM concepts WHERE embedding IS NOT NULL')
      .all() as unknown as ConceptRow[];
    let best: { node: ConceptNode; distance: number } | null = null;
    for (const row of rows) {
      const vec = parseEmbedding(row.embedding!);
      if (!vec || vec.length !== embedding.length) continue; // 维度失配行跳过（与 semanticSeeds 同守卫）
      const distance = cosineDistance(embedding, vec);
      if (!best || distance < best.distance) {
        best = { node: this.rowToNode(row), distance };
      }
    }
    if (best && best.distance <= this.candidateBandHi) return best;
    return null;
  }

  /** 同 pair（无向）已有 memoryIds：边 basis + causal_candidate */
  private collectPairMemoryIds(sourceId: string, targetId: string): string[] {
    const ids = new Set<string>();
    const edges = this.db.raw
      .prepare(
        `SELECT basis FROM concept_edges
         WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
      )
      .all(sourceId, targetId, targetId, sourceId) as Array<{ basis: string }>;
    for (const e of edges) {
      try {
        const b = JSON.parse(e.basis) as { memoryIds?: string[] };
        for (const mid of b.memoryIds ?? []) ids.add(mid);
      } catch {
        // basis 解析失败不贡献证据
      }
    }
    const aux = this.db.raw
      .prepare(
        `SELECT memory_ids FROM concept_edges_aux
         WHERE edge_key IN (?, ?)`,
      )
      .all(`${sourceId}->${targetId}`, `${targetId}->${sourceId}`) as Array<{ memory_ids: string }>;
    for (const a of aux) {
      for (const mid of safeJsonArray(a.memory_ids)) ids.add(mid);
    }
    return [...ids];
  }

  async admitEdge(input: AdmitEdgeInput): Promise<AdmitEdgeResult> {
    // 持证前累积同 pair 已有 memoryIds（跨命题多证据闭环）
    const priorIds = this.collectPairMemoryIds(input.sourceId, input.targetId);
    const memoryIds = [...new Set([...priorIds, ...(input.basis.memoryIds ?? [])])];

    const license = licenseEdge({
      relationType: input.relationType,
      evidenceClass: input.basis.evidenceClass,
      cue: input.basis.cue,
      evidenceText: input.evidenceText,
      memoryIds,
      causesMinIndependentMemories: this.causesMinIndependentMemories,
    });

    if (license.status === 'rejected') {
      return { action: 'rejected', reason: license.reason, message: license.message };
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

    if (!input.sourceId || !input.targetId) {
      return { action: 'rejected', reason: 'invalid_relation', message: 'endpoint id missing' };
    }

    // 端点存在性
    const src = this.db.raw.prepare('SELECT id FROM concepts WHERE id = ?').get(input.sourceId) as
      | { id: string }
      | undefined;
    const tgt = this.db.raw.prepare('SELECT id FROM concepts WHERE id = ?').get(input.targetId) as
      | { id: string }
      | undefined;
    if (!src || !tgt) {
      return { action: 'rejected', reason: 'invalid_relation', message: 'endpoint missing' };
    }

    const relationType = license.relationType;
    const status: ConceptStatus = license.status === 'active' ? 'active' : 'shadow';
    const now = Date.now();
    const basis: EdgeBasis = {
      memoryIds: [...new Set(input.basis.memoryIds ?? [])],
      cue: input.basis.cue ?? '',
      evidenceClass: input.basis.evidenceClass,
      licensedAt: input.basis.licensedAt ?? now,
    };

    const existing = this.db.raw
      .prepare(
        'SELECT * FROM concept_edges WHERE source_id = ? AND target_id = ? AND relation_type = ?',
      )
      .get(input.sourceId, input.targetId, relationType) as EdgeRow | undefined;

    if (existing) {
      const edge = this.rowToEdge(existing);
      const memIds = new Set([...edge.basis.memoryIds, ...basis.memoryIds]);
      const mergedBasis = { ...edge.basis, memoryIds: [...memIds], cue: basis.cue || edge.basis.cue };
      this.db.raw
        .prepare(
          'UPDATE concept_edges SET strength = MAX(strength, ?), basis = ?, status = CASE WHEN ? = \'active\' THEN \'active\' ELSE status END, updated_at = ? WHERE id = ?',
        )
        .run(input.strength, JSON.stringify(mergedBasis), status, now, existing.id);
      return {
        action: license.status === 'demoted' ? 'demoted' : status,
        edgeId: existing.id,
        relationType,
        reason: license.reason,
      };
    }

    const edgeId = AgentDatabase.generateId('edge');
    this.db.raw
      .prepare(
        `INSERT INTO concept_edges
         (id, source_id, target_id, relation_type, strength, description, status, basis, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        edgeId,
        input.sourceId,
        input.targetId,
        relationType,
        Math.min(1, Math.max(0, input.strength)),
        input.description ?? null,
        status,
        JSON.stringify(basis),
        now,
        now,
      );

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
    const edgeKey = `${input.sourceId}->${input.targetId}`;
    this.db.raw
      .prepare(
        `INSERT INTO concept_edges_aux (id, edge_key, kind, memory_ids, cue, note, created_at)
         VALUES (?, ?, 'causal_candidate', ?, ?, ?, ?)`,
      )
      .run(
        AgentDatabase.generateId('causal'),
        edgeKey,
        JSON.stringify(input.memoryIds ?? []),
        normalizeForCue(input.cue),
        input.note ?? null,
        Date.now(),
      );
  }

  async listMergeCandidates(limit = 50): Promise<MergeCandidate[]> {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM concept_merge_candidates WHERE status = 'open' ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      left_id: string;
      right_id: string;
      reason: string;
      distance: number | null;
      fingerprint_diff: string;
      status: string;
      created_at: number;
      resolved_at: number | null;
      resolved_action: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      leftId: r.left_id,
      rightId: r.right_id,
      reason: r.reason,
      distance: r.distance,
      fingerprintDiff: safeJsonArray(r.fingerprint_diff),
      status: r.status as MergeCandidate['status'],
      createdAt: r.created_at,
      resolvedAt: r.resolved_at ?? undefined,
      resolvedAction: r.resolved_action ?? undefined,
    }));
  }

  /** 语义种子能力：已注 embeddingProvider 才可做查询近邻 */
  get supportsSemanticSeeds(): boolean {
    return this.embedding != null;
  }

  /**
   * 查询语义种子：查询文本经自有 provider 嵌入后，对已存向量做近邻扫描。
   * 距离带用 `semanticSeedMaxDistance`（相关性域，默认 0.65）——与 merge 的同一性带
   * （candidateBandHi 0.35）不同域：真模型下「查询句→短概念名」相关对实测 0.41–0.59。
   *
   * @param query - 查询文本
   * @param k - 种子上限（缺省 4）
   * @returns 概念名列表（近者优先）；provider 缺失/嵌入失败/无近邻/维度失配行 → 空/跳过（增强路径不 fail）
   */
  async semanticSeeds(query: string, k = 4): Promise<string[]> {
    if (!this.embedding || !query.trim()) return [];
    const limit = Math.max(1, Math.floor(k));
    let vec: number[];
    try {
      vec = await withTimeout(this.embedding.embed(query), this.semanticSeedEmbedTimeoutMs);
    } catch {
      // 增强路径：嵌入失败/超时降级空种子（词面召回照常），不向上抛
      return [];
    }
    const rows = this.db.raw
      .prepare('SELECT id, name, embedding, updated_at FROM concepts WHERE embedding IS NOT NULL')
      .all() as unknown as Array<{ id: string; name: string; embedding: string | null; updated_at: number }>;
    const scored: Array<{ name: string; distance: number }> = [];
    const freshCache = new Map<string, { stamp: string; vec: number[] } | null>();
    for (const r of rows) {
      const stamp = `${r.updated_at}`;
      let entry = this.parsedVectorCache.get(r.id);
      if (!entry || entry.stamp !== stamp) {
        const parsed = r.embedding ? parseEmbedding(r.embedding) : null;
        entry = parsed ? { stamp, vec: parsed } : null;
      }
      freshCache.set(r.id, entry);
      if (!entry || entry.vec.length !== vec.length) continue; // 维度失配行跳过（provider 换代遗留向量）
      const distance = cosineDistance(vec, entry.vec);
      if (distance <= this.semanticSeedMaxDistance) scored.push({ name: r.name, distance });
    }
    this.parsedVectorCache = freshCache; // 顺带清掉已删行的缓存
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, limit).map((s) => s.name);
  }

  async resolveMerge(
    id: string,
    action: 'merge' | 'keep_split' | 'drop',
    options?: { canonicalKind?: ConceptKind },
  ): Promise<void> {
    const row = this.db.raw
      .prepare('SELECT * FROM concept_merge_candidates WHERE id = ?')
      .get(id) as { id: string; left_id: string; right_id: string } | undefined;
    if (!row) return;

    const status = action === 'merge' ? 'merged' : action === 'keep_split' ? 'kept_split' : 'dropped';

    if (action !== 'merge') {
      this.db.raw
        .prepare(
          'UPDATE concept_merge_candidates SET status = ?, resolved_at = ?, resolved_action = ? WHERE id = ?',
        )
        .run(status, Date.now(), action, id);
      return;
    }

    const left = this.db.raw.prepare('SELECT * FROM concepts WHERE id = ?').get(row.left_id) as
      | ConceptRow
      | undefined;
    let right = this.db.raw.prepare('SELECT * FROM concepts WHERE id = ?').get(row.right_id) as
      | ConceptRow
      | undefined;
    if (!right && row.right_id.startsWith('pending:')) {
      const pendingName = row.right_id.slice('pending:'.length).toLowerCase();
      const candidates = this.db.raw
        .prepare('SELECT * FROM concepts WHERE LOWER(name) = ? ORDER BY created_at ASC, id ASC')
        .all(pendingName) as unknown as ConceptRow[];
      // 同名多义项：取非 left 的第一个
      right = candidates.find((c) => c.id !== row.left_id);
    }
    if (!left || !right || left.id === right.id) {
      this.db.raw
        .prepare(
          'UPDATE concept_merge_candidates SET status = ?, resolved_at = ?, resolved_action = ? WHERE id = ?',
        )
        .run('dropped', Date.now(), 'drop_missing_endpoint', id);
      return;
    }

    const db = this.db.raw;
    db.exec('BEGIN');
    try {
      const memIds = new Set([
        ...safeJsonArray(left.memory_ids),
        ...safeJsonArray(right.memory_ids),
      ]);
      const domains = new Set([
        ...safeJsonArray(left.domain),
        ...safeJsonArray(right.domain),
      ]);
      // 活口径合并（F4）：两侧口径不同则被替换方（right）的口径与其版本链并入 left 版本链，不静默丢口径
      const leftHistory = safeJsonRevisions(left.description_history);
      const rightHistory = safeJsonRevisions(right.description_history);
      const rightMemIds = safeJsonArray(right.memory_ids) as string[];
      // 合并不丢名字：right 的 canonical name 与 aliases 全部并入 left aliases（m-1）
      const mergedAliases = new Set([
        ...safeJsonArray(left.aliases),
        ...safeJsonArray(right.aliases),
        right.name,
      ]);
      mergedAliases.delete(left.name);
      const mergedHistory =
        right.description && right.description !== left.description && left.description
          ? [
              { text: right.description, memoryId: rightMemIds[0], at: Date.now() },
              ...rightHistory,
              ...leftHistory,
            ].slice(0, DESCRIPTION_HISTORY_CAP)
          : [...leftHistory, ...rightHistory].slice(0, DESCRIPTION_HISTORY_CAP);
      db.prepare(
        'UPDATE concepts SET frequency = frequency + ?, memory_ids = ?, domain = ?, aliases = ?, description = COALESCE(description, ?), description_history = ?, updated_at = ? WHERE id = ?',
      ).run(right.frequency, JSON.stringify([...memIds]), JSON.stringify([...domains]), JSON.stringify([...mergedAliases]), right.description ?? null, JSON.stringify(mergedHistory), Date.now(), left.id);
      if (options?.canonicalKind && left.kind !== options.canonicalKind) {
        db.prepare('UPDATE concepts SET kind = ?, updated_at = ? WHERE id = ?').run(
          options.canonicalKind,
          Date.now(),
          left.id,
        );
      }

      // 迁边前：丢掉会变自环的边
      db.prepare('DELETE FROM concept_edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)')
        .run(left.id, right.id, right.id, left.id);

      // 改写端点（UNIQUE 冲突则保留 left 侧已有边，丢弃 right 侧重复）
      db.prepare(
        `UPDATE OR IGNORE concept_edges SET source_id = ?, updated_at = ? WHERE source_id = ?`,
      ).run(left.id, Date.now(), right.id);
      db.prepare(
        `UPDATE OR IGNORE concept_edges SET target_id = ?, updated_at = ? WHERE target_id = ?`,
      ).run(left.id, Date.now(), right.id);
      // OR IGNORE 未更新的仍是 right 端点 → 删除残留
      db.prepare('DELETE FROM concept_edges WHERE source_id = ? OR target_id = ?').run(right.id, right.id);
      // 迁完后自环清理
      db.prepare('DELETE FROM concept_edges WHERE source_id = target_id').run();

      db.prepare('DELETE FROM concepts WHERE id = ?').run(right.id);
      db.prepare(
        'UPDATE concept_merge_candidates SET status = ?, resolved_at = ?, resolved_action = ? WHERE id = ?',
      ).run('merged', Date.now(), 'merge', id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err instanceof Error
        ? err
        : new Error(`resolveMerge failed: ${String(err)}`);
    }
  }

  async reinforce(input: {
    nodeIds?: string[];
    edgeIds?: string[];
    evidenceStrength?: number;
  }): Promise<void> {
    const e = Math.min(1, Math.max(0, input.evidenceStrength ?? 0.5));
    const now = Date.now();
    for (const id of input.nodeIds ?? []) {
      this.db.raw
        .prepare('UPDATE concepts SET frequency = frequency + 1, updated_at = ? WHERE id = ?')
        .run(now, id);
    }
    for (const id of input.edgeIds ?? []) {
      const row = this.db.raw.prepare('SELECT strength FROM concept_edges WHERE id = ?').get(id) as
        | { strength: number }
        | undefined;
      if (!row) continue;
      const next = hebbianStrengthen(row.strength, e);
      this.db.raw
        .prepare('UPDATE concept_edges SET strength = ?, updated_at = ? WHERE id = ?')
        .run(next, now, id);
    }
  }

  async counterEvidence(input: {
    edgeId: string;
    memoryId?: string;
    markOpposes?: boolean;
  }): Promise<void> {
    const row = this.db.raw
      .prepare('SELECT * FROM concept_edges WHERE id = ?')
      .get(input.edgeId) as EdgeRow | undefined;
    if (!row) return;
    const edge = this.rowToEdge(row);
    let strength = counterEvidenceWeaken(edge.strength);
    let relationType = edge.relationType;
    if (input.markOpposes) relationType = 'opposes';
    let memIds = edge.basis.memoryIds;
    if (input.memoryId) {
      memIds = memIds.filter((m) => m !== input.memoryId);
    }
    this.db.raw
      .prepare(
        'UPDATE concept_edges SET strength = ?, relation_type = ?, basis = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        strength,
        relationType,
        JSON.stringify({ ...edge.basis, memoryIds: memIds }),
        Date.now(),
        input.edgeId,
      );
  }

  async promote(ids: string[], to: 'active' | 'strengthened'): Promise<void> {
    const now = Date.now();
    for (const id of ids) {
      this.db.raw
        .prepare('UPDATE concepts SET status = ?, updated_at = ? WHERE id = ?')
        .run(to, now, id);
      this.db.raw
        .prepare('UPDATE concept_edges SET status = ?, updated_at = ? WHERE id = ?')
        .run(to, now, id);
    }
  }

  async demote(ids: string[], to: 'shadow'): Promise<void> {
    const now = Date.now();
    for (const id of ids) {
      this.db.raw
        .prepare('UPDATE concepts SET status = ?, updated_at = ? WHERE id = ?')
        .run(to, now, id);
      this.db.raw
        .prepare('UPDATE concept_edges SET status = ?, updated_at = ? WHERE id = ?')
        .run(to, now, id);
    }
  }

  async applyDecay(now = Date.now()): Promise<DecayResult> {
    const edges = this.db.raw.prepare('SELECT * FROM concept_edges').all() as unknown as EdgeRow[];
    let decayedEdges = 0;
    for (const row of edges) {
      const days = daysBetween(row.updated_at, now);
      if (days < 1) continue;
      const next = nextEdgeStrength(row.strength, row.relation_type as ConceptRelationType, days);
      if (next < row.strength - 1e-6) {
        this.db.raw
          .prepare('UPDATE concept_edges SET strength = ?, updated_at = ? WHERE id = ?')
          .run(next, now, row.id);
        decayedEdges += 1;
      }
    }

    // GC 无支撑且无有效边的节点
    const liveEdges = this.db.raw
      .prepare(`SELECT source_id, target_id FROM concept_edges WHERE strength > ?`)
      .all(this.decayFloor) as Array<{ source_id: string; target_id: string }>;
    const connected = new Set<string>();
    for (const e of liveEdges) {
      connected.add(e.source_id);
      connected.add(e.target_id);
    }

    const nodes = this.db.raw.prepare('SELECT id, memory_ids FROM concepts').all() as Array<{
      id: string;
      memory_ids: string;
    }>;
    let gcNodes = 0;
    for (const n of nodes) {
      if (!connected.has(n.id) && safeJsonArray(n.memory_ids).length === 0) {
        this.db.raw.prepare('DELETE FROM concept_edges WHERE source_id = ? OR target_id = ?').run(n.id, n.id);
        this.db.raw.prepare('DELETE FROM concepts WHERE id = ?').run(n.id);
        gcNodes += 1;
      }
    }

    const gcEdges = (
      this.db.raw
        .prepare(
          `DELETE FROM concept_edges WHERE source_id NOT IN (SELECT id FROM concepts)
            OR target_id NOT IN (SELECT id FROM concepts)`,
        )
        .run() as { changes: number }
    ).changes;

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
    const statuses = options?.statuses ?? DEFAULT_RETRIEVE_STATUSES;
    const empty: ActivatedGraph = { nodes: [], edges: [], activation: {}, seeds: [] };
    if (!seeds.length || statuses.length === 0) return empty;

    const statusPlace = statuses.map(() => '?').join(',');
    const statusSet = new Set(statuses);

    // 反向匹配（token 含 name）无法下推 SQL：轻列扫描 + 共享谓词（cognition-seeds 单源）
    const candidateRows = this.db.raw
      .prepare(`SELECT id, name, description, aliases FROM concepts WHERE status IN (${statusPlace})`)
      .all(...statuses) as unknown as Array<Pick<ConceptRow, 'id' | 'name' | 'description' | 'aliases'>>;
    const seedMatcher = createSeedMatcher(seeds);
    const seedIds: string[] = [];
    for (const r of candidateRows) {
      if (seedMatcher(r.name, r.description, safeJsonArray(r.aliases))) seedIds.push(r.id);
    }
    if (!seedIds.length) return empty;

    const activation = new Map<string, number>();
    for (const id of seedIds) activation.set(id, 1);

    // 邻接：两端都必须在检索 status 集合内（禁止扩散进 shadow）
    const allEdges = this.db.raw
      .prepare(
        `SELECT e.* FROM concept_edges e
         JOIN concepts s ON s.id = e.source_id
         JOIN concepts t ON t.id = e.target_id
         WHERE s.status IN (${statusPlace}) AND t.status IN (${statusPlace})`,
      )
      .all(...statuses, ...statuses) as unknown as EdgeRow[];

    const adj = new Map<string, Array<{ to: string; w: number }>>();
    for (const row of allEdges) {
      const e = this.rowToEdge(row);
      const src = this.db.raw.prepare('SELECT status FROM concepts WHERE id = ?').get(e.sourceId) as
        | { status: string }
        | undefined;
      const tgt = this.db.raw.prepare('SELECT status FROM concepts WHERE id = ?').get(e.targetId) as
        | { status: string }
        | undefined;
      if (!src || !tgt || !statusSet.has(src.status as ConceptStatus) || !statusSet.has(tgt.status as ConceptStatus)) {
        continue;
      }
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
    if (!nodeIds.size) return empty;

    const nodes: ConceptNode[] = [];
    for (const id of nodeIds) {
      const row = this.db.raw.prepare('SELECT * FROM concepts WHERE id = ?').get(id) as
        | ConceptRow
        | undefined;
      if (row) nodes.push(this.rowToNode(row));
    }

    const idList = [...nodeIds];
    const placeholders = idList.map(() => '?').join(',');
    const edgeRows = this.db.raw
      .prepare(
        `SELECT * FROM concept_edges WHERE source_id IN (${placeholders})
          AND target_id IN (${placeholders})`,
      )
      .all(...idList, ...idList) as unknown as EdgeRow[];

    return {
      nodes,
      edges: edgeRows.map((r) => this.rowToEdge(r)),
      activation: Object.fromEntries(kept),
      seeds: seedIds,
    };
  }

  async getFullGraph(): Promise<ConceptGraph> {
    const nodes = (this.db.raw.prepare('SELECT * FROM concepts').all() as unknown as ConceptRow[]).map((r) =>
      this.rowToNode(r),
    );
    const edges = (this.db.raw.prepare('SELECT * FROM concept_edges').all() as unknown as EdgeRow[]).map((r) =>
      this.rowToEdge(r),
    );
    return { nodes, edges };
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

    for (const row of this.db.raw.prepare('SELECT status, kind FROM concepts').all() as Array<{
      status: string;
      kind: string;
    }>) {
      const s = (row.status as ConceptStatus) in byStatus ? (row.status as ConceptStatus) : 'shadow';
      byStatus[s] += 1;
      if (row.kind in byKind) byKind[row.kind as ConceptKind] += 1;
    }

    const nodes = (
      this.db.raw.prepare('SELECT COUNT(*) AS c FROM concepts').get() as { c: number }
    ).c;
    const edges = (
      this.db.raw.prepare('SELECT COUNT(*) AS c FROM concept_edges').get() as { c: number }
    ).c;
    const openMerge = (
      this.db.raw
        .prepare(`SELECT COUNT(*) AS c FROM concept_merge_candidates WHERE status = 'open'`)
        .get() as { c: number }
    ).c;
    const causal = (
      this.db.raw
        .prepare(`SELECT COUNT(*) AS c FROM concept_edges_aux WHERE kind = 'causal_candidate'`)
        .get() as { c: number }
    ).c;
    const birth = (
      this.db.raw
        .prepare('SELECT COUNT(*) AS c FROM concept_birth_candidates WHERE expires_at > ?')
        .get(Date.now()) as { c: number }
    ).c;

    return {
      nodes,
      edges,
      byStatus,
      byKind,
      openMergeCandidates: openMerge,
      causalCandidates: causal,
      birthCandidates: birth,
    };
  }
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 口径修订链解析：保留 { text, memoryId?, at } 对象条目（safeJsonArray 会滤掉对象） */
function safeJsonRevisions(raw: string): ConceptDescriptionRevision[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v)
      ? v.filter(
          (x): x is ConceptDescriptionRevision =>
            !!x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string',
        )
      : [];
  } catch {
    return [];
  }
}
