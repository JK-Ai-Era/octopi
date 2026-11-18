/**
 * cognition.steward.conceptualize — 命题 + contextSlice → 概念/边（持证）
 *
 * 失败语义：缺 llmPort / LLM 错误 / 解析失败 → act.status=failed。
 * 只写 ConceptGraphStore（E3）；不写 Memory / Wisdom / Knowledge。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  SubsystemInput,
  SubsystemOutput,
  InjectedDependencies,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';
import type { ConceptGraphStore, MemoryStatus } from '@octopi-agent/engine/harness/memory/types.js';
import {
  DEP_LLM_PORT,
  DEP_SUBSYSTEM_PROMPT,
  chatForCompleteOutput,
  type SubsystemLLMPort,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/index.js';
import {
  conceptualizeAndAdmit,
  hasSufficientContext,
  parseConceptualizerJson,
} from '../../../harness/memory/conceptualizer.js';
import {
  DEFAULT_CONTEXT_SLICE_MAX_CHARS,
  DEFAULT_CONTEXT_WINDOW_MESSAGES,
  extractContextSlice,
} from '../../../harness/memory/context-slice.js';

const DEP_CONCEPT_GRAPH = 'conceptGraphStore';
const DEP_SESSION_STORE = 'sessionStore';
const DEP_CONFIG = '__subsystem_config__';

interface ConceptualizeConfig {
  maxNodesPerProposition?: number;
  maxEdgesPerProposition?: number;
  /** LLM 生成配额（传参，非业务截断）；缺省 8192 */
  maxTokens?: number;
  /** contextSlice 回补窗口（锚点两侧 ±N 条实质消息）；缺省 2 */
  contextWindowMessages?: number;
  /** contextSlice 字符上限；缺省 4000 */
  contextSliceMaxChars?: number;
}

function resolveSubsystemPrompt(
  deps: InjectedDependencies | undefined,
  llmPort?: SubsystemLLMPort,
): string {
  const fromDeps = deps?.[DEP_SUBSYSTEM_PROMPT];
  if (typeof fromDeps === 'string' && fromDeps.trim()) return fromDeps;
  if (llmPort?.cognitivePrompt?.trim()) return llmPort.cognitivePrompt;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, 'SUBSYSTEM.md'), 'utf8');
  } catch {
    return '';
  }
}

function failOutput(message: string, reason: string): SubsystemOutput {
  return {
    act: {
      mode: 'inject',
      status: 'failed',
      error: message,
      target: 'concept-graph',
      messages: [{ role: 'system', content: `cognition.steward.conceptualize.failed reason=${reason}` }],
    },
    signals: [{ action: 'alert', reason: message, data: { reason } }],
  };
}

/** 配置正整数校验：非法值（NaN/负数/小数/非 number）回退缺省 */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * contextSlice 缺省回补：sessionStore.load(sessionId) → evidence 锚定 ±N 窗口。
 *
 * 失败分层：sessionStore 未注入是装配故障（throw，与 conceptGraphStore 同语义）；
 * load 抛错/形状不符转显式 `session_load_failed`——吞掉的只是单会话读取异常
 * （不得拖垮概念化派发），但必须显式归因，不得伪装成数据问题；
 * 会话缺失或 evidence 无锚点返回空 slice，由调用方按 `no_context_slice` 归因。
 */
async function backfillContextSliceFromSession(
  deps: InjectedDependencies | undefined,
  opts: {
    sessionId: string;
    evidence: string;
    windowMessages: number;
    maxChars: number;
  },
): Promise<{ slice: string } | { fail: 'session_load_failed'; detail: string }> {
  if (!opts.sessionId.trim() || !opts.evidence.trim()) return { slice: '' };
  const sessionStore = deps?.[DEP_SESSION_STORE] as
    | { load?: (sessionId: string) => Promise<{ messages?: unknown[] } | null> }
    | undefined;
  if (!sessionStore) {
    throw new Error(
      'cognition.steward.conceptualize: sessionStore not injected (contextSlice backfill)',
    );
  }
  if (typeof sessionStore.load !== 'function') {
    return { fail: 'session_load_failed', detail: 'sessionStore.load missing' };
  }
  try {
    const session = await sessionStore.load(opts.sessionId);
    if (session == null) return { slice: '' };
    if (!Array.isArray(session.messages)) {
      return {
        fail: 'session_load_failed',
        detail: `session ${opts.sessionId} messages malformed`,
      };
    }
    return {
      slice: extractContextSlice({
        messages: session.messages,
        evidence: opts.evidence,
        windowMessages: opts.windowMessages,
        maxChars: opts.maxChars,
      }),
    };
  } catch (err) {
    // 只吞单会话读取异常并转显式失败；其余路径（缺依赖/坏形状）各有归因，不会落到这里
    return {
      fail: 'session_load_failed',
      detail: `session ${opts.sessionId} load failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function handler(
  input: SubsystemInput,
  deps?: InjectedDependencies,
): Promise<SubsystemOutput> {
  const store = deps?.[DEP_CONCEPT_GRAPH] as ConceptGraphStore | undefined;
  if (!store) {
    throw new Error('cognition.steward.conceptualize: conceptGraphStore not injected');
  }

  const llmPort = deps?.[DEP_LLM_PORT] as SubsystemLLMPort | undefined;
  if (!llmPort?.chat) {
    return failOutput('llmPort missing', 'llm_port_missing');
  }

  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const proposition = String(payload.proposition ?? '').trim();
  const memoryId = String(payload.memoryId ?? '');
  const evidence = String(payload.evidence ?? '');
  const memoryType = (String(payload.memoryType ?? payload.type ?? 'fact') as 'fact' | 'method' | 'norm');
  const memoryStatus = (payload.memoryStatus as MemoryStatus | undefined) ?? undefined;

  if (!proposition || !memoryId) {
    return failOutput('missing proposition/memoryId', 'bad_payload');
  }

  const config = (deps?.[DEP_CONFIG] as ConceptualizeConfig | undefined) ?? {};
  const windowMessages = positiveInt(
    config.contextWindowMessages,
    DEFAULT_CONTEXT_WINDOW_MESSAGES,
  );
  const maxChars = positiveInt(config.contextSliceMaxChars, DEFAULT_CONTEXT_SLICE_MAX_CHARS);

  // contextSlice 缺省从 session 补齐（输入包契约，arch/cognition-graph-formation.md D1）
  const rawSlice = payload.contextSlice ?? payload.context_slice;
  const providedSlice = typeof rawSlice === 'string' ? rawSlice : '';
  let contextSlice = providedSlice;
  if (!contextSlice.trim()) {
    const backfill = await backfillContextSliceFromSession(deps, {
      sessionId: String(payload.sessionId ?? ''),
      evidence,
      windowMessages,
      maxChars,
    });
    if ('fail' in backfill) {
      return failOutput(backfill.detail, backfill.fail);
    }
    contextSlice = backfill.slice;
  }

  // 与 admit 门同一判定（hasSufficientContext），且前置到 LLM 之前：无语境不烧 LLM
  if (!hasSufficientContext({ contextSlice })) {
    return failOutput(
      'no context slice (evidence anchor not found in session)',
      'no_context_slice',
    );
  }

  const systemPrompt = resolveSubsystemPrompt(deps, llmPort);
  const userText = [
    `memoryType: ${memoryType}`,
    `proposition: ${proposition}`,
    `evidence: ${evidence}`,
    `contextSlice: ${contextSlice}`,
  ].join('\n');

  // maxTokens 只是生成配额（LLM 传参）：截断（finish=length）或解析失败都放大配额重试
  // 一次，仍失败显式上报——业务完整性优先，禁止静默半截结果
  const outcome = await chatForCompleteOutput(
    llmPort,
    {
      systemPrompt: systemPrompt || undefined,
      messages: [{ role: 'user', content: userText }],
      maxTokens: config.maxTokens ?? 8192,
    },
    (text) => parseConceptualizerJson(text),
  );
  if (!outcome.ok) {
    return failOutput(outcome.message, outcome.reason);
  }
  const parsed = outcome.parsed;

  const result = await conceptualizeAndAdmit(
    parsed,
    {
      proposition,
      memoryId,
      memoryType,
      evidence,
      contextSlice,
      memoryStatus,
    },
    store,
  );

  const created = result.nodes.filter((n) => n.admit.action === 'created' || n.admit.action === 'merged').length;
  const edgesIn = result.edges.filter((e) => e.admit && e.admit.action !== 'rejected').length;

  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'concept-graph',
      messages: [
        {
          role: 'system',
          content: `cognition.steward.conceptualized nodes=${created} edges=${edgesIn} rejected=${result.rejected.length}`,
        },
      ],
    },
    signals: [
      {
        action: 'suggest',
        reason: 'conceptualized',
        data: {
          memoryId,
          nodes: created,
          edges: edgesIn,
          rejected: result.rejected,
        },
      },
    ],
  };
}

export default handler;
