/**
 * Wisdom 归因窗口 — 弱归因验证的记账、取证与判官准备（arch/wisdom-layer-formation.md §7）
 *
 * 分工纪律：代码只做记账 / 取证 / 候选路由；`assisted` / `contested` 判决只出自
 * LLM 判官（wisdom.steward.attribute，digest 批量判决）；evaluate 只做入账与状态迁移。
 * 禁止把「任务成功」当「这条有功」——结局标志位只是判官的上下文，不是判决。
 *
 * @module harness/memory/wisdom-attribution
 */

import type { Message } from '@octopi-agent/core/types.js';
import { messageText } from '../context/turn-envelope.js';
import type {
  WisdomAttributionCitation,
  WisdomAttributionWindow,
  WisdomEntry,
  WisdomOutcomeEvent,
  WisdomStore,
} from './types.js';
import { scenarioMatchDetail } from './wisdom-formation.js';

/** run 收尾记账输入（Runner 钩子） */
export interface WisdomRunWindowInfo {
  sessionId: string;
  agentId?: string;
  /** run 收尾原因（completed/aborted/error…）——仅作判官上下文 */
  outcome: string;
  /** 本轮任务/查询文本 */
  query: string;
  /** 本轮注入的 wisdom id（装配 manifest sources） */
  injectedIds: string[];
  /** 本轮产出的 assistant 文本（引用摘录来源） */
  assistantTexts: string[];
}

/** 引用摘录上下文半宽（命中点前后各取的字符数） */
const CITATION_EXCERPT_HALF = 160;

/** statement 命中的最短前缀长度（放宽引用识别：整句或长前缀皆算） */
const CITATION_STATEMENT_PREFIX_MIN = 12;

/** 判决候选（窗口 × 条目）及其路由 */
export interface AttributionCandidate {
  window: WisdomAttributionWindow;
  entry: WisdomEntry;
  /** cited=显式引用；scenario=场景命中；sampled=core 常驻抽样（可选证据） */
  route: 'cited' | 'scenario' | 'sampled';
}

/** 判官输出的单条判决（pair 为 digest 中的序号，从 1 起） */
export interface AttributionVerdict {
  pair: number;
  verdict: 'assisted' | 'contested' | 'unclear';
  reason?: string;
}

/** 批次装箱结果（窗口原子：必判对整窗进或整窗退） */
export interface AttributionBatch {
  /** 进 digest 的候选（必判在前，抽样在后） */
  selected: AttributionCandidate[];
  /** 预算不足被整窗推迟的窗口（保持 pending，下批再判） */
  deferredWindowIds: string[];
  /** 判无可判或抽样未中的窗口（按设计直接关闭，不产生事件） */
  closableWindowIds: string[];
}

/**
 * 收集本轮新增 assistant 文本（引用摘录来源）。
 *
 * @param messages - 会话消息（含历史 + 本轮新增）
 * @param base - 本轮新增消息的起始下标（装配时抓取的 messages.length）
 * @returns 本轮 assistant 纯文本（非空）
 */
export function collectRunAssistantTexts(messages: Message[], base: number): string[] {
  return messages
    .slice(Math.max(0, base))
    .filter((m) => m.role === 'assistant')
    .map((m) => messageText(m.content))
    .filter((t) => t.trim().length > 0);
}

/**
 * 从 assistant 文本提取范式引用摘录。
 *
 * @param texts - 本轮 assistant 文本
 * @param entries - 本轮注入的条目（id + statement）
 * @returns 每条被引用条目一处摘录（id 字面命中，或 statement 整句/长前缀命中）
 */
export function extractCitations(
  texts: string[],
  entries: Array<Pick<WisdomEntry, 'id' | 'statement'>>,
): WisdomAttributionCitation[] {
  const out: WisdomAttributionCitation[] = [];
  for (const e of entries) {
    for (const t of texts) {
      const idIdx = t.indexOf(e.id);
      // statement 命中放宽到长前缀（整句或 ≥12 字符前缀）：允许部分引用
      const stmtNeedle =
        e.statement.length >= CITATION_STATEMENT_PREFIX_MIN
          ? e.statement
          : e.statement.slice(0, CITATION_STATEMENT_PREFIX_MIN);
      const stmtIdx = t.indexOf(stmtNeedle);
      const idx = idIdx >= 0 ? idIdx : stmtIdx;
      if (idx < 0) continue;
      const matchedLen = idIdx >= 0 ? e.id.length : stmtNeedle.length;
      const start = Math.max(0, idx - CITATION_EXCERPT_HALF);
      const end = Math.min(t.length, idx + matchedLen + CITATION_EXCERPT_HALF);
      out.push({ wisdomId: e.id, excerpt: t.slice(start, end) });
      break;
    }
  }
  return out;
}

/**
 * run 收尾记账：取注入条目 → 提取引用摘录 → 落窗口。
 *
 * @param store - WisdomStore
 * @param info - run 收尾信息
 * @returns 窗口 id；本轮无注入时返回 null（不落窗口）
 */
export async function recordWisdomRunWindow(
  store: WisdomStore,
  info: WisdomRunWindowInfo,
): Promise<string | null> {
  const ids = [...new Set(info.injectedIds)].filter(Boolean);
  if (ids.length === 0) return null;
  const all = await store.listForGovern({ includeRetired: true });
  const byId = new Map(all.map((e) => [e.id, e]));
  const entries = ids
    .map((id) => byId.get(id))
    .filter((e): e is WisdomEntry => e !== undefined);
  if (entries.length === 0) return null;
  return store.recordAttributionWindow({
    sessionId: info.sessionId,
    agentId: info.agentId,
    query: info.query,
    outcome: info.outcome,
    injectedIds: entries.map((e) => e.id),
    citations: extractCitations(info.assistantTexts, entries),
  });
}

/**
 * 候选路由：cited / scenario 命中必判；core 常驻只抽样。
 *
 * 注入时的命中可由 (entry, window.query) 确定性重算（同一 matcher、同一 query），
 * 无需在窗口里冗余记录 bucket。终态条目（retired/superseded/candidate）不进候选。
 *
 * @param windows - 未判决窗口
 * @param entries - 条目全集（含终态，内部过滤）
 * @param options - sampleMax 抽样上限（缺省 2）
 * @returns 判决候选（必判在前，抽样在后）
 */
export function selectAttributionCandidates(
  windows: WisdomAttributionWindow[],
  entries: WisdomEntry[],
  options?: { sampleMax?: number },
): AttributionCandidate[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const sampleMax = options?.sampleMax ?? 2;
  const mandatory: AttributionCandidate[] = [];
  const sampled: AttributionCandidate[] = [];
  for (const w of windows) {
    for (const id of w.injectedIds) {
      const entry = byId.get(id);
      if (!entry) continue;
      if (entry.status === 'retired' || entry.status === 'superseded' || entry.status === 'candidate') {
        continue;
      }
      const cited = w.citations.some((c) => c.wisdomId === id);
      const scenarioHit = scenarioMatchDetail(entry, w.query).score > 0;
      if (cited) mandatory.push({ window: w, entry, route: 'cited' });
      else if (scenarioHit) mandatory.push({ window: w, entry, route: 'scenario' });
      else sampled.push({ window: w, entry, route: 'sampled' });
    }
  }
  return [...mandatory, ...sampled.slice(0, sampleMax)];
}

/**
 * 批次装箱（窗口原子）：必判对整窗进或整窗退，被 maxPairs 裁掉的窗口保持 pending；
 * 抽样对是可选证据，预算有余才带，未中即按设计丢弃（不悬挂）。
 *
 * @param windows - 未判决窗口
 * @param entries - 条目全集
 * @param options - sampleMax / maxPairs
 * @returns 装箱结果（selected + deferred + closable）
 */
export function planAttributionBatch(
  windows: WisdomAttributionWindow[],
  entries: WisdomEntry[],
  options?: { sampleMax?: number; maxPairs?: number },
): AttributionBatch {
  const cands = selectAttributionCandidates(windows, entries, {
    sampleMax: options?.sampleMax,
  });
  const byWindow = new Map<string, AttributionCandidate[]>();
  for (const c of cands) {
    const list = byWindow.get(c.window.id) ?? [];
    list.push(c);
    byWindow.set(c.window.id, list);
  }
  const budget = options?.maxPairs ?? 40;
  const selected: AttributionCandidate[] = [];
  const deferredWindowIds: string[] = [];
  const closableWindowIds: string[] = [];
  for (const w of windows) {
    const list = byWindow.get(w.id) ?? [];
    const mandatory = list.filter((c) => c.route !== 'sampled');
    const optional = list.filter((c) => c.route === 'sampled');
    if (mandatory.length === 0) {
      // 无必判对：抽样有余量就带上（带了就要判），没抽中按设计关闭
      let took = false;
      for (const o of optional) {
        if (selected.length >= budget) break;
        selected.push(o);
        took = true;
      }
      if (!took) closableWindowIds.push(w.id);
      continue;
    }
    if (selected.length + mandatory.length > budget) {
      deferredWindowIds.push(w.id);
      continue;
    }
    selected.push(...mandatory);
    for (const o of optional) {
      if (selected.length >= budget) break;
      selected.push(o);
    }
  }
  return { selected, deferredWindowIds, closableWindowIds };
}

/**
 * 构建判官 digest（每候选一小块）与 pair 序号映射。
 *
 * @param candidates - 判决候选
 * @returns digest 文本 + P{n} → (windowId, wisdomId)
 */
export function buildAttributionDigest(candidates: AttributionCandidate[]): {
  text: string;
  pairRefs: Array<{ windowId: string; wisdomId: string }>;
} {
  const pairRefs: Array<{ windowId: string; wisdomId: string }> = [];
  const blocks: string[] = [];
  candidates.forEach((c, i) => {
    pairRefs.push({ windowId: c.window.id, wisdomId: c.entry.id });
    const excerpts = c.window.citations
      .filter((x) => x.wisdomId === c.entry.id)
      .slice(0, 2)
      .map((x) => x.excerpt.slice(0, 400));
    blocks.push(
      [
        `### P${i + 1} [${c.entry.id}]`,
        `范式: ${c.entry.statement.slice(0, 240)}`,
        `场景: ${c.entry.scenario.problemTypes.join('、') || '（无）'}` +
          ` / 信号: ${(c.entry.scenario.signals ?? []).join('、') || '（无）'}`,
        `任务: ${c.window.query.slice(0, 120) || '（无）'} | 结局: ${c.window.outcome} | 路由: ${c.route}`,
        `引用摘录: ${excerpts.length ? excerpts.join('\n---\n') : '（无）'}`,
      ].join('\n'),
    );
  });
  return { text: blocks.join('\n\n'), pairRefs };
}

/**
 * 从 LLM 文本提取判决 JSON `{items: [{pair, verdict, reason}]}`。
 *
 * 覆盖率是硬契约：expectedPairs 中每个 pair **恰好一条**判决（unclear 也算判决，
 * 必须显式给出）；缺项、重复、越界、空 items 一律视为解析失败（null）——
 * 半截/退化输出不得当业务结果，宁可整批失败重试也不静默吞窗口。
 *
 * @param text - LLM 输出
 * @param expectedPairs - 期望的 pair 序号（1 起）
 * @returns 解析结果或 null（覆盖率不符）
 */
export function parseAttributionVerdicts(
  text: string,
  expectedPairs: number[],
): { items: AttributionVerdict[] } | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  if (end <= start) return null;
  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as { items?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.items)) return null;

  const byPair = new Map<number, AttributionVerdict>();
  for (const raw of parsed.items) {
    const item = raw as { pair?: unknown; verdict?: unknown; reason?: unknown };
    if (typeof item.pair !== 'number' || !Number.isInteger(item.pair) || item.pair < 1) return null;
    if (item.verdict !== 'assisted' && item.verdict !== 'contested' && item.verdict !== 'unclear') {
      return null;
    }
    if (byPair.has(item.pair)) return null; // 重复 pair：冲突判决不可信
    byPair.set(item.pair, {
      pair: item.pair,
      verdict: item.verdict,
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 300) : undefined,
    });
  }
  // 覆盖率：期望 pair 每个恰好一条，不允许缺项/多项
  if (byPair.size !== expectedPairs.length) return null;
  const items: AttributionVerdict[] = [];
  for (const pair of expectedPairs) {
    const v = byPair.get(pair);
    if (!v) return null;
    items.push(v);
  }
  return { items };
}

/**
 * 判决 → 弱归因结局事件（unclear 不入账——宁可不更新也不污染）。
 *
 * @param items - 判官判决（已过覆盖率校验）
 * @param pairRefs - digest 序号映射
 * @param now - 时间戳
 * @returns assisted/contested 事件（ref=窗口 id）
 */
export function verdictsToOutcomeEvents(
  items: AttributionVerdict[],
  pairRefs: Array<{ windowId: string; wisdomId: string }>,
  now: number = Date.now(),
): WisdomOutcomeEvent[] {
  const seen = new Set<string>();
  const out: WisdomOutcomeEvent[] = [];
  for (const v of items) {
    if (v.verdict === 'unclear') continue;
    const ref = pairRefs[v.pair - 1];
    if (!ref) continue;
    // (windowId, wisdomId, signal) 幂等：同一次证据绝不重复入账
    const key = `${ref.windowId}|${ref.wisdomId}|${v.verdict}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      wisdomId: ref.wisdomId,
      signal: v.verdict,
      at: now,
      note: v.reason,
      ref: ref.windowId,
    });
  }
  return out;
}
