/**
 * KnowledgeSourceStore — 源注册 + 可见性 + catalog 投影
 */

import { randomUUID, createHash } from 'node:crypto';
import type { KnowledgeCatalogItem } from './catalog-types.js';
import { KnowledgeDatabase } from './db.js';
import { deriveTopicsFromPaths } from './topics.js';
import { asSourceId } from './types.js';
import type {
  KnowledgeSource,
  KnowledgeSourceId,
  KnowledgeSourceInput,
  KnowledgeSourcePatch,
  KnowledgeScopeRef,
  KnowledgeSourceSync,
} from './types.js';

const DEFAULT_SYNC: KnowledgeSourceSync = { strategy: 'watch', debounceMs: 2000, enabled: true };

function statusBucket(status: string): string {
  if (status === 'ready') return 'ready';
  if (status === 'partial' || status === 'discovering') return 'indexing';
  if (status === 'error') return 'error';
  if (status === 'disabled' || status === 'removed') return 'off';
  return 'pending';
}

/** 规模粗标：`~1.2k files` / `small`（arch/knowledge-layer.md §4.1）；不输出精确 coverage */
function formatFileScale(fileCount: number): string {
  if (fileCount <= 0) return 'empty';
  if (fileCount < 30) return 'small';
  if (fileCount < 1000) return `~${fileCount} files`;
  if (fileCount < 1_000_000) {
    const k = fileCount / 1000;
    return `~${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k files`;
  }
  const m = fileCount / 1_000_000;
  return `~${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}m files`;
}

function scaleLabel(source: KnowledgeSource, fileCount?: number): string | undefined {
  if (fileCount != null && fileCount > 0) return formatFileScale(fileCount);
  const cov = source.coverage;
  if (cov == null) return undefined;
  // 尚无文件规模时用覆盖粗桶；避免 coverage 数字抖动进 catalog fingerprint
  if (cov >= 0.999) return 'ready';
  if (cov >= 0.5) return 'partial';
  return 'indexing';
}

function normalizeScope(scope: KnowledgeScopeRef): KnowledgeScopeRef {
  const key = scope.key?.trim();
  if (!key) throw new Error('scopeRef.key is required');
  if (scope.level === 'global' && key !== 'global') {
    return { level: 'global', key: 'global' };
  }
  return { level: scope.level, key };
}

function deriveDisplayName(location: string): string {
  const cleaned = location.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || location || 'source';
}

function toCatalogItem(
  source: KnowledgeSource,
  extras?: { fileCount?: number; topics?: string[] },
): KnowledgeCatalogItem {
  return {
    id: source.id,
    displayName: source.displayName,
    kind: source.kind,
    status: statusBucket(source.status),
    description: source.description?.trim() || source.generatedDescription?.trim() || undefined,
    scopeLevel: source.scopeRef.level,
    scaleLabel: scaleLabel(source, extras?.fileCount),
    location: source.location,
    topics: extras?.topics?.length ? extras.topics : undefined,
  };
}

function rowToSource(row: Record<string, unknown>): KnowledgeSource {
  const sync = JSON.parse(String(row.sync_json ?? '{}')) as KnowledgeSourceSync;
  const errors = JSON.parse(String(row.errors_json ?? '[]')) as KnowledgeSource['errors'];
  const network =
    row.network_json == null
      ? undefined
      : (JSON.parse(String(row.network_json)) as KnowledgeSource['network']);
  return {
    id: asSourceId(String(row.id)),
    kind: String(row.kind) as KnowledgeSource['kind'],
    location: String(row.location),
    scopeRef: {
      level: String(row.scope_level) as KnowledgeScopeRef['level'],
      key: String(row.scope_key),
    },
    sync: { ...DEFAULT_SYNC, ...sync },
    status: String(row.status) as KnowledgeSource['status'],
    coverage: row.coverage == null ? undefined : Number(row.coverage),
    errors: errors?.length ? errors : undefined,
    displayName: String(row.display_name),
    description: row.description == null ? undefined : String(row.description),
    generatedDescription:
      row.generated_description == null ? undefined : String(row.generated_description),
    catalogPriority: row.catalog_priority == null ? undefined : Number(row.catalog_priority),
    hiddenFromCatalog: Number(row.hidden_from_catalog) === 1,
    authRef: row.auth_ref == null ? undefined : String(row.auth_ref),
    network,
    discover:
      row.discover_json == null
        ? undefined
        : (JSON.parse(String(row.discover_json)) as KnowledgeSource['discover']),
    lastPolledAt: row.last_polled_at == null ? undefined : Number(row.last_polled_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class KnowledgeSourceStore {
  private db: KnowledgeDatabase;

  constructor(db: KnowledgeDatabase) {
    this.db = db;
  }

  /**
   * 打开 knowledge.db 上的源注册表
   */
  static async open(options?: { dbPath?: string }): Promise<KnowledgeSourceStore> {
    const db = await KnowledgeDatabase.create(options);
    return new KnowledgeSourceStore(db);
  }

  get database(): KnowledgeDatabase {
    return this.db;
  }

  /**
   * 注册知识源
   */
  register(input: KnowledgeSourceInput): KnowledgeSource {
    const now = Date.now();
    const id = input.id ?? `ks_${randomUUID().slice(0, 12)}`;
    const displayName = input.displayName?.trim() || deriveDisplayName(input.location);
    const scopeRef = normalizeScope(input.scopeRef);
    const source: KnowledgeSource = {
      id: asSourceId(id),
      kind: input.kind,
      location: input.location,
      scopeRef,
      sync: { ...DEFAULT_SYNC, ...input.sync },
      status: input.status ?? 'pending',
      displayName,
      description: input.description,
      generatedDescription: input.generatedDescription,
      catalogPriority: input.catalogPriority,
      hiddenFromCatalog: input.hiddenFromCatalog ?? false,
      authRef: input.authRef,
      network: input.network,
      discover: input.discover,
      createdAt: now,
      updatedAt: now,
    };
    if (scopeRef.level === 'project') {
      this.createProject(scopeRef.key);
    }
    this.upsertRow(source);
    return source;
  }

  /**
   * 更新源字段（不改 id / createdAt）
   */
  update(id: KnowledgeSourceId | string, patch: KnowledgeSourcePatch): KnowledgeSource | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: KnowledgeSource = {
      ...existing,
      ...(patch.location !== undefined ? { location: patch.location } : {}),
      ...(patch.sync !== undefined ? { sync: { ...existing.sync, ...patch.sync } } : {}),
      ...(patch.displayName !== undefined
        ? {
            // displayName 必填：null 表示恢复由 location 推导
            displayName:
              patch.displayName === null
                ? deriveDisplayName(patch.location ?? existing.location)
                : patch.displayName,
          }
        : {}),
      ...(patch.description !== undefined
        ? { description: patch.description === null ? undefined : patch.description }
        : {}),
      ...(patch.generatedDescription !== undefined
        ? {
            generatedDescription:
              patch.generatedDescription === null
                ? undefined
                : patch.generatedDescription,
          }
        : {}),
      ...(patch.catalogPriority !== undefined ? { catalogPriority: patch.catalogPriority } : {}),
      ...(patch.hiddenFromCatalog !== undefined
        ? { hiddenFromCatalog: patch.hiddenFromCatalog }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.coverage !== undefined ? { coverage: patch.coverage } : {}),
      ...(patch.errors !== undefined ? { errors: patch.errors } : {}),
      ...(patch.scopeRef !== undefined
        ? {
            scopeRef: (() => {
              const scope = normalizeScope(patch.scopeRef!);
              if (scope.level === 'project') this.createProject(scope.key);
              return scope;
            })(),
          }
        : {}),
      ...(patch.authRef !== undefined
        ? { authRef: patch.authRef === null ? undefined : patch.authRef }
        : {}),
      ...(patch.network !== undefined
        ? { network: patch.network === null ? undefined : patch.network }
        : {}),
      ...(patch.discover !== undefined
        ? { discover: patch.discover === null ? undefined : patch.discover }
        : {}),
      ...(patch.lastPolledAt !== undefined ? { lastPolledAt: patch.lastPolledAt } : {}),
      updatedAt: Date.now(),
    };
    this.upsertRow(next);
    return next;
  }

  /**
   * 卸载源（物理删除注册行；Index 由 ingest 侧清理；会话 overlay 一并抹掉）
   */
  remove(id: KnowledgeSourceId | string): boolean {
    const res = this.db.raw.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);
    this.db.raw.prepare('DELETE FROM knowledge_agent_hidden WHERE source_id = ?').run(id);
    this.db.raw
      .prepare(
        "DELETE FROM knowledge_session_visibility WHERE target_type = 'source' AND target_id = ?",
      )
      .run(id);
    return Number(res.changes ?? 0) > 0;
  }

  get(id: KnowledgeSourceId | string): KnowledgeSource | null {
    const row = this.db.raw
      .prepare('SELECT * FROM knowledge_sources WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToSource(row) : null;
  }

  /**
   * 列出未删除源（含 disabled）
   */
  list(): KnowledgeSource[] {
    const rows = this.db.raw
      .prepare(
        'SELECT * FROM knowledge_sources WHERE status != ? ORDER BY catalog_priority DESC, display_name',
      )
      .all('removed') as Array<Record<string, unknown>>;
    return rows.map(rowToSource);
  }

  /**
   * 管理面按归属列源（不过滤可见性；二级注册：公共库 / 项目）
   */
  listByScope(
    level: import('./types.js').KnowledgeScopeLevel,
    key?: string,
  ): KnowledgeSource[] {
    const rows = (
      key
        ? this.db.raw
            .prepare(
              `SELECT * FROM knowledge_sources
               WHERE status != 'removed' AND scope_level = ? AND scope_key = ?
               ORDER BY catalog_priority DESC, display_name`,
            )
            .all(level, key)
        : this.db.raw
            .prepare(
              `SELECT * FROM knowledge_sources
               WHERE status != 'removed' AND scope_level = ?
               ORDER BY catalog_priority DESC, display_name`,
            )
            .all(level)
    ) as Array<Record<string, unknown>>;
    return rows.map(rowToSource);
  }

  // ── 可见性 ──

  /**
   * 将 agent 挂到 Project（显式）
   */
  assignProject(projectKey: string, agentId: string, opts?: { tenantId?: string; gatewayId?: string }): void {
    this.db.raw
      .prepare(
        `INSERT OR IGNORE INTO knowledge_project_agents
           (tenant_id, gateway_id, local_agent_id, project_key, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(opts?.tenantId ?? 'default', opts?.gatewayId ?? 'default', agentId, projectKey, Date.now());
  }

  unassignProject(projectKey: string, agentId: string, opts?: { tenantId?: string; gatewayId?: string }): void {
    this.db.raw
      .prepare(
        'DELETE FROM knowledge_project_agents WHERE tenant_id = ? AND gateway_id = ? AND project_key = ? AND local_agent_id = ?',
      )
      .run(opts?.tenantId ?? 'default', opts?.gatewayId ?? 'default', projectKey, agentId);
  }

  listProjectAgents(projectKey: string, opts?: { tenantId?: string; gatewayId?: string }): string[] {
    const rows = this.db.raw
      .prepare(
        `SELECT local_agent_id AS agent_id FROM knowledge_project_agents
         WHERE tenant_id = ? AND gateway_id = ? AND project_key = ?
         ORDER BY local_agent_id`,
      )
      .all(opts?.tenantId ?? 'default', opts?.gatewayId ?? 'default', projectKey) as Array<{
      agent_id: string;
    }>;
    return rows.map((r) => r.agent_id);
  }

  /**
   * 屏蔽 Global 源对某 agent 的可见（仅 global 源有意义）
   */
  hideSource(
    agentId: string,
    sourceId: KnowledgeSourceId | string,
    opts?: { tenantId?: string; gatewayId?: string },
  ): void {
    const source = this.get(sourceId);
    if (source && source.scopeRef.level !== 'global') {
      throw new Error(
        `hide is only valid for global sources (got scope ${source.scopeRef.level})`,
      );
    }
    this.db.raw
      .prepare(
        `INSERT OR IGNORE INTO knowledge_agent_hidden
           (tenant_id, gateway_id, local_agent_id, source_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        opts?.tenantId ?? 'default',
        opts?.gatewayId ?? 'default',
        agentId,
        sourceId,
        Date.now(),
      );
  }

  unhideSource(
    agentId: string,
    sourceId: KnowledgeSourceId | string,
    opts?: { tenantId?: string; gatewayId?: string },
  ): void {
    this.db.raw
      .prepare(
        'DELETE FROM knowledge_agent_hidden WHERE tenant_id = ? AND gateway_id = ? AND local_agent_id = ? AND source_id = ?',
      )
      .run(opts?.tenantId ?? 'default', opts?.gatewayId ?? 'default', agentId, sourceId);
  }

  listHidden(agentId: string, opts?: { tenantId?: string; gatewayId?: string }): string[] {
    const rows = this.db.raw
      .prepare(
        'SELECT source_id FROM knowledge_agent_hidden WHERE tenant_id = ? AND gateway_id = ? AND local_agent_id = ? ORDER BY source_id',
      )
      .all(opts?.tenantId ?? 'default', opts?.gatewayId ?? 'default', agentId) as Array<{
      source_id: string;
    }>;
    return rows.map((r) => r.source_id);
  }

  /** 哪些 agent 对该 global 源做了隐藏 */
  listAgentsHidingSource(
    sourceId: string,
    opts?: { tenantId?: string; gatewayId?: string },
  ): string[] {
    const rows = this.db.raw
      .prepare(
        'SELECT local_agent_id FROM knowledge_agent_hidden WHERE tenant_id = ? AND gateway_id = ? AND source_id = ? ORDER BY local_agent_id',
      )
      .all(opts?.tenantId ?? 'default', opts?.gatewayId ?? 'default', sourceId) as Array<{
      local_agent_id: string;
    }>;
    return rows.map((r) => r.local_agent_id);
  }

  /**
   * 会话 overlay：单条 upsert（资产归属不变，只改本场视图）
   */
  setSessionVisibility(
    sessionId: string,
    item: import('./types.js').KnowledgeSessionVisibilityInput,
    identity?: { tenantId?: string; gatewayId?: string },
  ): void {
    if (!sessionId?.trim()) throw new Error('sessionId is required');
    if (!item.targetId?.trim()) throw new Error('targetId is required');
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_session_visibility
           (tenant_id, gateway_id, local_session_id, target_type, target_id, op, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, gateway_id, local_session_id, target_type, target_id)
           DO UPDATE SET op = excluded.op`,
      )
      .run(
        identity?.tenantId ?? 'default',
        identity?.gatewayId ?? 'default',
        sessionId,
        item.targetType,
        item.targetId,
        item.op,
        Date.now(),
      );
  }

  /**
   * 会话 overlay：全量替换（按 tenant/gateway 隔离，禁清他方行）
   */
  replaceSessionVisibility(
    sessionId: string,
    items: readonly import('./types.js').KnowledgeSessionVisibilityInput[],
    identity?: { tenantId?: string; gatewayId?: string },
  ): void {
    if (!sessionId?.trim()) throw new Error('sessionId is required');
    this.clearSessionVisibility(sessionId, undefined, identity);
    for (const item of items) this.setSessionVisibility(sessionId, item, identity);
  }

  clearSessionVisibility(
    sessionId: string,
    target?: {
      targetType: import('./types.js').KnowledgeVisibilityTargetType;
      targetId: string;
    },
    identity?: { tenantId?: string; gatewayId?: string },
  ): void {
    const tenant = identity?.tenantId ?? 'default';
    const gateway = identity?.gatewayId ?? 'default';
    if (target) {
      this.db.raw
        .prepare(
          `DELETE FROM knowledge_session_visibility
           WHERE tenant_id = ? AND gateway_id = ? AND local_session_id = ?
             AND target_type = ? AND target_id = ?`,
        )
        .run(tenant, gateway, sessionId, target.targetType, target.targetId);
      return;
    }
    this.db.raw
      .prepare(
        `DELETE FROM knowledge_session_visibility
         WHERE tenant_id = ? AND gateway_id = ? AND local_session_id = ?`,
      )
      .run(tenant, gateway, sessionId);
  }

  listSessionVisibility(
    sessionId: string,
    identity?: { tenantId?: string; gatewayId?: string },
  ): import('./types.js').KnowledgeSessionVisibilityItem[] {
    const rows = this.db.raw
      .prepare(
        `SELECT local_session_id AS session_id, target_type, target_id, op, created_at
         FROM knowledge_session_visibility
         WHERE tenant_id = ? AND gateway_id = ? AND local_session_id = ?
         ORDER BY created_at`,
      )
      .all(
        identity?.tenantId ?? 'default',
        identity?.gatewayId ?? 'default',
        sessionId,
      ) as Array<{
      session_id: string;
      target_type: string;
      target_id: string;
      op: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      targetType: r.target_type as import('./types.js').KnowledgeVisibilityTargetType,
      targetId: r.target_id,
      op: r.op as import('./types.js').KnowledgeVisibilityOp,
      createdAt: Number(r.created_at),
    }));
  }

  /** 项目登记视图（管理面：先建项目再挂源；**不**用孤儿源计数复活已删项目） */
  listProjects(opts?: { tenantId?: string; gatewayId?: string }): Array<{
    projectKey: string;
    displayName?: string;
    sourceCount: number;
    assignedAgentIds: string[];
  }> {
    const tenant = opts?.tenantId ?? 'default';
    const gateway = opts?.gatewayId ?? 'default';
    const registered = this.db.raw
      .prepare(
        `SELECT project_key, display_name FROM knowledge_projects
         WHERE tenant_id = ? ORDER BY project_key`,
      )
      .all(tenant) as Array<{ project_key: string; display_name: string | null }>;
    const counts = this.db.raw
      .prepare(
        `SELECT scope_key AS project_key, COUNT(*) AS source_count
         FROM knowledge_sources
         WHERE scope_level = 'project' AND status != 'removed' AND tenant_id = ?
         GROUP BY scope_key`,
      )
      .all(tenant) as Array<{ project_key: string; source_count: number }>;
    const countMap = new Map(counts.map((c) => [c.project_key, c.source_count]));
    // 一次拉齐 project→agents，禁止每项目一条 N+1
    const agentRows = this.db.raw
      .prepare(
        `SELECT project_key, local_agent_id FROM knowledge_project_agents
         WHERE tenant_id = ? AND gateway_id = ?
         ORDER BY project_key, local_agent_id`,
      )
      .all(tenant, gateway) as Array<{ project_key: string; local_agent_id: string }>;
    const agentsByProject = new Map<string, string[]>();
    for (const row of agentRows) {
      const list = agentsByProject.get(row.project_key) ?? [];
      list.push(row.local_agent_id);
      agentsByProject.set(row.project_key, list);
    }
    // 只列已登记项目；孤儿源（项目已删）不再“复活”项目行
    return registered.map((r) => ({
      projectKey: r.project_key,
      displayName: r.display_name ?? undefined,
      sourceCount: countMap.get(r.project_key) ?? 0,
      assignedAgentIds: agentsByProject.get(r.project_key) ?? [],
    }));
  }

  /** 登记空项目（先建项目再挂源） */
  createProject(
    projectKey: string,
    displayName?: string,
    opts?: { tenantId?: string; registeredBy?: string },
  ): void {
    const key = projectKey.trim();
    if (!key) throw new Error('projectKey is required');
    const tenant = opts?.tenantId ?? 'default';
    const now = Date.now();
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_projects
           (tenant_id, project_key, display_name, registered_by, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'private', ?, ?)
         ON CONFLICT(tenant_id, project_key) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, knowledge_projects.display_name),
           updated_at = excluded.updated_at`,
      )
      .run(tenant, key, displayName ?? null, opts?.registeredBy ?? 'default', now, now);
  }

  /**
   * 删除项目登记。非空项目拒绝（先卸载/删除项目下源），避免孤儿源与静默收养。
   */
  removeProject(projectKey: string, opts?: { tenantId?: string }): boolean {
    const tenant = opts?.tenantId ?? 'default';
    const sourceCount = (
      this.db.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_sources
           WHERE scope_level = 'project' AND scope_key = ? AND status != 'removed' AND tenant_id = ?`,
        )
        .get(projectKey, tenant) as { n: number }
    ).n;
    if (sourceCount > 0) {
      throw new Error(
        `project "${projectKey}" still has ${sourceCount} source(s); remove or reassign them first`,
      );
    }
    const res = this.db.raw
      .prepare('DELETE FROM knowledge_projects WHERE project_key = ?')
      .run(projectKey);
    this.db.raw
      .prepare('DELETE FROM knowledge_project_agents WHERE project_key = ?')
      .run(projectKey);
    this.db.raw
      .prepare(
        "DELETE FROM knowledge_session_visibility WHERE target_type = 'project' AND target_id = ?",
      )
      .run(projectKey);
    return Number(res.changes ?? 0) > 0;
  }

  /**
   * 源是否对 (agent, session) 可见（gateway 漏斗 ⊕ base ⊕ session overlay）
   */
  isVisible(
    source: KnowledgeSource,
    agentId: string,
    sessionId?: string,
    identity?: { tenantId?: string; gatewayId?: string },
  ): boolean {
    if (source.status === 'removed' || source.status === 'disabled') return false;
    if (!this.isGatewayVisible(source, identity)) return false;
    return this.applySessionOverlay(
      source,
      this.isBaseVisible(source, agentId, sessionId, identity),
      sessionId,
      identity,
    );
  }

  /** 网关漏斗：registered_by=己方 ∪ public */
  isGatewayVisible(
    source: KnowledgeSource,
    identity?: { tenantId?: string; gatewayId?: string },
  ): boolean {
    const gw = identity?.gatewayId;
    if (!gw) return true;
    const row = this.db.raw
      .prepare('SELECT registered_by, visibility, tenant_id FROM knowledge_sources WHERE id = ?')
      .get(source.id) as
      | { registered_by?: string; visibility?: string; tenant_id?: string }
      | undefined;
    if (!row) return true;
    const tenant = identity?.tenantId ?? 'default';
    if (row.tenant_id && row.tenant_id !== tenant) return false;
    if (row.registered_by && row.registered_by !== gw && row.visibility !== 'public') {
      return false;
    }
    return true;
  }

  /** Agent 级 base 可见（不含会话 overlay；排查用） */
  isBaseVisible(
    source: KnowledgeSource,
    agentId: string,
    sessionId?: string,
    identity?: { tenantId?: string; gatewayId?: string },
  ): boolean {
    if (source.status === 'removed' || source.status === 'disabled') return false;
    const { level, key } = source.scopeRef;
    if (level === 'global') {
      return !this.isHidden(agentId, source.id, identity);
    }
    if (level === 'project') {
      return this.isProjectAssigned(key, agentId, identity);
    }
    return Boolean(sessionId) && key === sessionId;
  }

  private applySessionOverlay(
    source: KnowledgeSource,
    base: boolean,
    sessionId?: string,
    identity?: { tenantId?: string; gatewayId?: string },
  ): boolean {
    if (!sessionId) return base;
    const srcOp = this.sessionOp(sessionId, 'source', source.id, identity);
    if (srcOp === 'exclude') return false;
    if (srcOp === 'include') return true;
    if (source.scopeRef.level === 'project') {
      const projOp = this.sessionOp(sessionId, 'project', source.scopeRef.key, identity);
      if (projOp === 'exclude') return false;
      if (projOp === 'include') return true;
    }
    return base;
  }

  private sessionOp(
    sessionId: string,
    targetType: import('./types.js').KnowledgeVisibilityTargetType,
    targetId: string,
    identity?: { tenantId?: string; gatewayId?: string },
  ): import('./types.js').KnowledgeVisibilityOp | null {
    const row = this.db.raw
      .prepare(
        `SELECT op FROM knowledge_session_visibility
         WHERE tenant_id = ? AND gateway_id = ? AND local_session_id = ?
           AND target_type = ? AND target_id = ?`,
      )
      .get(
        identity?.tenantId ?? 'default',
        identity?.gatewayId ?? 'default',
        sessionId,
        targetType,
        targetId,
      ) as { op?: string } | undefined;
    return (row?.op as import('./types.js').KnowledgeVisibilityOp | undefined) ?? null;
  }

  private isHidden(
    agentId: string,
    sourceId: string,
    identity?: { tenantId?: string; gatewayId?: string },
  ): boolean {
    const row = this.db.raw
      .prepare(
        'SELECT 1 AS ok FROM knowledge_agent_hidden WHERE tenant_id = ? AND gateway_id = ? AND local_agent_id = ? AND source_id = ?',
      )
      .get(
        identity?.tenantId ?? 'default',
        identity?.gatewayId ?? 'default',
        agentId,
        sourceId,
      ) as { ok?: number } | undefined;
    return Boolean(row);
  }

  private isProjectAssigned(
    projectKey: string,
    agentId: string,
    identity?: { tenantId?: string; gatewayId?: string },
  ): boolean {
    const row = this.db.raw
      .prepare(
        'SELECT 1 AS ok FROM knowledge_project_agents WHERE tenant_id = ? AND gateway_id = ? AND project_key = ? AND local_agent_id = ?',
      )
      .get(
        identity?.tenantId ?? 'default',
        identity?.gatewayId ?? 'default',
        projectKey,
        agentId,
      ) as { ok?: number } | undefined;
    return Boolean(row);
  }

  // ── Catalog ──

  /** catalog 规模/topics 派生缓存（Tier 0 每轮装配；短 TTL 足够） */
  private catalogExtrasCache: {
    at: number;
    fileCounts: Map<string, number>;
    topics: Map<string, string[]>;
  } | null = null;
  private static readonly CATALOG_EXTRAS_TTL_MS = 2_000;

  /**
   * 生成 agent 可见 catalog（Tier 0）
   * 默认返回可见全集（display 截断在 KnowledgeLayer）；maxEntries 仅作安全硬顶
   * identity 必须与 UI 挂载查询同口径（tenant/gateway），否则会误命中他方挂载行
   */
  catalogFor(
    agentId: string,
    opts?: {
      sessionId?: string;
      maxEntries?: number;
      identity?: { tenantId?: string; gatewayId?: string };
    },
  ): KnowledgeCatalogItem[] {
    const max = opts?.maxEntries ?? 200;
    const visible = this.list().filter((s) =>
      this.isVisible(s, agentId, opts?.sessionId, opts?.identity),
    );
    const sorted = [...visible].sort((a, b) => {
      const pa = a.catalogPriority ?? 0;
      const pb = b.catalogPriority ?? 0;
      if (pa !== pb) return pb - pa;
      return a.displayName.localeCompare(b.displayName);
    });
    const extras = this.catalogExtras();
    return sorted
      .filter((s) => !s.hiddenFromCatalog)
      .slice(0, max)
      .map((s) =>
        toCatalogItem(s, {
          fileCount: extras.fileCounts.get(s.id),
          topics: extras.topics.get(s.id),
        }),
      );
  }

  /** 规模 + topics（短 TTL 缓存；禁止每轮全表拉 path） */
  private catalogExtras(): {
    fileCounts: Map<string, number>;
    topics: Map<string, string[]>;
  } {
    const now = Date.now();
    if (this.catalogExtrasCache && now - this.catalogExtrasCache.at < KnowledgeSourceStore.CATALOG_EXTRAS_TTL_MS) {
      return this.catalogExtrasCache;
    }
    const fileCounts = this.fileCountsBySource();
    const topics = this.topicsBySource();
    this.catalogExtrasCache = { at: now, fileCounts, topics };
    return this.catalogExtrasCache;
  }

  /** 每源已入库文件数（catalog 规模粗标用） */
  private fileCountsBySource(): Map<string, number> {
    const rows = this.db.raw
      .prepare(
        'SELECT source_id AS id, COUNT(*) AS n FROM knowledge_memberships GROUP BY source_id',
      )
      .all() as Array<{ id: string; n: number }>;
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  /**
   * 每源路径派生 topics（catalog 搜索线索）
   *
   * 只抽样前 N 条 path（按字典序），避免大库全表扫；topics 是粗线索不是精确索引。
   */
  private topicsBySource(): Map<string, string[]> {
    const sourceIds = (
      this.db.raw
        .prepare(`SELECT id FROM knowledge_sources WHERE status != 'removed'`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    const out = new Map<string, string[]>();
    const stmt = this.db.raw.prepare(
      `SELECT logical_path AS path FROM knowledge_memberships WHERE source_id = ? ORDER BY logical_path LIMIT 128`,
    );
    for (const id of sourceIds) {
      const paths = (stmt.all(id) as Array<{ path: string }>).map((r) => r.path);
      if (paths.length > 0) out.set(id, deriveTopicsFromPaths(paths));
    }
    return out;
  }

  /**
   * catalog 粗桶指纹（防每轮重渲）
   */
  catalogFingerprint(
    agentId: string,
    opts?: { sessionId?: string; identity?: { tenantId?: string; gatewayId?: string } },
  ): string {
    const items = this.catalogFor(agentId, { ...opts, maxEntries: 10_000 });
    const payload = items
      .map((i) =>
        [
          i.id,
          i.displayName,
          i.status ?? '',
          i.description ?? '',
          i.scopeLevel ?? '',
          (i.topics ?? []).join(','),
        ].join('|'),
      )
      .join('\n');
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  /**
   * 可见源列表（effective = base ⊕ session overlay；含 hiddenFromCatalog）
   */
  listVisible(
    agentId: string,
    sessionId?: string,
    identity?: { tenantId?: string; gatewayId?: string },
  ): KnowledgeSource[] {
    return this.list().filter((s) => this.isVisible(s, agentId, sessionId, identity));
  }

  /** Agent 级 base 可见源（不含会话 overlay） */
  listBaseVisible(
    agentId: string,
    sessionId?: string,
    identity?: { tenantId?: string; gatewayId?: string },
  ): KnowledgeSource[] {
    return this.list().filter((s) => this.isBaseVisible(s, agentId, sessionId, identity));
  }

  private upsertRow(source: KnowledgeSource): void {
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_sources (
          id, kind, location, scope_level, scope_key, sync_json, status, coverage,
          errors_json, display_name, description, generated_description,
          catalog_priority, hidden_from_catalog, auth_ref, network_json, discover_json,
          last_polled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind=excluded.kind,
          location=excluded.location,
          scope_level=excluded.scope_level,
          scope_key=excluded.scope_key,
          sync_json=excluded.sync_json,
          status=excluded.status,
          coverage=excluded.coverage,
          errors_json=excluded.errors_json,
          display_name=excluded.display_name,
          description=excluded.description,
          generated_description=excluded.generated_description,
          catalog_priority=excluded.catalog_priority,
          hidden_from_catalog=excluded.hidden_from_catalog,
          auth_ref=excluded.auth_ref,
          network_json=excluded.network_json,
          discover_json=excluded.discover_json,
          last_polled_at=excluded.last_polled_at,
          updated_at=excluded.updated_at`,
      )
      .run(
        source.id,
        source.kind,
        source.location,
        source.scopeRef.level,
        source.scopeRef.key,
        JSON.stringify(source.sync),
        source.status,
        source.coverage ?? null,
        JSON.stringify(source.errors ?? []),
        source.displayName,
        source.description ?? null,
        source.generatedDescription ?? null,
        source.catalogPriority ?? null,
        source.hiddenFromCatalog ? 1 : 0,
        source.authRef ?? null,
        source.network ? JSON.stringify(source.network) : null,
        source.discover ? JSON.stringify(source.discover) : null,
        source.lastPolledAt ?? null,
        source.createdAt,
        source.updatedAt,
      );
  }
}
