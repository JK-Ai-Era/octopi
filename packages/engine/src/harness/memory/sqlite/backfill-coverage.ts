/**
 * SQLite 覆盖表 — `memory_backfill`（agent.db）
 */

import type { AgentDatabase } from './agent-db.js';
import type {
  BackfillCoverageRecord,
  BackfillCoverageStore,
} from '../backfill-coverage.js';

interface Row {
  session_id: string;
  agent_id: string | null;
  fingerprint: string;
  status: string;
  reason: string | null;
  accepted: number | null;
  trigger: string | null;
  attempted_at: number;
}

function rowToRecord(r: Row): BackfillCoverageRecord {
  return {
    sessionId: r.session_id,
    agentId: r.agent_id ?? undefined,
    fingerprint: r.fingerprint,
    status: r.status as BackfillCoverageRecord['status'],
    reason: r.reason ?? undefined,
    accepted: r.accepted ?? undefined,
    trigger: r.trigger ?? undefined,
    attemptedAt: r.attempted_at,
  };
}

export class SqliteBackfillCoverageStore implements BackfillCoverageStore {
  constructor(private readonly db: AgentDatabase) {}

  async get(sessionId: string): Promise<BackfillCoverageRecord | null> {
    const row = this.db.raw
      .prepare('SELECT * FROM memory_backfill WHERE session_id = ?')
      .get(sessionId) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  async put(record: BackfillCoverageRecord): Promise<void> {
    this.db.raw
      .prepare(
        `INSERT INTO memory_backfill
           (session_id, agent_id, fingerprint, status, reason, accepted, trigger, attempted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           fingerprint = excluded.fingerprint,
           status = excluded.status,
           reason = excluded.reason,
           accepted = excluded.accepted,
           trigger = excluded.trigger,
           attempted_at = excluded.attempted_at`,
      )
      .run(
        record.sessionId,
        record.agentId ?? null,
        record.fingerprint,
        record.status,
        record.reason ?? null,
        record.accepted ?? null,
        record.trigger ?? null,
        record.attemptedAt,
      );
  }

  async listGaps(limit = 50): Promise<BackfillCoverageRecord[]> {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM memory_backfill
         WHERE status IN ('failed', 'pending')
         ORDER BY attempted_at DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as Row[];
    return rows.map(rowToRecord);
  }

  async listAll(limit = 200): Promise<BackfillCoverageRecord[]> {
    const rows = this.db.raw
      .prepare('SELECT * FROM memory_backfill ORDER BY attempted_at DESC LIMIT ?')
      .all(limit) as unknown as Row[];
    return rows.map(rowToRecord);
  }
}
