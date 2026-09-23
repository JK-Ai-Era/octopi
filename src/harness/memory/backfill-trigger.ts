/**
 * BackfillTrigger — 补录脉搏协调器
 *
 * 时机：
 * - 硬收敛（session → recent / /new / idle reset）立即评估并 emit
 * - 空闲漂移（默认 20min）软收敛
 * - 覆盖差扫描（默认 6h）兜底
 *
 * 只做结构密度预筛 + 覆盖表去重；**不做**意图判断。
 * emit `memory.steward.backfill.request`，不阻塞 run 收尾。
 *
 * @module harness/memory/backfill-trigger
 */

import type { EventBus } from '../../core/primitives/event-bus.js';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../session-types.js';
import {
  measureSessionDensity,
  parseEvidenceLines,
  passesPrefilter,
  shouldAttempt,
  type BackfillCoverageStore,
  type BackfillTriggerKind,
  type PrefilterConfig,
} from './backfill-coverage.js';

export const BACKFILL_REQUEST_EVENT = 'memory.steward.backfill.request';

export interface BackfillTriggerOptions {
  events: EventBus;
  coverage: BackfillCoverageStore;
  /** 用于 idle/gap 扫描时读原文；硬收敛可直接传 SessionData */
  sessionStore?: Pick<SessionStore<SessionData>, 'load' | 'list'>;
  /** 空闲漂移阈值（默认 20min） */
  idleDelayMs?: number;
  /** idle 扫描间隔（默认 60s） */
  idleScanMs?: number;
  /** 覆盖差扫描间隔（默认 6h） */
  gapScanMs?: number;
  prefilter?: PrefilterConfig;
  failedRetryMs?: number;
  pendingTtlMs?: number;
  /** 写入 sessionText 上限（默认 8000，对齐 backfill） */
  maxEvidenceChars?: number;
  now?: () => number;
}

interface ActivityState {
  sessionId: string;
  agentId?: string;
  lastInteractionAt: number;
}

export class BackfillTrigger {
  private readonly events: EventBus;
  private readonly coverage: BackfillCoverageStore;
  private readonly sessionStore?: Pick<SessionStore<SessionData>, 'load' | 'list'>;
  private readonly idleDelayMs: number;
  private readonly idleScanMs: number;
  private readonly gapScanMs: number;
  private readonly prefilter: PrefilterConfig;
  private readonly failedRetryMs: number;
  private readonly pendingTtlMs: number;
  private readonly maxEvidenceChars: number;
  private readonly now: () => number;

  private activity = new Map<string, ActivityState>();
  private idleTimer?: ReturnType<typeof setInterval>;
  private gapTimer?: ReturnType<typeof setInterval>;
  private disposables: Array<{ dispose(): void }> = [];
  private disposed = false;

  constructor(options: BackfillTriggerOptions) {
    this.events = options.events;
    this.coverage = options.coverage;
    this.sessionStore = options.sessionStore;
    this.idleDelayMs = options.idleDelayMs ?? 20 * 60_000;
    this.idleScanMs = options.idleScanMs ?? 60_000;
    this.gapScanMs = options.gapScanMs ?? 6 * 3600_000;
    this.prefilter = options.prefilter ?? {};
    this.failedRetryMs = options.failedRetryMs ?? 30 * 60_000;
    this.pendingTtlMs = options.pendingTtlMs ?? 5 * 60_000;
    this.maxEvidenceChars = options.maxEvidenceChars ?? 8000;
    this.now = options.now ?? (() => Date.now());
  }

  /** 订阅 lifecycle + 启动 idle/gap 扫描 */
  start(): void {
    if (this.disposed) return;

    this.disposables.push(
      this.events.on('session.lifecycle.updated', (e) => {
        const data = (e.data ?? {}) as Record<string, unknown>;
        const sessionId = (e.sessionId ?? data.sessionId) as string | undefined;
        if (!sessionId) return;
        const agentId = (e.agentId ?? data.agentId) as string | undefined;
        const lifecycle = data.lifecycle as string | undefined;
        const lastInteractionAt =
          typeof data.lastInteractionAt === 'number' ? data.lastInteractionAt : this.now();

        this.noteActivity(sessionId, agentId, lastInteractionAt);

        // 硬收敛：session → recent
        if (lifecycle === 'recent') {
          void this.requestHardConverge({
            sessionId,
            agentId,
            // idle reset 场景 messages 即将被清空：优先用事件携带的快照
            sessionText: typeof data.sessionText === 'string' ? data.sessionText : undefined,
            trigger: 'hard_converge',
          });
        }
      }),
    );

    this.idleTimer = setInterval(() => {
      void this.scanIdle();
    }, this.idleScanMs);
    (this.idleTimer as { unref?: () => void }).unref?.();

    this.gapTimer = setInterval(() => {
      void this.scanGaps();
    }, this.gapScanMs);
    (this.gapTimer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.gapTimer) {
      clearInterval(this.gapTimer);
      this.gapTimer = undefined;
    }
  }

  dispose(): void {
    this.stop();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.activity.clear();
    this.disposed = true;
  }

  /** 记录活跃（每轮 handle / lifecycle active） */
  noteActivity(sessionId: string, agentId?: string, at?: number): void {
    this.activity.set(sessionId, {
      sessionId,
      agentId,
      lastInteractionAt: at ?? this.now(),
    });
  }

  /**
   * 硬收敛：立即评估并 emit（穿透意图是「这段干完了」）
   * 可传入 session 快照，避免 reset 清空 messages 后读到空库。
   */
  async requestHardConverge(input: {
    sessionId: string;
    agentId?: string;
    session?: SessionData;
    sessionText?: string;
    trigger?: BackfillTriggerKind | string;
  }): Promise<{ emitted: boolean; reason?: string }> {
    return this.evaluateAndEmit({
      sessionId: input.sessionId,
      agentId: input.agentId,
      session: input.session,
      sessionText: input.sessionText,
      trigger: input.trigger ?? 'hard_converge',
    });
  }

  /** 空闲漂移扫描 */
  async scanIdle(): Promise<number> {
    const now = this.now();
    let emitted = 0;
    for (const state of this.activity.values()) {
      if (now - state.lastInteractionAt < this.idleDelayMs) continue;
      const r = await this.evaluateAndEmit({
        sessionId: state.sessionId,
        agentId: state.agentId,
        trigger: 'idle_drift',
      });
      if (r.emitted) {
        emitted++;
        // 已发请求的会话移出 idle 集，避免重复打点
        this.activity.delete(state.sessionId);
      } else if (r.reason === 'already_covered' || r.reason === 'skipped_same_fingerprint' || r.reason === 'too_few_user_turns' || r.reason === 'too_short') {
        this.activity.delete(state.sessionId);
      }
    }
    return emitted;
  }

  /**
   * 覆盖差兜底：sessionStore 中仍 active/recent、密度够、但未成功覆盖的会话
   */
  async scanGaps(limit = 20): Promise<number> {
    if (!this.sessionStore) return 0;
    let metas: Array<{ id: string; lifecycle?: string }> = [];
    try {
      metas = (await this.sessionStore.list()) as Array<{ id: string; lifecycle?: string }>;
    } catch {
      return 0;
    }
    let emitted = 0;
    for (const meta of metas.slice(0, 100)) {
      if (emitted >= limit) break;
      const lifecycle = meta.lifecycle ?? 'active';
      if (lifecycle === 'archived') continue;
      const r = await this.evaluateAndEmit({
        sessionId: meta.id,
        trigger: 'coverage_gap',
      });
      if (r.emitted) emitted++;
    }
    return emitted;
  }

  private async evaluateAndEmit(input: {
    sessionId: string;
    agentId?: string;
    session?: SessionData;
    sessionText?: string;
    trigger: BackfillTriggerKind | string;
  }): Promise<{ emitted: boolean; reason?: string }> {
    let session = input.session;
    if (!session && this.sessionStore) {
      try {
        session = (await this.sessionStore.load(input.sessionId)) ?? undefined;
      } catch {
        session = undefined;
      }
    }

    // 快照优先：idle reset / `/new` 会在 store.messages 清空后才可见，
    // 此时必须用事件里的 sessionText，不得退回空密度。
    const snapshot = input.sessionText?.trim() ? input.sessionText : undefined;
    const sessionText = snapshot ?? (session ? this.renderSessionText(session) : undefined);

    const density = snapshot
      ? measureSessionDensity(parseEvidenceLines(snapshot) as never)
      : measureSessionDensity(session?.messages ?? []);

    const gate = passesPrefilter(density, this.prefilter);
    if (!gate.pass) {
      await this.coverage.put({
        sessionId: input.sessionId,
        agentId: input.agentId,
        fingerprint: density.fingerprint,
        status: 'skipped',
        reason: gate.reason,
        trigger: input.trigger,
        attemptedAt: this.now(),
      });
      return { emitted: false, reason: gate.reason };
    }

    const existing = await this.coverage.get(input.sessionId);
    const decision = shouldAttempt(existing, density.fingerprint, {
      failedRetryMs: this.failedRetryMs,
      pendingTtlMs: this.pendingTtlMs,
      now: this.now(),
    });
    if (!decision.attempt) {
      return { emitted: false, reason: decision.reason };
    }

    await this.coverage.put({
      sessionId: input.sessionId,
      agentId: input.agentId ?? session?.agentId,
      fingerprint: density.fingerprint,
      status: 'pending',
      reason: decision.reason,
      trigger: input.trigger,
      attemptedAt: this.now(),
    });

    this.events.emit({
      type: BACKFILL_REQUEST_EVENT,
      timestamp: this.now(),
      agentId: input.agentId ?? session?.agentId,
      sessionId: input.sessionId,
      data: {
        sessionId: input.sessionId,
        agentId: input.agentId ?? session?.agentId,
        sessionIds: [input.sessionId],
        reason: input.trigger,
        fingerprint: density.fingerprint,
        ...(sessionText ? { sessionText } : {}),
      },
    });

    return { emitted: true, reason: decision.reason };
  }

  private renderSessionText(session: SessionData): string {
    const parts: string[] = [];
    for (const m of session.messages ?? []) {
      const kind = m.metadata?.kind;
      if (kind === 'command' || kind === 'command_result') continue;
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      if (!content.trim()) continue;
      parts.push(`[${m.role}] ${content}`);
    }
    return parts.join('\n').slice(0, this.maxEvidenceChars);
  }
}
