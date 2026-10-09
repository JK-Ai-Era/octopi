/**
 * InMemoryWisdomStore — 测试/开发用内存实现
 *
 * @module harness/memory/wisdom
 */

import type {
  AdmitWisdomInput,
  AdmitWisdomResult,
  WisdomCounterevidence,
  WisdomEntry,
  WisdomInjectPick,
  WisdomInjectQuery,
  WisdomOutcomes,
  WisdomRetireReason,
  WisdomStats,
  WisdomStatus,
  WisdomStore,
  WisdomOutcomeEvent,
} from './types.js';
import { WISDOM_STATUSES } from './types.js';
import { evaluateWisdomGate, resolveInitialWisdomStatus } from './wisdom-gates.js';
import { foldOutcomeEvents, planConfidenceUpdate } from './wisdom-policy.js';
import { pickForInjection } from './wisdom-formation.js';

export class InMemoryWisdomStore implements WisdomStore {
  readonly name = 'in-memory-wisdom';
  private entries = new Map<string, WisdomEntry>();
  private seq = 0;

  async admit(
    input: AdmitWisdomInput,
    options?: { allowedMemoryIds?: ReadonlySet<string> },
  ): Promise<AdmitWisdomResult> {
    const existing = [...this.entries.values()]
      .filter((e) => e.status !== 'retired')
      .map((e) => ({ id: e.id, statement: e.statement, status: e.status, kind: e.kind }));
    const gate = evaluateWisdomGate(input, {
      existing,
      allowedMemoryIds: options?.allowedMemoryIds,
    });
    if (!gate.ok) {
      return { action: 'rejected', reason: gate.reason, message: gate.message };
    }
    const now = Date.now();
    const status = resolveInitialWisdomStatus(input);
    const id = `wis_${++this.seq}`;
    if (input.supersedesId) {
      const prev = this.entries.get(input.supersedesId);
      if (!prev) {
        return {
          action: 'rejected',
          reason: 'supersedes_target_missing',
          message: `supersedesId=${input.supersedesId}`,
        };
      }
      this.entries.set(prev.id, {
        ...prev,
        status: 'superseded',
        supersededBy: id,
        updatedAt: now,
      });
    }
    this.entries.set(id, {
      id,
      statement: input.statement.trim(),
      rationale: input.rationale,
      scenario: input.scenario,
      effect: input.effect,
      status,
      confidence: input.confidence ?? (status === 'active' ? 0.7 : 0.5),
      priority: input.priority ?? (status === 'active' ? 50 : 30),
      derivedFrom: input.derivedFrom,
      exceptions: input.exceptions,
      counterevidence: [],
      outcomes: emptyOutcomes(),
      origin: input.origin ?? 'distilled',
      kind: input.kind,
      createdAt: now,
      updatedAt: now,
    });
    return { action: input.supersedesId ? 'superseded' : 'created', id };
  }

  async get(id: string): Promise<WisdomEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async selectForInjection(query: WisdomInjectQuery): Promise<WisdomInjectPick[]> {
    const entries = [...this.entries.values()];
    return pickForInjection(entries, query.text ?? '', {
      coreMaxItems: query.coreMaxItems,
      scenarioMaxItems: query.scenarioMaxItems,
      includeTrial: query.includeTrial,
    });
  }

  async listForGovern(filter?: { includeRetired?: boolean }): Promise<WisdomEntry[]> {
    return [...this.entries.values()].filter(
      (e) => filter?.includeRetired || e.status !== 'retired',
    );
  }

  async update(id: string, patch: Partial<WisdomEntry>): Promise<void> {
    const cur = this.entries.get(id);
    if (!cur) throw new Error(`wisdom_update_not_found: ${id}`);
    this.entries.set(id, {
      ...cur,
      ...patch,
      id: cur.id,
      createdAt: cur.createdAt,
      updatedAt: Date.now(),
      outcomes: { ...cur.outcomes, ...(patch.outcomes ?? {}) },
    });
  }

  async softRetire(id: string, meta: { by: string; reason: WisdomRetireReason | string }): Promise<void> {
    const cur = this.entries.get(id);
    if (!cur || cur.status === 'superseded') return;
    await this.update(id, {
      status: 'retired',
      exceptions: [...(cur.exceptions ?? []), `retired:${meta.reason}:${meta.by}`],
    });
  }

  async recordOutcomes(events: WisdomOutcomeEvent[]): Promise<void> {
    const byId = new Map<string, WisdomOutcomeEvent[]>();
    for (const e of events) {
      const list = byId.get(e.wisdomId) ?? [];
      list.push(e);
      byId.set(e.wisdomId, list);
    }
    for (const [id, evs] of byId) {
      const cur = this.entries.get(id);
      if (!cur) continue;
      const folded = foldOutcomeEvents(cur, evs);
      let next: WisdomEntry = { ...cur, ...folded, updatedAt: Date.now() };
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
          ce.push({ ref: c.ref ?? c.wisdomId, note: c.note ?? 'contested', at: c.at ?? Date.now(), weight: 1 });
        }
        next = { ...next, counterevidence: ce };
      }
      await this.update(id, next);
    }
  }

  async touchApplied(ids: string[]): Promise<void> {
    const now = Date.now();
    for (const id of ids) {
      const cur = this.entries.get(id);
      if (!cur) continue;
      this.entries.set(id, {
        ...cur,
        outcomes: {
          ...cur.outcomes,
          applied: cur.outcomes.applied + 1,
          lastAppliedAt: now,
        },
        updatedAt: now,
      });
    }
  }

  async stats(): Promise<WisdomStats> {
    const list = [...this.entries.values()];
    const byStatus = Object.fromEntries(WISDOM_STATUSES.map((s) => [s, 0])) as Record<
      WisdomStatus,
      number
    >;
    let conf = 0;
    let prio = 0;
    let applied = 0;
    let contested = 0;
    for (const e of list) {
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
      conf += e.confidence;
      prio += e.priority;
      applied += e.outcomes.applied;
      contested += e.outcomes.contested;
    }
    const n = list.length || 1;
    return {
      total: list.length,
      byStatus,
      avgConfidence: conf / n,
      avgPriority: prio / n,
      totalApplied: applied,
      totalContested: contested,
    };
  }
}

function emptyOutcomes(): WisdomOutcomes {
  return { applied: 0, cited: 0, assisted: 0, contested: 0, evalAssisted: 0, evalContested: 0 };
}
