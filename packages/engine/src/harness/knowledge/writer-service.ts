/**
 * KnowledgeWriteService — 唯一写者端口（API 线程不得直接摸 SQLite）
 *
 * 生产：Writer Worker 持有 knowledge.db + ingest；API 经 RPC 调用。
 * 测试 / :memory:：LocalKnowledgeWriteService 同进程实现（同一接口）。
 */

import type { KnowledgeDatabase } from './db.js';
import { KnowledgeSourceStore } from './source-store.js';
import { KnowledgeIndexStore } from './index-store.js';
import { MembershipStore } from './membership-store.js';
import { KnowledgeIngest, type IngestProgressEvent } from './ingest.js';
import { generateKnowledgeDescription } from './describe.js';
import type { KnowledgeSource, KnowledgeSourceInput } from './types.js';
import type { KnowledgeJobControlState } from './job-control-state.js';
import type { DocumentCapabilityConfig } from '../capabilities/document/factory.js';
import type { EmbeddingProvider } from '../memory/sqlite/embedding.js';

export interface WriteIdentity {
  tenantId: string;
  gatewayId: string;
}

export interface WriteAbortStats {
  cancelledQueued: number;
  abortedRunning: number;
  runningJobs: number;
}

export interface WriteResumeStats {
  restoredCancelled: number;
  embedQueued: number;
}

export interface WriteRegisterResult extends KnowledgeSource {
  registeredBy: string;
}

export interface WriteDescribeResult {
  generatedDescription: string;
  source: string;
}

export interface WriteReprocessResult {
  queued: number;
  alreadyActive: number;
  cleanedNonFiles: number;
  resumed: boolean;
  rejected: number;
}

/** API → Writer 的变更面。读走 KnowledgeQueryService。 */
export interface KnowledgeWriteService {
  upsertPrincipal(
    identity: WriteIdentity,
    agentId: string,
    body: { displayName?: string; status?: string },
  ): Promise<void>;
  /** autoRegister=true 且缺失则写入；否则缺失抛 principal_not_registered */
  ensurePrincipal(identity: WriteIdentity, agentId: string, autoRegister: boolean): Promise<void>;
  assertOwnPrincipal(identity: WriteIdentity, agentId: string): Promise<void>;

  createProject(
    identity: WriteIdentity,
    input: { projectKey: string; displayName?: string; visibility?: string },
  ): Promise<{
    projectKey: string;
    displayName: string | null;
    registeredBy: string;
    visibility: 'public' | 'private';
  }>;
  removeProject(
    identity: WriteIdentity,
    projectKey: string,
  ): Promise<{ projectKey: string; removed: boolean }>;

  registerSource(
    identity: WriteIdentity,
    input: Record<string, unknown>,
  ): Promise<WriteRegisterResult>;
  updateSource(
    identity: WriteIdentity,
    sourceId: string,
    patch: Record<string, unknown>,
  ): Promise<KnowledgeSource | null>;
  removeSource(
    identity: WriteIdentity,
    sourceId: string,
  ): Promise<{ id: string; purgedFiles: number }>;
  describeSource(identity: WriteIdentity, sourceId: string): Promise<WriteDescribeResult | null>;

  reindexSource(sourceId: string): Promise<void>;
  /** 按路径强制重解析（中止态自动 resume） */
  reprocessFiles(sourceId: string, paths: string[]): Promise<WriteReprocessResult>;
  reprocessByFilter(
    sourceId: string,
    filter?: { status?: string; ext?: string; q?: string },
  ): Promise<WriteReprocessResult>;
  abortSource(sourceId: string): Promise<WriteAbortStats & KnowledgeJobControlState>;
  resumeSource(sourceId: string): Promise<KnowledgeJobControlState>;
  abortAllOwned(identity: WriteIdentity): Promise<WriteAbortStats>;
  resumeAllOwned(identity: WriteIdentity): Promise<WriteResumeStats>;

  assignProject(identity: WriteIdentity, agentId: string, projectKey: string): Promise<void>;
  unassignProject(identity: WriteIdentity, agentId: string, projectKey: string): Promise<void>;
  hideSource(identity: WriteIdentity, agentId: string, sourceId: string): Promise<void>;
  unhideSource(identity: WriteIdentity, agentId: string, sourceId: string): Promise<void>;
  replaceSessionVisibility(
    identity: WriteIdentity,
    agentId: string,
    sessionId: string,
    items: Array<{ targetType: string; targetId: string; op: string }>,
  ): Promise<number>;
  setSessionVisibilityItem(
    identity: WriteIdentity,
    sessionId: string,
    item: { targetType: 'project' | 'source'; targetId: string; op: 'include' | 'exclude' },
  ): Promise<void>;
  clearSessionVisibility(
    identity: WriteIdentity,
    sessionId: string,
    target?: { targetType: 'project' | 'source'; targetId: string },
  ): Promise<void>;

  isSourceOwner(sourceId: string, gatewayId: string): Promise<boolean>;
  sourceVisibleToGateway(sourceId: string, gatewayId: string): Promise<boolean>;

  startIngestRuntime(): Promise<void>;
  onProgress(cb: (evt: IngestProgressEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface LocalWriteDeps {
  db: KnowledgeDatabase;
  documentConfig?: DocumentCapabilityConfig | null;
  embeddingProvider?: EmbeddingProvider | null;
  embed?: {
    enabled?: boolean;
    embedBatch?: number;
    embedMinIntervalMs?: number;
    embedConcurrency?: number;
    embedSecretPolicy?: 'allow' | 'redact' | 'skip';
  } | null;
}

/** 进程内唯一写者（测试 / :memory:）。 */
export class LocalKnowledgeWriteService implements KnowledgeWriteService {
  readonly sources: KnowledgeSourceStore;
  readonly index: KnowledgeIndexStore;
  readonly memberships: MembershipStore;
  readonly ingest: KnowledgeIngest;
  private readonly progressCbs = new Set<(evt: IngestProgressEvent) => void>();

  constructor(private readonly deps: LocalWriteDeps) {
    this.sources = new KnowledgeSourceStore(deps.db);
    this.index = new KnowledgeIndexStore(deps.db);
    this.memberships = new MembershipStore(deps.db);
    const embed = deps.embed ?? null;
    this.ingest = new KnowledgeIngest({
      sourceStore: this.sources,
      indexStore: this.index,
      documentConfig: deps.documentConfig ?? null,
      embeddingProvider: embed?.enabled === false ? null : (deps.embeddingProvider ?? null),
      ...(embed?.embedBatch != null ? { embedBatch: embed.embedBatch } : {}),
      ...(embed?.embedMinIntervalMs != null ? { embedMinIntervalMs: embed.embedMinIntervalMs } : {}),
      ...(embed?.embedConcurrency != null ? { embedConcurrency: embed.embedConcurrency } : {}),
      ...(embed?.embedSecretPolicy != null ? { embedSecretPolicy: embed.embedSecretPolicy } : {}),
    });
    this.ingest.on('knowledge.index.progress', (evt: IngestProgressEvent) => {
      for (const cb of this.progressCbs) {
        try {
          cb(evt);
        } catch {
          /* SSE 订阅方异常不得打断 ingest */
        }
      }
    });
  }

  private get db(): KnowledgeDatabase {
    return this.deps.db;
  }

  async upsertPrincipal(
    identity: WriteIdentity,
    agentId: string,
    body: { displayName?: string; status?: string },
  ): Promise<void> {
    const now = Date.now();
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_principals
           (tenant_id, gateway_id, local_agent_id, display_name, status, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, gateway_id, local_agent_id) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, knowledge_principals.display_name),
           status = excluded.status,
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        identity.tenantId,
        identity.gatewayId,
        agentId,
        body.displayName ?? null,
        body.status ?? 'active',
        now,
        now,
        now,
      );
  }

  async ensurePrincipal(
    identity: WriteIdentity,
    agentId: string,
    autoRegister: boolean,
  ): Promise<void> {
    const row = this.db.raw
      .prepare(
        `SELECT status FROM knowledge_principals
         WHERE tenant_id = ? AND gateway_id = ? AND local_agent_id = ?`,
      )
      .get(identity.tenantId, identity.gatewayId, agentId) as { status?: string } | undefined;
    if (row) return;
    if (autoRegister) {
      await this.upsertPrincipal(identity, agentId, {});
      return;
    }
    throw Object.assign(new Error('principal not registered'), {
      code: 'principal_not_registered',
    });
  }

  async assertOwnPrincipal(identity: WriteIdentity, agentId: string): Promise<void> {
    // 不得按 gateway 预过滤后再比较——那是永不失败的空检查。
    // 同名 principal 可挂多 gateway（复合 PK）；仅当**另一 gateway 已登记**时拒绝。
    const rows = this.db.raw
      .prepare(
        `SELECT gateway_id FROM knowledge_principals
         WHERE tenant_id = ? AND local_agent_id = ?`,
      )
      .all(identity.tenantId, agentId) as Array<{ gateway_id: string }>;
    const foreign = rows.find((r) => r.gateway_id !== identity.gatewayId);
    if (foreign) {
      throw Object.assign(new Error('not principal owner'), { code: 'not_principal_owner' });
    }
  }

  async createProject(
    identity: WriteIdentity,
    input: { projectKey: string; displayName?: string; visibility?: string },
  ): Promise<{
    projectKey: string;
    displayName: string | null;
    registeredBy: string;
    visibility: 'public' | 'private';
  }> {
    const existing = this.db.raw
      .prepare(
        `SELECT registered_by FROM knowledge_projects
         WHERE tenant_id = ? AND project_key = ?`,
      )
      .get(identity.tenantId, input.projectKey) as { registered_by?: string } | undefined;
    if (existing?.registered_by && existing.registered_by !== identity.gatewayId) {
      throw Object.assign(new Error('project owned by another gateway'), {
        code: 'not_resource_owner',
      });
    }
    this.sources.createProject(input.projectKey, input.displayName, {
      tenantId: identity.tenantId,
      registeredBy: identity.gatewayId,
    });
    const visibility = input.visibility === 'public' ? 'public' : 'private';
    this.db.raw
      .prepare(
        `UPDATE knowledge_projects SET registered_by = ?, visibility = ?
         WHERE tenant_id = ? AND project_key = ?`,
      )
      .run(identity.gatewayId, visibility, identity.tenantId, input.projectKey);
    return {
      projectKey: input.projectKey,
      displayName: input.displayName ?? null,
      registeredBy: identity.gatewayId,
      visibility,
    };
  }

  async removeProject(
    identity: WriteIdentity,
    projectKey: string,
  ): Promise<{ projectKey: string; removed: boolean }> {
    const row = this.db.raw
      .prepare(
        `SELECT registered_by FROM knowledge_projects
         WHERE tenant_id = ? AND project_key = ?`,
      )
      .get(identity.tenantId, projectKey) as { registered_by?: string } | undefined;
    if (row?.registered_by && row.registered_by !== identity.gatewayId) {
      throw Object.assign(new Error('not project owner'), { code: 'not_resource_owner' });
    }
    try {
      const removed = this.sources.removeProject(projectKey, { tenantId: identity.tenantId });
      return { projectKey, removed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not empty|non-empty|仍有/i.test(msg)) {
        throw Object.assign(new Error(msg), { code: 'project_not_empty' });
      }
      throw e;
    }
  }

  async registerSource(
    identity: WriteIdentity,
    rawInput: Record<string, unknown>,
  ): Promise<WriteRegisterResult> {
    const input = { ...rawInput };
    delete input.id;
    delete input.registeredBy;
    delete input.registered_by;
    delete input.tenantId;
    delete input.tenant_id;
    const src = this.sources.register(input as unknown as KnowledgeSourceInput);
    this.db.raw
      .prepare(
        `UPDATE knowledge_sources SET registered_by = ?, visibility = ?, tenant_id = ?
         WHERE id = ?`,
      )
      .run(
        identity.gatewayId,
        typeof input.visibility === 'string' ? input.visibility : 'private',
        identity.tenantId,
        src.id,
      );
    void this.ingest.ingestSource(src.id, { full: true }).catch((e) => {
      console.warn(
        `[Knowledge] auto-ingest after register failed (${src.id}): ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    return { ...src, registeredBy: identity.gatewayId };
  }

  async updateSource(
    identity: WriteIdentity,
    sourceId: string,
    patch: Record<string, unknown>,
  ): Promise<KnowledgeSource | null> {
    const row = this.db.raw
      .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string } | undefined;
    if (row?.registered_by && row.registered_by !== identity.gatewayId) {
      throw Object.assign(new Error('not source owner'), { code: 'not_resource_owner' });
    }
    const updated = this.sources.update(sourceId, patch as never);
    if (!updated) return null;
    if (typeof patch.visibility === 'string') {
      this.db.raw
        .prepare('UPDATE knowledge_sources SET visibility = ? WHERE id = ?')
        .run(patch.visibility, sourceId);
    }
    return updated;
  }

  async removeSource(
    identity: WriteIdentity,
    sourceId: string,
  ): Promise<{ id: string; purgedFiles: number }> {
    const src = this.sources.get(sourceId);
    if (!src) {
      throw Object.assign(new Error('source not found'), { code: 'source_not_found' });
    }
    const row = this.db.raw
      .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string } | undefined;
    if (row?.registered_by && row.registered_by !== identity.gatewayId) {
      throw Object.assign(new Error('not source owner'), { code: 'not_resource_owner' });
    }
    // 先停在途 parse/embed：否则 purge 让出窗口内 upsert 会把 File/Chunk 再写回来
    this.ingest.abortJobs({ sourceId });
    const purged = await this.memberships.unclaimAllForSourceAsync(sourceId, (fileId) =>
      this.index.purgeFileAsync(fileId),
    );
    this.sources.remove(sourceId);
    return { id: sourceId, purgedFiles: purged.length };
  }

  async describeSource(
    identity: WriteIdentity,
    sourceId: string,
  ): Promise<WriteDescribeResult | null> {
    await this.assertSourceOwner(identity, sourceId);
    const src = this.sources.get(sourceId);
    if (!src) return null;
    const paths = this.db.raw
      .prepare(
        'SELECT logical_path FROM knowledge_memberships WHERE source_id = ? ORDER BY logical_path LIMIT 20',
      )
      .all(sourceId) as Array<{ logical_path: string }>;
    const sample = paths.map((p) => p.logical_path).join('\n') || src.location;
    const r = await generateKnowledgeDescription(src, sample, { enabled: true });
    this.sources.update(sourceId, { generatedDescription: r.description });
    return { generatedDescription: r.description, source: r.source };
  }

  private async assertSourceOwner(identity: WriteIdentity, sourceId: string): Promise<void> {
    const row = this.db.raw
      .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string } | undefined;
    if (!row) {
      throw Object.assign(new Error('source not found'), { code: 'source_not_found' });
    }
    if (row.registered_by && row.registered_by !== identity.gatewayId) {
      throw Object.assign(new Error('not source owner'), { code: 'not_resource_owner' });
    }
  }

  async reindexSource(sourceId: string): Promise<void> {
    void this.ingest.ingestSource(sourceId, { full: true }).catch((e) => {
      console.warn(
        `[Knowledge] reindex kick failed (${sourceId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  async reprocessFiles(sourceId: string, paths: string[]): Promise<WriteReprocessResult> {
    return this.ingest.reprocessFiles(sourceId, paths);
  }

  async reprocessByFilter(
    sourceId: string,
    filter?: { status?: string; ext?: string; q?: string },
  ): Promise<WriteReprocessResult> {
    return this.ingest.reprocessByFilter(sourceId, filter as never);
  }

  async abortSource(sourceId: string): Promise<WriteAbortStats & KnowledgeJobControlState> {
    const stats = this.ingest.abortJobs({ sourceId });
    return { ...stats, ...this.ingest.jobControlState(sourceId) };
  }

  async resumeSource(sourceId: string): Promise<KnowledgeJobControlState> {
    this.ingest.resumeJobs({ sourceId });
    return this.ingest.jobControlState(sourceId);
  }

  async abortAllOwned(identity: WriteIdentity): Promise<WriteAbortStats> {
    const owned = this.sources.list().filter((s) => this.isOwnerRow(s.id, identity.gatewayId));
    let cancelledQueued = 0;
    let abortedRunning = 0;
    let runningJobs = 0;
    for (const s of owned) {
      const st = this.ingest.abortJobs({ sourceId: s.id });
      cancelledQueued += st.cancelledQueued;
      abortedRunning += st.abortedRunning;
      runningJobs += st.runningJobs;
    }
    return { cancelledQueued, abortedRunning, runningJobs };
  }

  async resumeAllOwned(identity: WriteIdentity): Promise<WriteResumeStats> {
    const owned = this.sources.list().filter((s) => this.isOwnerRow(s.id, identity.gatewayId));
    let restoredCancelled = 0;
    let embedQueued = 0;
    for (const s of owned) {
      const st = this.ingest.resumeJobs({ sourceId: s.id });
      restoredCancelled += st.restoredCancelled;
      embedQueued += st.embedQueued;
    }
    return { restoredCancelled, embedQueued };
  }

  private isOwnerRow(sourceId: string, gatewayId: string): boolean {
    const row = this.db.raw
      .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string } | undefined;
    if (!row) return false;
    if (row.registered_by && row.registered_by !== gatewayId) return false;
    return true;
  }

  async assignProject(
    identity: WriteIdentity,
    agentId: string,
    projectKey: string,
  ): Promise<void> {
    this.sources.assignProject(projectKey, agentId, identity);
  }

  async unassignProject(
    identity: WriteIdentity,
    agentId: string,
    projectKey: string,
  ): Promise<void> {
    this.sources.unassignProject(projectKey, agentId, identity);
  }

  async hideSource(identity: WriteIdentity, agentId: string, sourceId: string): Promise<void> {
    this.sources.hideSource(agentId, sourceId, identity);
  }

  async unhideSource(identity: WriteIdentity, agentId: string, sourceId: string): Promise<void> {
    this.sources.unhideSource(agentId, sourceId, identity);
  }

  async replaceSessionVisibility(
    identity: WriteIdentity,
    _agentId: string,
    sessionId: string,
    items: Array<{ targetType: string; targetId: string; op: string }>,
  ): Promise<number> {
    const typed = items.map((raw) => {
      const targetType = raw.targetType as 'project' | 'source' | undefined;
      const targetId = typeof raw.targetId === 'string' ? raw.targetId : '';
      const op = raw.op as 'include' | 'exclude' | undefined;
      if (
        !targetId ||
        (targetType !== 'project' && targetType !== 'source') ||
        (op !== 'include' && op !== 'exclude')
      ) {
        throw Object.assign(new Error('items[] invalid'), { code: 'bad_request' });
      }
      return { targetType, targetId, op };
    });
    this.sources.replaceSessionVisibility(sessionId, typed, identity);
    return typed.length;
  }

  async setSessionVisibilityItem(
    identity: WriteIdentity,
    sessionId: string,
    item: { targetType: 'project' | 'source'; targetId: string; op: 'include' | 'exclude' },
  ): Promise<void> {
    this.sources.setSessionVisibility(sessionId, item, identity);
  }

  async clearSessionVisibility(
    identity: WriteIdentity,
    sessionId: string,
    target?: { targetType: 'project' | 'source'; targetId: string },
  ): Promise<void> {
    this.sources.clearSessionVisibility(sessionId, target, identity);
  }

  async isSourceOwner(sourceId: string, gatewayId: string): Promise<boolean> {
    return this.isOwnerRow(sourceId, gatewayId);
  }

  async sourceVisibleToGateway(sourceId: string, gatewayId: string): Promise<boolean> {
    const row = this.db.raw
      .prepare('SELECT registered_by, visibility FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string; visibility?: string } | undefined;
    if (!row) return true;
    if (row.registered_by === gatewayId) return true;
    return row.visibility === 'public';
  }

  async startIngestRuntime(): Promise<void> {
    const { sources, ingest } = this;
    ingest.onSourceSettled = (sourceId) => {
      void (async () => {
        try {
          const src = sources.get(sourceId);
          if (!src || src.description?.trim()) return;
          const paths = this.db.raw
            .prepare(
              'SELECT logical_path FROM knowledge_memberships WHERE source_id = ? ORDER BY logical_path LIMIT 20',
            )
            .all(sourceId) as Array<{ logical_path: string }>;
          const sample = paths.map((p) => p.logical_path).join('\n') || src.location;
          const r = await generateKnowledgeDescription(src, sample, { enabled: true });
          sources.update(sourceId, { generatedDescription: r.description });
        } catch {
          /* describe 失败不影响索引 */
        }
      })();
    };
    for (const s of sources.list()) {
      if (s.status === 'removed' || s.status === 'disabled') continue;
      if (s.sync.enabled !== false && s.sync.strategy === 'watch') {
        ingest.startWatch(s.id);
      }
      if (s.status === 'pending') {
        void ingest.ingestSource(s.id, { full: true }).catch((e) => {
          console.warn(
            `[Knowledge] recover pending failed (${s.id}): ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }
    }
    ingest.startReconciler();
    ingest.startPolling();
  }

  onProgress(cb: (evt: IngestProgressEvent) => void): () => void {
    this.progressCbs.add(cb);
    return () => {
      this.progressCbs.delete(cb);
    };
  }

  async dispose(): Promise<void> {
    this.progressCbs.clear();
    this.ingest.dispose();
  }
}
