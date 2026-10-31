/**
 * Wisdom formation — 炼制解析、场景匹配、注入排版
 *
 * LLM 判「是不是范式、适用域」；本模块做结构解析 + admit 门控 + 关键词场景匹配。
 * 禁止 session 全文 ETL。规范：arch/wisdom-layer-formation.md §6 / §9。
 *
 * @module harness/memory/wisdom-formation
 */

import type {
  AdmitWisdomInput,
  AdmitWisdomResult,
  WisdomEntry,
  WisdomInjectPick,
  WisdomKind,
  WisdomStore,
} from './types.js';
import { WISDOM_KINDS } from './types.js';
import { wisdomInjectScore } from './wisdom-policy.js';
import { evaluateWisdomGate } from './wisdom-gates.js';

// ── LLM 输出解析 ──

export interface RawWisdomFormationOutput {
  items?: unknown;
  droppedNotes?: unknown;
}

export interface ParsedWisdomItem {
  statement: string;
  rationale?: string;
  problemTypes: string[];
  signals?: string[];
  antiScenarios?: string[];
  questions?: string[];
  biases?: string[];
  posture?: string;
  memoryIds: string[];
  conceptIds?: string[];
  exceptions?: string[];
  kind: WisdomKind;
  /** 取代已有范式（LLM 对照库内已有范式后给出；指向被取代条目 id） */
  supersedesId?: string;
}

export interface ParsedWisdomFormation {
  items: ParsedWisdomItem[];
  droppedNotes: string[];
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x)).filter(Boolean);
}

function parseKind(v: unknown): WisdomKind | null {
  const s = asString(v) as WisdomKind;
  return WISDOM_KINDS.includes(s) ? s : null;
}

/**
 * 从 LLM 文本提取 `{items, droppedNotes}`。
 *
 * @param text - LLM 输出
 * @returns 解析结果或 null
 */
export function parseWisdomFormationJson(text: string): RawWisdomFormationOutput | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  if (end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    return obj as RawWisdomFormationOutput;
  } catch {
    return null;
  }
}

/**
 * 归一化 raw → 严格 Parsed（丢弃残缺项，不半写）。
 *
 * @param raw - 解析后的 JSON
 * @returns 有效 items 与丢弃说明
 */
export function normalizeWisdomFormation(
  raw: RawWisdomFormationOutput,
): ParsedWisdomFormation {
  const items: ParsedWisdomItem[] = [];
  const droppedNotes = asStringArray(raw.droppedNotes);
  const list = Array.isArray(raw.items) ? raw.items : [];
  for (const it of list) {
    if (!it || typeof it !== 'object') {
      droppedNotes.push('non_object_item');
      continue;
    }
    const o = it as Record<string, unknown>;
    const statement = asString(o.statement);
    const scenarioObj =
      typeof o.scenario === 'object' && o.scenario && !Array.isArray(o.scenario)
        ? (o.scenario as Record<string, unknown>)
        : {};
    const pts = asStringArray(o.problemTypes).length
      ? asStringArray(o.problemTypes)
      : asStringArray(scenarioObj.problemTypes);
    const signals = asStringArray(o.signals ?? scenarioObj.signals);
    const antiScenarios = asStringArray(o.antiScenarios ?? scenarioObj.antiScenarios);
    const effect = (typeof o.effect === 'object' && o.effect ? o.effect : o) as Record<string, unknown>;
    const questions = asStringArray(effect.questions ?? o.questions);
    const biases = asStringArray(effect.biases ?? o.biases);
    const posture = asString(effect.posture ?? o.posture);
    const derived = (typeof o.derivedFrom === 'object' && o.derivedFrom
      ? o.derivedFrom
      : o) as Record<string, unknown>;
    const memoryIds = asStringArray(derived.memoryIds ?? o.memoryIds);
    const conceptIds = asStringArray(derived.conceptIds ?? o.conceptIds);
    const kind = parseKind(o.kind);
    const supersedesId = asString(o.supersedesId) || undefined;

    if (!statement || pts.length === 0) {
      droppedNotes.push(`incomplete:${statement.slice(0, 24) || 'empty'}`);
      continue;
    }
    if (!questions.length && !biases.length && !posture) {
      droppedNotes.push(`no_effect:${statement.slice(0, 24)}`);
      continue;
    }
    if (memoryIds.length === 0 && conceptIds.length === 0 && !supersedesId) {
      droppedNotes.push(`no_derived:${statement.slice(0, 24)}`);
      continue;
    }
    if (!kind) {
      droppedNotes.push(`invalid_kind:${asString(o.kind).slice(0, 16)}`);
      continue;
    }

    items.push({
      statement,
      rationale: asString(o.rationale) || undefined,
      problemTypes: pts,
      signals: signals.length ? signals : undefined,
      antiScenarios: antiScenarios.length ? antiScenarios : undefined,
      questions: questions.length ? questions : undefined,
      biases: biases.length ? biases : undefined,
      posture: posture || undefined,
      memoryIds,
      conceptIds: conceptIds.length ? conceptIds : undefined,
      exceptions: asStringArray(o.exceptions).length
        ? asStringArray(o.exceptions)
        : undefined,
      kind,
      supersedesId,
    });
  }
  return { items, droppedNotes };
}

/**
 * Parsed → AdmitWisdomInput（distilled 默认）。
 *
 * @param item - 已归一项
 * @param options - origin / supersedesId
 * @returns admit 入参
 */
export function toAdmitWisdomInput(
  item: ParsedWisdomItem,
  options?: { origin?: AdmitWisdomInput['origin']; supersedesId?: string },
): AdmitWisdomInput {
  return {
    statement: item.statement,
    rationale: item.rationale,
    scenario: {
      problemTypes: item.problemTypes,
      signals: item.signals,
      antiScenarios: item.antiScenarios,
    },
    effect: {
      questions: item.questions,
      biases: item.biases,
      posture: item.posture,
    },
    derivedFrom: {
      memoryIds: item.memoryIds,
      conceptIds: item.conceptIds,
    },
    kind: item.kind,
    origin: options?.origin ?? 'distilled',
    exceptions: item.exceptions,
    supersedesId: options?.supersedesId,
  };
}

/**
 * 炼制解析并逐条 admit。
 *
 * @param llmText - LLM 原文
 * @param store - WisdomStore
 * @param options - origin / maxItems
 * @returns admit 结果与丢弃笔记
 */
export async function formAndAdmit(
  llmText: string,
  store: WisdomStore,
  options?: {
    origin?: AdmitWisdomInput['origin'];
    maxItems?: number;
    allowedMemoryIds?: ReadonlySet<string>;
    dryRun?: boolean;
  },
): Promise<{ results: AdmitWisdomResult[]; droppedNotes: string[] }> {
  const raw = parseWisdomFormationJson(llmText);
  if (!raw) {
    return {
      results: [{ action: 'rejected', reason: 'empty_statement', message: 'parse_failed' }],
      droppedNotes: ['parse_failed'],
    };
  }
  const { items, droppedNotes } = normalizeWisdomFormation(raw);
  const maxItems = options?.maxItems ?? 3;
  // M4：dryRun 与真实 admit 的查重口径一致（全部存活条目参与 duplicate/near-dup/对立）
  const existing = options?.dryRun
    ? (await store.listForGovern()).filter(
        (w) => w.status !== 'retired' && w.status !== 'superseded',
      )
    : undefined;
  const results: AdmitWisdomResult[] = [];
  for (const item of items.slice(0, maxItems)) {
    let allowedIds = options?.allowedMemoryIds;
    if (item.supersedesId) {
      // supersede 继承被取代者的溯源：已覆盖语料被排除出证据包后，「同源精炼」
      // 的自然溯源不在白名单里——并入目标 derivedFrom，取代主路径才通
      const target = await store.get(item.supersedesId);
      const inherited = target?.derivedFrom?.memoryIds ?? [];
      if (!item.memoryIds.length && inherited.length) {
        item.memoryIds = [...inherited];
      }
      if (options?.allowedMemoryIds && inherited.length) {
        allowedIds = new Set([...options.allowedMemoryIds, ...inherited]);
      }
    }
    const input = toAdmitWisdomInput(item, {
      origin: options?.origin,
      supersedesId: item.supersedesId,
    });
    if (options?.dryRun) {
      const gate = evaluateWisdomGate(input, {
        allowedMemoryIds: allowedIds,
        existing,
      });
      results.push(
        gate.ok
          ? { action: 'created', message: 'dry_run' }
          : { action: 'rejected', reason: gate.reason, message: gate.message },
      );
      continue;
    }
    results.push(await store.admit(input, { allowedMemoryIds: allowedIds }));
  }
  return { results, droppedNotes };
}

// ── 场景匹配（P0 keyword；embedding/llm 留给后续，不假装已实现） ──

/** 场景词分段：按空白/标点/符号（含 。.!?-_ 等）切碎成长描述句的短语碎片（≥2 字），使「任务快照」「system」等片段可独立命中。 */
function segmentScenarioWord(w: string): string[] {
  return w
    .split(/[\s\p{P}\p{S}\\]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * 关键词/字面场景匹配分 + 全字面命中标记 + anti 排除标记。
 *
 * 匹配单位是**分段**（长描述句切短语后逐段匹配）：任一段全字面命中记 2 分，
 * 仅 2-gram 弱重叠记 1 分。fullHit = 存在长度 ≥3 的分段全字面命中——
 * trial 的 scenario 入场券只认 fullHit（弱重叠不算，2 字通用词也不够格）。
 *
 * antiScenarios 是排除条件（误触发会静默丢范式），要求更强证据才触发：
 * 整串命中，或长度 ≥3 的分段命中（2 字碎片歧义大，如「越权」不应压制修越权 bug 的任务）。
 *
 * @param entry - 条目
 * @param text - 本轮查询/任务文本
 * @returns score∈[0,1]（无命中为 0）；fullHit=problemTypes/signals ≥3 字分段全字面命中；excluded=anti 命中
 */
export function scenarioMatchDetail(
  entry: WisdomEntry,
  text: string,
): { score: number; fullHit: boolean; excluded: boolean } {
  const q = text.toLowerCase();
  if (!q.trim()) return { score: 0, fullHit: false, excluded: false };
  const anti = (entry.scenario.antiScenarios ?? []).map((s) => s.toLowerCase());
  for (const a of anti) {
    if (!a) continue;
    if (q.includes(a)) return { score: 0, fullHit: false, excluded: true };
    if (segmentScenarioWord(a).some((seg) => seg.length >= 3 && q.includes(seg))) {
      return { score: 0, fullHit: false, excluded: true };
    }
  }

  const words = entry.scenario.problemTypes
    .concat(entry.scenario.signals ?? [])
    .flatMap((w) => segmentScenarioWord(w.toLowerCase()));
  if (words.length === 0) return { score: 0, fullHit: false, excluded: false };

  let hit = 0;
  let fullHit = false;
  for (const w of words) {
    if (!w) continue;
    if (q.includes(w)) {
      hit += 2;
      if (w.length >= 3) fullHit = true;
    } else if (overlapChars(q, w)) hit += 1;
  }
  if (hit === 0) return { score: 0, fullHit: false, excluded: false };
  return { score: Math.min(1, hit / (words.length * 2)), fullHit, excluded: false };
}

/**
 * 关键词/字面场景匹配分。
 *
 * @param entry - 条目
 * @param text - 本轮查询/任务文本
 * @returns [0,1]；无命中为 0
 */
export function scenarioMatchScore(entry: WisdomEntry, text: string): number {
  return scenarioMatchDetail(entry, text).score;
}

function overlapChars(q: string, w: string): boolean {
  // CJK 友好：词全字面出现在 q 已由 includes 覆盖；此处做 2-gram 弱重叠
  if (w.length < 2) return false;
  for (let i = 0; i < w.length - 1; i++) {
    const g = w.slice(i, i + 2);
    if (q.includes(g)) return true;
  }
  return false;
}

/**
 * core 桶资格：宽覆盖（多 problemTypes 或 strengthened/factory）；
 * trial 永不进 core——未验证的假设只走场景匹配命中，不常驻刷屏。
 *
 * @param entry - 条目（状态已过 usable 过滤或可独立断言）
 * @returns 是否可进 core 桶
 */
export function isCoreEligible(
  entry: Pick<WisdomEntry, 'status' | 'origin' | 'scenario'>,
): boolean {
  if (entry.status === 'trial') return false;
  return (
    entry.origin === 'factory' ||
    entry.status === 'strengthened' ||
    entry.scenario.problemTypes.length >= 2
  );
}

/**
 * 选择注入集：小核心 + 场景匹配。
 *
 * @param entries - 可注入条目（store 已滤状态）
 * @param text - 本轮文本
 * @param options - 条数硬顶；trialMaxItems 缺省 2（trial 轮转保底曝光，打破晋升死锁）；includeTrial 缺省 true（trial 的意义就是被试用）
 * @returns 排序后的注入选择
 */
export function pickForInjection(
  entries: WisdomEntry[],
  text: string,
  options?: {
    coreMaxItems?: number;
    scenarioMaxItems?: number;
    trialMaxItems?: number;
    includeTrial?: boolean;
  },
): WisdomInjectPick[] {
  const coreMax = options?.coreMaxItems ?? 8;
  const scenarioMax = options?.scenarioMaxItems ?? 8;
  const trialMax = options?.trialMaxItems ?? 2;
  const includeTrial = options?.includeTrial ?? true;

  const usable = entries.filter((e) => {
    if (e.status === 'retired' || e.status === 'superseded' || e.status === 'candidate') return false;
    if (e.status === 'contested') return false;
    if (e.status === 'trial' && !includeTrial) return false;
    return true;
  });

  const scored = usable.map((e) => {
    const m = scenarioMatchDetail(e, text);
    return {
      entry: e,
      match: m.score,
      fullHit: m.fullHit,
      excluded: m.excluded,
      score: wisdomInjectScore(e, 1),
      scenarioScore: wisdomInjectScore(e, m.score),
    };
  });

  const coreCandidates = scored
    .filter((s) => isCoreEligible(s.entry))
    .sort((a, b) => b.score - a.score)
    .slice(0, coreMax)
    .map((s) => ({ entry: s.entry, bucket: 'core' as const, score: 1 }));

  const coreIds = new Set(coreCandidates.map((c) => c.entry.id));
  // scenario：trial 须全字面命中（bigram 弱重叠不算数——未验证假设不给模糊入场券）
  const scenario = scored
    .filter(
      (s) =>
        s.match > 0 &&
        (s.entry.status !== 'trial' || s.fullHit) &&
        !coreIds.has(s.entry.id),
    )
    .sort((a, b) => b.scenarioScore - a.scenarioScore)
    .slice(0, scenarioMax)
    .map((s) => ({ entry: s.entry, bucket: 'scenario' as const, score: s.match }));

  // trial 轮转试用名额：trial 进不了 core、scenario 又只有全字面命中一张入场券，
  // 没有保底曝光就攒不出场景命中、永不晋升（trial→active 需 applied≥3+assisted）。
  // 轮转规则：最少被试用者优先（applied 升序），同分旧者先出（createdAt 升序），逐轮清队列。
  // anti 命中的条目不轮转（范式自陈不适用的任务不硬塞）；轮转注入不计 applied
  //（applied 语义保持「场景命中被使用」，防曝光污染 contest/zero-apply 治理）。
  const pickedIds = new Set([...coreIds, ...scenario.map((s) => s.entry.id)]);
  const trialRotation =
    trialMax > 0
      ? scored
          .filter(
            (s) => s.entry.status === 'trial' && !pickedIds.has(s.entry.id) && !s.excluded,
          )
          .sort(
            (a, b) =>
              a.entry.outcomes.applied - b.entry.outcomes.applied ||
              a.entry.createdAt - b.entry.createdAt,
          )
          .slice(0, trialMax)
          .map((s) => ({ entry: s.entry, bucket: 'trial' as const, score: s.match }))
      : [];

  return [...coreCandidates, ...scenario, ...trialRotation];
}

// ── 注入排版 ──

/**
 * 按 problemTypes 分组渲染 system 片段（不含 # 思维框架 头，由 WisdomLayer 加）。
 *
 * @param picks - 注入选择
 * @returns 正文
 */
export function formatWisdomBody(picks: WisdomInjectPick[]): string {
  if (picks.length === 0) return '';
  const byType = new Map<string, Array<{ entry: WisdomEntry; bucket: WisdomInjectPick['bucket'] }>>();
  for (const p of picks) {
    const key = p.entry.scenario.problemTypes[0] ?? '通用';
    const list = byType.get(key) ?? [];
    list.push({ entry: p.entry, bucket: p.bucket });
    byType.set(key, list);
  }
  const blocks: string[] = [];
  blocks.push(
    '> 归因：若某条范式实质影响了你的决策，可在回复中引用其 id（如 [wis_xxx]）以便事后验证。',
  );
  for (const [type, list] of byType) {
    const lines = list.map((e) => formatWisdomBullet(e.entry, e.bucket));
    blocks.push(`## 面对「${type}」\n\n${lines.join('\n\n')}`);
  }
  return blocks.join('\n\n');
}

function formatWisdomBullet(e: WisdomEntry, bucket?: WisdomInjectPick['bucket']): string {
  // trial 轮转注入的条目未经场景验证，显式标记供模型降权采信
  const marker = bucket === 'trial' ? '[试用] ' : '';
  const parts = [`- ${marker}[${e.id}] ${e.statement}`];
  const effectBits: string[] = [];
  if (e.effect.posture) effectBits.push(`推理姿态：${e.effect.posture}`);
  if (e.effect.questions?.length) effectBits.push(`先问：${e.effect.questions.join('；')}`);
  if (effectBits.length) parts.push(`  ${effectBits.join('。')}。`);
  const anti = e.scenario.antiScenarios?.[0];
  if (anti) parts.push(`  不适用：${anti}`);
  return parts.join('\n');
}
