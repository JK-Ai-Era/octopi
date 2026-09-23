/**
 * Memory 补录覆盖表 — 决定是否值得再花一次 LLM
 *
 * 只做结构密度预筛与指纹去重；**不做**意图判断。
 *
 * @module harness/memory/backfill-coverage
 */

import { createHash } from 'node:crypto';
import type { Message } from '../../core/types.js';
import { getTextContent } from '../../core/types.js';

export type BackfillCoverageStatus = 'pending' | 'skipped' | 'success' | 'failed';

export type BackfillTriggerKind =
  | 'hard_converge'
  | 'idle_drift'
  | 'coverage_gap'
  | 'manual';

export interface BackfillCoverageRecord {
  sessionId: string;
  agentId?: string;
  fingerprint: string;
  status: BackfillCoverageStatus;
  reason?: string;
  accepted?: number;
  trigger?: BackfillTriggerKind | string;
  attemptedAt: number;
}

export interface BackfillCoverageStore {
  get(sessionId: string): Promise<BackfillCoverageRecord | null>;
  put(record: BackfillCoverageRecord): Promise<void>;
  /** 覆盖差扫描：未成功或长期失败的记录 */
  listGaps(limit?: number): Promise<BackfillCoverageRecord[]>;
  listAll(limit?: number): Promise<BackfillCoverageRecord[]>;
}

export interface SessionDensity {
  userTurns: number;
  assistantTurns: number;
  totalChars: number;
  lastTs: number;
  fingerprint: string;
}

export interface PrefilterConfig {
  minUserTurns?: number;
  minTotalChars?: number;
}

export const DEFAULT_PREFILTER: Required<PrefilterConfig> = {
  minUserTurns: 2,
  minTotalChars: 200,
};

/** 跳过命令回显等非实质对话 */
function isNoiseMessage(m: { role?: string; metadata?: Record<string, unknown> }): boolean {
  const kind = m.metadata?.kind;
  return kind === 'command' || kind === 'command_result';
}

function messageText(m: { content?: unknown }): string {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    try {
      return getTextContent(c as never);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * 从证据文本解析 `[role] content` 行，供密度/指纹使用。
 * 硬收敛快照（sessionText）与 messages 路径共用同一度量。
 */
export function parseEvidenceLines(text: string): Array<{ role: string; content: string; timestamp?: number }> {
  const out: Array<{ role: string; content: string }> = [];
  // 允许行中出现 `[role]`（快照拼接可能带前缀噪音）；多段 role 可同在一行
  const roleRe = /\[(user|assistant|system|tool)\]\s*/g;
  let last = 0;
  let lastRole: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = roleRe.exec(text)) !== null) {
    if (lastRole) {
      out.push({ role: lastRole, content: text.slice(last, m.index).trim() });
    }
    lastRole = m[1]!;
    last = m.index + m[0].length;
  }
  if (lastRole) {
    out.push({ role: lastRole, content: text.slice(last).trim() });
  }
  if (out.length === 0 && text.trim()) {
    out.push({ role: 'user', content: text });
  }
  return out.filter((x) => x.content.length > 0);
}

/**
 * 结构密度 + 指纹（只看形态，不猜意图）
 */
export function measureSessionDensity(
  messages: Array<Pick<Message, 'role' | 'content' | 'timestamp'> & { metadata?: Record<string, unknown> }>,
): SessionDensity {
  let userTurns = 0;
  let assistantTurns = 0;
  let totalChars = 0;
  let lastTs = 0;
  const bodyParts: string[] = [];
  for (const m of messages ?? []) {
    if (isNoiseMessage(m)) continue;
    const text = messageText(m);
    if (!text.trim()) continue;
    totalChars += text.length;
    bodyParts.push(`${m.role}:${text}`);
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (ts > lastTs) lastTs = ts;
    if (m.role === 'user') userTurns++;
    if (m.role === 'assistant') assistantTurns++;
  }
  // 指纹含正文：避免同长度/同轮次但内容不同被当成 already_covered
  const fingerprint = createHash('sha1')
    .update(`${messages?.length ?? 0}:${userTurns}:${assistantTurns}:${totalChars}:${lastTs}\n${bodyParts.join('\n')}`)
    .digest('hex')
    .slice(0, 16);
  return { userTurns, assistantTurns, totalChars, lastTs, fingerprint };
}

export function passesPrefilter(
  density: SessionDensity,
  config?: PrefilterConfig,
): { pass: boolean; reason?: string } {
  const cfg = {
    minUserTurns: config?.minUserTurns ?? DEFAULT_PREFILTER.minUserTurns,
    minTotalChars: config?.minTotalChars ?? DEFAULT_PREFILTER.minTotalChars,
  };
  if (density.userTurns < cfg.minUserTurns) {
    return { pass: false, reason: 'too_few_user_turns' };
  }
  if (density.totalChars < cfg.minTotalChars) {
    return { pass: false, reason: 'too_short' };
  }
  return { pass: true };
}

export interface ShouldAttemptOptions {
  /** 同指纹 failed 重试间隔（默认 30min） */
  failedRetryMs?: number;
  /** pending 超时视为可重试（默认 5min） */
  pendingTtlMs?: number;
  now?: number;
}

/**
 * 覆盖表决策：同指纹 success 不再跑；pending 在途不重入；failed 到期可重试；指纹变化必跑。
 */
export function shouldAttempt(
  record: BackfillCoverageRecord | null | undefined,
  fingerprint: string,
  options?: ShouldAttemptOptions,
): { attempt: boolean; reason?: string } {
  const now = options?.now ?? Date.now();
  const failedRetryMs = options?.failedRetryMs ?? 30 * 60_000;
  const pendingTtlMs = options?.pendingTtlMs ?? 5 * 60_000;

  if (!record) return { attempt: true, reason: 'never_attempted' };
  if (record.fingerprint !== fingerprint) return { attempt: true, reason: 'fingerprint_changed' };
  if (record.status === 'success') return { attempt: false, reason: 'already_covered' };
  if (record.status === 'skipped') return { attempt: false, reason: 'skipped_same_fingerprint' };
  if (record.status === 'pending') {
    if (now - record.attemptedAt < pendingTtlMs) return { attempt: false, reason: 'in_flight' };
    return { attempt: true, reason: 'pending_expired' };
  }
  // failed
  if (now - record.attemptedAt < failedRetryMs) return { attempt: false, reason: 'failed_cooldown' };
  return { attempt: true, reason: 'failed_retry' };
}

/** 内存覆盖表（测试 / 无 agent.db 场景） */
export class InMemoryBackfillCoverageStore implements BackfillCoverageStore {
  private map = new Map<string, BackfillCoverageRecord>();

  async get(sessionId: string): Promise<BackfillCoverageRecord | null> {
    return this.map.get(sessionId) ?? null;
  }

  async put(record: BackfillCoverageRecord): Promise<void> {
    this.map.set(record.sessionId, { ...record });
  }

  async listGaps(limit = 50): Promise<BackfillCoverageRecord[]> {
    return this.listAll(limit).then((all) =>
      all.filter((r) => r.status === 'failed' || r.status === 'pending'),
    );
  }

  async listAll(limit = 200): Promise<BackfillCoverageRecord[]> {
    return Array.from(this.map.values())
      .sort((a, b) => b.attemptedAt - a.attemptedAt)
      .slice(0, limit);
  }
}
