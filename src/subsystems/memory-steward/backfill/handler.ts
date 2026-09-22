/**
 * memory.steward.backfill — session 原文 → 命题候选 → 门控入库
 */

import type { SubsystemInput, SubsystemOutput, InjectedDependencies } from '../../../harness/autonomous-subsystem/types.js';
import type { MemoryStore } from '../../../harness/memory/types.js';
import { DEP_LLM_PORT, type SubsystemLLMPort } from '../../../harness/autonomous-subsystem/index.js';
import { admitCandidates, type StewardCandidate } from '../shared/policy.js';

const DEP_MEMORY_STORE = 'memoryStore';
const DEP_SESSION_STORE = 'sessionStore';
const DEP_CONSTITUTION = 'constitution';
const DEP_CONFIG = '__subsystem_config__';

interface BackfillConfig {
  maxCandidatesPerSession?: number;
  maxEvidenceChars?: number;
}

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
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
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

function messagesToText(session: any): string {
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  return msgs
    .map((m: any) => {
      const role = m?.role ?? 'unknown';
      const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
      return `[${role}] ${content}`;
    })
    .join('\n')
    .trim();
}

async function handler(input: SubsystemInput, deps?: InjectedDependencies): Promise<SubsystemOutput> {
  const memoryStore = deps?.[DEP_MEMORY_STORE] as MemoryStore | undefined;
  if (!memoryStore) {
    throw new Error('memory.steward.backfill: memoryStore not injected');
  }
  const config = (deps?.[DEP_CONFIG] as BackfillConfig | undefined) ?? {};
  const maxCandidates = config.maxCandidatesPerSession ?? 8;
  const maxEvidenceChars = config.maxEvidenceChars ?? 8000;

  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const sessionId = input.sessionMetadata?.sessionId ?? String(payload.sessionId ?? 'unknown');
  const agentId = input.sessionMetadata?.agentId ?? String(payload.agentId ?? 'default');

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
    for (const sid of ids.slice(0, 20)) {
      try {
        const session =
          (typeof sessionStore.get === 'function' ? await sessionStore.get(sid) : undefined) ??
          (typeof sessionStore.load === 'function' ? await sessionStore.load(sid) : undefined);
        const text = messagesToText(session);
        if (text) chunks.push(text);
      } catch {
        // skip unreadable session
      }
    }
    sessionText = chunks.join('\n---\n').slice(0, maxEvidenceChars);
  }

  const constitution = typeof deps?.[DEP_CONSTITUTION] === 'string' ? (deps[DEP_CONSTITUTION] as string) : '';

  if (!sessionText.trim()) {
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
        data: { accepted: 0, sessionId },
      }],
    };
  }

  let candidates: StewardCandidate[] = [];
  const llmPort = deps?.[DEP_LLM_PORT] as SubsystemLLMPort | undefined;
  if (llmPort) {
    try {
      const constitutionBlock = constitution.trim()
        ? `\n## Operating constitution (extract under these rules)\n${constitution.slice(0, 4000)}\n`
        : '';
      const res = await llmPort.chat({
        messages: [{
          role: 'user',
          content: `${constitutionBlock}\n## Session evidence (session=${sessionId})\n${sessionText}\n\nExtract long-term memory propositions per the constitution. Output strict JSON array only.`,
        }],
        temperature: 0.2,
        maxTokens: 2048,
      });
      if (res.finishReason !== 'error' && res.content) {
        const parsed = extractJsonArray(res.content);
        if (parsed) candidates = parseCandidates(parsed, maxCandidates);
      }
    } catch {
      candidates = [];
    }
  }

  const result = await admitCandidates(
    memoryStore,
    candidates,
    `session:${sessionId};via:backfill`,
  );

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
        accepted: result.accepted.length,
        rejected: result.rejected.map((r) => r.reason),
        acceptedItems: result.accepted,
        usedConstitution: Boolean(constitution.trim()),
        usedSessionStore: !Boolean(String(payload.sessionText ?? payload.evidenceText ?? '').trim()),
      },
    }],
  };
}

export default {
  handler,
  contract: { input: 'SessionBackfillInput', output: 'ExtractionResult' },
  dependencies: [DEP_MEMORY_STORE, DEP_SESSION_STORE, DEP_CONSTITUTION],
};

export { handler };
