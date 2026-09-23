/**
 * memory.steward.backfill — session 原文 → 命题候选 → 门控入库
 *
 * 失败语义：缺 llmPort / LLM 错误 / 解析失败 → act.status=failed（不得洗成 accepted=0 成功）。
 * 显式绑定 SUBSYSTEM.md（认知指令）为 systemPrompt；宪法并入 system。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SubsystemInput, SubsystemOutput, InjectedDependencies } from '../../../harness/autonomous-subsystem/types.js';
import type { MemoryStore } from '../../../harness/memory/types.js';
import {
  DEP_LLM_PORT,
  DEP_SUBSYSTEM_PROMPT,
  type SubsystemLLMPort,
} from '../../../harness/autonomous-subsystem/index.js';
import { admitCandidates, type StewardCandidate } from '../shared/policy.js';
import {
  measureSessionDensity,
  type BackfillCoverageStore,
} from '../../../harness/memory/backfill-coverage.js';

const DEP_MEMORY_STORE = 'memoryStore';
const DEP_SESSION_STORE = 'sessionStore';
const DEP_CONSTITUTION = 'constitution';
const DEP_BACKFILL_COVERAGE = 'backfillCoverage';
const DEP_CONFIG = '__subsystem_config__';

interface BackfillConfig {
  maxCandidatesPerSession?: number;
  maxEvidenceChars?: number;
  maxSessionsPerRun?: number;
}

type BackfillFailReason =
  | 'llm_port_missing'
  | 'llm_error'
  | 'llm_empty'
  | 'parse_failed';

function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inString) { if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)) as unknown[]; } catch { return null; }
      }
    }
  }
  return null;
}

function parseCandidates(raw: unknown[], max: number): StewardCandidate[] {
  const out: StewardCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const proposition = typeof o.proposition === 'string' ? o.proposition.trim() : typeof o.content === 'string' ? o.content.trim() : '';
    if (!proposition) continue;
    const type = typeof o.type === 'string' ? o.type : 'fact';
    if (!['fact', 'method', 'norm'].includes(type)) continue;
    out.push({
      type,
      proposition,
      evidence: typeof o.evidence === 'string' ? o.evidence : undefined,
      future_use: typeof o.future_use === 'string' ? o.future_use : undefined,
      anchors: Array.isArray(o.anchors) ? o.anchors.filter((a): a is string => typeof a === 'string') : undefined,
      channel: (typeof o.channel === 'string' ? o.channel : 'model_inference') as StewardCandidate['channel'],
      importance: typeof o.importance === 'number' ? o.importance : undefined,
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 证据切片：只要实质 user/assistant 文本；丢 tool/命令回显；
 * 超长时保留「头 + 尾」（起因 + 收束/纠错），避免中段过程挤掉结论。
 */
function messagesToText(session: any, maxChars = 8000): string {
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  const lines: string[] = [];
  for (const m of msgs) {
    const kind = m?.metadata?.kind;
    if (kind === 'command' || kind === 'command_result') continue;
    const role = m?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
    const text = content.trim();
    if (!text) continue;
    lines.push(`[${role}] ${text}`);
  }
  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;
  const headBudget = Math.floor(maxChars * 0.4);
  const tailBudget = maxChars - headBudget - 20;
  return `${joined.slice(0, headBudget)}\n...[evidence truncated]...\n${joined.slice(-tailBudget)}`;
}

/** 显式解析认知指令：deps → llmPort.cognitivePrompt → 同目录 SUBSYSTEM.md */
function resolveSubsystemPrompt(deps: InjectedDependencies | undefined, llmPort?: SubsystemLLMPort): string {
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

async function markCoverage(
  deps: InjectedDependencies | undefined,
  patch: {
    sessionId: string;
    agentId?: string;
    fingerprint: string;
    status: 'skipped' | 'success' | 'failed';
    reason?: string;
    accepted?: number;
    trigger?: string;
  },
): Promise<void> {
  const store = deps?.[DEP_BACKFILL_COVERAGE] as BackfillCoverageStore | undefined;
  if (!store) return;
  try {
    await store.put({
      ...patch,
      attemptedAt: Date.now(),
    });
  } catch {
    // 覆盖表失败不阻断补录结果上报
  }
}

function failOutput(reason: BackfillFailReason, message: string, sessionId: string, extra?: Record<string, unknown>): SubsystemOutput {
  return {
    act: {
      mode: 'inject',
      status: 'failed',
      error: message,
      target: 'memory-store',
      messages: [{ role: 'system', content: `memory.steward.backfill.failed reason=${reason}` }],
    },
    signals: [{
      action: 'alert',
      reason: message,
      data: { reason, sessionId, accepted: 0, ...extra },
    }],
  };
}

async function handler(input: SubsystemInput, deps?: InjectedDependencies): Promise<SubsystemOutput> {
  const memoryStore = deps?.[DEP_MEMORY_STORE] as MemoryStore | undefined;
  if (!memoryStore) {
    throw new Error('memory.steward.backfill: memoryStore not injected');
  }
  const config = (deps?.[DEP_CONFIG] as BackfillConfig | undefined) ?? {};
  const maxCandidates = config.maxCandidatesPerSession ?? 8;
  const maxEvidenceChars = config.maxEvidenceChars ?? 8000;
  const maxSessionsPerRun = config.maxSessionsPerRun ?? 20;

  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const sessionId = input.sessionMetadata?.sessionId ?? String(payload.sessionId ?? 'unknown');
  const agentId = input.sessionMetadata?.agentId ?? String(payload.agentId ?? 'default');
  const triggerKind = typeof payload.reason === 'string' ? payload.reason : undefined;
  const coverageFingerprint =
    typeof payload.fingerprint === 'string' && payload.fingerprint
      ? payload.fingerprint
      : measureSessionDensity([]).fingerprint;

  let sessionText = String(payload.sessionText ?? payload.evidenceText ?? '').slice(0, maxEvidenceChars);

  // 未携带 sessionText 时，尝试从 sessionStore 按 sessionIds/sessionId 补读原文
  const sessionStore = deps?.[DEP_SESSION_STORE] as
    | { get?: (sessionId: string) => Promise<any>; load?: (sessionId: string) => Promise<any> }
    | undefined;
  if (!sessionText.trim() && sessionStore) {
    const ids = Array.isArray(payload.sessionIds) && payload.sessionIds.length > 0
      ? (payload.sessionIds as string[]).map(String)
      : [sessionId];
    const chunks: string[] = [];
    for (const sid of ids.slice(0, maxSessionsPerRun)) {
      try {
        const session =
          (typeof sessionStore.get === 'function' ? await sessionStore.get(sid) : undefined) ??
          (typeof sessionStore.load === 'function' ? await sessionStore.load(sid) : undefined);
        const text = messagesToText(session, maxEvidenceChars);
        if (text) chunks.push(text);
      } catch {
        // 个别 session 不可读时跳过；空结果仍走 no-op/failed 语义，不吞整批
      }
    }
    sessionText = chunks.join('\n---\n');
    if (sessionText.length > maxEvidenceChars) {
      const head = Math.floor(maxEvidenceChars * 0.4);
      const tail = Math.floor(maxEvidenceChars * 0.55);
      sessionText = `${sessionText.slice(0, head)}\n...[evidence truncated]...\n${sessionText.slice(-tail)}`;
    }
  }

  const constitution = typeof deps?.[DEP_CONSTITUTION] === 'string' ? (deps[DEP_CONSTITUTION] as string) : '';

  if (!sessionText.trim()) {
    await markCoverage(deps, {
      sessionId,
      agentId,
      fingerprint: coverageFingerprint,
      status: 'skipped',
      reason: 'empty_session_evidence',
      trigger: triggerKind,
    });
    return {
      act: {
        mode: 'inject',
        status: 'success',
        target: 'memory-store',
        messages: [{ role: 'system', content: 'memory.steward.backfilled accepted=0 (no session text)' }],
      },
      signals: [{
        action: 'no-op',
        reason: 'backfill skipped: empty session evidence',
        data: { accepted: 0, sessionId, agentId },
      }],
    };
  }

  const llmPort = deps?.[DEP_LLM_PORT] as SubsystemLLMPort | undefined;
  if (!llmPort) {
    await markCoverage(deps, {
      sessionId,
      agentId,
      fingerprint: coverageFingerprint,
      status: 'failed',
      reason: 'llm_port_missing',
      trigger: triggerKind,
    });
    return failOutput('llm_port_missing', 'backfill failed: llmPort not injected', sessionId, { agentId });
  }

  const subsystemPrompt = resolveSubsystemPrompt(deps, llmPort);
  const constitutionBlock = constitution.trim()
    ? `\n## Operating constitution (extract under these rules)\n${constitution.slice(0, 4000)}\n`
    : '';
  const systemPrompt = `${subsystemPrompt}${constitutionBlock}`.trim() || undefined;

  let rawContent = '';
  try {
    const res = await llmPort.chat({
      systemPrompt,
      messages: [{
        role: 'user',
        content: `## Session evidence (session=${sessionId})\n${sessionText}\n\nExtract long-term memory propositions. Output strict JSON array only.`,
      }],
      temperature: 0.2,
      maxTokens: 2048,
    });
    if (res.finishReason === 'error') {
      await markCoverage(deps, {
        sessionId,
        agentId,
        fingerprint: coverageFingerprint,
        status: 'failed',
        reason: 'llm_error',
        trigger: triggerKind,
      });
      return failOutput('llm_error', res.content || 'backfill failed: LLM chat error', sessionId, { agentId });
    }
    rawContent = res.content ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markCoverage(deps, {
      sessionId,
      agentId,
      fingerprint: coverageFingerprint,
      status: 'failed',
      reason: 'llm_error',
      trigger: triggerKind,
    });
    return failOutput('llm_error', `backfill failed: ${msg}`, sessionId, { agentId });
  }

  if (!rawContent.trim()) {
    await markCoverage(deps, {
      sessionId,
      agentId,
      fingerprint: coverageFingerprint,
      status: 'failed',
      reason: 'llm_empty',
      trigger: triggerKind,
    });
    return failOutput('llm_empty', 'backfill failed: empty LLM content', sessionId, { agentId });
  }

  const parsed = extractJsonArray(rawContent);
  if (!parsed) {
    await markCoverage(deps, {
      sessionId,
      agentId,
      fingerprint: coverageFingerprint,
      status: 'failed',
      reason: 'parse_failed',
      trigger: triggerKind,
    });
    return failOutput('parse_failed', 'backfill failed: response is not a JSON array', sessionId, { agentId });
  }

  const candidates = parseCandidates(parsed, maxCandidates);
  const result = await admitCandidates(
    memoryStore,
    candidates,
    `session:${sessionId};via:backfill`,
  );

  await markCoverage(deps, {
    sessionId,
    agentId,
    fingerprint: coverageFingerprint,
    status: 'success',
    reason: result.accepted.length === 0 && candidates.length === 0 ? 'empty_extract' : undefined,
    accepted: result.accepted.length,
    trigger: triggerKind,
  });

  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'memory-store',
      messages: [{
        role: 'system',
        content: `memory.steward.backfilled accepted=${result.accepted.length} rejected=${result.rejected.length}`,
      }],
    },
    signals: [{
      action: 'suggest',
      reason: `Memory backfill completed accepted=${result.accepted.length}`,
      data: {
        sessionId,
        agentId,
        accepted: result.accepted.length,
        rejected: result.rejected.map((r) => ({ reason: r.reason, existingId: r.existingId })),
        acceptedItems: result.accepted,
        usedConstitution: Boolean(constitution.trim()),
        usedSubsystemPrompt: Boolean(subsystemPrompt),
        usedSessionStore: !Boolean(String(payload.sessionText ?? payload.evidenceText ?? '').trim()),
      },
    }],
  };
}

export default {
  handler,
  contract: { input: 'SessionBackfillInput', output: 'BackfillResult' },
  dependencies: [DEP_MEMORY_STORE, DEP_SESSION_STORE, DEP_CONSTITUTION, DEP_BACKFILL_COVERAGE],
};

export { handler };
