/**
 * Memory / Wisdom / Cognition 契约
 *
 * @layer harness/memory — Context Intelligence 存储协议。
 * 实现：InMemory* / Sqlite*（AgentDatabase）。非 Kernel。
 */

// ── Memory ──

/**
 * 记忆类型 — 蒸馏产物三类（见 docs/memory.md）
 *
 * - fact：稳定事实与已定结论（含环境、约定、否定结论）
 * - method：可复用做法或因果
 * - norm：以后怎么做（行为开关）
 */
export type MemoryType = 'fact' | 'method' | 'norm';

export const MEMORY_TYPES: readonly MemoryType[] = ['fact', 'method', 'norm'] as const;

/** 写入通道 — LLM 判断后结构化传入；代码只做映射不做 NL 意图识别 */
export type MemoryChannel =
  | 'user_directive'
  | 'decision'
  | 'fail_fix'
  | 'model_inference'
  | 'admin';

/** 运行时置信状态 */
export type MemoryStatus = 'shadow' | 'active' | 'strengthened';

/** 软删除原因 */
export type SoftDeleteReason =
  | 'junk_recheck'
  | 'duplicate_loser'
  | 'superseded'
  | 'shadow_expired'
  | 'decay_unused'
  | 'capacity';

/** 记忆条目 */
export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  source: string;
  confidence: number;
  importance: number;
  accessCount: number;
  lastAccessedAt: number;
  createdAt: number;
  decayFactor: number;
  tags: string[];
  /** 写入通道 */
  channel?: MemoryChannel;
  /** 置信状态；缺省视为 active */
  status?: MemoryStatus;
  /** 何时/如何使用（条件句） */
  futureUse?: string;
  /** 检索锚点 */
  anchors?: string[];
  /** 证据原话/定位 */
  evidence?: string;
  /** 最近强化时间 */
  reinforcedAt?: number;
  /** 软删除 */
  deleted?: boolean;
  deletedAt?: number;
  deletedBy?: string;
  deletedReason?: SoftDeleteReason | string;
  deletedMeta?: Record<string, unknown>;
}

/** 记忆查询 */
export interface MemoryQuery {
  text: string;
  type?: MemoryType | MemoryType[];
  tags?: string[];
  minConfidence?: number;
  minImportance?: number;
  limit?: number;
  updateAccess?: boolean;
  /** 是否包含 shadow（默认 false：注入路径；search 工具为 true） */
  includeShadow?: boolean;
  /** 是否包含已软删（默认 false） */
  includeDeleted?: boolean;
  status?: MemoryStatus | MemoryStatus[];
  channel?: MemoryChannel | MemoryChannel[];
  /**
   * 向量路径最低余弦相似度；低于则丢弃（宁缺毋滥）。
   * 未写出时用 store 默认（注入路径偏严，search 可放宽为 0）。
   */
  minSimilarity?: number;
  /** 关键词路径最低命中分；未写出时用 store 默认 */
  minKeywordScore?: number;
}

/** 记忆统计 */
export interface MemoryStats {
  /** 未软删条数 */
  totalEntries: number;
  byType: Record<MemoryType, number>;
  avgConfidence: number;
  avgImportance: number;
  /** 已软删条数 */
  deletedEntries?: number;
  /** shadow 条数（未删） */
  shadowEntries?: number;
}

/** MemoryStore — 记忆存储接口 */
export interface MemoryStore {
  readonly name: string;
  store(entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>): Promise<string>;
  retrieve(query: MemoryQuery): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | null>;
  update(id: string, patch: Partial<MemoryEntry>): Promise<void>;
  delete(id: string): Promise<void>;
  /** 软删除（治理默认路径） */
  softDelete(id: string, meta: { by: string; reason: SoftDeleteReason | string; winnerId?: string }): Promise<void>;
  undelete(id: string): Promise<void>;
  /** 治理批量读取 */
  listForGovern(filter?: { includeDeleted?: boolean }): Promise<MemoryEntry[]>;
  /** 按类型曲线衰减 idle 条目；返回本轮改动条数 */
  decay(options?: {
    typeParams?: Partial<Record<MemoryType, { idleDays?: number; factor?: number; min?: number }>>;
  }): Promise<number>;
  stats(): Promise<MemoryStats>;
}

// ── Wisdom ──
// 规范：arch/wisdom-layer-formation.md（maxim / 状态机 / W1–W5）

/** 范式生命周期 */
export type WisdomStatus =
  | 'candidate'
  | 'trial'
  | 'active'
  | 'strengthened'
  | 'contested'
  | 'retired'
  | 'superseded';

export const WISDOM_STATUSES: readonly WisdomStatus[] = [
  'candidate',
  'trial',
  'active',
  'strengthened',
  'contested',
  'retired',
  'superseded',
] as const;

/** 可注入状态（contested 默认不注入） */
export const WISDOM_INJECTABLE_STATUSES: readonly WisdomStatus[] = [
  'trial',
  'active',
  'strengthened',
] as const;

/** 写入来源 */
export type WisdomOrigin = 'factory' | 'distilled' | 'agent_write' | 'admin';

export const WISDOM_ORIGINS: readonly WisdomOrigin[] = [
  'factory',
  'distilled',
  'agent_write',
  'admin',
] as const;

/** 范式形态 */
export type WisdomKind = 'generalize' | 'corrective' | 'selection' | 'boundary';

export const WISDOM_KINDS: readonly WisdomKind[] = [
  'generalize',
  'corrective',
  'selection',
  'boundary',
] as const;

/** 软退休原因 */
export type WisdomRetireReason =
  | 'capacity'
  | 'high_miss'
  | 'zero_apply'
  | 'superseded'
  | 'counterevidence'
  | 'admin';

/** 适用域 — 问题形态签名（非主题关键词堆） */
export interface WisdomScenario {
  /** 问题形态（如「验证型宣称」「失败排查」） */
  problemTypes: string[];
  /** 触发线索（任务特征 / 领域 / 失败模式） */
  signals?: string[];
  /** 明确不适用 */
  antiScenarios?: string[];
}

/** 操作效应 — 元认知可执行（禁止空壳格言） */
export interface WisdomEffect {
  /** 推理时先问的问题 */
  questions?: string[];
  /** 要校准的偏见 */
  biases?: string[];
  /** 姿态简述 */
  posture?: string;
}

/** 溯源 — MDL 多源压缩 */
export interface WisdomDerivation {
  memoryIds: string[];
  conceptIds?: string[];
  sessionIds?: string[];
  communityId?: string;
  promotionBatchId?: string;
}

/** 反证登记（可错论） */
export interface WisdomCounterevidence {
  ref: string;
  note: string;
  at: number;
  weight: number;
}

/** 结局统计（弱归因线索，非因果证明） */
export interface WisdomOutcomes {
  applied: number;
  cited: number;
  assisted: number;
  contested: number;
  lastAppliedAt?: number;
  lastOutcomeAt?: number;
  /** 置信度评估水位：已并入 confidence 的 assisted/contested 累计值（增量更新） */
  evalAssisted?: number;
  evalContested?: number;
}

/** 智慧条目 — 判断范式（maxim） */
export interface WisdomEntry {
  id: string;
  /** 核心范式陈述 */
  statement: string;
  rationale?: string;
  scenario: WisdomScenario;
  effect: WisdomEffect;
  status: WisdomStatus;
  confidence: number;
  priority: number;
  derivedFrom: WisdomDerivation;
  exceptions?: string[];
  counterevidence?: WisdomCounterevidence[];
  outcomes: WisdomOutcomes;
  origin: WisdomOrigin;
  kind: WisdomKind;
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
}

/** 出生门控 reason */
export type WisdomGateReason =
  | 'ok'
  | 'empty_statement'
  | 'statement_too_long'
  | 'empty_problem_types'
  | 'empty_effect'
  | 'secret_like'
  | 'persona_overwrite'
  | 'insufficient_support'
  | 'duplicate_statement'
  | 'semantic_conflict'
  | 'capacity_admit_stop'
  | 'invalid_status'
  | 'invalid_origin'
  | 'invalid_kind'
  | 'missing_derived_from'
  | 'unknown_derived_id'
  | 'supersedes_target_missing';

export interface WisdomGateOutcome {
  ok: boolean;
  reason: WisdomGateReason;
  message?: string;
}

/** admit 入口（代码执法；意图归 LLM） */
export interface AdmitWisdomInput {
  statement: string;
  rationale?: string;
  scenario: WisdomScenario;
  effect: WisdomEffect;
  derivedFrom: WisdomDerivation;
  kind: WisdomKind;
  origin?: WisdomOrigin;
  exceptions?: string[];
  /** 显式取代既有条目 */
  supersedesId?: string;
  priority?: number;
  confidence?: number;
  /** factory / 显式 agent_write 可直达 active；distilled 一律 trial 起步 */
  initialStatus?: WisdomStatus;
}

export type AdmitWisdomAction = 'created' | 'superseded' | 'rejected';

export interface AdmitWisdomResult {
  action: AdmitWisdomAction;
  id?: string;
  reason?: WisdomGateReason;
  message?: string;
}

/** 注入检索 */
export interface WisdomInjectQuery {
  /** 本轮任务/查询文本（场景匹配） */
  text?: string;
  /** 小核心条数硬顶 */
  coreMaxItems?: number;
  /** 场景条数硬顶 */
  scenarioMaxItems?: number;
  /** 是否包含 trial（默认 false） */
  includeTrial?: boolean;
}

export interface WisdomInjectPick {
  entry: WisdomEntry;
  /** core = 常备小核心；scenario = 本轮匹配 */
  bucket: 'core' | 'scenario';
  /** 场景匹配分（core 为 1） */
  score: number;
}

export type WisdomOutcomeSignal =
  | 'applied'
  | 'cited'
  | 'assisted'
  | 'contested'
  | 'ignored';

/** 结局观测窗口内的一次弱信号 */
export interface WisdomOutcomeEvent {
  wisdomId: string;
  signal: WisdomOutcomeSignal;
  at?: number;
  note?: string;
  ref?: string;
}

export interface WisdomStats {
  total: number;
  byStatus: Record<WisdomStatus, number>;
  avgConfidence: number;
  avgPriority: number;
  totalApplied: number;
  totalContested: number;
}

/**
 * WisdomStore — 判断范式存储
 *
 * 写入只经 admit*（门控在 wisdom-gates）。检索主路径是 selectForInjection。
 */
export interface WisdomStore {
  readonly name: string;
  admit(
    input: AdmitWisdomInput,
    options?: { allowedMemoryIds?: ReadonlySet<string> },
  ): Promise<AdmitWisdomResult>;
  get(id: string): Promise<WisdomEntry | null>;
  /** 注入选择：core + scenario（不含 retired/superseded/candidate） */
  selectForInjection(query: WisdomInjectQuery): Promise<WisdomInjectPick[]>;
  /** 治理全量读（含 contested；不含 superseded 链内容可另取） */
  listForGovern(filter?: { includeRetired?: boolean }): Promise<WisdomEntry[]>;
  update(id: string, patch: Partial<WisdomEntry>): Promise<void>;
  softRetire(id: string, meta: { by: string; reason: WisdomRetireReason | string }): Promise<void>;
  /** 弱归因结局入账 */
  recordOutcomes(events: WisdomOutcomeEvent[]): Promise<void>;
  /** 注入命中轻量入账（S1 applied）；不跑 confidence 规划 */
  touchApplied(ids: string[]): Promise<void>;
  stats(): Promise<WisdomStats>;
}

// ── Cognition ──
// 规范：arch/cognition-graph-formation.md（持证关系 / 结构同一性 / 快慢两态）

/** 概念种类 — 基本层级偏置 */
export type ConceptKind = 'entity' | 'construct' | 'method' | 'problem' | 'constraint';

export const CONCEPT_KINDS: readonly ConceptKind[] = [
  'entity',
  'construct',
  'method',
  'problem',
  'constraint',
] as const;

/** 关系类型；`related` 为弱边（共现级） */
export type ConceptRelationType =
  | 'causes'
  | 'part_of'
  | 'opposes'
  | 'similar_to'
  | 'evolves_to'
  | 'related';

export const CONCEPT_RELATION_TYPES: readonly ConceptRelationType[] = [
  'causes',
  'part_of',
  'opposes',
  'similar_to',
  'evolves_to',
  'related',
] as const;

/** 强关系（需持证）；`related` / `similar_to` 不在此列 */
export const STRONG_RELATION_TYPES: readonly ConceptRelationType[] = [
  'causes',
  'part_of',
  'opposes',
  'evolves_to',
] as const;

/** 概念/边运行时状态（与 Memory 对齐） */
export type ConceptStatus = 'shadow' | 'active' | 'strengthened';

/** 证据形态 — 持证件字段 */
export type EvidenceClass = 'causal' | 'mereonymy' | 'negation' | 'analogy' | 'evolution' | 'cooccur';

/** 边持证件：强边入库必填 */
export interface EdgeBasis {
  /** 独立支撑命题 */
  memoryIds: string[];
  /** 证据中的原句片段（须 ⊆ evidence/contextSlice） */
  cue: string;
  evidenceClass: EvidenceClass;
  licensedAt: number;
}

/** 概念节点（义项，非词面） */
export interface ConceptNode {
  id: string;
  name: string;
  kind: ConceptKind;
  /** 原型描述（含论域） */
  description?: string;
  frequency: number;
  memoryIds: string[];
  /** 论域标签（义项指纹） */
  domain: string[];
  status: ConceptStatus;
  embedding?: number[] | null;
  createdAt: number;
  updatedAt: number;
}

/** 概念关系 */
export interface ConceptEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: ConceptRelationType;
  strength: number;
  description?: string;
  status: ConceptStatus;
  basis: EdgeBasis;
  createdAt: number;
  updatedAt: number;
}

/** 认知图谱 */
export interface ConceptGraph {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
}

/** 合并候选（近阈带 / 指纹可疑） */
export interface MergeCandidate {
  id: string;
  leftId: string;
  rightId: string;
  reason: string;
  distance: number | null;
  fingerprintDiff: string[];
  status: 'open' | 'merged' | 'kept_split' | 'dropped';
  createdAt: number;
  resolvedAt?: number;
  resolvedAction?: string;
}

/** `causal_candidate` 等旁路假设，不进慢图强边 */
export interface EdgeAux {
  id: string;
  edgeKey: string;
  kind: 'causal_candidate';
  memoryIds: string[];
  cue: string;
  note?: string;
  createdAt: number;
}

export type AdmitConceptAction = 'created' | 'merged' | 'merge_candidate' | 'rejected';

export interface AdmitConceptResult {
  action: AdmitConceptAction;
  /** created / merged 时的节点 id */
  id?: string;
  /** merge_candidate 时的候选 id */
  candidateId?: string;
  reason?: ConceptGateReason;
  message?: string;
}

export type AdmitEdgeAction = 'active' | 'shadow' | 'demoted' | 'rejected' | 'candidate_only';

export interface AdmitEdgeResult {
  action: AdmitEdgeAction;
  edgeId?: string;
  /** demoted 时实际入库的关系类型 */
  relationType?: ConceptRelationType;
  reason?: ConceptGateReason;
  message?: string;
}

export type ConceptGateReason =
  | 'ok'
  | 'empty_name'
  | 'invalid_kind'
  | 'invalid_relation'
  | 'mdl_insufficient'
  | 'pseudo_concept'
  | 'secret_like'
  | 'budget_node'
  | 'budget_edge'
  | 'cue_mismatch'
  | 'multi_evidence_required'
  | 'cooccur_no_escalation'
  | 'demoted_related'
  | 'candidate_only'
  | 'fingerprint_conflict'
  | 'capacity_admit_stop'
  | 'no_context_slice';

export interface AdmitConceptInput {
  name: string;
  kind: ConceptKind;
  description?: string;
  domain?: string[];
  memoryIds?: string[];
  /** 提出该概念的命题条数（MDL）；缺省用 memoryIds.length */
  supportCount?: number;
}

export interface AdmitEdgeInput {
  sourceId: string;
  targetId: string;
  relationType: ConceptRelationType;
  strength: number;
  description?: string;
  basis: EdgeBasis;
  /** 用于 cue 校验的证据/语境全文；缺省跳过 cue 子串校验（仅类型门控） */
  evidenceText?: string;
}

export interface SpreadingActivateOptions {
  /** BFS/扩散深度（默认 2） */
  depth?: number;
  /** 距离衰减（默认 0.55） */
  delta?: number;
  /** 激活地板（默认 0.08） */
  tau?: number;
  /** 节点上限（默认 40） */
  limit?: number;
  /** 仅这些 status（默认 active + strengthened） */
  statuses?: ConceptStatus[];
}

export interface ActivatedGraph extends ConceptGraph {
  /** nodeId → 激活值 */
  activation: Record<string, number>;
  seeds: string[];
}

export interface ConceptGraphStats {
  nodes: number;
  edges: number;
  byStatus: Record<ConceptStatus, number>;
  byKind: Record<ConceptKind, number>;
  openMergeCandidates: number;
  causalCandidates: number;
}

export interface DecayResult {
  decayedEdges: number;
  gcNodes: number;
  gcEdges: number;
}

/**
 * ConceptGraphStore — 认知图谱存储
 *
 * 写入只经 admit*（门控在 layers 之上的 cognition-gates / conceptualizer）。
 * 检索主路径是 spreadingActivate；getFullGraph 供巩固与 health。
 */
export interface ConceptGraphStore {
  admitConcept(input: AdmitConceptInput): Promise<AdmitConceptResult>;
  admitEdge(input: AdmitEdgeInput): Promise<AdmitEdgeResult>;
  /** 记录「假因果」假设，不进慢图 */
  addCausalCandidate(input: {
    sourceId: string;
    targetId: string;
    memoryIds: string[];
    cue: string;
    note?: string;
  }): Promise<void>;
  listMergeCandidates(limit?: number): Promise<MergeCandidate[]>;
  resolveMerge(
    id: string,
    action: 'merge' | 'keep_split' | 'drop',
  ): Promise<void>;
  /** Hebbian 加强（使用痕迹 / 新证据） */
  reinforce(input: {
    nodeIds?: string[];
    edgeIds?: string[];
    /** 0–1 证据强度 */
    evidenceStrength?: number;
  }): Promise<void>;
  /** 反证：降权或改型 */
  counterEvidence(input: {
    edgeId: string;
    memoryId?: string;
    /** 是否改标 opposes */
    markOpposes?: boolean;
  }): Promise<void>;
  promote(ids: string[], to: 'active' | 'strengthened'): Promise<void>;
  demote(ids: string[], to: 'shadow'): Promise<void>;
  applyDecay(now?: number): Promise<DecayResult>;
  spreadingActivate(
    seeds: string[],
    options?: SpreadingActivateOptions,
  ): Promise<ActivatedGraph>;
  getFullGraph(): Promise<ConceptGraph>;
  stats(): Promise<ConceptGraphStats>;
}

// ── 写入槽位（memory 工具 / Steward 共用） ──

export interface MemoryWriteSlot {
  type: MemoryType;
  /** 原子命题 */
  proposition: string;
  /** 证据原话或定位 */
  evidence: string;
  /** 当…时应/不应… */
  futureUse?: string;
  anchors?: string[];
  channel: MemoryChannel;
  importance?: number;
  tags?: string[];
}

/** 门控/置信度可调用的 store 入参 */
export type MemoryStoreInput = Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>;
