/**
 * KnowledgeSourceStore — 源注册 + 可见性 + catalog 投影
 */

import { randomUUID, createHash } from 'node:crypto';
import type { KnowledgeCatalogItem } from '../context/knowledge/types.js';
import { KnowledgeDatabase } from './db.js';
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

function scaleLabel(source: KnowledgeSource): string | undefined {
  const cov = source.coverage;
  if (cov == null) return undefined;
  // 粗标，避免 coverage 数字抖动进 catalog fingerprint
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

function toCatalogItem(source: KnowledgeSource): KnowledgeCatalogItem {
  return {
    id: source.id,
    displayName: source.displayName,
    kind: source.kind,
    status: statusBucket(source.status),
    description: source.description?.trim() || source.generatedDescription?.trim() || undefined,
    scopeLevel: source.scopeRef.level,
    scaleLabel: scaleLabel(source),
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
    const source: KnowledgeSource = {
      id: asSourceId(id),
      kind: input.kind,
      location: input.location,
      scopeRef: normalizeScope(input.scopeRef),
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
      ...(patch.scopeRef !== undefined ? { scopeRef: normalizeScope(patch.scopeRef) } : {}),
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
   * 卸载源（物理删除注册行；Index 由 ingest 侧清理）
   */
  remove(id: KnowledgeSourceId | string): boolean {
    const res = this.db.raw.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);
    this.db.raw.prepare('DELETE FROM knowledge_agent_hidden WHERE source_id = ?').run(id);
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

  // ── 可见性 ──

  /**
   * 将 agent 挂到 Project（显式）
   */
  assignProject(projectKey: string, agentId: string): void {
    this.db.raw
      .prepare(
        `INSERT OR IGNORE INTO knowledge_project_agents (project_key, agent_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(projectKey, agentId, Date.now());
  }

  unassignProject(projectKey: string, agentId: string): void {
    this.db.raw
      .prepare('DELETE FROM knowledge_project_agents WHERE project_key = ? AND agent_id = ?')
      .run(projectKey, agentId);
  }

  listProjectAgents(projectKey: string): string[] {
    const rows = this.db.raw
      .prepare(
        'SELECT agent_id FROM knowledge_project_agents WHERE project_key = ? ORDER BY agent_id',
      )
      .all(projectKey) as Array<{ agent_id: string }>;
    return rows.map((r) => r.agent_id);
  }

  /**
   * 屏蔽 Global 源对某 agent 的可见
   */
  hideSource(agentId: string, sourceId: KnowledgeSourceId | string): void {
    this.db.raw
      .prepare(
        `INSERT OR IGNORE INTO knowledge_agent_hidden (agent_id, source_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(agentId, sourceId, Date.now());
  }

  unhideSource(agentId: string, sourceId: KnowledgeSourceId | string): void {
    this.db.raw
      .prepare('DELETE FROM knowledge_agent_hidden WHERE agent_id = ? AND source_id = ?')
      .run(agentId, sourceId);
  }

  listHidden(agentId: string): string[] {
    const rows = this.db.raw
      .prepare('SELECT source_id FROM knowledge_agent_hidden WHERE agent_id = ? ORDER BY source_id')
      .all(agentId) as Array<{ source_id: string }>;
    return rows.map((r) => r.source_id);
  }

  /**
   * 源是否对 (agent, session) 可见
   */
  isVisible(source: KnowledgeSource, agentId: string, sessionId?: string): boolean {
    if (source.status === 'removed' || source.status === 'disabled') return false;
    const { level, key } = source.scopeRef;
    if (level === 'global') {
      return !this.isHidden(agentId, source.id);
    }
    if (level === 'project') {
      return this.isProjectAssigned(key, agentId);
    }
    return Boolean(sessionId) && key === sessionId;
  }

  private isHidden(agentId: string, sourceId: string): boolean {
    const row = this.db.raw
      .prepare('SELECT 1 AS ok FROM knowledge_agent_hidden WHERE agent_id = ? AND source_id = ?')
      .get(agentId, sourceId) as { ok?: number } | undefined;
    return Boolean(row);
  }

  private isProjectAssigned(projectKey: string, agentId: string): boolean {
    const row = this.db.raw
      .prepare(
        'SELECT 1 AS ok FROM knowledge_project_agents WHERE project_key = ? AND agent_id = ?',
      )
      .get(projectKey, agentId) as { ok?: number } | undefined;
    return Boolean(row);
  }

  // ── Catalog ──

  /**
   * 生成 agent 可见 catalog（Tier 0）
   * 默认返回可见全集（display 截断在 KnowledgeLayer）；maxEntries 仅作安全硬顶
   */
  catalogFor(
    agentId: string,
    opts?: { sessionId?: string; maxEntries?: number },
  ): KnowledgeCatalogItem[] {
    const max = opts?.maxEntries ?? 200;
    const visible = this.list().filter((s) => this.isVisible(s, agentId, opts?.sessionId));
    const sorted = [...visible].sort((a, b) => {
      const pa = a.catalogPriority ?? 0;
      const pb = b.catalogPriority ?? 0;
      if (pa !== pb) return pb - pa;
      return a.displayName.localeCompare(b.displayName);
    });
    return sorted
      .filter((s) => !s.hiddenFromCatalog)
      .slice(0, max)
      .map((s) => toCatalogItem(s));
  }

  /**
   * catalog 粗桶指纹（防每轮重渲）
   */
  catalogFingerprint(agentId: string, opts?: { sessionId?: string }): string {
    const items = this.catalogFor(agentId, { ...opts, maxEntries: 10_000 });
    const payload = items
      .map((i) =>
        [i.id, i.displayName, i.status ?? '', i.description ?? '', i.scopeLevel ?? ''].join('|'),
      )
      .join('\n');
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  /**
   * 可见源原列表（管理面；含 hiddenFromCatalog）
   */
  listVisible(agentId: string, sessionId?: string): KnowledgeSource[] {
    return this.list().filter((s) => this.isVisible(s, agentId, sessionId));
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
