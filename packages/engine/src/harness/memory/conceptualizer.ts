/**
 * Conceptualizer — 命题 + 证据语境 → 概念/关系假设 → 门控入库
 *
 * 唯一概念化入口。禁止 session 全文 ETL / 正则 extractFromText。
 * LLM 判义项与关系假设；本模块做结构解析与持证执法。
 *
 * @module harness/memory/conceptualizer
 */

import type {
  AdmitConceptResult,
  AdmitEdgeResult,
  ConceptGraphStore,
  ConceptKind,
  ConceptRelationType,
  EvidenceClass,
  MemoryStatus,
} from './types.js';
import { CONCEPT_KINDS, CONCEPT_RELATION_TYPES } from './types.js';
import {
  evaluateConceptGate,
  licenseEdge,
  splitIdentifierMixed,
  isSecretLike,
  type EdgeLicenseOutcome,
} from './cognition-gates.js';
import { normName } from './cognition-seeds.js';
const CJK = /[一-鿿]/;

/** 概念化输入包 — 语境切片是消歧必需品 */
export interface ConceptualizerInput {
  proposition: string;
  memoryId: string;
  memoryType: 'fact' | 'method' | 'norm';
  evidence: string;
  /** 证据周边语境（±N 消息或 anchor span）；缺失时拒绝概念化 */
  contextSlice: string;
  memoryStatus?: MemoryStatus;
  /**
   * 用于 cue 校验的拼接文本（默认 evidence + contextSlice）。
   * 仅当调用方已把语境切片并入本字段时可替代 contextSlice（evidence 单独不算语境）。
   */
  evidenceText?: string;
}

/** LLM 原始候选（解析前） */
export interface RawConceptualizerOutput {
  nodes?: unknown;
  edges?: unknown;
  rejected?: unknown;
}

export interface ConceptualizerNodeOut {
  name: string;
  kind: ConceptKind;
  description?: string;
  domain: string[];
  supportCount: number;
  /** 出生通道（观测：定义直生与复现计票可区分） */
  birthChannel?: 'definition' | 'theme';
  /** 兄弟面/标识符别名（命名清洗与归并的产物） */
  aliases?: string[];
  admit: AdmitConceptResult;
}

export interface ConceptualizerEdgeOut {
  fromName: string;
  toName: string;
  requestedType: ConceptRelationType;
  /** 一句关系释义（约束边一等公民：约束以边+释义表达，不埋节点文本） */
  description?: string;
  license: EdgeLicenseOutcome;
  admit?: AdmitEdgeResult;
}

export interface ConceptualizerResult {
  nodes: ConceptualizerNodeOut[];
  edges: ConceptualizerEdgeOut[];
  rejected: Array<{ name: string; reason: string }>;
}

const MAX_NODES = 2;
const MAX_EDGES = 12;

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function parseKind(v: unknown): ConceptKind | null {
  const s = asString(v) as ConceptKind;
  return CONCEPT_KINDS.includes(s) ? s : null;
}

function parseRelation(v: unknown): ConceptRelationType | null {
  const s = asString(v) as ConceptRelationType;
  return CONCEPT_RELATION_TYPES.includes(s) ? s : null;
}

function parseEvidenceClass(v: unknown): EvidenceClass | null {
  const s = asString(v);
  const allowed: EvidenceClass[] = ['causal', 'mereonymy', 'negation', 'analogy', 'evolution', 'cooccur'];
  return (allowed as string[]).includes(s) ? (s as EvidenceClass) : null;
}

/**
 * 从 LLM 文本中提取 JSON 对象（`{nodes,edges}`）。
 *
 * @param text - LLM 输出
 * @returns 解析结果或 null
 */
export function parseConceptualizerJson(text: string): RawConceptualizerOutput | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as RawConceptualizerOutput;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 语境充分性判定 — handler 前置检查与 admit 门共用（唯一判定点）。
 *
 * @param input - contextSlice 或调用方预合并的 evidenceText 任一非空即有语境
 * @returns 是否具备概念化所需的证据语境
 */
export function hasSufficientContext(
  input: Pick<ConceptualizerInput, 'contextSlice' | 'evidenceText'>,
): boolean {
  return Boolean(input.contextSlice?.trim() || input.evidenceText?.trim());
}

/**
 * 解析 + 门控 + 入库（store 可选时只评估不写）。
 *
 * @param raw - LLM 结构化输出或原文
 * @param input - 输入包（须含 contextSlice）
 * @param store - ConceptGraphStore；省略则只跑门控
 */
export async function conceptualizeAndAdmit(
  raw: RawConceptualizerOutput | string,
  input: ConceptualizerInput,
  store?: ConceptGraphStore,
): Promise<ConceptualizerResult> {
  const parsed = typeof raw === 'string' ? parseConceptualizerJson(raw) : raw;
  const rejected: Array<{ name: string; reason: string }> = [];
  if (!parsed) {
    return { nodes: [], edges: [], rejected: [{ name: '*', reason: 'parse_failed' }] };
  }

  if (!hasSufficientContext(input)) {
    return {
      nodes: [],
      edges: [],
      rejected: [{ name: '*', reason: 'no_context_slice' }],
    };
  }

  const evidenceText =
    input.evidenceText ?? `${input.evidence}\n${input.contextSlice}`;
  const supportBase = 1;

  // 预载既有概念名 → id（跨命题连边）
  const nameToId = new Map<string, string>();
  if (store) {
    try {
      const full = await store.getFullGraph();
      for (const n of full.nodes) {
        const key = n.name.trim().toLowerCase();
        if (!nameToId.has(key)) nameToId.set(key, n.id);
        for (const alias of n.aliases ?? []) {
          const ak = alias.trim().toLowerCase();
          if (!nameToId.has(ak)) nameToId.set(ak, n.id);
        }
      }
    } catch {
      // 读图失败时仅能连本批节点
    }
  }

  // ── nodes ──
  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const nodes: ConceptualizerNodeOut[] = [];

  // 命名清洗 + 同批兄弟面归并（R7′ commit 3，B-1 修正版）：
  // ①「标识符+中文」混合名 → 中文主体为 name、标识符提为 alias（命名卫生）；
  // ② 只并**同 kind**（异 kind 是义项，各自走 store 的 merge_candidate 裁决）；
  // ③ 同名或包含对且短名含 CJK（拉丁词包含多为巧合：run⊂runtime 不并）；
  // ④ 先见者为主名，承接 definition/description/domain，被并名留痕 rejected('merged_into_sibling')。
  const cleaned = rawNodes.slice(0, MAX_NODES * 2).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const o = item as Record<string, unknown>;
    const split = splitIdentifierMixed(asString(o.name));
    return [{ o, name: split.name, rawName: asString(o.name), aliases: split.alias ? [split.alias] : [] }];
  });
  const merged: typeof cleaned = [];
  for (const c of cleaned) {
    const target = merged.find((m) => {
      const a = normName(m.name);
      const b = normName(c.name);
      if (a.length < 2 || b.length < 2) return false;
      // 只并同 kind：异 kind 是不同义项，禁止自动归并（契约：义项冲突走 merge_candidate）
      const kindA = asString(m.o.kind) || 'construct';
      const kindB = asString(c.o.kind) || 'construct';
      if (kindA !== kindB) return false;
      const same = a === b;
      const contained =
        (CJK.test(m.name) || CJK.test(c.name)) && (a.includes(b) || b.includes(a));
      return same || contained;
    });
    if (!target) {
      merged.push(c);
      continue;
    }
    // 审计留痕：被并名不作为独立概念产出
    rejected.push({ name: c.name, reason: 'merged_into_sibling' });
    // 承接（B-1）：定义标记与口径原文优先于长度/顺序——不许静默丢
    const cDef = c.o.definition === true;
    const tDef = target.o.definition === true;
    if (cDef && !tDef) {
      target.o.definition = true;
      if (asString(c.o.description)) target.o.description = c.o.description;
    } else if (!asString(target.o.description) && asString(c.o.description)) {
      target.o.description = c.o.description;
    }
    const tDomain = Array.isArray(target.o.domain) ? (target.o.domain as unknown[]) : [];
    const cDomain = Array.isArray(c.o.domain) ? (c.o.domain as unknown[]) : [];
    target.o.domain = [...new Set([...tDomain, ...cDomain])];
    // 别名：被并名与其别名并入（去重、不把主名收进自己的别名）
    for (const alias of [c.name, c.rawName, ...c.aliases]) {
      if (!alias || normName(alias) === normName(target.name)) continue;
      if (!target.aliases.includes(alias)) target.aliases.push(alias);
    }
    if (c.rawName && !target.aliases.includes(c.rawName) && normName(c.rawName) !== normName(target.name)) {
      target.aliases.push(c.rawName);
    }
  }

  for (const item of merged) {
    if (nodes.length >= MAX_NODES) {
      // 裂变预算显式拒绝（fail loud）：被丢提案不再静默消失
      rejected.push({ name: item.name, reason: 'budget_node' });
      continue;
    }
    const o = item.o;
    const name = item.name;
    const rawKind = asString(o.kind);
    const kind = parseKind(o.kind);
    if (rawKind && !kind) {
      rejected.push({ name, reason: 'kind_invalid' });
      continue;
    }
    const resolvedKind = kind ?? 'construct';
    const description = asString(o.description) || undefined;
    const domain = Array.isArray(o.domain)
      ? o.domain.filter((d): d is string => typeof d === 'string').map((d) => d.trim()).filter(Boolean)
      : [];
    // 定义句标记（R7′ 定义通道）：定义/纠正/口径类命题直生，description = 口径原文。
    // 结构防护（F2/F12）：只有 norm 命题 + 权威状态（active/strengthened）的定义标记有效——
    // 低置信来源不得免票直生、更不得覆盖既有口径；非布尔标记显式留痕不静默降级。
    const rawDefinition = o.definition;
    if (rawDefinition !== undefined && rawDefinition !== false && rawDefinition !== true) {
      rejected.push({ name, reason: 'definition_flag_invalid' });
    }
    const definitionAuthorized =
      rawDefinition === true &&
      input.memoryType === 'norm' &&
      (input.memoryStatus === 'active' || input.memoryStatus === 'strengthened');
    if (rawDefinition === true && !definitionAuthorized) {
      rejected.push({ name, reason: 'definition_requires_norm_active' });
    }
    const birthChannel = definitionAuthorized ? 'definition' : undefined;

    const gate = evaluateConceptGate(
      {
        name,
        kind: resolvedKind,
        description,
        domain,
        memoryIds: [input.memoryId],
        supportCount: supportBase,
      },
      { skipMdl: birthChannel === 'definition' },
    );
    // 票不够（mdl_insufficient）不是拒绝：交 store 入出生候选区投票（R7′ 复现计票）
    if (!gate.ok && gate.reason !== 'mdl_insufficient') {
      rejected.push({ name, reason: gate.reason });
      continue;
    }

    let admit: AdmitConceptResult = {
      action: 'rejected',
      reason: gate.reason ?? 'mdl_insufficient',
      message: gate.message ?? 'store not provided',
    };
    if (store) {
      admit = await store.admitConcept({
        name,
        kind: resolvedKind,
        description,
        domain,
        aliases: item.aliases,
        memoryIds: [input.memoryId],
        supportCount: supportBase,
        birthChannel,
      });
    } else if (!gate.ok) {
      // gate-only 模式如实回传门控结论（1 票会 park，不是 created）
      admit = { action: 'candidate_parked', reason: gate.reason, message: 'store not provided (gate-only)' };
    } else {
      admit = { action: 'created', reason: 'ok' };
    }

    // 边端点解析要能命中改名/归并后的节点：canonical 名、清洗前原名、别名全部登记（M-1）
    if (admit.id) {
      nameToId.set(name.toLowerCase(), admit.id);
      for (const alias of item.aliases) nameToId.set(alias.toLowerCase(), admit.id);
      if (item.rawName) nameToId.set(item.rawName.toLowerCase(), admit.id);
    }
    nodes.push({
      name,
      kind: resolvedKind,
      description,
      domain,
      supportCount: supportBase,
      birthChannel: birthChannel ?? 'theme',
      aliases: item.aliases,
      admit,
    });
  }

  // ── edges ──
  const rawEdges = Array.isArray(parsed.edges) ? parsed.edges : [];
  const edges: ConceptualizerEdgeOut[] = [];

  for (const item of rawEdges.slice(0, MAX_EDGES * 2)) {
    if (edges.length >= MAX_EDGES) break;
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const fromName = asString(o.fromName ?? o.from ?? o.source);
    const toName = asString(o.toName ?? o.to ?? o.target);
    const requestedType = parseRelation(o.relationType ?? o.relation) ?? 'related';
    const evidenceClass = parseEvidenceClass(o.evidenceClass) ?? 'cooccur';
    const cue = asString(o.cue);
    // 约束边一等公民：边的一句关系释义；缺省不猜不渲染，密钥形态不入库
    const gloss = asString(o.description);
    const description = gloss && !isSecretLike(gloss) ? gloss : undefined;

    const license = licenseEdge({
      relationType: requestedType,
      evidenceClass,
      cue,
      evidenceText,
      memoryIds: [input.memoryId],
      memoryStatuses: input.memoryStatus ? [input.memoryStatus] : [],
    });

    const edgeOut: ConceptualizerEdgeOut = {
      fromName,
      toName,
      requestedType,
      description,
      license,
    };

    if (store && license.status !== 'rejected') {
      const sourceId = nameToId.get(fromName.toLowerCase());
      const targetId = nameToId.get(toName.toLowerCase());
      if (!sourceId || !targetId) {
        // 端点未出生（1 票候选区是常态）：显式边界——首观察且端点未出生的边被丢弃
        // （复现挣来：端点出生后的再次观察会重建）；释义保留在 edgeOut 供观测，不入库
        edgeOut.license = {
          ...license,
          status: 'rejected',
          reason: 'endpoint_not_admitted',
          message: 'endpoint concept not admitted (may be parked in birth candidates)',
        };
      } else {
        // 统一走 store.admitEdge：store 内部累积同 pair 跨命题证据（collectPairMemoryIds）
        // 并自路由候选——此处不得前置短路 candidate_only，否则单命题 causes 永远攒不齐
        // 2 票、也绕过累积通道（B1）。
        // 传 requestedType 而非 license.relationType（B2）：pre-license 会把未持证 causes
        // 降级成 related，若把降级类型传下去，store 复审永远只见到 related、累积证据永无
        // 转正机会；store 自己的 licenseEdge 随累积证据单调放行，是唯一裁决点
        const admit = await store.admitEdge({
          sourceId,
          targetId,
          relationType: requestedType,
          strength: license.status === 'active' ? 0.7 : 0.4,
          description,
          basis: {
            memoryIds: [input.memoryId],
            cue,
            evidenceClass,
            licensedAt: Date.now(),
          },
          evidenceText,
        });
        edgeOut.admit = admit;
      }
    }

    edges.push(edgeOut);
  }

  return { nodes, edges, rejected };
}
