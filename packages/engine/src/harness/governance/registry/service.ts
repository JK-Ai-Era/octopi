/**
 * RegistryService — 租户与定义面服务（arch/multi-tenancy.md）。
 *
 * 核心原则：**租户内是「引用」，跨租户是「集成」**——租户内自由（互委派/共 session/
 * 共挂载），跨租户一律不穿透。所有权锚=tenantId；ownerUserId=管理归属；visibility
 * 决定租户内可见性。
 *
 * Q12：单机起步（gateway 进程内 + registry.db），API 按服务化契约设计——分布式时
 * 迁 C 机服务、调用面不变。
 */

import { randomUUID } from 'node:crypto';
import { RegistryDatabase } from './db.js';
import type { RegistryDatabaseOptions } from './db.js';
import type {
  AgentId,
  AuthToken,
  AgentRecord,
  AgentVisibility,
  Binding,
  BindingId,
  KnowledgeSource,
  KnowledgeSourceId,
  Mount,
  MountConsumerType,
  MountId,
  MountSourceType,
  SessionPolicy,
  Tenant,
  TenantId,
  User,
  UserId,
} from './types.js';

const VISIBILITIES: readonly AgentVisibility[] = ['private', 'tenant'];
const SESSION_POLICIES: readonly SessionPolicy[] = ['per-user', 'per-chat', 'per-message'];

export interface RegisterUserInput {
  name: string;
}

export interface CreateAgentInput {
  tenantId: TenantId;
  ownerUserId: UserId;
  name: string;
  /** 定义 JSON 文本（config/persona/skills 引用）；须为合法 JSON */
  definition?: string;
  visibility?: AgentVisibility;
  homeRef?: string;
}

export interface UpdateAgentInput {
  agentId: AgentId;
  /** 操作者：须为 owner 或平台 admin */
  viewerUserId: UserId;
  patch: {
    name?: string;
    definition?: string;
    visibility?: AgentVisibility;
    homeRef?: string | null;
  };
}

export interface CreateBindingInput {
  tenantId: TenantId;
  platform: string;
  identity: string;
  agentId: AgentId;
  sessionPolicy?: SessionPolicy;
}

export interface CreateMountInput {
  tenantId: TenantId;
  consumerType: MountConsumerType;
  consumerId: string;
  sourceType: MountSourceType;
  sourceId: string;
}

export interface CreateKnowledgeSourceInput {
  scope: 'platform' | 'tenant';
  /** scope=tenant 时必填 */
  tenantId?: TenantId;
  name: string;
}

export class RegistryService {
  private db: RegistryDatabase;

  private constructor(db: RegistryDatabase) {
    this.db = db;
  }

  /**
   * 创建 RegistryService
   *
   * @param options - 透传 RegistryDatabase 选项（dbPath/wal/busyTimeoutMs）
   */
  static async create(options?: RegistryDatabaseOptions): Promise<RegistryService> {
    return new RegistryService(await RegistryDatabase.create(options));
  }

  close(): void {
    this.db.close();
  }

  /**
   * 注册用户（一用户=一租户策略）：建 tenant + user（1:1）。
   * 首个注册用户为平台 admin（Q13）。
   *
   * @param input - name（用户名/租户名，全局唯一）
   * @returns 新建的 tenant 与 user
   */
  registerUser(input: RegisterUserInput): { tenant: Tenant; user: User } {
    const name = requireNonEmpty(input.name, 'user name');
    const now = Date.now();
    const tenantId = randomUUID() as TenantId;
    const userId = randomUUID() as UserId;
    const isFirst = this.countUsers() === 0;

    const raw = this.db.raw;
    raw.exec('BEGIN');
    try {
      raw
        .prepare('INSERT INTO tenants (tenant_id, name, created_at) VALUES (?, ?, ?)')
        .run(tenantId, name, now);
      raw
        .prepare(
          'INSERT INTO users (user_id, tenant_id, name, is_platform_admin, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(userId, tenantId, name, isFirst ? 1 : 0, now);
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }

    return {
      tenant: { tenantId, name, createdAt: now },
      user: { userId, tenantId, name, isPlatformAdmin: isFirst, createdAt: now },
    };
  }

  /**
   * 查询用户
   *
   * @param userId - 用户 id
   */
  getUser(userId: UserId): User | null {
    const row = this.db.raw
      .prepare('SELECT user_id, tenant_id, name, is_platform_admin, created_at FROM users WHERE user_id = ?')
      .get(userId) as
      | { user_id: string; tenant_id: string; name: string; is_platform_admin: number; created_at: number }
      | undefined;
    if (!row) return null;
    return {
      userId: row.user_id as UserId,
      tenantId: row.tenant_id as TenantId,
      name: row.name,
      isPlatformAdmin: row.is_platform_admin === 1,
      createdAt: row.created_at,
    };
  }

  /**
   * 按用户名查询（MVP 登录面：token 会话 + 名称直登，口令/SSO 属 P3）。
   *
   * @param name - 用户名（全局唯一）
   */
  getUserByName(name: string): User | null {
    const row = this.db.raw
      .prepare('SELECT user_id, tenant_id, name, is_platform_admin, created_at FROM users WHERE name = ?')
      .get(name) as
      | { user_id: string; tenant_id: string; name: string; is_platform_admin: number; created_at: number }
      | undefined;
    if (!row) return null;
    return {
      userId: row.user_id as UserId,
      tenantId: row.tenant_id as TenantId,
      name: row.name,
      isPlatformAdmin: row.is_platform_admin === 1,
      createdAt: row.created_at,
    };
  }

  /**
   * 创建 agent。所有权锚=tenantId；owner 须属于该租户。
   *
   * @param input - 租户/owner/名称/定义/可见性
   */
  createAgent(input: CreateAgentInput): AgentRecord {
    const name = requireNonEmpty(input.name, 'agent name');
    const visibility = input.visibility ?? 'private';
    if (!VISIBILITIES.includes(visibility)) {
      throw new Error(`registry_invalid_visibility: ${visibility}`);
    }
    if (input.definition !== undefined) {
      requireJson(input.definition);
    }
    this.requireTenant(input.tenantId);
    const owner = this.getUser(input.ownerUserId);
    if (!owner) throw new Error(`registry_user_not_found: ${input.ownerUserId}`);
    if (owner.tenantId !== input.tenantId) {
      // 跨租户不可拥有/管理 agent（§8 同一性：管理关系也不出租户）
      throw new Error('registry_cross_tenant_owner: owner must belong to the agent tenant');
    }

    const now = Date.now();
    const record: AgentRecord = {
      agentId: randomUUID() as AgentId,
      tenantId: input.tenantId,
      ownerUserId: input.ownerUserId,
      visibility,
      name,
      definition: input.definition ?? '{}',
      homeRef: input.homeRef ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.raw
      .prepare(
        'INSERT INTO agents (agent_id, tenant_id, owner_user_id, visibility, name, definition, home_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.agentId,
        record.tenantId,
        record.ownerUserId,
        record.visibility,
        record.name,
        record.definition,
        record.homeRef,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  /**
   * 列出 viewer 可见的 agent：private=仅 owner；tenant=租户共享。
   *
   * @param input - 租户与查看者
   */
  listAgents(input: { tenantId: TenantId; viewerUserId: UserId }): AgentRecord[] {
    const rows = this.db.raw
      .prepare(
        'SELECT * FROM agents WHERE tenant_id = ? AND (visibility = ? OR owner_user_id = ?) ORDER BY created_at',
      )
      .all(input.tenantId, 'tenant', input.viewerUserId) as Record<string, unknown>[];
    return rows.map(rowToAgent);
  }

  /**
   * 查询 agent（不做可见性过滤——调用方按需用 listAgents）。
   *
   * @param agentId - agent id
   */
  getAgent(agentId: AgentId): AgentRecord | null {
    const row = this.db.raw.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToAgent(row) : null;
  }

  /**
   * 列出全部 agent（宿主管理面：启动装载 / 对账；租户过滤的可见列表用 listAgents）。
   */
  listAllAgents(): AgentRecord[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM agents ORDER BY created_at')
      .all() as Record<string, unknown>[];
    return rows.map(rowToAgent);
  }

  /**
   * 更新 agent（写权限：owner 或平台 admin）。
   *
   * @param input - agentId + viewerUserId + 变更补丁
   */
  updateAgent(input: UpdateAgentInput): AgentRecord {
    const record = this.requireAgent(input.agentId);
    this.requireManageAuth(record, input.viewerUserId);
    const patch = input.patch;
    if (patch.definition !== undefined) requireJson(patch.definition);
    if (patch.visibility !== undefined && !VISIBILITIES.includes(patch.visibility)) {
      throw new Error(`registry_invalid_visibility: ${patch.visibility}`);
    }
    const updated: AgentRecord = {
      ...record,
      name: patch.name !== undefined ? requireNonEmpty(patch.name, 'agent name') : record.name,
      definition: patch.definition ?? record.definition,
      visibility: patch.visibility ?? record.visibility,
      homeRef: patch.homeRef !== undefined ? patch.homeRef : record.homeRef,
      updatedAt: Date.now(),
    };
    this.db.raw
      .prepare(
        'UPDATE agents SET name = ?, definition = ?, visibility = ?, home_ref = ?, updated_at = ? WHERE agent_id = ?',
      )
      .run(
        updated.name,
        updated.definition,
        updated.visibility,
        updated.homeRef,
        updated.updatedAt,
        updated.agentId,
      );
    return updated;
  }

  /**
   * 删除 agent（写权限：owner 或平台 admin）。
   *
   * @param input - agentId + viewerUserId
   * @returns 是否删除了记录
   */
  deleteAgent(input: { agentId: AgentId; viewerUserId: UserId }): boolean {
    const record = this.requireAgent(input.agentId);
    this.requireManageAuth(record, input.viewerUserId);
    const res = this.db.raw.prepare('DELETE FROM agents WHERE agent_id = ?').run(record.agentId);
    return res.changes > 0;
  }

  /**
   * 创建渠道绑定（路由真相源）。agent 须属于同租户（挂载/绑定不出租户）。
   *
   * @param input - 租户/平台/身份/agent/会话策略
   */
  createBinding(input: CreateBindingInput): Binding {
    const platform = requireNonEmpty(input.platform, 'platform');
    const identity = requireNonEmpty(input.identity, 'identity');
    const sessionPolicy = input.sessionPolicy ?? 'per-user';
    if (!SESSION_POLICIES.includes(sessionPolicy)) {
      throw new Error(`registry_invalid_session_policy: ${sessionPolicy}`);
    }
    const agent = this.requireAgent(input.agentId);
    if (agent.tenantId !== input.tenantId) {
      throw new Error('registry_cross_tenant_binding: binding must stay within one tenant');
    }
    const binding: Binding = {
      bindingId: randomUUID() as BindingId,
      tenantId: input.tenantId,
      platform,
      identity,
      agentId: input.agentId,
      sessionPolicy,
      createdAt: Date.now(),
    };
    this.db.raw
      .prepare(
        'INSERT INTO bindings (binding_id, tenant_id, platform, identity, agent_id, session_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        binding.bindingId,
        binding.tenantId,
        binding.platform,
        binding.identity,
        binding.agentId,
        binding.sessionPolicy,
        binding.createdAt,
      );
    return binding;
  }

  /**
   * 解析渠道绑定（§2.3 ② 绑定解析）。
   *
   * @param input - 租户/平台/身份
   */
  resolveBinding(input: { tenantId: TenantId; platform: string; identity: string }): Binding | null {
    const row = this.db.raw
      .prepare('SELECT * FROM bindings WHERE tenant_id = ? AND platform = ? AND identity = ?')
      .get(input.tenantId, input.platform, input.identity) as Record<string, unknown> | undefined;
    return row ? rowToBinding(row) : null;
  }

  /**
   * 创建挂载（租户内 consumer→source）。source 须为 platform 公共或同租户私有。
   *
   * @param input - 租户/消费方/资产
   */
  createMount(input: CreateMountInput): Mount {
    const source = this.requireSource(input.sourceId as KnowledgeSourceId);
    const sameTenant = source.scope === 'tenant' && source.tenantId === input.tenantId;
    const isPlatform = source.scope === 'platform';
    if (!sameTenant && !isPlatform) {
      // 挂载不出租户：跨租户共享唯一合法形态=platform 公共库（§6）
      throw new Error('registry_cross_tenant_mount: only platform sources may cross tenants');
    }
    const mount: Mount = {
      mountId: randomUUID() as MountId,
      tenantId: input.tenantId,
      consumerType: input.consumerType,
      consumerId: requireNonEmpty(input.consumerId, 'consumer id'),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      createdAt: Date.now(),
    };
    this.db.raw
      .prepare(
        'INSERT INTO mounts (mount_id, tenant_id, consumer_type, consumer_id, source_type, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        mount.mountId,
        mount.tenantId,
        mount.consumerType,
        mount.consumerId,
        mount.sourceType,
        mount.sourceId,
        mount.createdAt,
      );
    return mount;
  }

  /**
   * 可见知识源集合（§6 检索上下文）：挂载库 ∪ 本租户公共 ∪ platform 公共。
   *
   * @param input - 租户 + 消费方
   */
  listVisibleSources(input: {
    tenantId: TenantId;
    consumerType: MountConsumerType;
    consumerId: string;
  }): KnowledgeSource[] {
    const rows = this.db.raw
      .prepare(
        `SELECT DISTINCT ks.* FROM knowledge_sources ks
         WHERE ks.scope = 'platform'
            OR ks.tenant_id = ?
            OR ks.source_id IN (
              SELECT m.source_id FROM mounts m
              WHERE m.tenant_id = ? AND m.consumer_type = ? AND m.consumer_id = ?
            )`,
      )
      .all(input.tenantId, input.tenantId, input.consumerType, input.consumerId) as Record<
      string,
      unknown
    >[];
    return rows.map(rowToSource);
  }

  /**
   * 创建知识源（platform 公共 / tenant 私有）。
   *
   * @param input - scope/tenantId/name
   */
  createKnowledgeSource(input: CreateKnowledgeSourceInput): KnowledgeSource {
    const name = requireNonEmpty(input.name, 'source name');
    if (input.scope === 'tenant') {
      if (!input.tenantId) throw new Error('registry_source_tenant_required: tenant scope needs tenantId');
      this.requireTenant(input.tenantId);
    }
    const source: KnowledgeSource = {
      sourceId: randomUUID() as KnowledgeSourceId,
      scope: input.scope,
      tenantId: input.scope === 'tenant' ? (input.tenantId as TenantId) : null,
      name,
      createdAt: Date.now(),
    };
    this.db.raw
      .prepare('INSERT INTO knowledge_sources (source_id, scope, tenant_id, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(source.sourceId, source.scope, source.tenantId, source.name, source.createdAt);
    return source;
  }

  /**
   * 签发会话 token（MVP 鉴权：token 会话；企业 SSO 属 P3）。
   *
   * @param userId - 用户 id
   * @returns 不透明 token（存储于 registry.db auth_tokens）
   */
  issueToken(userId: UserId): AuthToken {
    if (!this.getUser(userId)) throw new Error(`registry_user_not_found: ${userId}`);
    const token = randomUUID() as AuthToken;
    this.db.raw
      .prepare('INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)')
      .run(token, userId, Date.now());
    return token;
  }

  /**
   * 解析会话 token → 用户。
   *
   * @param token - Bearer token
   */
  resolveToken(token: string): User | null {
    if (!token.trim()) return null;
    const row = this.db.raw.prepare('SELECT user_id FROM auth_tokens WHERE token = ?').get(token) as
      | { user_id: string }
      | undefined;
    if (!row) return null;
    return this.getUser(row.user_id as UserId);
  }

  /**
   * 撤销会话 token。
   *
   * @param token - Bearer token
   * @returns 是否撤销了记录
   */
  revokeToken(token: string): boolean {
    return this.db.raw.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token).changes > 0;
  }

  /**
   * 列出租户内绑定（渠道路由真相源）。
   *
   * @param input - 租户
   */
  listBindings(input: { tenantId: TenantId }): Binding[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM bindings WHERE tenant_id = ? ORDER BY created_at')
      .all(input.tenantId) as Record<string, unknown>[];
    return rows.map(rowToBinding);
  }

  /**
   * 同租户断言（§8 委派/参与边界的执行点）：一组 agent 必须同属一个租户。
   *
   * @param agentIds - 参与 agent 列表
   * @returns 共同租户 id
   */
  assertSameTenant(agentIds: readonly AgentId[]): TenantId {
    if (agentIds.length === 0) throw new Error('registry_empty_agent_set: need at least one agent');
    const first = this.requireAgent(agentIds[0]);
    for (const id of agentIds.slice(1)) {
      const agent = this.requireAgent(id);
      if (agent.tenantId !== first.tenantId) {
        throw new Error('registry_cross_tenant_participation: agents must belong to one tenant');
      }
    }
    return first.tenantId;
  }

  private countUsers(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return row.n;
  }

  private requireTenant(tenantId: TenantId): Tenant {
    const row = this.db.raw.prepare('SELECT * FROM tenants WHERE tenant_id = ?').get(tenantId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`registry_tenant_not_found: ${tenantId}`);
    return { tenantId: row.tenant_id as TenantId, name: row.name as string, createdAt: row.created_at as number };
  }

  private requireAgent(agentId: AgentId): AgentRecord {
    const record = this.getAgent(agentId);
    if (!record) throw new Error(`registry_agent_not_found: ${agentId}`);
    return record;
  }

  private requireSource(sourceId: KnowledgeSourceId): KnowledgeSource {
    const row = this.db.raw.prepare('SELECT * FROM knowledge_sources WHERE source_id = ?').get(sourceId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`registry_source_not_found: ${sourceId}`);
    return rowToSource(row);
  }

  private requireManageAuth(record: AgentRecord, viewerUserId: UserId): void {
    const viewer = this.getUser(viewerUserId);
    if (!viewer) throw new Error(`registry_user_not_found: ${viewerUserId}`);
    if (viewer.isPlatformAdmin) return;
    if (viewer.userId !== record.ownerUserId || viewer.tenantId !== record.tenantId) {
      throw new Error('registry_forbidden: only the owner or a platform admin may manage this agent');
    }
  }
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`registry_invalid_${label.replace(/ /g, '_')}: must be non-empty`);
  return trimmed;
}

function requireJson(value: string): void {
  try {
    JSON.parse(value);
  } catch {
    throw new Error('registry_invalid_definition: must be valid JSON text');
  }
}

function rowToAgent(row: Record<string, unknown>): AgentRecord {
  return {
    agentId: row.agent_id as AgentId,
    tenantId: row.tenant_id as TenantId,
    ownerUserId: row.owner_user_id as UserId,
    visibility: row.visibility as AgentVisibility,
    name: row.name as string,
    definition: row.definition as string,
    homeRef: (row.home_ref as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToBinding(row: Record<string, unknown>): Binding {
  return {
    bindingId: row.binding_id as BindingId,
    tenantId: row.tenant_id as TenantId,
    platform: row.platform as string,
    identity: row.identity as string,
    agentId: row.agent_id as AgentId,
    sessionPolicy: row.session_policy as SessionPolicy,
    createdAt: row.created_at as number,
  };
}

function rowToSource(row: Record<string, unknown>): KnowledgeSource {
  return {
    sourceId: row.source_id as KnowledgeSourceId,
    scope: row.scope as KnowledgeSource['scope'],
    tenantId: (row.tenant_id as TenantId | null) ?? null,
    name: row.name as string,
    createdAt: row.created_at as number,
  };
}
