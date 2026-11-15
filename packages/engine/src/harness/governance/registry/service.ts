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

import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;
/** M3 等耗时路径的固定盐（防时序枚举；非凭据，公开无害） */
const DUMMY_SALT = 'octopi-dummy-salt-for-constant-time-auth';
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
  /** session 挂载必填：反物化锚（消费会话所属 agent） */
  agentRef?: string;
}

export interface CreateKnowledgeSourceInput {
  scope: 'platform' | 'tenant';
  /** scope=tenant 时必填 */
  tenantId?: TenantId;
  name: string;
  /**
   * 关联的知识面行 id（knowledge.db `knowledge_sources.id`）。
   * 受管注册入口先在知识面建档、再以同一 id 登记所有权（定义面 ↔ 执法面链接）；
   * 缺省自生成（纯定义面登记，暂无知识面行）。
   */
  sourceId?: string;
}

/** 保留字：platform 域哨兵不是真实租户（arch/multi-tenancy.md §6）——不得注册为租户 id */
const RESERVED_TENANT_IDS = new Set(['platform']);

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
   * 查询知识源定义（不做可见性过滤——管理面）。
   *
   * @param sourceId - 知识面行 id（knowledge.db id）
   */
  getKnowledgeSource(sourceId: string): KnowledgeSource | null {
    const row = this.db.raw
      .prepare('SELECT * FROM knowledge_sources WHERE source_id = ?')
      .get(sourceId) as Record<string, unknown> | undefined;
    return row ? rowToSource(row) : null;
  }

  /**
   * 列知识源定义（T3b 管理面）：platform 库 + 本租户库；平台 admin 全量。
   *
   * @param input - 调用方租户 / admin
   */
  listKnowledgeSources(input: {
    viewerTenantId: TenantId;
    isPlatformAdmin: boolean;
  }): KnowledgeSource[] {
    const rows = input.isPlatformAdmin
      ? (this.db.raw
          .prepare('SELECT * FROM knowledge_sources ORDER BY created_at')
          .all() as Record<string, unknown>[])
      : (this.db.raw
          .prepare(
            `SELECT * FROM knowledge_sources
             WHERE scope = 'platform' OR tenant_id = ?
             ORDER BY created_at`,
          )
          .all(input.viewerTenantId) as Record<string, unknown>[]);
    return rows.map(rowToSource);
  }

  /**
   * 知识源写权限断言（platform 库=平台 admin；tenant 库=本租户）。返回记录供调用方使用。
   *
   * @param input - sourceId + 调用方租户/admin
   */
  assertKnowledgeSourceAccess(input: {
    sourceId: string;
    viewerTenantId: TenantId;
    isPlatformAdmin: boolean;
  }): KnowledgeSource {
    const source = this.requireSource(input.sourceId as KnowledgeSourceId);
    if (source.scope === 'platform') {
      if (!input.isPlatformAdmin) {
        throw new Error('registry_forbidden: platform sources are managed by platform admin');
      }
    } else if (source.tenantId !== input.viewerTenantId) {
      throw new Error('registry_cross_tenant: source belongs to another tenant');
    }
    return source;
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
   * 租户是否存在（渠道锚启动校验用）。
   *
   * @param tenantId - 租户 id
   */
  hasTenant(tenantId: TenantId): boolean {
    return this.db.raw.prepare('SELECT 1 FROM tenants WHERE tenant_id = ?').get(tenantId) !== undefined;
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
    // 幽灵绑定防线（评审 MIN-12）：agent 消失后 bindings 行若留存，命中者会永久走
    // 「绑定指向不可跑 agent」的弃收路径——删除时一并清掉，不留配置漂移
    this.db.raw.prepare('DELETE FROM bindings WHERE agent_id = ?').run(record.agentId);
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
    // UNIQUE(tenant_id, platform, identity) 撞约束前先出干净错误（裸 SQLite 错不可读；
    // 换目标走 updateBinding，不走删了重建）
    const existing = this.resolveBinding({ tenantId: input.tenantId, platform, identity });
    if (existing) {
      throw new Error(`registry_binding_exists: ${platform}:${identity} already bound to ${existing.agentId}`);
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
    try {
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
    } catch (err) {
      // 预检（registry_binding_exists）是 TOCTOU：并发下仍会撞 UNIQUE(tenant_id,platform,identity)——
      // 在此转成同一分类的干净错误，HTTP 面状态码不依赖 SQLite 文本（评审 MIN-7）
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        throw new Error(`registry_binding_exists: ${binding.platform}:${binding.identity} is already bound (concurrent create)`);
      }
      throw err;
    }
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
      agentRef: input.consumerType === 'session' ? requireNonEmpty(input.agentRef ?? '', 'agent ref') : (input.agentRef ?? null),
      createdAt: Date.now(),
    };
    this.db.raw
      .prepare(
        'INSERT INTO mounts (mount_id, tenant_id, consumer_type, consumer_id, source_type, source_id, agent_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        mount.mountId,
        mount.tenantId,
        mount.consumerType,
        mount.consumerId,
        mount.sourceType,
        mount.sourceId,
        mount.agentRef,
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
      if (RESERVED_TENANT_IDS.has(input.tenantId)) {
        throw new Error(`registry_reserved_tenant: "${input.tenantId}" is reserved (platform domain sentinel)`);
      }
      this.requireTenant(input.tenantId);
    }
    const source: KnowledgeSource = {
      sourceId: (input.sourceId ?? randomUUID()) as KnowledgeSourceId,
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
   * 删除知识源定义（连带删除其挂载）。platform 库仅平台 admin；tenant 库限本租户。
   *
   * @param input - sourceId + 调用方租户/admin
   * @returns 是否删除了记录
   */
  deleteKnowledgeSource(input: {
    sourceId: string;
    viewerTenantId: TenantId;
    isPlatformAdmin: boolean;
  }): boolean {
    const source = this.assertKnowledgeSourceAccess(input);
    this.db.raw.prepare('DELETE FROM mounts WHERE source_id = ?').run(source.sourceId);
    const res = this.db.raw.prepare('DELETE FROM knowledge_sources WHERE source_id = ?').run(source.sourceId);
    return Number(res.changes ?? 0) > 0;
  }

  /**
   * 列挂载（按消费方或资产过滤；租户收口——platform 库挂载可见，他租户挂载不出界）。
   *
   * @param input - 租户 + 过滤条件
   */
  listMounts(input: {
    tenantId: TenantId;
    consumerType?: MountConsumerType;
    consumerId?: string;
    sourceId?: string;
  }): Mount[] {
    const clauses: string[] = ['m.tenant_id = ?'];
    const params: string[] = [input.tenantId];
    if (input.consumerType) {
      clauses.push('m.consumer_type = ?');
      params.push(input.consumerType);
    }
    if (input.consumerId) {
      clauses.push('m.consumer_id = ?');
      params.push(input.consumerId);
    }
    if (input.sourceId) {
      clauses.push('m.source_id = ?');
      params.push(input.sourceId);
    }
    const rows = this.db.raw
      .prepare(`SELECT * FROM mounts m WHERE ${clauses.join(' AND ')} ORDER BY m.created_at`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToMount);
  }

  /**
   * 查询挂载（管理面）。
   *
   * @param mountId - 挂载 id
   */
  getMount(mountId: MountId): Mount | null {
    const row = this.db.raw
      .prepare('SELECT * FROM mounts WHERE mount_id = ?')
      .get(mountId) as Record<string, unknown> | undefined;
    return row ? rowToMount(row) : null;
  }

  /**
   * 删除挂载（租户收口：本租户挂载才可删）。
   *
   * @param input - mountId + 调用方租户
   * @returns 是否删除了记录
   */
  deleteMount(input: { mountId: MountId; tenantId: TenantId }): boolean {
    const row = this.db.raw
      .prepare('SELECT tenant_id FROM mounts WHERE mount_id = ?')
      .get(input.mountId) as { tenant_id?: string } | undefined;
    if (!row) return false;
    if (row.tenant_id !== input.tenantId) {
      throw new Error('registry_cross_tenant: mount belongs to another tenant');
    }
    const res = this.db.raw.prepare('DELETE FROM mounts WHERE mount_id = ?').run(input.mountId);
    return Number(res.changes ?? 0) > 0;
  }

  /**
   * 签发会话 token（MVP 鉴权：token 会话；企业 SSO 属 P3）。
   *
   * @param userId - 用户 id
   * @param ttlMs - 可选有效期（毫秒）；缺省不过期（兼容存量语义）
   * @returns 不透明 token（存储于 registry.db auth_tokens）
   */
  issueToken(userId: UserId, ttlMs?: number): AuthToken {
    if (!this.getUser(userId)) throw new Error(`registry_user_not_found: ${userId}`);
    const token = randomUUID() as AuthToken;
    const now = Date.now();
    this.db.raw
      .prepare('INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, now, ttlMs ? now + ttlMs : null);
    return token;
  }

  /**
   * 解析会话 token → 用户（过期 token 视为无效并顺手清除）。
   *
   * @param token - Bearer token
   */
  resolveToken(token: string): User | null {
    if (!token.trim()) return null;
    const row = this.db.raw.prepare('SELECT user_id, expires_at FROM auth_tokens WHERE token = ?').get(token) as
      | { user_id: string; expires_at: number | null }
      | undefined;
    if (!row) return null;
    if (row.expires_at != null && row.expires_at < Date.now()) {
      this.revokeToken(token); // 过期条目不留账面（防无限堆积）
      return null;
    }
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
   * 设置/更新用户密码（scrypt + 随机盐；节点内置，不引第三方依赖）。
   *
   * 异步 scrypt 走线程池，不阻塞事件循环（评审 M5）。
   *
   * @param userId - 用户 id
   * @param password - 明文密码（两遍确认等 UX 由调用方负责）
   * @throws registry_user_not_found 用户不存在
   */
  async setUserPassword(userId: UserId, password: string): Promise<void> {
    if (!this.getUser(userId)) throw new Error(`registry_user_not_found: ${userId}`);
    if (!password) throw new Error('registry_password_required');
    const salt = randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt, 32)).toString('hex');
    this.db.raw
      .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE user_id = ?')
      .run(hash, salt, userId);
  }

  /**
   * 用户是否已设密码（路由层据此决定是否强制验密）。
   *
   * @param userId - 用户 id
   */
  hasPassword(userId: UserId): boolean {
    const row = this.db.raw
      .prepare('SELECT password_hash FROM users WHERE user_id = ?')
      .get(userId) as { password_hash: string | null } | undefined;
    return Boolean(row?.password_hash);
  }

  /**
   * 密码登录校验（product-onboarding.md §6：身份 = (tenant, name) 二元组 + 密码）。
   *
   * tenant 显式给定时按二元组定位（多租户撞名消歧）；缺省按用户名唯一定位
   * （registerUser 一用户一租户的形态）。返回 null 的一切路径**等耗时**（评审 M3：
   * 未知用户/无密码用户也跑一次等价 KDF，抹平时序侧信道）；比较用 timingSafeEqual。
   * 无密码用户返回 null——免密语义只属于 loopback 名登录兼容路径。
   *
   * @param input - 用户名 + 明文密码（可选组织/租户名）
   * @returns 校验通过的用户；失败 null
   */
  async authenticate(input: { tenant?: string; name: string; password: string }): Promise<User | null> {
    const row = input.tenant
      ? (this.db.raw
          .prepare(
            `SELECT u.user_id AS user_id FROM users u JOIN tenants t ON t.tenant_id = u.tenant_id
             WHERE t.name = ? AND u.name = ?`,
          )
          .get(input.tenant, input.name) as { user_id: string } | undefined)
      : (this.db.raw.prepare('SELECT user_id FROM users WHERE name = ?').get(input.name) as
          | { user_id: string }
          | undefined);
    const cred = row
      ? (this.db.raw
          .prepare('SELECT password_hash, password_salt FROM users WHERE user_id = ?')
          .get(row.user_id) as { password_hash: string | null; password_salt: string | null } | undefined)
      : undefined;
    if (!cred?.password_hash || !cred.password_salt) {
      // 等耗时路径：对固定 dummy 盐跑同参 KDF（几十 ms），未知用户不再微秒返回
      await scryptAsync(input.password, DUMMY_SALT, 32);
      return null;
    }
    const hash = await scryptAsync(input.password, cred.password_salt, 32);
    const expected = Buffer.from(cred.password_hash, 'hex');
    if (hash.length !== expected.length || !timingSafeEqual(hash, expected)) return null;
    return this.getUser(row!.user_id as UserId);
  }

  /**
   * 在既有租户内创建用户（②③部署模式的成员面；registerUser「一用户一租户」之外的补充入口）。
   *
   * 插入 + 设密同事务（m7 对称 registerUser）：设密失败不留「无密码半用户」。
   *
   * @param input - tenantId + name + 可选 password / isPlatformAdmin
   * @returns 新建用户
   * @throws registry_tenant_not_found / registry_password 相关
   */
  async createUserInTenant(input: {
    tenantId: TenantId;
    name: string;
    password?: string;
    isPlatformAdmin?: boolean;
  }): Promise<User> {
    const name = requireNonEmpty(input.name, 'user name');
    if (!this.hasTenant(input.tenantId)) throw new Error(`registry_tenant_not_found: ${input.tenantId}`);
    const now = Date.now();
    const userId = randomUUID() as UserId;
    this.db.raw.exec('BEGIN');
    try {
      this.db.raw
        .prepare('INSERT INTO users (user_id, tenant_id, name, is_platform_admin, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, input.tenantId, name, input.isPlatformAdmin ? 1 : 0, now);
      if (input.password) await this.setUserPassword(userId, input.password);
      this.db.raw.exec('COMMIT');
    } catch (err) {
      this.db.raw.exec('ROLLBACK');
      throw err;
    }
    return {
      userId,
      tenantId: input.tenantId,
      name,
      isPlatformAdmin: Boolean(input.isPlatformAdmin),
      createdAt: now,
    };
  }

  /**
   * 按 (tenantId, name) 取用户（部署模式播种的精确查找，M10；不做全局名碰撞误配）。
   *
   * @param tenantId - 租户 id
   * @param name - 用户名
   */
  getUserInTenant(tenantId: TenantId, name: string): User | null {
    const row = this.db.raw
      .prepare('SELECT user_id FROM users WHERE tenant_id = ? AND name = ?')
      .get(tenantId, name) as { user_id: string } | undefined;
    return row ? this.getUser(row.user_id as UserId) : null;
  }

  /**
   * 幂等确保租户存在（部署模式播种用；registerUser「一用户一租户」之外的主机侧配置面）。
   *
   * @param name - 租户（组织）名
   * @param explicitId - 显式租户 id（personal/②模式用 'default' = core DEFAULT_TENANT_ID 语义，
   *   与 config agent 的 default 域同 ID 空间；缺省自生成 uuid）
   * @returns 租户（已存在则返回既有；同 id 撞异名 fail-loud）
   * @throws registry_tenant_id_conflict 显式 id 已被不同名占用
   */
  ensureTenant(name: string, explicitId?: string): Tenant {
    const tenantName = requireNonEmpty(name, 'tenant name');
    const existing = this.db.raw.prepare('SELECT tenant_id, name, created_at FROM tenants WHERE name = ?').get(tenantName) as
      | { tenant_id: string; name: string; created_at: number }
      | undefined;
    if (existing) {
      return { tenantId: existing.tenant_id as TenantId, name: existing.name, createdAt: existing.created_at };
    }
    if (explicitId) {
      const byId = this.db.raw.prepare('SELECT tenant_id, name, created_at FROM tenants WHERE tenant_id = ?').get(explicitId) as
        | { tenant_id: string; name: string; created_at: number }
        | undefined;
      if (byId) {
        if (byId.name !== tenantName) {
          throw new Error(`registry_tenant_id_conflict: id ${explicitId} 已被租户「${byId.name}」占用`);
        }
        return { tenantId: byId.tenant_id as TenantId, name: byId.name, createdAt: byId.created_at };
      }
    }
    const now = Date.now();
    const tenantId = (explicitId ?? randomUUID()) as TenantId;
    this.db.raw.prepare('INSERT INTO tenants (tenant_id, name, created_at) VALUES (?, ?, ?)').run(tenantId, tenantName, now);
    return { tenantId, name: tenantName, createdAt: now };
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
   * 查询单条绑定（管理面）。
   *
   * @param bindingId - 绑定 id
   */
  getBinding(bindingId: BindingId): Binding | null {
    const row = this.db.raw.prepare('SELECT * FROM bindings WHERE binding_id = ?').get(bindingId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToBinding(row) : null;
  }

  /**
   * 更新绑定（换目标 agent / 会话策略）。绑定是租户资产：tenantId 域内可管；
   * 换目标 agent 时重验租户内约束（与 createBinding 同闸）。
   *
   * @param input - bindingId + 租户域 + 变更补丁
   */
  updateBinding(input: {
    bindingId: BindingId;
    tenantId: TenantId;
    patch: { agentId?: AgentId; sessionPolicy?: SessionPolicy };
  }): Binding {
    const binding = this.requireBinding(input.bindingId, input.tenantId);
    const patch = input.patch;
    if (patch.sessionPolicy !== undefined && !SESSION_POLICIES.includes(patch.sessionPolicy)) {
      throw new Error(`registry_invalid_session_policy: ${patch.sessionPolicy}`);
    }
    if (patch.agentId !== undefined) {
      const agent = this.requireAgent(patch.agentId);
      if (agent.tenantId !== binding.tenantId) {
        throw new Error('registry_cross_tenant_binding: binding must stay within one tenant');
      }
    }
    const nextAgent = patch.agentId ?? binding.agentId;
    const nextPolicy = patch.sessionPolicy ?? binding.sessionPolicy;
    this.db.raw
      .prepare('UPDATE bindings SET agent_id = ?, session_policy = ? WHERE binding_id = ?')
      .run(nextAgent, nextPolicy, binding.bindingId);
    return { ...binding, agentId: nextAgent, sessionPolicy: nextPolicy };
  }

  /**
   * 删除绑定（租户域内）。行不存在或不属本租户 = false（幂等重试不炸）。
   *
   * @param input - bindingId + 租户域
   * @returns 是否删除了记录
   */
  deleteBinding(input: { bindingId: BindingId; tenantId: TenantId }): boolean {
    const binding = this.getBinding(input.bindingId);
    if (!binding || binding.tenantId !== input.tenantId) return false;
    this.db.raw.prepare('DELETE FROM bindings WHERE binding_id = ?').run(input.bindingId);
    return true;
  }

  private requireBinding(bindingId: BindingId, tenantId: TenantId): Binding {
    const binding = this.getBinding(bindingId);
    if (!binding || binding.tenantId !== tenantId) {
      throw new Error(`registry_binding_not_found: ${bindingId}`);
    }
    return binding;
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

function rowToMount(row: Record<string, unknown>): Mount {
  return {
    mountId: row.mount_id as MountId,
    tenantId: row.tenant_id as TenantId,
    consumerType: row.consumer_type as MountConsumerType,
    consumerId: row.consumer_id as string,
    sourceType: row.source_type as MountSourceType,
    sourceId: row.source_id as string,
    agentRef: (row.agent_ref as string | null) ?? null,
    createdAt: row.created_at as number,
  };
}
