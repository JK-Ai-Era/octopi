/**
 * `octopi llm-diff` — 比对每轮发给 provider 的完整请求，定位前缀断点
 *
 * 数据来源：`observability.llmRequestDump` 落盘的 `<dir>/<session>/index.jsonl`。
 * 判据：前缀缓存只看相邻两次请求的输入前缀，因此这里按时间顺序逐对比对。
 *
 * @module cli/llm-diff
 */

import type { CliArgs } from './args.js';
import {
  listWireDumpSessions,
  readWireDumpIndex,
  readFirstWireDumpRequest,
  compareWireCalls,
  loadWireDumpBody,
  explainWireDivergence,
  reportWireAging,
  estimateAgingPayback,
  type WireCallSummary,
  type WirePrefixDiff,
} from '@octopi-agent/engine/integration/providers/wire-dump-diff.js';
import { defaultWireDumpDir } from '@octopi-agent/engine/integration/providers/wire-dump.js';

/** 默认展示的调用条数（长 session 调用数可达数百） */
const DEFAULT_LIMIT = 20;

/**
 * 缓存命中相对全价的默认比例
 *
 * 各家定价不同（DeepSeek / OpenAI / Anthropic 的缓存读普遍在 5%–25%），取 0.1 作为
 * 「一折」的中位假设；可用 `--cache-discount` 覆盖。这个值只影响回本估算，不影响比对本身。
 */
const DEFAULT_CACHE_DISCOUNT = 0.1;

/** dump 根目录下的一个 session 目录 */
interface SessionEntry {
  dir: string;
  /** 目录名（已 sanitize） */
  sessionId: string;
  mtimeMs: number;
}

/**
 * 是否为子系统调用桶（非对话会话）
 *
 * 摘要/任务快照这类子系统调用自建 RunScope，sessionId 退化为 agentId，
 * 于是落进以 agent 命名的目录。默认挑选会话时必须排除它们，否则「最近更新」
 * 很容易命中的是子系统桶而不是正在对话的 session。
 *
 * @param entry - session 目录
 * @returns true = 子系统桶
 */
function isSubsystemBucket(entry: SessionEntry): boolean {
  if (entry.sessionId === '_unscoped') return true;
  const first = readFirstWireDumpRequest(entry.dir);
  return first != null && first.sessionId != null && first.sessionId === first.agentId;
}

/**
 * 执行 `llm-diff` 命令
 *
 * @param args - CLI 参数（session / --dir / --limit / --json）
 */
export async function llmDiffCommand(args: CliArgs): Promise<void> {
  const rootDir = args.dir ?? defaultWireDumpDir();
  const sessions = listWireDumpSessions(rootDir);
  if (sessions.length === 0) {
    console.log(`No wire dump found under ${rootDir}`);
    console.log('Enable it in config: { "observability": { "llmRequestDump": { "enabled": true } } }');
    return;
  }

  const wanted = args.session ?? args.subcommand;
  // 默认挑选「最近更新的对话 session」；子系统桶（sessionId == agentId）只在没有对话 session 时兜底
  const conversationSessions = sessions.filter((s) => !isSubsystemBucket(s));
  const defaultPool = conversationSessions.length > 0 ? conversationSessions : sessions;
  let picked: SessionEntry;
  if (wanted) {
    const resolved = resolveSession(wanted, sessions);
    if (!resolved.match) {
      if (resolved.candidates.length > 1) {
        console.log(`Session "${wanted}" is ambiguous — ${resolved.candidates.length} matches under ${rootDir}:`);
        for (const s of resolved.candidates.slice(0, 20)) console.log(`  ${describeSession(s)}`);
        console.log('Pass a longer id (or the exact directory name) to disambiguate.');
      } else {
        console.log(`Session "${wanted}" not found under ${rootDir}. Known sessions:`);
        for (const s of sessions.slice(0, 20)) console.log(`  ${describeSession(s)}`);
      }
      return;
    }
    picked = resolved.match;
  } else {
    picked = defaultPool[0];
  }

  const limit = args.limit ?? DEFAULT_LIMIT;
  const allCalls = readWireDumpIndex(picked.dir);
  if (allCalls.length === 0) {
    console.log(`No calls recorded for session ${picked.sessionId} (${picked.dir})`);
    return;
  }
  // 目录名经过 sanitize；展示与 JSON 输出用日志里的真实 sessionId
  const sessionId = allCalls[0].request.sessionId ?? picked.sessionId;
  const calls = limit > 0 ? allCalls.slice(-limit) : allCalls;

  // 后续调用数按**全量**索引计算：--limit 只影响展示，不应影响回本判定的摊薄面
  const callsAfterById = new Map<string, number>();
  allCalls.forEach((call, i) => {
    callsAfterById.set(call.request.id, allCalls.length - 1 - i);
  });

  const diffs: Array<WirePrefixDiff | null> = calls.map((call, i) => {
    const prev = i === 0 ? undefined : calls[i - 1];
    return prev ? compareWireCalls(prev, call) : null;
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          dir: picked.dir,
          sessionId,
          totalCalls: allCalls.length,
          shown: calls.length,
          calls: calls.map((call, i) => ({
            request: call.request,
            result: call.result,
            fromPrev: diffs[i],
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`LLM wire dump — ${picked.dir}`);
  const agents = Array.from(new Set(allCalls.map((c) => c.request.agentId ?? '-')));
  console.log(
    `session=${sessionId}  agents=${agents.join(',')}  calls=${allCalls.length}${calls.length < allCalls.length ? ` (showing last ${calls.length}; --limit 0 = all)` : ''}`,
  );
  console.log('');
  printTable(calls);
  console.log('');
  printTransitions(calls, diffs, picked.dir, args.cacheDiscount ?? DEFAULT_CACHE_DISCOUNT, callsAfterById);

  const diverged = diffs.filter((d) => d?.stability === 'diverged').length;
  const appendOnly = diffs.filter((d) => d?.stability === 'append-only').length;
  const identical = diffs.filter((d) => d?.stability === 'identical').length;
  const truncated = diffs.filter((d) => d?.stability === 'truncated').length;
  console.log('');
  console.log(
    `transitions: append-only=${appendOnly} identical=${identical} truncated=${truncated} diverged=${diverged} (${diffs.length - 1} pairs)`,
  );
}

/** 调用清单表 */
function printTable(calls: WireCallSummary[]): void {
  const header = [
    pad('#', 4, 'left'),
    pad('time', 9),
    pad('mode', 7),
    pad('model', 22),
    pad('msgs', 5, 'right'),
    pad('chars', 10, 'right'),
    pad('tools', 9),
    pad('ttft', 7, 'right'),
    pad('dur', 8, 'right'),
    pad('cached/input', 18, 'right'),
    'outcome',
  ].join('  ');
  console.log(header);

  calls.forEach((call, i) => {
    const r = call.request;
    const res = call.result;
    const usage = res?.usage;
    const cachedText = usage
      ? `${compactNum(usage.inputCachedTokens)}/${compactNum(usage.inputReportedTokens ?? usage.inputCachedTokens + usage.inputUncachedTokens)}`
      : '-';
    console.log(
      [
        pad(String(i + 1), 4, 'left'),
        `${pad(formatTime(r.at), 9)}`,
        pad(r.mode, 7),
        pad(truncate(r.model, 22), 22),
        pad(String(r.msgCount), 5, 'right'),
        pad(compactNum(r.chars), 10, 'right'),
        pad(r.toolsHash ? `h:${r.toolsHash.slice(0, 6)}` : '-', 9),
        pad(res?.ttftMs != null ? `${(res.ttftMs / 1000).toFixed(1)}s` : '-', 7, 'right'),
        pad(res ? `${(res.durationMs / 1000).toFixed(1)}s` : '-', 8, 'right'),
        pad(cachedText, 18, 'right'),
        `${res?.outcome ?? 'pending'}${bodyNote(call, r.oversize)}`,
      ].join('  '),
    );
  });
}

/** body 缺失的原因：oversize 从未落盘 ≠ 被环形裁剪掉 */
function bodyNote(call: WireCallSummary, oversize: boolean): string {
  if (call.hasBody) return '';
  return oversize ? ' (body skipped: oversize)' : ' (body trimmed)';
}

/** 逐对前缀比对 */
function printTransitions(
  calls: WireCallSummary[],
  diffs: Array<WirePrefixDiff | null>,
  dir: string,
  cacheDiscount: number,
  callsAfterById: Map<string, number>,
): void {
  console.log('Prefix transitions (adjacent calls — provider cache judges the previous request prefix):');
  let printed = 0;

  // 每个 run 的调用次数：仅用于「还需几次调用 ≈ 几个 run」的直观换算
  const callsPerRun = new Map<string, number>();
  for (const call of calls) {
    const key = call.request.runId ?? '(none)';
    callsPerRun.set(key, (callsPerRun.get(key) ?? 0) + 1);
  }

  for (let i = 1; i < calls.length; i++) {
    const diff = diffs[i];
    if (!diff) continue;
    const label = `  #${i + 1} ← #${i}`;
    const notes: string[] = [];
    if (calls[i - 1].request.runId !== calls[i].request.runId) notes.push('new run');
    if (diff.toolsChanged) notes.push('TOOLS CHANGED');
    if (diff.modelChanged) notes.push('MODEL CHANGED');
    if (diff.modeChanged) notes.push('MODE CHANGED');
    const suffix = notes.length ? `  [${notes.join(', ')}]` : '';
    // tools/model 变化时 stableChars 仍是消息前缀量，但缓存实际一条都命中不了
    const cacheNote =
      diff.cacheableChars === diff.stableChars
        ? `stable ${compactNum(diff.stableChars)} chars`
        : `stable ${compactNum(diff.stableChars)} chars, cacheable ${compactNum(diff.cacheableChars)}`;

    if (diff.stability === 'identical') {
      console.log(`${label}  identical (${cacheNote})${suffix}`);
      printed += 1;
      continue;
    }

    if (diff.stability === 'append-only') {
      console.log(`${label}  append-only +${diff.appended} msg (${cacheNote})${suffix}`);
      printed += 1;
      continue;
    }

    if (diff.stability === 'truncated') {
      console.log(`${label}  TAIL DROPPED -${diff.removed} msg (${cacheNote})${suffix}`);
      printed += 1;
      continue;
    }

    const d = diff.divergence!;
    console.log(
      `${label}  DIVERGED at msg[${d.index}] role=${d.prevRole ?? '?'}→${d.nextRole ?? '?'} ` +
        `(len ${d.prevLen ?? '?'}→${d.nextLen ?? '?'}); prefix ${cacheNote}${suffix}`,
    );
    // 批量改写（老化）与单点改写的处置完全不同：前者不是装配 bug，且失效范围到尾部
    if (diff.changedAfter > 0) {
      console.log(
        `        ${diff.changedAfter} further msg(s) also differ after the break — invalidation extends to the tail`,
      );
    }
    const prevBody = loadWireDumpBody(dir, calls[i - 1].request);
    const nextBody = loadWireDumpBody(dir, calls[i].request);
    const aging = reportWireAging(prevBody, nextBody);
    if (aging && (aging.agedInPlace > 0 || aging.agedArgCharsSaved > 0)) {
      const argNote =
        aging.agedArgCharsSaved > 0 ? `, args -${compactNum(aging.agedArgCharsSaved)} chars` : '';
      console.log(
        `        history aged into pointers: +${aging.agedInPlace} msg (total ${aging.prevPointers} → ${aging.nextPointers}), first at msg[${aging.firstAgedIndex}]${argNote}`,
      );
      printAgingPayback(calls, i, diff, aging, cacheDiscount, callsPerRun, callsAfterById);
    }
    const detail = prevBody && nextBody ? explainWireDivergence(prevBody, nextBody, d.index) : null;
    if (detail) {
      console.log(`        offset ${detail.offset}  (<|> marks the first differing character)`);
      console.log(`        prev: ${detail.prevSnippet}`);
      console.log(`        next: ${detail.nextSnippet}`);
    } else {
      console.log(`        (body files unavailable${unavailableReason(calls[i - 1], calls[i])})`);
    }
    printed += 1;
  }

  if (printed === 0) console.log('  (need at least two calls to compare)');
}

/**
 * 输出老化回本判定
 *
 * 老化是一次性付费（重算失效尾部）+ 持续收益（此后每次调用少读）。判据是「回本需要多少次
 * 调用」对比「之后实际发生了多少次调用」——后者是实测值，比按 turn 估算可靠（一个 turn
 * 会跨多个 run，用 runId 分组会严重低估调用量）。
 *
 * @param calls - 调用列表
 * @param index - 老化发生的调用下标（next 侧）
 * @param diff - 该次前缀比对结果（提供实际失效字符量）
 * @param aging - 老化统计（提供净减字符量）
 * @param cacheDiscount - 缓存命中相对全价的比例
 * @param callsPerRun - 各 run 的调用次数（用于「还需几轮」的直观换算）
 * @param callsAfterById - 每次调用之后的剩余调用数
 */
function printAgingPayback(
  calls: WireCallSummary[],
  index: number,
  diff: WirePrefixDiff,
  aging: { agedCharsSaved: number },
  cacheDiscount: number,
  callsPerRun: Map<string, number>,
  callsAfterById: Map<string, number>,
): void {
  const call = calls[index];
  const request = call.request;

  // tools/model 变化时整段前缀都失效，燃烧量取整个请求体
  const burnedChars = Math.max(0, request.chars - diff.cacheableChars);
  const tokensPerChar = estimateTokensPerChar(call);
  const callsAfter = callsAfterById.get(request.id) ?? 0;

  const payback = estimateAgingPayback({
    agedCharsSaved: aging.agedCharsSaved,
    burnedChars,
    tokensPerChar,
    cacheDiscount,
    callsAfter,
  });

  if (!Number.isFinite(payback.paybackCalls)) {
    console.log(
      `        payback: saved ${compactNum(payback.savedTokens)} tok/call vs burned ${compactNum(payback.burnedTokens)} tok ` +
        `— no positive return (cache-discount=${cacheDiscount})`,
    );
    return;
  }

  const verdict = payback.repaid
    ? `repaid (${callsAfter} calls followed)`
    : `needs ${approxTurnsText(payback.paybackCalls - callsAfter, callsPerRun, request.runId)} more`;
  console.log(
    `        payback: saved ${compactNum(payback.savedTokens)} tok/call vs burned ${compactNum(payback.burnedTokens)} tok ` +
      `→ ${payback.paybackCalls.toFixed(1)} calls at ${Math.round(cacheDiscount * 100)}% cache price — ${verdict}`,
  );
}

/**
 * 把「还差多少次调用」换算成轮数
 *
 * @param remainingCalls - 还差的调用次数
 * @param callsPerRun - 各 run 调用次数
 * @param runId - 当前 run
 * @returns 可读描述
 */
function approxTurnsText(
  remainingCalls: number,
  callsPerRun: Map<string, number>,
  runId: string | undefined,
): string {
  const perRun = callsPerRun.get(runId ?? '(none)') ?? 0;
  if (perRun <= 1) return `${remainingCalls.toFixed(1)} calls`;
  return `${remainingCalls.toFixed(1)} calls (≈${(remainingCalls / perRun).toFixed(1)} runs)`;
}

/**
 * 由真实 usage 推算 tokens/char
 *
 * 缺 usage（调用失败/未回填）时退回 1/3 的通用粗估，并保持与 chars 同口径。
 *
 * @param call - 调用摘要
 * @returns tokens per char
 */
function estimateTokensPerChar(call: WireCallSummary): number {
  const usage = call.result?.usage;
  const promptTokens = usage
    ? usage.inputCachedTokens + usage.inputUncachedTokens
    : 0;
  if (promptTokens > 0 && call.request.chars > 0) {
    return promptTokens / call.request.chars;
  }
  return 1 / 3;
}

/** body 缺失的处置建议：oversize 要调大上限，裁剪需要看更近的调用 */
function unavailableReason(prev: WireCallSummary, next: WireCallSummary): string {
  if (prev.request.oversize || next.request.oversize) {
    return ' — body exceeded maxBodyBytes and was never written; raise observability.llmRequestDump.maxBodyBytes';
  }
  return ' — trimmed by maxCallsPerSession or removed manually; hash-level diff above still holds';
}

/**
 * 匹配目标 session
 *
 * 目录名经过 sanitize（`:`、`/` 等被替换），因此先按目录名精确匹配，再按索引里的真实
 * sessionId 匹配，最后才退化为子串匹配。子串命中多于一个时**不猜**：返回候选让调用方
 * 报歧义，避免把另一个 session 的调用当成目标来分析。
 *
 * @param wanted - 用户输入（完整 id 或片段）
 * @param sessions - dump 根目录下的 session 列表
 * @returns 唯一命中（match）或候选列表（candidates）
 */
function resolveSession(
  wanted: string,
  sessions: SessionEntry[],
): { match?: SessionEntry; candidates: SessionEntry[] } {
  const byDir = sessions.find((s) => s.sessionId === wanted);
  if (byDir) return { match: byDir, candidates: [] };

  const realIds = sessions.map((s) => ({ s, real: readFirstWireDumpRequest(s.dir)?.sessionId }));
  const exactReal = realIds.find((entry) => entry.real === wanted);
  if (exactReal) return { match: exactReal.s, candidates: [] };

  const partial = realIds.filter((entry) => entry.real?.includes(wanted)).map((entry) => entry.s);
  const candidates =
    partial.length > 0 ? partial : sessions.filter((s) => s.sessionId.includes(wanted));
  if (candidates.length === 1) return { match: candidates[0], candidates: [] };
  return { candidates };
}

/** 展示用 sessionId：优先索引里的真实值 */
/**
 * 列出候选 session 时标注子系统桶，避免用户以为那是对话
 *
 * @param entry - session 目录
 * @returns 展示名
 */
function describeSession(entry: SessionEntry): string {
  const base = displaySessionId(entry.dir, entry.sessionId);
  return isSubsystemBucket(entry) ? `${base}  (subsystem calls, not a conversation)` : base;
}

function displaySessionId(dir: string, fallback: string): string {
  return readFirstWireDumpRequest(dir)?.sessionId ?? fallback;
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (text.length >= width) return text.slice(0, width);
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toTimeString().slice(0, 8);
}
