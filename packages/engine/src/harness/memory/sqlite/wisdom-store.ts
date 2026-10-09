/**
 * SqliteWisdomStore — 判断范式（maxim）SQLite 存储
 *
 * 写入只经 admit（门控在 wisdom-gates）。无旧 content 形态兼容。
 *
 * @module
 */

import type {
  AdmitWisdomInput,
  AdmitWisdomResult,
  WisdomCounterevidence,
  WisdomDerivation,
  WisdomEffect,
  WisdomEntry,
  WisdomInjectPick,
  WisdomInjectQuery,
  WisdomKind,
  WisdomOrigin,
  WisdomOutcomeEvent,
  WisdomOutcomes,
  WisdomRetireReason,
  WisdomScenario,
  WisdomStats,
  WisdomStatus,
  WisdomStore,
} from '../types.js';
import { WISDOM_STATUSES } from '../types.js';
import {
  evaluateWisdomGate,
  resolveInitialWisdomStatus,
} from '../wisdom-gates.js';
import { foldOutcomeEvents, planConfidenceUpdate } from '../wisdom-policy.js';
import { pickForInjection } from '../wisdom-formation.js';
import { AgentDatabase } from './agent-db.js';

interface WisdomRow {
  id: string;
  statement: string;
  rationale: string | null;
  scenario_json: string;
  effect_json: string;
  status: string;
  confidence: number;
  priority: number;
  derived_from_json: string;
  exceptions_json: string | null;
  counterevidence_json: string | null;
  outcomes_json: string;
  origin: string;
  kind: string;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface SqliteWisdomStoreOptions {
  /** admit 硬顶（存活面）；默认 80 */
  hardCap?: number;
}

export class SqliteWisdomStore implements WisdomStore {
  readonly name = 'sqlite-wisdom';
  private db: AgentDatabase;
  private readonly hardCapLimit: number;

  constructor(db: AgentDatabase, options?: SqliteWisdomStoreOptions) {
    this.db = db;
    this.hardCapLimit = options?.hardCap ?? 80;
  }

  async admit(
    input: AdmitWisdomInput,
    options?: { allowedMemoryIds?: ReadonlySet<string> },
  ): Promise<AdmitWisdomResult> {
    const existing = this.listMinimal();
    const gate = evaluateWisdomGate(input, {
      existing,
      allowedMemoryIds: options?.allowedMemoryIds,
      capacityAdmitStop: this.livingCount() >= this.hardCap(),
    });
    if (!gate.ok) {
      return { action: 'rejected', reason: gate.reason, message: gate.message };
    }

    const now = Date.now();
    const status = resolveInitialWisdomStatus(input);
    const id = AgentDatabase.generateId('wis');

    if (input.supersedesId) {
      const prev = this.getSync(input.supersedesId);
      if (!prev) {
        return {
          action: 'rejected',
          reason: 'supersedes_target_missing',
          message: `supersedesId=${input.supersedesId}`,
        };
      }
      this.db.raw
        .prepare(`UPDATE wisdom SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`)
        .run(id, now, prev.id);
    }

    this.db.raw
      .prepare(
        `INSERT INTO wisdom (
          id, statement, rationale, scenario_json, effect_json, status, confidence, priority,
          derived_from_json, exceptions_json, counterevidence_json, outcomes_json,
          origin, kind, superseded_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.statement.trim(),
        input.rationale?.trim() || null,
        JSON.stringify(input.scenario),
        JSON.stringify(input.effect),
        status,
        clamp01(input.confidence ?? defaultConfidence(status, input.origin ?? 'distilled')),
        input.priority ?? defaultPriority(status, input.origin ?? 'distilled'),
        JSON.stringify(input.derivedFrom),
        JSON.stringify(input.exceptions ?? []),
        JSON.stringify([]),
        JSON.stringify(emptyOutcomes()),
        input.origin ?? 'distilled',
        input.kind,
        null,
        now,
        now,
      );

    return {
      action: input.supersedesId ? 'superseded' : 'created',
      id,
    };
  }

  async get(id: string): Promise<WisdomEntry | null> {
    const row = this.db.raw.prepare(`SELECT * FROM wisdom WHERE id = ?`).get(id) as unknown as
      | WisdomRow
      | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  async selectForInjection(query: WisdomInjectQuery): Promise<WisdomInjectPick[]> {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM wisdom WHERE status IN ('trial','active','strengthened') ORDER BY priority DESC, confidence DESC`,
      )
      .all() as unknown as WisdomRow[];
    const entries = rows.map((r) => this.rowToEntry(r));
    return pickForInjection(entries, query.text ?? '', {
      coreMaxItems: query.coreMaxItems,
      scenarioMaxItems: query.scenarioMaxItems,
      includeTrial: query.includeTrial,
    });
  }

  async listForGovern(filter?: { includeRetired?: boolean }): Promise<WisdomEntry[]> {
    const includeRetired = filter?.includeRetired ?? false;
    const rows = (
      includeRetired
        ? this.db.raw.prepare(`SELECT * FROM wisdom ORDER BY updated_at DESC`).all()
        : this.db.raw
            .prepare(`SELECT * FROM wisdom WHERE status NOT IN ('retired') ORDER BY updated_at DESC`)
            .all()
    ) as unknown as WisdomRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  async update(id: string, patch: Partial<WisdomEntry>): Promise<void> {
    const current = this.getSync(id);
    if (!current) throw new Error(`wisdom_update_not_found: ${id}`);
    const merged: WisdomEntry = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
      outcomes: { ...current.outcomes, ...(patch.outcomes ?? {}) },
    };
    this.db.raw
      .prepare(
        `UPDATE wisdom SET
          statement = ?, rationale = ?, scenario_json = ?, effect_json = ?,
          status = ?, confidence = ?, priority = ?, derived_from_json = ?,
          exceptions_json = ?, counterevidence_json = ?, outcomes_json = ?,
          origin = ?, kind = ?, superseded_by = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        merged.statement,
        merged.rationale ?? null,
        JSON.stringify(merged.scenario),
        JSON.stringify(merged.effect),
        merged.status,
        clamp01(merged.confidence),
        merged.priority,
        JSON.stringify(merged.derivedFrom),
        JSON.stringify(merged.exceptions ?? []),
        JSON.stringify(merged.counterevidence ?? []),
        JSON.stringify(merged.outcomes),
        merged.origin,
        merged.kind,
        merged.supersededBy ?? null,
        merged.updatedAt,
        id,
      );
  }

  async softRetire(
    id: string,
    meta: { by: string; reason: WisdomRetireReason | string },
  ): Promise<void> {
    const current = this.getSync(id);
    if (!current) return;
    if (current.status === 'superseded') return;
    await this.update(id, {
      status: 'retired',
      exceptions: [...(current.exceptions ?? []), `retired:${meta.reason}:${meta.by}`],
    });
  }

  async recordOutcomes(events: WisdomOutcomeEvent[]): Promise<void> {
    if (events.length === 0) return;
    const byId = new Map<string, WisdomOutcomeEvent[]>();
    for (const e of events) {
      const list = byId.get(e.wisdomId) ?? [];
      list.push(e);
      byId.set(e.wisdomId, list);
    }
    for (const [id, evs] of byId) {
      const current = this.getSync(id);
      if (!current) continue;
      const folded = foldOutcomeEvents(current, evs);
      let next: WisdomEntry = { ...current, ...folded, updatedAt: Date.now() };
      const plan = planConfidenceUpdate(next);
      if (plan) {
        next = {
          ...next,
          confidence: plan.confidence,
          status: plan.status,
          outcomes: {
            ...next.outcomes,
            evalAssisted: plan.evalAssisted,
            evalContested: plan.evalContested,
          },
        };
      }
      const counter = evs.filter((e) => e.signal === 'contested' && (e.ref || e.note));
      if (counter.length) {
        const ce: WisdomCounterevidence[] = [...(next.counterevidence ?? [])];
        for (const c of counter) {
          ce.push({
            ref: c.ref ?? c.wisdomId,
            note: c.note ?? 'contested',
            at: c.at ?? Date.now(),
            weight: 1,
          });
        }
        next = { ...next, counterevidence: ce };
      }
      await this.update(id, next);
    }
  }

  async touchApplied(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const now = Date.now();
    for (const id of ids) {
      const cur = this.getSync(id);
      if (!cur) continue;
      const outcomes: WisdomOutcomes = {
        ...cur.outcomes,
        applied: cur.outcomes.applied + 1,
        lastAppliedAt: now,
      };
      this.db.raw
        .prepare(`UPDATE wisdom SET outcomes_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(outcomes), now, id);
    }
  }

  async stats(): Promise<WisdomStats> {
    const rows = this.db.raw.prepare(`SELECT * FROM wisdom`).all() as unknown as WisdomRow[];
    const byStatus = Object.fromEntries(WISDOM_STATUSES.map((s) => [s, 0])) as Record<
      WisdomStatus,
      number
    >;
    let confSum = 0;
    let prioSum = 0;
    let applied = 0;
    let contested = 0;
    for (const r of rows) {
      const st = (r.status as WisdomStatus) ?? 'active';
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      confSum += r.confidence;
      prioSum += r.priority;
      const o = safeParse<WisdomOutcomes>(r.outcomes_json, emptyOutcomes());
      applied += o.applied;
      contested += o.contested;
    }
    const n = rows.length || 1;
    return {
      total: rows.length,
      byStatus,
      avgConfidence: confSum / n,
      avgPriority: prioSum / n,
      totalApplied: applied,
      totalContested: contested,
    };
  }

  /** 存活面计数（candidate/trial/active/strengthened/contested） */
  countLive(): number {
    return this.livingCount();
  }

  private hardCap(): number {
    return this.hardCapLimit;
  }

  private livingCount(): number {
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) as c FROM wisdom WHERE status IN ('candidate','trial','active','strengthened','contested')`,
      )
      .get() as { c: number };
    return row.c;
  }

  private listMinimal(): Array<Pick<WisdomEntry, 'id' | 'statement' | 'status' | 'kind'>> {
    const rows = this.db.raw
      .prepare(`SELECT id, statement, status, kind FROM wisdom WHERE status NOT IN ('retired')`)
      .all() as unknown as Array<Pick<WisdomEntry, 'id' | 'statement' | 'status' | 'kind'>>;
    return rows;
  }

  private getSync(id: string): WisdomEntry | null {
    const row = this.db.raw.prepare(`SELECT * FROM wisdom WHERE id = ?`).get(id) as unknown as
      | WisdomRow
      | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  private rowToEntry(row: WisdomRow): WisdomEntry {
    return {
      id: row.id,
      statement: row.statement,
      rationale: row.rationale ?? undefined,
      scenario: safeParse<WisdomScenario>(row.scenario_json, { problemTypes: [] }),
      effect: safeParse<WisdomEffect>(row.effect_json, {}),
      status: (WISDOM_STATUSES.includes(row.status as WisdomStatus)
        ? row.status
        : 'active') as WisdomStatus,
      confidence: row.confidence,
      priority: row.priority,
      derivedFrom: safeParse<WisdomDerivation>(row.derived_from_json, { memoryIds: [] }),
      exceptions: safeParse<string[]>(row.exceptions_json, []),
      counterevidence: safeParse<WisdomCounterevidence[]>(row.counterevidence_json, []),
      outcomes: safeParse<WisdomOutcomes>(row.outcomes_json, emptyOutcomes()),
      origin: row.origin as WisdomOrigin,
      kind: row.kind as WisdomKind,
      supersededBy: row.superseded_by ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function emptyOutcomes(): WisdomOutcomes {
  return { applied: 0, cited: 0, assisted: 0, contested: 0, evalAssisted: 0, evalContested: 0 };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function defaultConfidence(status: WisdomStatus, origin: WisdomOrigin): number {
  if (origin === 'factory' || status === 'active') return 0.7;
  return 0.5;
}

function defaultPriority(status: WisdomStatus, origin: WisdomOrigin): number {
  if (origin === 'factory') return 80;
  if (status === 'active') return 50;
  return 30;
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
