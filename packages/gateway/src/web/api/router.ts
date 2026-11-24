/**
 * Web API Router for Gateway HTTP Channel
 *
 * 第一版 REST 骨架，用于 Web Runtime。
 * 优先覆盖：health、agents、sessions、messages、abort、providers、approvals、memory。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Gateway } from '../../gateway/gateway.js';
import type { ConfigApplyService } from '../../gateway/config-apply.js';
import { ConfigConflictError } from '@octopi-agent/engine/config-admin/port.js';
import { assertSafeConfigName } from '@octopi-agent/engine/config-admin/name-guard.js';
import { listProviderPresets } from '@octopi-agent/engine/config-admin/model-presets.js';
import type { AgentId, BindingId, SessionPolicy, User } from '@octopi-agent/engine/harness/governance/registry/types.js';
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';
import { OnboardingService, OnboardingStepInvalidError } from './onboarding.js';

export interface WebApiRouterOptions {
  gateway: Gateway;
  basePath?: string;
  /** JSON 请求体大小上限（字节），默认 1MB。文件上传应使用独立端点。 */
  maxBodyBytes?: number;
  /** 配置热应用服务（arch/config-hot-reload.md）；未注入时 /config/* 返回 503 */
  configApply?: ConfigApplyService;
  /**
   * 认证身份署名（apiKey 闸验明的持钥方）：审批 confirmedBy 用它，
   * 不信客户端自报。未配置 = 无认证部署，退回 body 自报（可仿冒）。
   */
  approverIdentity?: string;
  /** Web 向导服务端（§7 setup token）；未注入时 /onboarding/* 返回 503 */
  onboarding?: OnboardingService;
  /** 浏览器引擎安装任务面（arch/browser-capability.md §3.9）；缺省自建进程内注册表 */
  browserInstalls?: BrowserInstallJobs;
}

import { BrowserInstallJobs } from './browser-install.js';

/**
 * 自鉴权面的分派谓词（路径段匹配）：`/onboarding` 命中自身与子路径，
 * 不命中 `/onboardingX`。与 adapter 侧 `isSameOrSubPath` 同一语义。
 *
 * @param relativePath - basePath 之后的路径
 * @returns 是否属于 Web 向导面
 */
function matchesSelfAuthPath(relativePath: string): boolean {
  return WebApiRouter.SELF_AUTH_PATHS.some((p) => relativePath === p || relativePath.startsWith(`${p}/`));
}

/**
 * 向导面的 Origin 校验：带 Origin 的请求必须是**本机来源**。
 *
 * 目的：堵「本机任意网页借 127.0.0.1 驱动向导写配置」。setup token 已是主闸，
 * 这是第二道：只认 `localhost` / 回环地址上的页面，外部站点一律拒。
 *
 * 注意不能用「socket 来自回环」作为放行理由——公网页面发到 127.0.0.1 时 socket
 * 同样是回环，那正是要挡的场景。
 *
 * 无 Origin（命令行/脚本工具）不受此闸约束（主闸 token 已验）。
 *
 * @param origin - `Origin` 头值（已确认非空）
 * @returns 是否允许
 */
function isLocalOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // 非法 Origin：拒（fail-closed）
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

/**
 * 配置名合法化（provider 名 / agent id 通用）：实现见 engine config-admin/name-guard.ts
 * （单一实现点：拒路径穿越 `.`/`..`、原型污染键）
 */

/**
 * 解析 create agent 请求的类型模板 persona 补充件
 *
 * @param value - 请求体 `personaFiles`
 * @returns 补充件数组；未提供返回 undefined（不触碰脚手架四件套）
 * @throws 形态非法时抛错（fail-loud，不静默丢弃）
 */
function parseRolePersonaFiles(
  value: unknown,
): Array<{ file: string; content: string }> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('personaFiles must be an array');
  return value.map((item) => {
    const o = item as Record<string, unknown>;
    if (typeof o?.file !== 'string' || typeof o?.content !== 'string') {
      throw new Error('invalid personaFiles entry: {file, content} string fields required');
    }
    return { file: o.file, content: o.content };
  });
}

/**
 * 解析 create agent 请求的类型模板技能套装
 *
 * @param value - 请求体 `skills`
 * @returns 技能数组；未提供返回 undefined
 * @throws 形态非法时抛错（fail-loud，不静默丢弃）
 */
function parseRoleSkills(
  value: unknown,
): Array<{ id: string; name: string; description: string; content: string; tools?: string[] }> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('skills must be an array');
  return value.map((item) => {
    const o = item as Record<string, unknown>;
    if (
      typeof o?.id !== 'string' ||
      typeof o?.name !== 'string' ||
      typeof o?.description !== 'string' ||
      typeof o?.content !== 'string'
    ) {
      throw new Error('invalid skills entry: {id, name, description, content} string fields required');
    }
    let tools: string[] | undefined;
    if (Array.isArray(o.tools)) {
      if ((o.tools as unknown[]).some((t) => typeof t !== 'string')) {
        throw new Error('invalid skills entry: tools must be an array of strings');
      }
      tools = o.tools as string[];
    }
    return { id: o.id, name: o.name, description: o.description, content: o.content, tools };
  });
}

export class WebApiRouter {
  /**
   * 自鉴权面（相对 basePath）：Web 向导 §7 的 setup-token 闸自己把凭证关，
   * 上游 adapter 的 Bearer 闸必须让路——否则 401 发生在闸之前，向导面在
   * 默认全新部署（init 生成随机 apiKey）上永远不可达。
   *
   * 单源：daemon 用它填 `HttpAdapterOptions.apiKeyExemptPaths`，避免硬编码路径漂移。
   */
  static readonly SELF_AUTH_PATHS = ['/onboarding'] as const;

  private gateway: Gateway;
  private basePath: string;
  private maxBodyBytes: number;
  private configApply?: ConfigApplyService;
  private approverIdentity?: string;
  private onboarding?: OnboardingService;
  private browserInstalls: BrowserInstallJobs;

  constructor(options: WebApiRouterOptions) {
    this.gateway = options.gateway;
    this.basePath = options.basePath ?? '/api/v1';
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    this.configApply = options.configApply;
    this.approverIdentity = options.approverIdentity;
    this.onboarding = options.onboarding;
    this.browserInstalls = options.browserInstalls ?? new BrowserInstallJobs();
  }

  /**
   * 自鉴权面的绝对路径前缀（basePath 拼上 SELF_AUTH_PATHS），供 adapter 的
   * `apiKeyExemptPaths` 使用——路径单源在 router，adapter 不复制。
   *
   * @returns 绝对前缀数组（如 `/api/v1/onboarding`）
   */
  selfAuthPathPrefixes(): string[] {
    return WebApiRouter.SELF_AUTH_PATHS.map((p) => `${this.basePath}${p}`);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Debug 面（不在 /api/v1 下）：Observer Run Observatory
    if (path.startsWith('/debug/run/')) {
      return this.handleDebugRun(req, res, url);
    }

    if (!path.startsWith(this.basePath)) {
      return false;
    }

    const relativePath = decodeURIComponent(path.slice(this.basePath.length) || '/');
    const method = req.method?.toUpperCase() ?? 'GET';

    try {
      if (relativePath === '/health' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: {
            status: 'ok',
            agents: this.gateway.getRegisteredAgents(),
            // 状态指示器 seed（兑现 getKnowledgeState「供 /health」的注释承诺）：
            // WebUI 生命周期标记 mount/WS 重连时以此为准，事件仅作低延迟增量
            knowledge: this.gateway.getKnowledgeState(),
            effectPolicy: this.gateway.getEffectPolicyStatus(),
            // 缺口2：channel adapter 健康聚合（status?() 可选契约）
            channels: this.gateway.getChannelStatuses(),
            // ops P4：常驻 PRIVILEGED 标记（不是一次性 toast）的数据源
            privileged: await this.gateway.getPrivilegedStatus(),
          },
        });
      }

      // ── Web 向导面（arch/product-onboarding.md §1/§7）：状态机单源在 engine，此面只做 HTTP ──
      // 分派谓词与 adapter 的豁免谓词同一口径（路径段，不是裸前缀）：单源语义,
      // 避免「/onboardingX 被 adapter 豁免、却被 router 当向导子路径」这类两侧认知分裂。
      if (matchesSelfAuthPath(relativePath)) {
        return await this.handleOnboarding(req, res, relativePath, method, url);
      }

      // ── 租户与定义面（arch/multi-tenancy.md T1b）：注册/登录 + registry CRUD ──
      if (relativePath.startsWith('/registry')) {
        return await this.handleRegistry(req, res, relativePath, method);
      }

      // ── fleet 运维面（MAJ-4）：ops 原语入口（arch/service-topology-p0c.md §5.2；鉴权随上游闸）──
      if (relativePath === '/fleet' && method === 'GET') {
        return this.json(res, 200, { ok: true, data: this.gateway.fleetStatus() });
      }
      if (relativePath === '/fleet/spawn' && method === 'POST') {
        const body = (await this.readBody(req)) as {
          version?: unknown;
          buildRef?: unknown;
          n?: unknown;
        };
        if (typeof body.version !== 'string' || typeof body.buildRef !== 'string') {
          return this.json(res, 400, { ok: false, error: 'version and buildRef are required strings' });
        }
        const n = body.n === undefined ? 1 : body.n;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
          return this.json(res, 400, { ok: false, error: 'n must be a positive integer' });
        }
        return this.json(res, 200, {
          ok: true,
          data: await this.gateway.fleetSpawn(body.version, body.buildRef, n),
        });
      }
      if (relativePath === '/fleet/weights' && method === 'POST') {
        const body = await this.readBody(req);
        if (!body?.weights || typeof body.weights !== 'object') {
          return this.json(res, 400, { ok: false, error: 'weights object is required' });
        }
        try {
          this.gateway.fleetSetWeights(body.weights as Record<string, number>);
          return this.json(res, 200, { ok: true, data: this.gateway.fleetStatus().route });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (relativePath === '/fleet/scale' && method === 'POST') {
        const body = await this.readBody(req);
        // MAJ-3 修复：n 必须整数 0-64（防小数截断 drain 全版本 / 无界 spawn）；buildRef 显式
        if (!body?.version || typeof body.buildRef !== 'string') {
          return this.json(res, 400, { ok: false, error: 'version and buildRef are required' });
        }
        if (!Number.isInteger(body.n) || body.n < 0 || body.n > 64) {
          return this.json(res, 400, { ok: false, error: 'n must be an integer in [0,64]' });
        }
        const outcome = await this.gateway.fleetScale(body.version, body.buildRef, body.n);
        return this.json(res, 200, { ok: true, data: outcome });
      }

      if (relativePath === '/fleet/promote' && method === 'POST') {
        const body = (await this.readBody(req)) as { version?: unknown };
        if (typeof body.version !== 'string') {
          return this.json(res, 400, { ok: false, error: 'version is required string' });
        }
        this.gateway.fleetPromote(body.version);
        return this.json(res, 200, { ok: true, data: this.gateway.fleetStatus() });
      }
      if (relativePath === '/fleet/rollback' && method === 'POST') {
        const body = (await this.readBody(req)) as {
          version?: unknown;
          buildRef?: unknown;
          n?: unknown;
        };
        if (typeof body.version !== 'string' || typeof body.buildRef !== 'string') {
          return this.json(res, 400, { ok: false, error: 'version and buildRef are required strings' });
        }
        const n = body.n === undefined ? undefined : body.n;
        if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 1)) {
          return this.json(res, 400, { ok: false, error: 'n must be a positive integer' });
        }
        return this.json(res, 200, {
          ok: true,
          data: await this.gateway.fleetRollback(body.version, body.buildRef, n as number | undefined),
        });
      }
      if (relativePath === '/fleet/drain' && method === 'POST') {
        const body = (await this.readBody(req)) as { instanceId?: unknown };
        if (typeof body.instanceId !== 'string') {
          return this.json(res, 400, { ok: false, error: 'instanceId is required string' });
        }
        await this.gateway.fleetDrain(body.instanceId);
        return this.json(res, 200, { ok: true, data: this.gateway.fleetStatus() });
      }

      if (relativePath === '/agents' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.getRegisteredAgents(),
        });
      }

      if (relativePath === '/models' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.getModelCatalog(),
        });
      }

      // ── 配置管理面（arch/config-hot-reload.md）──
      if (relativePath.startsWith('/config/')) {
        return this.handleConfigAdmin(relativePath, method, req, res, url);
      }

      // ── 浏览器引擎管理面（arch/browser-capability.md §3.9；WebUI 设置页）──
      if (relativePath.startsWith('/browser')) {
        return this.handleBrowserAdmin(relativePath, method, req, res);
      }

      if (relativePath === '/providers' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.getProviderSummaries(),
        });
      }

      if (relativePath === '/commands' && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.getCommandCatalog(),
        });
      }

      if (relativePath === '/issues' && method === 'GET') {
        const status = url.searchParams.get('status') as 'open' | 'resolved' | 'dismissed' | null;
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.listSystemIssues(status ?? undefined),
        });
      }

      const issueDismissMatch = relativePath.match(/^\/issues\/([^/]+)\/dismiss$/);
      if (issueDismissMatch && method === 'POST') {
        this.gateway.getIssueRegistry().dismiss(issueDismissMatch[1]);
        return this.json(res, 200, { ok: true, data: { id: issueDismissMatch[1], status: 'dismissed' } });
      }

      if (relativePath === '/sessions' && method === 'GET') {
        const agentId = url.searchParams.get('agentId') ?? undefined;
        const rawTenant = url.searchParams.get('tenantId');
        if (rawTenant !== null && rawTenant.trim() === '') {
          return this.json(res, 400, { ok: false, error: 'tenantId must be non-empty when given' });
        }
        // 读侧隔离（MAJ-3）：身份在场即按身份收口——租户用户只看本租户，
        // query 自报仅平台 admin 可用；无 X-Registry-Token = 宿主面（apiKey 闸
        // 已验的信任边界，host 管理台全量列表是其正确语义）
        const listIdentity = this.resolveRequestUser(req);
        if (listIdentity === 'invalid') {
          return this.json(res, 401, { ok: false, error: 'unauthorized: invalid X-Registry-Token' });
        }
        let listTenant: string | undefined = rawTenant ?? undefined;
        if (listIdentity !== 'host') {
          if (listTenant !== undefined && !listIdentity.isPlatformAdmin) {
            return this.json(res, 403, {
              ok: false,
              error: 'registry_forbidden: only a platform admin may query another tenant',
            });
          }
          listTenant = listIdentity.tenantId;
        }
        const sessions = await this.gateway.listSessions(agentId, listTenant);
        return this.json(res, 200, { ok: true, data: sessions });
      }

      // 单会话端点租户闸（§9.1-3，T4b）：X-Registry-Token 在场时，目标会话必须属于
      // 身份租户（平台 admin 豁免）；越域按「不存在」回（不泄漏存在性）。
      // 无该头 = 宿主面（apiKey 闸已验），存量语义不变。**前置**于一切
      // /sessions/:id* 分支（含 events 回放——曾因注册在闸前漏放，评审 MAJ-3）。
      const singleSessionMatch = relativePath.match(/^\/sessions\/([^/]+)/);
      if (singleSessionMatch) {
        const singleIdentity = this.resolveRequestUser(req);
        if (singleIdentity === 'invalid') {
          return this.json(res, 401, { ok: false, error: 'unauthorized: invalid X-Registry-Token' });
        }
        if (singleIdentity !== 'host' && !singleIdentity.isPlatformAdmin) {
          const target = await this.gateway.getSession(singleSessionMatch[1]);
          let targetTenant = target?.tenantId ?? DEFAULT_TENANT_ID;
          let known = !!target;
          if (!target) {
            // 回落封存注册表：archived→trashed 等对已封存 id 的操作也过租户闸
            // （getSession 只读热库，直接 404 会把租户用户的"归档→回收站"堵死）
            try {
              const entry = (await this.gateway.listArchives()).find(
                (e) => e.sessionId === singleSessionMatch[1],
              );
              if (entry) {
                known = true;
                // 注册表 tenantId 存储为 string；来源=SessionMeta.tenantId（TenantId 品牌），边界收窄
                targetTenant = entry.tenantId as typeof targetTenant;
              }
            } catch {
              // 封存子系统不可用（无 relocate 能力）：无归档可查，按未知处理
            }
          }
          if (!known || targetTenant !== singleIdentity.tenantId) {
            return this.json(res, 404, { ok: false, error: 'Session not found' });
          }
        }
      }

      const sessionEventsMatch = /^\/sessions\/([^/]+)\/events$/.exec(relativePath);
      if (sessionEventsMatch && method === 'GET') {
        // run 事件回放读口（P1-3b，Q3=(a)）：读归档旁路；无历史=空数组
        const events = await this.gateway.readSessionEvents(sessionEventsMatch[1]);
        return this.json(res, 200, { ok: true, data: events });
      }

      const childSessionsMatch = /^\/sessions\/([^/]+)\/children$/.exec(relativePath);
      if (childSessionsMatch && method === 'GET') {
        // 直接子会话（委派 spawnBy 归属，D7）：右栏"子会话"数据源；租户闸已由单会话闸覆盖
        try {
          const children = await this.gateway.listChildSessions(childSessionsMatch[1]);
          return this.json(res, 200, { ok: true, data: children });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) {
            return this.json(res, 404, { ok: false, error: message });
          }
          throw err;
        }
      }

      if (relativePath === '/sessions' && method === 'POST') {
        const body = await this.readBody(req);
        if (!body?.agentId) {
          return this.json(res, 400, { ok: false, error: 'agentId is required' });
        }

        const metadata = { ...(body.metadata ?? {}) };
        if (typeof body.model === 'string' && body.model) {
          metadata.model = body.model;
        }

        // 租户身份（arch/multi-tenancy.md §9）：X-Registry-Token 在场则按身份定租户
        // （不信 body 自报，防冒领）；坏凭证 fail-loud 401（不静默落 default）；
        // 无该头 = 宿主面调用（apiKey 闸已验），存量语义不变（DEFAULT_TENANT_ID）
        const registrySvc = this.gateway.getRegistry();
        const sessionIdentity = this.resolveRequestUser(req);
        if (sessionIdentity === 'invalid') {
          return this.json(res, 401, { ok: false, error: 'unauthorized: invalid X-Registry-Token' });
        }
        const sessionUser = sessionIdentity === 'host' ? null : sessionIdentity;
        if (sessionUser) {
          // agent 归属校验（§7 硬边界）：registry 托管的 agent 不得跨租户建会话
          const target = registrySvc?.getAgent(body.agentId as import('@octopi-agent/engine/harness/governance/registry/types.js').AgentId);
          if (target && target.tenantId !== sessionUser.tenantId && !sessionUser.isPlatformAdmin) {
            return this.json(res, 403, {
              ok: false,
              error: 'registry_cross_tenant_agent: cannot create a session for another tenant\'s agent',
            });
          }
        }
        let session;
        try {
          session = await this.gateway.createSession({
            agentId: body.agentId,
            sessionId: body.sessionId,
            metadata,
            ...(sessionUser ? { tenantId: sessionUser.tenantId } : {}),
          });
        } catch (err) {
          // session_exists（覆盖拒收）等 → 409/400 明示（MAJ-6 fail-loud，不 500）。
          // sendError 定义在本方法后段（TDZ），此处内联同一映射口径
          const message = err instanceof Error ? err.message : String(err);
          const status = message.includes('_exists')
            ? 409
            : message.includes('_not_found')
              ? 404
              : message.startsWith('registry_forbidden')
                ? 403
                : 400;
          return this.json(res, status, { ok: false, error: message });
        }

        // 与 setSessionModel 同源校验/规范化 model 引用
        if (typeof body.model === 'string' && body.model) {
          try {
            await this.gateway.setSessionModel(session.id, body.model, body.agentId);
          } catch (err) {
            return this.json(res, 400, {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return this.json(res, 201, { ok: true, data: session });
      }

      // 单会话闸已前移至 /sessions/:id* 全分支之前（含 events 回放）

      const sessionMatch = relativePath.match(/^\/sessions\/([^/]+)$/);
      if (sessionMatch && method === 'GET') {
        const session = await this.gateway.getSessionView(sessionMatch[1]);
        if (!session) {
          return this.json(res, 404, { ok: false, error: 'Session not found' });
        }

        return this.json(res, 200, { ok: true, data: session });
      }

      const effectRootsMatch = relativePath.match(
        /^\/sessions\/([^/]+)\/effect-roots$/,
      );
      if (effectRootsMatch && method === 'GET') {
        try {
          const data = await this.gateway.getSessionEffectRoots(effectRootsMatch[1]);
          return this.json(res, 200, { ok: true, data });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return this.json(res, msg.includes('not found') ? 404 : 400, {
            ok: false,
            error: msg,
          });
        }
      }
      if (effectRootsMatch && method === 'POST') {
        const body = await this.readBody(req);
        const path = typeof body?.path === 'string' ? body.path : '';
        if (!path.trim()) {
          return this.json(res, 400, { ok: false, error: 'path is required' });
        }
        try {
          const data = await this.gateway.addSessionEffectRoot(
            effectRootsMatch[1],
            path,
          );
          return this.json(res, 200, { ok: true, data });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return this.json(res, msg.includes('not found') ? 404 : 400, {
            ok: false,
            error: msg,
          });
        }
      }
      if (effectRootsMatch && method === 'DELETE') {
        const qPath = url.searchParams.get('path') ?? '';
        const bodyPath = qPath || '';
        if (!bodyPath.trim()) {
          // also accept JSON body for hosts that cannot set DELETE query
          const body = await this.readBody(req);
          const path = typeof body?.path === 'string' ? body.path : '';
          if (!path.trim()) {
            return this.json(res, 400, { ok: false, error: 'path is required' });
          }
          try {
            const data = await this.gateway.removeSessionEffectRoot(
              effectRootsMatch[1],
              path,
            );
            return this.json(res, 200, { ok: true, data });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return this.json(res, msg.includes('not found') ? 404 : 400, {
              ok: false,
              error: msg,
            });
          }
        }
        try {
          const data = await this.gateway.removeSessionEffectRoot(
            effectRootsMatch[1],
            bodyPath,
          );
          return this.json(res, 200, { ok: true, data });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return this.json(res, msg.includes('not found') ? 404 : 400, {
            ok: false,
            error: msg,
          });
        }
      }

      const gitStatusMatch = relativePath.match(/^\/sessions\/([^/]+)\/git-status$/);
      if (gitStatusMatch && method === 'GET') {
        const target = url.searchParams.get('path') ?? '';
        if (!target.trim()) {
          return this.json(res, 400, { ok: false, error: 'path is required' });
        }
        const maxEntriesRaw = url.searchParams.get('maxEntries');
        const maxEntries = maxEntriesRaw === null ? undefined : Number(maxEntriesRaw);
        if (
          maxEntriesRaw !== null &&
          !(Number.isInteger(maxEntries) && (maxEntries as number) >= 1 && (maxEntries as number) <= 2000)
        ) {
          return this.json(res, 400, {
            ok: false,
            error: 'maxEntries must be an integer in 1..2000',
          });
        }
        try {
          const data = await this.gateway.getSessionGitStatus(gitStatusMatch[1], target, {
            maxEntries,
          });
          return this.json(res, 200, { ok: true, data });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // 前缀码精确映射（消息文本不可作为契约）：git_status_busy → 429（可重试，
          // 带 Retry-After）；其余 git_* 是服务端问题 → 500；资源缺失 → 404；默认 500。
          const code = msg.startsWith('path_not_allowed') || msg.startsWith('path_invalid')
            ? 400
            : msg.startsWith('git_status_busy:')
              ? (res.setHeader('Retry-After', '5'), 429)
              : msg.startsWith('git_')
                ? 500
                : msg.startsWith('path_not_found') || msg.includes('not found')
                  ? 404
                  : 500;
          return this.json(res, code, { ok: false, error: msg });
        }
      }

      if (sessionMatch && method === 'PATCH') {
        const body = await this.readBody(req);
        const title = typeof body?.title === 'string' && body.title.trim() ? body.title : undefined;
        const pinned = typeof body?.pinned === 'boolean' ? body.pinned : undefined;
        // 提供了 title 但非法：显式报错，不静默忽略调用方的字段
        if (body?.title !== undefined && !title) {
          return this.json(res, 400, { ok: false, error: 'title must not be empty' });
        }
        if (!title && pinned === undefined) {
          return this.json(res, 400, { ok: false, error: 'title or pinned is required' });
        }
        try {
          let meta;
          if (pinned !== undefined) {
            meta = await this.gateway.setSessionPinned(sessionMatch[1], pinned);
          }
          if (title) {
            meta = await this.gateway.renameSession(sessionMatch[1], title);
          }
          return this.json(res, 200, { ok: true, data: meta });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg.includes('not found') ? 404 : 400;
          return this.json(res, code, { ok: false, error: msg });
        }
      }

      if (sessionMatch && method === 'DELETE') {
        try {
          const result = await this.gateway.deleteSession(sessionMatch[1]);
          return this.json(res, 200, { ok: true, data: { id: sessionMatch[1], ...result } });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg.includes('session_running')
            ? 409
            : msg.includes('not found')
              ? 404
              : 400;
          return this.json(res, code, { ok: false, error: msg });
        }
      }

      // ── 会话封存（归档/回收站；arch/session-archive-recycle.md §4） ──

      const sessionArchiveMatch = relativePath.match(/^\/sessions\/([^/]+)\/archive$/);
      if (sessionArchiveMatch && method === 'POST') {
        // 租户闸由 /sessions/:id* 单会话闸覆盖（在本分支之前）
        try {
          const result = await this.gateway.archiveSession(sessionArchiveMatch[1]);
          return this.json(res, 200, { ok: true, data: { id: sessionArchiveMatch[1], ...result } });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg.includes('session_running')
            ? 409
            : msg.includes('not found')
              ? 404
              : 400;
          return this.json(res, code, { ok: false, error: msg });
        }
      }

      const archivesListMatch = relativePath.match(/^\/archives$/);
      if (archivesListMatch && method === 'GET') {
        const identity = this.resolveRequestUser(req);
        if (identity === 'invalid') {
          return this.json(res, 401, { ok: false, error: 'unauthorized: invalid X-Registry-Token' });
        }
        const stateRaw = url.searchParams.get('state');
        if (stateRaw !== null && stateRaw !== 'archived' && stateRaw !== 'trashed') {
          // 非法参数不静默当"全部"（fail loud）
          return this.json(res, 400, {
            ok: false,
            error: `invalid state: ${stateRaw} (expected archived|trashed)`,
          });
        }
        const state = stateRaw === 'archived' || stateRaw === 'trashed' ? stateRaw : undefined;
        let items;
        try {
          items = await this.gateway.listArchives(state);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return this.json(res, msg.includes('archive_unavailable') ? 400 : 500, {
            ok: false,
            error: msg,
          });
        }
        // 租户可见性（与 /sessions/:id* 同款）：非宿主/平台 admin 只见本租户
        if (identity !== 'host' && !identity.isPlatformAdmin) {
          items = items.filter((e) => e.tenantId === identity.tenantId);
        }
        return this.json(res, 200, { ok: true, data: items });
      }

      if (archivesListMatch && method === 'DELETE') {
        // 清空回收站（批量不可逆）：确认闩 + 仅接受 state=trashed；返回 { purged, bytes, warnings }
        if (url.searchParams.get('confirm') !== 'true') {
          return this.json(res, 400, {
            ok: false,
            error: 'confirm=true is required for emptying the trash',
          });
        }
        const stateRaw = url.searchParams.get('state');
        if (stateRaw !== 'trashed') {
          // 非法参数不静默当"全部回收站"（fail loud）
          return this.json(res, 400, {
            ok: false,
            error: `invalid state: ${stateRaw ?? '(missing)'} (expected trashed)`,
          });
        }
        const identity = this.resolveRequestUser(req);
        if (identity === 'invalid') {
          return this.json(res, 401, { ok: false, error: 'unauthorized: invalid X-Registry-Token' });
        }
        try {
          const result = await this.gateway.purgeTrash(
            identity !== 'host' && !identity.isPlatformAdmin ? identity.tenantId : null,
          );
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return this.json(res, msg.includes('archive_unavailable') ? 400 : 500, {
            ok: false,
            error: msg,
          });
        }
      }

      const archiveRestoreMatch = relativePath.match(/^\/archives\/([^/]+)\/restore$/);
      if (archiveRestoreMatch && method === 'POST') {
        const identity = this.resolveRequestUser(req);
        if (identity === 'invalid') {
          return this.json(res, 401, { ok: false, error: 'unauthorized: invalid X-Registry-Token' });
        }
        try {
          const entry = (await this.gateway.listArchives()).find((e) => e.sessionId === archiveRestoreMatch[1]);
          if (!entry || (identity !== 'host' && !identity.isPlatformAdmin && entry.tenantId !== identity.tenantId)) {
            // 404（非 403）：不泄漏他租户封存的存在性
            return this.json(res, 404, { ok: false, error: 'Not found' });
          }
          const result = await this.gateway.restoreArchive(archiveRestoreMatch[1]);
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = /not found/.test(msg)
            ? 404
            : /archive_unavailable|session_id_conflict|entry_not_ready|bundle_manifest_invalid|group_partial/.test(msg)
              ? 400
              : 500; // 非输入错误不伪装成客户端错误（可观测）
          return this.json(res, code, { ok: false, error: msg });
        }
      }

      const archivePurgeMatch = relativePath.match(/^\/archives\/([^/]+)$/);
      if (archivePurgeMatch && method === 'DELETE') {
        // 彻底删除（不可逆）：API 层确认闩，误触直达一律拒绝
        if (url.searchParams.get('confirm') !== 'true') {
          return this.json(res, 400, {
            ok: false,
            error: 'confirm=true is required for permanent delete',
          });
        }
        const identity = this.resolveRequestUser(req);
        if (identity === 'invalid') {
          return this.json(res, 401, { ok: false, error: 'unauthorized: invalid X-Registry-Token' });
        }
        try {
          const entry = (await this.gateway.listArchives()).find((e) => e.sessionId === archivePurgeMatch[1]);
          if (!entry || (identity !== 'host' && !identity.isPlatformAdmin && entry.tenantId !== identity.tenantId)) {
            return this.json(res, 404, { ok: false, error: 'Not found' });
          }
          const result = await this.gateway.purgeArchive(archivePurgeMatch[1]);
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = /not found/.test(msg)
            ? 404
            : /archive_unavailable|entry_not_ready|group_partial/.test(msg)
              ? 400
              : 500;
          return this.json(res, code, { ok: false, error: msg });
        }
      }

      const messageMatch = relativePath.match(/^\/sessions\/([^/]+)\/messages$/);
      if (messageMatch && method === 'GET') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50'), 1), 200);
        const cursor = url.searchParams.get('cursor') ?? undefined;
        const directionRaw = url.searchParams.get('direction');
        const direction = directionRaw === 'backward' || directionRaw === 'forward' ? directionRaw : undefined;
        const page = await this.gateway.getSessionMessages(messageMatch[1], { limit, cursor, direction });
        return this.json(res, 200, { ok: true, data: page });
      }

      // turn 定位索引：user 角色消息轻量投影（语义分类由 web 层统一执行）
      const userMessagesMatch = relativePath.match(/^\/sessions\/([^/]+)\/user-messages$/);
      if (userMessagesMatch && method === 'GET') {
        try {
          const projection = await this.gateway.getSessionUserMessages(userMessagesMatch[1]);
          return this.json(res, 200, { ok: true, data: projection });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return this.json(res, msg.includes('not found') ? 404 : 400, { ok: false, error: msg });
        }
      }

      const branchMatch = relativePath.match(/^\/sessions\/([^/]+)\/branch$/);
      if (branchMatch && method === 'POST') {
        const body = await this.readBody(req);
        const beforeIndex = body?.beforeIndex;
        if (!Number.isInteger(beforeIndex)) {
          return this.json(res, 400, { ok: false, error: 'beforeIndex (integer) is required' });
        }
        try {
          const meta = await this.gateway.branchSession(branchMatch[1], {
            beforeIndex: beforeIndex as number,
            agentId: typeof body?.agentId === 'string' ? body.agentId : undefined,
          });
          return this.json(res, 201, { ok: true, data: meta });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg.includes('not found') ? 404 : 400;
          return this.json(res, code, { ok: false, error: msg });
        }
      }

      const truncateMatch = relativePath.match(/^\/sessions\/([^/]+)\/messages\/truncate$/);
      if (truncateMatch && method === 'POST') {
        const body = await this.readBody(req);
        const fromIndex = body?.fromIndex;
        if (!Number.isInteger(fromIndex)) {
          return this.json(res, 400, { ok: false, error: 'fromIndex (integer) is required' });
        }
        try {
          const result = await this.gateway.truncateMessagesFrom(
            truncateMatch[1],
            fromIndex as number,
          );
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg.includes('not found') ? 404 : 400;
          return this.json(res, code, { ok: false, error: msg });
        }
      }

      // ── 会话附件（OP-15）──
      // 已 release 文件内容（send_file）GET/列表
      const fileContentMatch = relativePath.match(/^\/sessions\/([^/]+)\/files\/([^/]+)$/);
      if (fileContentMatch && method === 'GET') {
        const sessionId = fileContentMatch[1];
        const fileId = fileContentMatch[2];
        const rangeHeader = req.headers['range'] as string | undefined;
        const result = await this.gateway.getSessionFileContent(sessionId, fileId, {
          rangeHeader,
        });
        if (!result) {
          return this.json(res, 404, { ok: false, error: 'file not released for this session' });
        }
        if (result.ok === false) {
          if (result.reason === 'unsatisfiable') {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${result.totalSize ?? 0}`);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.end();
            return true;
          }
          return this.json(res, 404, { ok: false, error: result.reason });
        }
        const { record, totalSize, start, end, ranged, handle } = result;
        const length = totalSize === 0 ? 0 : end - start + 1;
        // 防 XSS：一律 attachment + nosniff；WebUI 走 fetch/blob
        res.statusCode = ranged ? 206 : 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(length));
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Content-Type', record.mime || 'application/octet-stream');
        res.setHeader('X-File-Name', encodeURIComponent(record.name));
        res.setHeader('X-File-Id', record.fileId);
        const asciiName = record.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(record.name)}`,
        );
        if (ranged) {
          res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        }
        await handle.close().catch(() => {});
        if (length === 0) {
          res.end();
          return true;
        }
        const { createReadStream } = await import('node:fs');
        const stream = createReadStream(record.absPath, { start, end });
        stream.on('error', () => {
          res.destroy();
        });
        stream.pipe(res);
        return true;
      }
      const fileListMatch = relativePath.match(/^\/sessions\/([^/]+)\/files$/);
      if (fileListMatch && method === 'GET') {
        return this.json(res, 200, {
          ok: true,
          data: await this.gateway.listSessionFileReleases(fileListMatch[1]),
        });
      }

      const attachmentsMatch = relativePath.match(/^\/sessions\/([^/]+)\/attachments$/);
      if (attachmentsMatch && method === 'GET') {
        const items = await this.gateway.listSessionAttachments(attachmentsMatch[1]);
        return this.json(res, 200, { ok: true, data: items });
      }
      if (attachmentsMatch && method === 'POST') {
        // 附件上传：提高 body 上限（base64 会膨胀）
        const body = await this.readBody(req, Math.max(this.maxBodyBytes, 64 * 1024 * 1024));
        const files = Array.isArray(body?.files) ? body.files : body?.name ? [body] : [];
        if (files.length === 0) {
          return this.json(res, 400, { ok: false, error: 'files[] or {name,dataBase64|text} required' });
        }
        try {
          const items = await this.gateway.uploadSessionAttachments(attachmentsMatch[1], files);
          return this.json(res, 201, { ok: true, data: items });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const attachmentOneMatch = relativePath.match(/^\/sessions\/([^/]+)\/attachments\/([^/]+)$/);
      if (attachmentOneMatch && method === 'DELETE') {
        const removed = await this.gateway.deleteSessionAttachment(
          attachmentOneMatch[1],
          attachmentOneMatch[2],
        );
        if (!removed) return this.json(res, 404, { ok: false, error: 'attachment not found' });
        return this.json(res, 200, { ok: true, data: { id: attachmentOneMatch[2], removed: true } });
      }
      const attachmentPromoteMatch = relativePath.match(
        /^\/sessions\/([^/]+)\/attachments\/([^/]+)\/promote$/,
      );
      const attachmentSearchableMatch = relativePath.match(
        /^\/sessions\/([^/]+)\/attachments\/([^/]+)\/make-searchable$/,
      );
      if (attachmentSearchableMatch && method === 'POST') {
        try {
          const result = await this.gateway.makeAttachmentSearchable(
            attachmentSearchableMatch[1],
            attachmentSearchableMatch[2],
          );
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (attachmentPromoteMatch && method === 'POST') {
        const body = await this.readBody(req);
        const projectKey = body?.projectKey as string | undefined;
        if (!projectKey) {
          return this.json(res, 400, { ok: false, error: 'projectKey is required' });
        }
        try {
          const result = await this.gateway.promoteSessionAttachment(
            attachmentPromoteMatch[1],
            attachmentPromoteMatch[2],
            { projectKey, targetSourceId: body?.targetSourceId },
          );
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const tasksMatch = relativePath.match(/^\/sessions\/([^/]+)\/tasks$/);
      if (tasksMatch && method === 'GET') {
        const agentId = url.searchParams.get('agentId') ?? undefined;
        try {
          const tasks = await this.gateway.getSessionTasks(tasksMatch[1], agentId ?? undefined);
          return this.json(res, 200, { ok: true, data: tasks ?? [] });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) {
            return this.json(res, 404, { ok: false, error: message });
          }
          throw err;
        }
      }

      const schedulesMatch = relativePath.match(/^\/sessions\/([^/]+)\/schedules$/);
      if (schedulesMatch && method === 'GET') {
        try {
          const data = await this.gateway.getSessionSchedules(schedulesMatch[1]);
          return this.json(res, 200, { ok: true, data });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) {
            return this.json(res, 404, { ok: false, error: message });
          }
          throw err;
        }
      }

      const scheduleActionMatch = relativePath.match(
        /^\/sessions\/([^/]+)\/schedules\/([^/]+)\/(cancel|pause|resume)$/,
      );
      if (scheduleActionMatch && method === 'POST') {
        const action = scheduleActionMatch[3] as 'cancel' | 'pause' | 'resume';
        try {
          const body = await this.readBody(req).catch(() => null);
          const reason =
            body && typeof body.reason === 'string' ? body.reason : undefined;
          const data = await this.gateway.controlSchedule(
            scheduleActionMatch[1],
            scheduleActionMatch[2],
            action,
            reason,
          );
          return this.json(res, 200, { ok: true, data });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) {
            return this.json(res, 404, { ok: false, error: message });
          }
          return this.json(res, 400, { ok: false, error: message });
        }
      }

      const abortMatch = relativePath.match(/^\/sessions\/([^/]+)\/abort$/);
      if (abortMatch && method === 'POST') {
        this.gateway.abortSession(abortMatch[1]);
        return this.json(res, 200, { ok: true, data: { aborted: true } });
      }

      const sessionModelMatch = relativePath.match(/^\/sessions\/([^/]+)\/model$/);
      if (sessionModelMatch && method === 'GET') {
        const agentId = url.searchParams.get('agentId') ?? undefined;
        const view = await this.gateway.getSessionModel(sessionModelMatch[1], agentId);
        if (!view) {
          return this.json(res, 404, { ok: false, error: 'Session not found' });
        }
        return this.json(res, 200, { ok: true, data: view });
      }

      if (sessionModelMatch && (method === 'POST' || method === 'PUT')) {
        const body = await this.readBody(req);
        const agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
        const modelRef = body.model === null || body.model === undefined
          ? null
          : String(body.model);
        try {
          const view = await this.gateway.setSessionModel(sessionModelMatch[1], modelRef, agentId);
          return this.json(res, 200, { ok: true, data: view });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) {
            return this.json(res, 404, { ok: false, error: message });
          }
          return this.json(res, 400, { ok: false, error: message });
        }
      }

      const compactMatch = relativePath.match(/^\/sessions\/([^/]+)\/compact$/);
      if (compactMatch && method === 'POST') {
        const body = await this.readBody(req);
        const agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
        try {
          const result = await this.gateway.compactSession(compactMatch[1], agentId);
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) {
            return this.json(res, 404, { ok: false, error: message });
          }
          return this.json(res, 400, { ok: false, error: message });
        }
      }

      const contextLayersMatch = relativePath.match(/^\/sessions\/([^/]+)\/context\/layers$/);
      if (contextLayersMatch && method === 'GET') {
        const snapshot = this.gateway.getSessionContextLayers(contextLayersMatch[1]);
        return this.json(res, 200, { ok: true, data: snapshot });
      }

      // 旧 run 路径已迁 /debug/run/...（调试面，非稳定产品 API）
      const agentHealthMatch = relativePath.match(/^\/agents\/([^/]+)\/context\/health$/);
      if (agentHealthMatch && method === 'GET') {
        const health = await this.gateway.getAgentContextHealth(agentHealthMatch[1]);
        return this.json(res, 200, { ok: true, data: health });
      }

      // ── Knowledge sources（Host 管理面；arch/knowledge-layer.md §6 / knowledge-admin-ui.md §4）──
      const knowledgeStatsMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/stats$/);
      if (knowledgeStatsMatch && method === 'GET') {
        try {
          const stats = await this.gateway.getKnowledgeStats(knowledgeStatsMatch[1]);
          return this.json(res, 200, { ok: true, data: stats });
        } catch (err) {
          return this.json(res, 503, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const knowledgeProjectsMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/projects$/);
      if (knowledgeProjectsMatch && method === 'GET') {
        try {
          const projects = await this.gateway.listKnowledgeProjects();
          return this.json(res, 200, { ok: true, data: projects });
        } catch (err) {
          return this.json(res, 503, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (knowledgeProjectsMatch && method === 'POST') {
        const body = await this.readBody(req);
        const projectKey = typeof body?.projectKey === 'string' ? body.projectKey.trim() : '';
        if (!projectKey) {
          return this.json(res, 400, { ok: false, error: 'projectKey is required' });
        }
        await this.gateway.createKnowledgeProject(
          projectKey,
          typeof body?.displayName === 'string' ? body.displayName : undefined,
          body?.visibility === 'public' || body?.visibility === 'private'
            ? body.visibility
            : undefined,
        );
        return this.json(res, 201, { ok: true, data: { projectKey } });
      }

      const knowledgeProjectMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/projects\/([^/]+)$/,
      );
      if (knowledgeProjectMatch && method === 'DELETE') {
        try {
          const removed = await this.gateway.removeKnowledgeProject(knowledgeProjectMatch[2]);
          return this.json(res, 200, {
            ok: true,
            data: { projectKey: knowledgeProjectMatch[2], removed },
          });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const knowledgeSearchMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/search$/);
      if (knowledgeSearchMatch && method === 'GET') {
        const q = url.searchParams.get('q')?.trim() ?? '';
        if (!q) return this.json(res, 400, { ok: false, error: 'q is required' });
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const limitRaw = Number(url.searchParams.get('limit') ?? '');
        const result = await this.gateway.searchKnowledge(q, {
          agentId: knowledgeSearchMatch[1],
          sessionId,
          limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 20) : 8,
        });
        return this.json(res, 200, {
          ok: true,
          data: {
            usedVector: result.usedVector,
            coverage: result.coverage,
            keywordHits: result.keywordHits,
            vectorHits: result.vectorHits,
            hits: result.hits.map((h) => ({
              sourceId: h.sourceId,
              path: h.path,
              startLine: h.startLine,
              endLine: h.endLine,
              score: h.score,
              snippet: h.text.slice(0, 400),
            })),
          },
        });
      }

      const knowledgeSessionVisMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/session-visibility$/,
      );
      if (knowledgeSessionVisMatch && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          return this.json(res, 400, { ok: false, error: 'sessionId is required' });
        }
        const items = await this.gateway.getKnowledgeSessionVisibility(
          knowledgeSessionVisMatch[1],
          sessionId,
        );
        return this.json(res, 200, { ok: true, data: items });
      }
      if (knowledgeSessionVisMatch && method === 'PUT') {
        const body = await this.readBody(req);
        const sessionId = String(body?.sessionId ?? '');
        if (!sessionId) return this.json(res, 400, { ok: false, error: 'sessionId is required' });
        const rawItems = Array.isArray(body?.items) ? body.items : [];
        const items: Array<{
          targetType: 'project' | 'source';
          targetId: string;
          op: 'include' | 'exclude';
        }> = [];
        for (const raw of rawItems) {
          const targetType = raw?.targetType as 'project' | 'source' | undefined;
          const targetId = typeof raw?.targetId === 'string' ? raw.targetId : '';
          const op = raw?.op as 'include' | 'exclude' | undefined;
          if (
            !targetId ||
            (targetType !== 'project' && targetType !== 'source') ||
            (op !== 'include' && op !== 'exclude')
          ) {
            return this.json(res, 400, {
              ok: false,
              error: 'items[].targetType(project|source), targetId, op(include|exclude) required',
            });
          }
          items.push({ targetType, targetId, op });
        }
        await this.gateway.replaceKnowledgeSessionVisibility(
          knowledgeSessionVisMatch[1],
          sessionId,
          items,
        );
        return this.json(res, 200, { ok: true, data: { sessionId, count: items.length } });
      }
      if (knowledgeSessionVisMatch && method === 'POST') {
        const body = await this.readBody(req);
        const sessionId = String(body?.sessionId ?? '');
        const targetType = body?.targetType as 'project' | 'source' | undefined;
        const targetId = typeof body?.targetId === 'string' ? body.targetId : '';
        const op = body?.op as 'include' | 'exclude' | undefined;
        if (
          !sessionId ||
          !targetId ||
          (targetType !== 'project' && targetType !== 'source') ||
          (op !== 'include' && op !== 'exclude')
        ) {
          return this.json(res, 400, {
            ok: false,
            error:
              'sessionId, targetType(project|source), targetId, op(include|exclude) are required',
          });
        }
        await this.gateway.setKnowledgeSessionVisibility(knowledgeSessionVisMatch[1], sessionId, {
          targetType,
          targetId,
          op,
        });
        return this.json(res, 200, { ok: true, data: { sessionId, targetType, targetId, op } });
      }
      if (knowledgeSessionVisMatch && method === 'DELETE') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          return this.json(res, 400, { ok: false, error: 'sessionId is required' });
        }
        const targetType = url.searchParams.get('targetType') as 'project' | 'source' | null;
        const targetId = url.searchParams.get('targetId');
        if (targetType && targetId) {
          await this.gateway.clearKnowledgeSessionVisibility(knowledgeSessionVisMatch[1], sessionId, {
            targetType,
            targetId,
          });
        } else {
          await this.gateway.clearKnowledgeSessionVisibility(knowledgeSessionVisMatch[1], sessionId);
        }
        return this.json(res, 200, { ok: true, data: { sessionId } });
      }

      const knowledgeVisibilitySummaryMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/visibility$/,
      );
      if (knowledgeVisibilitySummaryMatch && method === 'GET') {
        const summary = await this.gateway.getKnowledgeVisibility(knowledgeVisibilitySummaryMatch[1]);
        return this.json(res, 200, { ok: true, data: summary });
      }

      const knowledgePromoMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/promotion-candidates$/,
      );
      if (knowledgePromoMatch && method === 'GET') {
        const candidates = await this.gateway.getKnowledgePromotionCandidates();
        // 只返回严格门槛（≥minSessions 且 ≥minHits）；宽松命中见 meetsThreshold 字段
        const strict = candidates.filter((c) => c.meetsThreshold);
        return this.json(res, 200, {
          ok: true,
          data: { strict, all: candidates },
        });
      }

      const knowledgeSourcesMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/sources$/);
      if (knowledgeSourcesMatch && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const scopeLevel = url.searchParams.get('scopeLevel') as
          | 'global'
          | 'project'
          | 'session'
          | null;
        const projectKey = url.searchParams.get('projectKey') ?? undefined;
        if (scopeLevel === 'session' && !sessionId?.trim()) {
          return this.json(res, 400, {
            ok: false,
            error: 'sessionId is required when scopeLevel=session',
          });
        }
        try {
          const sources = await this.gateway.listKnowledgeSources(knowledgeSourcesMatch[1], {
            sessionId,
            scopeLevel: scopeLevel ?? undefined,
            projectKey,
          });
          return this.json(res, 200, { ok: true, data: sources });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const status =
            /knowledge_http_timeout|knowledge_query_timeout|busy|disabled/i.test(message)
              ? 503
              : 400;
          return this.json(res, status, {
            ok: false,
            error: message,
          });
        }
      }
      if (knowledgeSourcesMatch && method === 'POST') {
        const body = await this.readBody(req);
        const kind = body?.kind as string | undefined;
        const level = body?.scopeRef?.level as string | undefined;
        const allowedKinds = new Set(['workspace', 'directory', 'file', 'url', 'connector']);
        const allowedLevels = new Set(['global', 'project', 'session']);
        if (!kind || !allowedKinds.has(kind) || !body?.location || !level || !allowedLevels.has(level) || !body?.scopeRef?.key) {
          return this.json(res, 400, {
            ok: false,
            error:
              'kind(workspace|directory|file|url|connector), location, scopeRef.level(global|project|session), scopeRef.key are required',
          });
        }
        try {
          const source = await this.gateway.createKnowledgeSource(body);
          return this.json(res, 201, { ok: true, data: source });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const knowledgeSourceFilesMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)\/files$/,
      );
      if (knowledgeSourceFilesMatch && method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? '1');
        const pageSize = Number(url.searchParams.get('pageSize') ?? '50');
        const status = (url.searchParams.get('status') ?? 'all') as
          | 'indexed'
          | 'skipped'
          | 'error'
          | 'all';
        const ext = url.searchParams.get('ext') ?? undefined;
        const q = url.searchParams.get('q') ?? undefined;
        // 带分页参数时走分页；无参保持旧「全量数组」响应
        const paged =
          url.searchParams.has('page') ||
          url.searchParams.has('pageSize') ||
          url.searchParams.has('status') ||
          url.searchParams.has('ext') ||
          url.searchParams.has('q');
        if (paged) {
          const data = await this.gateway.listKnowledgeSourceFilesPaged(
            knowledgeSourceFilesMatch[2],
            {
              status,
              ext,
              q,
              page: Number.isFinite(page) && page > 0 ? page : 1,
              pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 50,
            },
          );
          return this.json(res, 200, { ok: true, data });
        }
        const files = await this.gateway.listKnowledgeSourceFiles(knowledgeSourceFilesMatch[2]);
        return this.json(res, 200, { ok: true, data: files });
      }

      // 重做文件：单路径 / 批量路径 / 按筛选批量
      const knowledgeReprocessMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)\/reprocess$/,
      );
      if (knowledgeReprocessMatch && method === 'POST') {
        const body = await this.readBody(req).catch(() => ({}));
        try {
          const rawFilter = body?.filter as
            | { status?: string; ext?: string; q?: string }
            | undefined;
          const flatFilter = {
            status: body?.status as string | undefined,
            ext: body?.ext as string | undefined,
            q: body?.q as string | undefined,
          };
          const filterSrc = rawFilter ?? flatFilter;
          const hasFilter =
            filterSrc != null &&
            (filterSrc.status != null || filterSrc.ext != null || filterSrc.q != null);
          const result = await this.gateway.reprocessKnowledgeFiles(
            knowledgeReprocessMatch[2],
            {
              paths: Array.isArray(body?.paths)
                ? body.paths.filter((p: unknown) => typeof p === 'string' && p)
                : undefined,
              ...(hasFilter ? { filter: filterSrc } : {}),
            },
          );
          return this.json(res, 200, result);
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 路径任务状态（重做完成跟踪）
      const knowledgePathJobsMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)\/path-jobs$/,
      );
      if (knowledgePathJobsMatch && method === 'POST') {
        const body = await this.readBody(req).catch(() => ({}));
        const paths = Array.isArray(body?.paths)
          ? body.paths.filter((p: unknown) => typeof p === 'string' && p)
          : [];
        const data = await this.gateway.knowledgePathJobStates(
          knowledgePathJobsMatch[2],
          paths,
        );
        return this.json(res, 200, { ok: true, data });
      }

      const knowledgeChunksMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/chunks$/);
      if (knowledgeChunksMatch && method === 'GET') {
        const sourceId = url.searchParams.get('sourceId') ?? '';
        const path = url.searchParams.get('path') ?? '';
        if (!sourceId || !path) {
          return this.json(res, 400, { ok: false, error: 'sourceId and path are required' });
        }
        const chunks = await this.gateway.listKnowledgeChunks(
          knowledgeChunksMatch[1],
          sourceId,
          path,
        );
        return this.json(res, 200, { ok: true, data: chunks });
      }

      const knowledgeSourceMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)$/,
      );
      if (knowledgeSourceMatch && method === 'GET') {
        const detail = await this.gateway.getKnowledgeSourceDetail(knowledgeSourceMatch[2]);
        if (!detail) return this.json(res, 404, { ok: false, error: 'source not found' });
        return this.json(res, 200, { ok: true, data: detail });
      }
      if (knowledgeSourceMatch && method === 'PATCH') {
        const body = await this.readBody(req);
        const updated = await this.gateway.updateKnowledgeSource(knowledgeSourceMatch[2], body ?? {});
        if (!updated) return this.json(res, 404, { ok: false, error: 'source not found' });
        return this.json(res, 200, { ok: true, data: updated });
      }
      if (knowledgeSourceMatch && method === 'DELETE') {
        const removed = await this.gateway.removeKnowledgeSource(knowledgeSourceMatch[2]);
        if (!removed) return this.json(res, 404, { ok: false, error: 'source not found' });
        return this.json(res, 200, { ok: true, data: { id: knowledgeSourceMatch[2], removed: true } });
      }

      const knowledgeReindexMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)\/reindex$/,
      );
      if (knowledgeReindexMatch && method === 'POST') {
        const body = await this.readBody(req).catch(() => ({}));
        try {
          const result = await this.gateway.reindexKnowledgeSource(knowledgeReindexMatch[2], {
            full: Boolean(body?.full),
            watch: body?.watch !== false,
          });
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 手动触发 describe：LLM 升级优先（models.level 已配置时），否则/失败回退 Service 启发式
      const knowledgeDescribeMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)\/describe$/,
      );
      if (knowledgeDescribeMatch && method === 'POST') {
        try {
          await this.gateway.autoDescribeKnowledgeSource(knowledgeDescribeMatch[2]);
          return this.json(res, 200, { ok: true, data: { id: knowledgeDescribeMatch[2] } });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 中止索引任务：单源 / 全部
      const knowledgeAbortSourceMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)\/abort$/,
      );
      if (knowledgeAbortSourceMatch && method === 'POST') {
        try {
          const result = await this.gateway.abortKnowledgeJobs(knowledgeAbortSourceMatch[2]);
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const knowledgeAbortAllMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/abort$/);
      if (knowledgeAbortAllMatch && method === 'POST') {
        try {
          const result = await this.gateway.abortKnowledgeJobs();
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 恢复/继续（中止后）；非全量 reindex
      const knowledgeResumeSourceMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/sources\/([^/]+)\/resume$/,
      );
      if (knowledgeResumeSourceMatch && method === 'POST') {
        try {
          const result = await this.gateway.resumeKnowledgeJobs(knowledgeResumeSourceMatch[2]);
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const knowledgeResumeAllMatch = relativePath.match(/^\/agents\/([^/]+)\/knowledge\/resume$/);
      if (knowledgeResumeAllMatch && method === 'POST') {
        try {
          const result = await this.gateway.resumeKnowledgeJobs();
          return this.json(res, 200, { ok: true, data: result });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const knowledgeVisibilityMatch = relativePath.match(
        /^\/agents\/([^/]+)\/knowledge\/visibility$/,
      );
      if (knowledgeVisibilityMatch && method === 'POST') {
        const body = await this.readBody(req);
        const op = body?.op as 'assignProject' | 'unassignProject' | 'hide' | 'unhide' | undefined;
        if (!op || !['assignProject', 'unassignProject', 'hide', 'unhide'].includes(op)) {
          return this.json(res, 400, {
            ok: false,
            error: 'op must be assignProject|unassignProject|hide|unhide',
          });
        }
        try {
          await this.gateway.setKnowledgeVisibility({
            op,
            agentId: knowledgeVisibilityMatch[1],
            projectKey: typeof body.projectKey === 'string' ? body.projectKey : undefined,
            sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
          });
          return this.json(res, 200, { ok: true, data: { op } });
        } catch (err) {
          return this.json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (relativePath === '/approvals' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.listPendingApprovals(sessionId),
        });
      }

      const approvalMatch = relativePath.match(/^\/approvals\/([^/]+)$/);
      if (approvalMatch && method === 'POST') {
        const body = await this.readBody(req);
        if (!body?.action || !['approve', 'reject'].includes(body.action)) {
          return this.json(res, 400, { ok: false, error: 'action must be approve or reject' });
        }
        const scope = body.scope;
        if (
          scope !== undefined &&
          !['once', 'session', 'always'].includes(String(scope))
        ) {
          return this.json(res, 400, {
            ok: false,
            error: 'scope must be once, session, or always',
          });
        }

        const resolved = this.gateway.resolvePendingApproval(approvalMatch[1], {
          action: body.action,
          scope: scope as 'once' | 'session' | 'always' | undefined,
          reason: body.reason,
          // ops P5 确认人入账：认证身份优先（apiKey 闸验明的持钥方，credential-backed）；
          // 无认证部署不再收客户端自报（可仿冒=审计撒谎）——固定记 unauthenticated（B-1 拍板 2026-11-18）
          approver: this.approverIdentity ?? 'unauthenticated',
          channel: body.channel === 'webhook' ? 'webhook' : 'gateway',
        });

        if (!resolved) {
          return this.json(res, 404, { ok: false, error: 'Approval not found' });
        }

        return this.json(res, 200, { ok: true, data: resolved });
      }

      if (relativePath === '/questions' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.listPendingQuestions(sessionId),
        });
      }

      const questionMatch = relativePath.match(/^\/questions\/([^/]+)$/);
      if (questionMatch && method === 'POST') {
        const body = await this.readBody(req);
        const answer = typeof body?.answer === 'string' ? body.answer : undefined;
        if (answer === undefined) {
          return this.json(res, 400, { ok: false, error: 'answer (string) is required' });
        }

        const resolved = this.gateway.resolvePendingQuestion(questionMatch[1], { answer });
        if (!resolved) {
          return this.json(res, 404, { ok: false, error: 'Question not found' });
        }

        return this.json(res, 200, { ok: true, data: resolved });
      }

      // ── Client Tools（arch/client-tools.md）──
      if (relativePath === '/client-tools' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        if (!sessionId) {
          return this.json(res, 400, { ok: false, error: 'sessionId is required' });
        }
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.listSessionClientTools(sessionId),
        });
      }

      if (relativePath === '/client-tools' && method === 'POST') {
        const body = await this.readBody(req);
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        const clientInstanceId =
          typeof body?.clientInstanceId === 'string' ? body.clientInstanceId : '';
        const descriptors = Array.isArray(body?.descriptors) ? body.descriptors : null;
        if (!sessionId || !clientInstanceId || !descriptors) {
          return this.json(res, 400, {
            ok: false,
            error: 'sessionId, clientInstanceId, descriptors are required',
          });
        }
        const { validateClientToolDescriptor } = await import(
          '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js'
        );
        for (const d of descriptors) {
          const err = validateClientToolDescriptor(d);
          if (err) return this.json(res, 400, { ok: false, error: err });
        }
        const result = this.gateway.registerClientTools({
          sessionId,
          clientInstanceId,
          platform: typeof body?.platform === 'string' ? body.platform : undefined,
          principalId: typeof body?.principalId === 'string' ? body.principalId : undefined,
          descriptors: descriptors as never,
        });
        return this.json(res, 200, { ok: true, data: result });
      }

      if (relativePath === '/client-tools/heartbeat' && method === 'POST') {
        const body = await this.readBody(req);
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        const clientInstanceId = typeof body?.clientInstanceId === 'string' ? body.clientInstanceId : '';
        if (!sessionId || !clientInstanceId) {
          return this.json(res, 400, {
            ok: false,
            error: 'sessionId, clientInstanceId are required',
          });
        }
        const result = this.gateway.heartbeatClientTools({ sessionId, clientInstanceId });
        return this.json(res, 200, { ok: true, data: result });
      }

      const clientToolUnregMatch = relativePath.match(/^\/client-tools\/([^/]+)$/);
      if (clientToolUnregMatch && method === 'DELETE') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        if (!sessionId) {
          return this.json(res, 400, { ok: false, error: 'sessionId is required' });
        }
        const result = this.gateway.unregisterClientTools({
          sessionId,
          clientInstanceId: clientToolUnregMatch[1],
        });
        return this.json(res, 200, { ok: true, data: result });
      }

      if (relativePath === '/client-tool-calls' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        if (!sessionId) {
          return this.json(res, 400, { ok: false, error: 'sessionId is required' });
        }
        return this.json(res, 200, {
          ok: true,
          data: await this.gateway.listClientToolCalls(sessionId),
        });
      }

      const clientToolCallResolveMatch = relativePath.match(/^\/client-tool-calls\/([^/]+)\/resolve$/);
      if (clientToolCallResolveMatch && method === 'POST') {
        const body = await this.readBody(req);
        const outcome = body?.outcome;
        const { validateClientToolOutcome } = await import(
          '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js'
        );
        const outcomeError = validateClientToolOutcome(outcome);
        if (outcomeError) {
          return this.json(res, 400, { ok: false, error: outcomeError });
        }
        // completedByPrincipalId 仅作展示元数据，不作授权依据（未接 ACL 前不可信）
        const resolved = this.gateway.resolveClientToolCall(
          clientToolCallResolveMatch[1],
          outcome as never,
          typeof body?.completedByPrincipalId === 'string' ? body.completedByPrincipalId : undefined,
        );
        if (!resolved) {
          return this.json(res, 404, { ok: false, error: 'Client tool call not found or not pending' });
        }
        return this.json(res, 200, { ok: true, data: resolved });
      }

      // ── Client Streams（§15.1 Host 通道；非 LLM API）──
      if (relativePath === '/client-streams' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        if (!sessionId) {
          return this.json(res, 400, { ok: false, error: 'sessionId is required' });
        }
        return this.json(res, 200, {
          ok: true,
          data: this.gateway.listClientStreams(sessionId),
        });
      }

      if (relativePath === '/client-streams' && method === 'POST') {
        const body = await this.readBody(req);
        const sessionId = String(body?.sessionId ?? '');
        const clientInstanceId = String(body?.clientInstanceId ?? '');
        const direction = body?.direction;
        if (!sessionId || !clientInstanceId) {
          return this.json(res, 400, {
            ok: false,
            error: 'sessionId, clientInstanceId are required',
          });
        }
        if (direction !== 'source' && direction !== 'sink') {
          return this.json(res, 400, { ok: false, error: 'direction must be source|sink' });
        }
        const channel = this.gateway.openClientStream({
          direction,
          sessionId,
          clientInstanceId,
          toolName: typeof body?.toolName === 'string' ? body.toolName : undefined,
          sampleHint: typeof body?.sampleHint === 'string' ? body.sampleHint : undefined,
          maxDurationMs:
            typeof body?.maxDurationMs === 'number' ? body.maxDurationMs : undefined,
        });
        return this.json(res, 200, { ok: true, data: channel });
      }

      const streamSamplesMatch = relativePath.match(/^\/client-streams\/([^/]+)\/samples$/);
      if (streamSamplesMatch && method === 'POST') {
        const body = await this.readBody(req);
        const streamId = streamSamplesMatch[1];
        const channel = this.gateway.getClientStream(streamId);
        if (!channel) {
          return this.json(res, 404, { ok: false, error: 'stream not found or closed' });
        }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        const clientInstanceId =
          typeof body?.clientInstanceId === 'string' ? body.clientInstanceId : '';
        if (sessionId && sessionId !== channel.owner.sessionId) {
          return this.json(res, 403, { ok: false, error: 'stream belongs to another session' });
        }
        if (clientInstanceId && clientInstanceId !== channel.owner.clientInstanceId) {
          return this.json(res, 403, {
            ok: false,
            error: 'stream belongs to another client instance',
          });
        }
        const raw = body?.samples;
        if (!Array.isArray(raw)) {
          return this.json(res, 400, { ok: false, error: 'samples must be an array' });
        }
        const samples = raw.map((data: unknown) => ({ data }));
        const ok = this.gateway.writeClientStreamSamples(streamId, samples);
        if (!ok) {
          return this.json(res, 404, { ok: false, error: 'stream not found or closed' });
        }
        return this.json(res, 200, { ok: true, data: { accepted: samples.length } });
      }

      const streamCloseMatch = relativePath.match(/^\/client-streams\/([^/]+)\/close$/);
      if (streamCloseMatch && method === 'POST') {
        const body = await this.readBody(req);
        const streamId = streamCloseMatch[1];
        const channel = this.gateway.getClientStream(streamId);
        if (!channel) {
          return this.json(res, 404, { ok: false, error: 'stream not found' });
        }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        if (sessionId && sessionId !== channel.owner.sessionId) {
          return this.json(res, 403, { ok: false, error: 'stream belongs to another session' });
        }
        const closed = this.gateway.closeClientStream(
          streamId,
          typeof body?.reason === 'string' ? body.reason : 'closed',
        );
        if (!closed) {
          return this.json(res, 404, { ok: false, error: 'stream not found' });
        }
        return this.json(res, 200, { ok: true, data: closed });
      }

      if (relativePath === '/memory/stats' && method === 'GET') {
        const stats = await this.gateway.getMemoryStats();
        if (!stats) {
          return this.json(res, 200, {
            ok: true,
            data: { configured: false },
          });
        }

        return this.json(res, 200, { ok: true, data: { configured: true, ...stats } });
      }

      if (relativePath === '/memory/query' && method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '10'), 1), 50);
        const page = await this.gateway.queryMemory({ q, limit });
        if (!page) {
          return this.json(res, 200, {
            ok: true,
            data: { configured: false },
          });
        }

        return this.json(res, 200, { ok: true, data: { configured: true, ...page } });
      }

      return this.json(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.json(res, 500, { ok: false, error: message });
    }
  }

  /**
   * Debug 面：Observer Run Observatory
   *
   * 路径（根路径，不在 /api/v1 下）：
   * - GET /debug/run/:sessionId/scope
   * - GET /debug/run/:sessionId/messages?phase=&runId=&view=
   *
   * 非稳定产品 API；受 observer.level / webPanel 门控。
   */
  private async handleDebugRun(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = (_req.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      return this.json(res, 405, { ok: false, error: 'Method not allowed' });
    }
    const match = url.pathname.match(/^\/debug\/run\/([^/]+)\/(scope|messages)$/);
    if (!match) {
      return this.json(res, 404, { ok: false, error: 'Not found' });
    }
    const sessionId = decodeURIComponent(match[1]!);
    const kind = match[2];
    // MAJ-5 修复：debug 面按会话读 run 快照/LLM 正文——与单会话端点同闸：
    // X-Registry-Token 在场则身份须过会话归属（admin 豁免），越域按「不存在」回
    const debugIdentity = this.resolveRequestUser(_req);
    if (debugIdentity === 'invalid') {
      return this.json(res, 401, { ok: false, error: 'unauthorized: invalid X-Registry-Token' });
    }
    if (debugIdentity !== 'host' && !debugIdentity.isPlatformAdmin) {
      const target = await this.gateway.getSession(sessionId);
      const targetTenant = target?.tenantId ?? DEFAULT_TENANT_ID;
      if (!target || targetTenant !== debugIdentity.tenantId) {
        return this.json(res, 404, { ok: false, error: 'Session not found' });
      }
    }
    try {
      const hub = this.gateway.getObserverHub();
      if (kind === 'scope') {
        const snapshot = this.gateway.getSessionRunObservatory(sessionId);
        return this.json(res, 200, {
          ok: true,
          data: snapshot,
          observer: hub.getStatus(),
        });
      }
      const phaseParam = url.searchParams.get('phase');
      const runId = url.searchParams.get('runId') ?? undefined;
      const viewParam = url.searchParams.get('view');
      const view = viewParam === 'llm' ? 'llm' : 'workspace';
      const phase = view === 'llm' ? 'llm' : phaseParam === 'entry' ? 'entry' : 'final';
      const snapshot = this.gateway.getSessionRunMessages(sessionId, {
        phase: phase as 'entry' | 'final' | 'llm',
        runId,
        view,
      });
      return this.json(res, 200, {
        ok: true,
        data: snapshot,
        observer: hub.getStatus(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.json(res, 500, { ok: false, error: message });
    }
  }

  /**
   * 浏览器引擎管理面：状态 / 启动安装 / 任务轮询。
   *
   * 授权：host 面（apiKey 闸已验）或平台 admin——安装写 OCTOPI_HOME 并拉网络，
   * 与配置管理同信任级但更偏宿主运维，故收紧到 host/platform-admin。
   *
   * @param relativePath - basePath 之后的路径
   * @param method - HTTP 方法
   * @param req - 请求（身份解析用）
   * @param res - 响应
   * @returns 恒 true（本段全权应答）
   */
  private async handleBrowserAdmin(
    relativePath: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const identity = this.resolveRequestUser(req);
    if (identity === 'invalid') {
      return this.json(res, 401, { ok: false, error: 'unauthorized: invalid X-Registry-Token' });
    }
    if (identity !== 'host' && !identity.isPlatformAdmin) {
      return this.json(res, 403, {
        ok: false,
        error: 'forbidden: browser engine admin is host/platform-admin only',
      });
    }
    const jobs = this.browserInstalls;

    if (relativePath === '/browser/engines' && method === 'GET') {
      return this.json(res, 200, { ok: true, data: jobs.status() });
    }

    const installMatch = relativePath.match(/^\/browser\/engines\/([^/]+)\/install$/);
    if (installMatch && method === 'POST') {
      const engine = installMatch[1];
      const started = jobs.start(engine);
      if ('error' in started) {
        return this.json(res, started.error.startsWith('unknown') ? 400 : 409, {
          ok: false,
          error: started.error,
        });
      }
      return this.json(res, 200, { ok: true, data: started });
    }

    const jobMatch = relativePath.match(/^\/browser\/engines\/install\/([^/]+)$/);
    if (jobMatch && method === 'GET') {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        return this.json(res, 404, { ok: false, error: 'install job not found' });
      }
      return this.json(res, 200, { ok: true, data: job });
    }

    return this.json(res, 404, { ok: false, error: `unknown browser admin route: ${relativePath}` });
  }

  /**
   * 配置管理面路由（arch/config-hot-reload.md §4）：
   * GET/PUT/DELETE /config/models… + POST …/test + GET /config/presets/models
   */
  private async handleConfigAdmin(
    relativePath: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const apply = this.configApply;
    if (!apply) {
      return this.json(res, 503, { ok: false, error: 'config admin not wired' });
    }
    try {
      if (relativePath === '/config/models' && method === 'GET') {
        return this.json(res, 200, { ok: true, data: apply.getModelsView() });
      }

      if (relativePath === '/config/presets/models' && method === 'GET') {
        return this.json(res, 200, { ok: true, data: listProviderPresets() });
      }

      if (relativePath === '/config/models/levels' && method === 'PUT') {
        const body = await this.readBody(req);
        const result = await apply.updateLevels(
          body?.level ?? {},
          typeof body?.hash === 'string' ? body.hash : '',
        );
        return this.json(res, 200, { ok: true, data: result });
      }

      // 浏览器引擎（arch/browser-capability.md §3.9；WebUI 设置页联动热生效）
      if (relativePath === '/config/browser' && method === 'GET') {
        return this.json(res, 200, { ok: true, data: apply.getBrowserView() });
      }

      if (relativePath === '/config/browser/engine' && method === 'PUT') {
        const body = await this.readBody(req);
        const result = await apply.updateBrowserEngine(
          typeof body?.engine === 'string' ? body.engine : '',
          typeof body?.hash === 'string' ? body.hash : '',
        );
        return this.json(res, 200, { ok: true, data: result });
      }

      const providerMatch = relativePath.match(/^\/config\/models\/providers\/([^/]+)$/);
      if (providerMatch && method === 'PUT') {
        const name = providerMatch[1]!;
        assertSafeConfigName(name);
        const body = await this.readBody(req);
        if (!body?.provider || typeof body.provider !== 'object') {
          return this.json(res, 400, { ok: false, error: 'provider object is required' });
        }
        const result = await apply.upsertProvider(
          name,
          body.provider as Record<string, unknown>,
          typeof body.hash === 'string' ? body.hash : '',
        );
        return this.json(res, 200, { ok: true, data: result });
      }

      if (providerMatch && method === 'DELETE') {
        const name = providerMatch[1]!;
        assertSafeConfigName(name);
        const hash = url.searchParams.get('hash') ?? '';
        const result = await apply.deleteProvider(name, hash);
        return this.json(res, 200, { ok: true, data: result });
      }

      const testMatch = relativePath.match(/^\/config\/models\/providers\/([^/]+)\/test$/);
      if (testMatch && method === 'POST') {
        const name = testMatch[1]!;
        assertSafeConfigName(name);
        const body = await this.readBody(req);
        const result = await apply.testProvider(name, (body?.provider ?? {}) as Record<string, unknown>);
        return this.json(res, 200, { ok: true, data: result });
      }

      if (relativePath === '/config/presets/agent-roles/render' && method === 'POST') {
        const body = await this.readBody(req);
        const rendered = apply.renderRole(
          String(body?.presetId ?? ''),
          {
            agentName: String(body?.agentName ?? ''),
            addressToUser: String(body?.addressToUser ?? ''),
          },
          body?.lang === 'en' || body?.lang === 'zh' ? body.lang : undefined,
        );
        return this.json(res, 200, { ok: true, data: rendered });
      }

      // ── 未知键告警 + 手动清理（方案3） ──
      if (relativePath === '/config/unknown-keys' && method === 'GET') {
        return this.json(res, 200, { ok: true, data: apply.getUnknownKeys() });
      }

      if (relativePath === '/config/cleanup-unknown-keys' && method === 'POST') {
        const body = await this.readBody(req);
        const result = await apply.cleanupUnknownKeys(typeof body?.hash === 'string' ? body.hash : '');
        return this.json(res, 200, { ok: true, data: result });
      }

      // ── 备份 / 回滚（P3） ──
      if (relativePath === '/config/backups' && method === 'GET') {
        return this.json(res, 200, { ok: true, data: apply.listBackups() });
      }

      if (relativePath === '/config/rollback' && method === 'POST') {
        const body = await this.readBody(req);
        const result = await apply.rollbackTo(
          String(body?.backupPath ?? ''),
          typeof body?.hash === 'string' ? body.hash : '',
        );
        return this.json(res, 200, { ok: true, data: result });
      }

      // ── 另存为角色模板（P3） ──
      const saveTplMatch = relativePath.match(/^\/config\/agents\/([^/]+)\/save-as-template$/);
      if (saveTplMatch && method === 'POST') {
        assertSafeConfigName(saveTplMatch[1]!);
        const body = await this.readBody(req);
        const preset = apply.saveAgentAsTemplate(saveTplMatch[1]!, {
          id: String(body?.id ?? ''),
          label: typeof body?.label === 'string' ? body.label : undefined,
          description: typeof body?.description === 'string' ? body.description : undefined,
        });
        return this.json(res, 200, { ok: true, data: preset });
      }

      if (relativePath === '/config/presets/agent-roles' && method === 'GET') {
        return this.json(res, 200, { ok: true, data: apply.listRolePresets() });
      }

      // ── agent 配置面（P2，arch/config-hot-reload.md §4） ──
      if (relativePath === '/config/agents' && method === 'GET') {
        return this.json(res, 200, { ok: true, data: apply.getAgentsView() });
      }

      if (relativePath === '/config/agents' && method === 'POST') {
        const body = await this.readBody(req);
        if (!body?.agent || typeof body.agent !== 'object') {
          return this.json(res, 400, { ok: false, error: 'agent object is required' });
        }
        if (this.refuseUnauthenticatedSecurityWrite(res, body.agent as Record<string, unknown>)) {
          return true;
        }
        const result = await apply.createAgent({
          agent: body.agent as Record<string, unknown>,
          agentsMd: typeof body.agentsMd === 'string' ? body.agentsMd : undefined,
          personaFiles: parseRolePersonaFiles(body?.personaFiles),
          skills: parseRoleSkills(body?.skills),
          lang: body?.lang === 'en' || body?.lang === 'zh' ? body.lang : undefined,
          hash: typeof body.hash === 'string' ? body.hash : '',
        });
        return this.json(res, 200, { ok: true, data: result });
      }

      const agentMatch = relativePath.match(/^\/config\/agents\/([^/]+)$/);
      if (agentMatch && (method === 'PUT' || method === 'DELETE')) {
        const agentId = agentMatch[1]!;
        assertSafeConfigName(agentId);
        if (method === 'PUT') {
          const body = await this.readBody(req);
          if (!body?.agent || typeof body.agent !== 'object') {
            return this.json(res, 400, { ok: false, error: 'agent object is required' });
          }
          if (this.refuseUnauthenticatedSecurityWrite(res, body.agent as Record<string, unknown>)) {
            return true;
          }
          const result = await apply.updateAgent(
            agentId,
            body.agent as Record<string, unknown>,
            typeof body.hash === 'string' ? body.hash : '',
          );
          return this.json(res, 200, { ok: true, data: result });
        }
        const hash = url.searchParams.get('hash') ?? '';
        const result = await apply.deleteAgent(agentId, hash);
        return this.json(res, 200, { ok: true, data: result });
      }

      const personaMatch = relativePath.match(/^\/config\/agents\/([^/]+)\/persona$/);
      if (personaMatch) {
        const agentId = personaMatch[1]!;
        assertSafeConfigName(agentId);
        if (method === 'GET') {
          return this.json(res, 200, { ok: true, data: apply.getPersona(agentId) });
        }
        if (method === 'PUT') {
          const body = await this.readBody(req);
          if (typeof body?.content !== 'string') {
            return this.json(res, 400, { ok: false, error: 'content (string) is required' });
          }
          const result = await apply.updatePersona(
            agentId,
            body.content,
            typeof body.hash === 'string' ? body.hash : '',
          );
          return this.json(res, 200, { ok: true, data: result });
        }
      }

      // persona/ 补充件（四件套等）：清单 + 单文件读写（控制台多文件编辑）
      const personaFilesMatch = relativePath.match(/^\/config\/agents\/([^/]+)\/persona\/files$/);
      if (personaFilesMatch) {
        const agentId = personaFilesMatch[1]!;
        assertSafeConfigName(agentId);
        if (method === 'GET') {
          return this.json(res, 200, { ok: true, data: apply.listPersonaFiles(agentId) });
        }
      }

      const personaFileMatch = relativePath.match(
        /^\/config\/agents\/([^/]+)\/persona\/files\/([^/]+)$/,
      );
      if (personaFileMatch) {
        const agentId = personaFileMatch[1]!;
        const file = personaFileMatch[2]!;
        assertSafeConfigName(agentId);
        if (method === 'GET') {
          return this.json(res, 200, { ok: true, data: apply.getPersonaFile(agentId, file) });
        }
        if (method === 'PUT') {
          const body = await this.readBody(req);
          if (typeof body?.content !== 'string') {
            return this.json(res, 400, { ok: false, error: 'content (string) is required' });
          }
          const result = await apply.updatePersonaFile(
            agentId,
            file,
            body.content,
            typeof body.hash === 'string' ? body.hash : '',
          );
          return this.json(res, 200, { ok: true, data: result });
        }
      }

      return this.json(res, 404, { ok: false, error: `unknown config endpoint: ${relativePath}` });
    } catch (err) {
      if (err instanceof ConfigConflictError) {
        return this.json(res, 409, {
          ok: false,
          error: err.message,
          data: { currentHash: err.currentHash },
        });
      }
      // fs/内部错误（带 errno code）→ 500；校验失败 / 引用拒绝等业务拒绝 → 400 带原因
      const errno = (err as NodeJS.ErrnoException | null)?.code;
      if (errno) {
        return this.json(res, 500, { ok: false, error: `internal error (${errno})` });
      }
      return this.json(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 解析 X-Registry-Token 身份（§9.1 信任边界，单源；T4b 评审 NIT-2 收编样板）。
   *
   * @param req - 请求（读 x-registry-token 头）
   * @returns 'host' = 无该头（宿主面，全量可见是其正确语义）；'invalid' = 坏凭证；其余 = registry 用户
   */
  private resolveRequestUser(req: IncomingMessage): 'host' | 'invalid' | User {
    const header = req.headers['x-registry-token'];
    const token = typeof header === 'string' ? header.trim() : '';
    if (!token) return 'host';
    return this.gateway.getRegistry()?.resolveToken(token) ?? 'invalid';
  }

  private async readBody(req: IncomingMessage, maxBytesOverride?: number): Promise<any> {
    const maxBytes = maxBytesOverride ?? this.maxBodyBytes;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > maxBytes) {
        throw new Error(`Request body too large (limit: ${Math.round(maxBytes / 1024)}KB)`);
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) {
      return {};
    }

    return JSON.parse(raw);
  }

  /**
   * console 无认证部署下的提权闸（ops §8.4 / §4.3.1，大哥 2026-10-31 拍板 A2）。
   *
   * 威胁：console API 无法区分调用者是人还是 agent。无 apiKey 部署下，非 host agent
   * （project 模式 `network=open`）可匿名调 `/config/agents` 把自己升到 host 完成提权——
   * 正好绕开 §8.4 要防的自提权面（直写文件已被路径约束挡住，网络这条路没有）。
   *
   * **只拦真正提权**（A2）：无 console key 时，仅当写入把 agent 升到 `mode=host`（全权：
   * 无 jail、可写 `~/.octopi`、network=open、escalation full）才 503。workspace /
   * project / untrusted 互改、默认值、tools 编辑都是非全权面，放行——否则无 key 部署连
   * 默认 workspace 新建都被拦（WebUI 新建总带 `effectPolicy.mode`）。host 改成别的 = 降权，同样放行。
   *
   * @param res - 响应对象（503 时已写响应）
   * @param agentEntry - 待写的 agents[] 条目（create / update 共用）
   * @returns true = 已响应 503（调用方直接 return）；false = 放行
   */
  private refuseUnauthenticatedSecurityWrite(
    res: ServerResponse,
    agentEntry: Record<string, unknown>,
  ): boolean {
    // 认证部署：持钥方 = 宿主管理身份，放行
    if (this.approverIdentity) return false;
    const ep = agentEntry.effectPolicy;
    if (ep && typeof ep === 'object' && (ep as Record<string, unknown>).mode === 'host') {
      this.json(res, 503, {
        ok: false,
        error:
          'security_config_unauthenticated: setting effectPolicy.mode=host (full privilege) requires an authenticated console (configure apiKey); unauthenticated deployments escalate via host restart only',
      });
      return true;
    }
    return false;
  }

  /** Web 向导路由（loopback 免闸；远程须 setup token——§7） */
  private async handleOnboarding(
    req: IncomingMessage,
    res: ServerResponse,
    relativePath: string,
    method: string,
    url: URL,
  ): Promise<boolean> {
    const svc = this.onboarding;
    if (!svc) return this.json(res, 503, { ok: false, error: 'onboarding_unavailable: Web 向导未装配' });

    const token = req.headers['x-setup-token'] ?? url.searchParams.get('setup') ?? undefined;
    // §7：来源一律要 token（含 loopback）——本机任意网页不得借 127.0.0.1 改写配置。
    // 浏览器侧始终在 URL 里带 setup 令牌，正常旅程不受影响。
    if (!svc.authorize(typeof token === 'string' ? token : undefined)) {
      return this.json(res, 401, { ok: false, error: 'setup_token_invalid: 需要终端打印的 setup 链接（30 分钟内有效）' });
    }
    // 跨站写入的第二道闸：带 Origin 的请求必须是本机来源（浏览器跨站 CORS 简单请求不带 Origin，
    // 但 POST/JSON 必然带；无 Origin 的本机工具不受此限）。
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '' && !isLocalOrigin(origin)) {
      return this.json(res, 403, { ok: false, error: 'onboarding_cross_origin: 向导面不接受跨站请求' });
    }

    if (relativePath === '/onboarding/availability' && method === 'GET') {
      return this.json(res, 200, { ok: true, data: { available: svc.isAvailable() } });
    }
    if (relativePath === '/onboarding/session' && method === 'POST') {
      try {
        // 起始语言由客户端界面偏好决定（服务端默认 zh 分不清「默认」与「用户选的 zh」）。
        // 只收白名单值：非 'en' 一律按 'zh'，不把任意字符串塞进 choices.lang。
        const body = (await this.readBody(req)) as { lang?: unknown } | undefined;
        const initialLang: 'zh' | 'en' = body?.lang === 'en' ? 'en' : 'zh';
        return this.json(res, 200, { ok: true, data: svc.start(initialLang) });
      } catch (e) {
        if (e instanceof OnboardingStepInvalidError) {
          return this.json(res, 403, { ok: false, error: `onboarding_step_invalid: ${e.message}` });
        }
        throw e;
      }
    }
    if (relativePath === '/onboarding/session' && method === 'GET') {
      return this.json(res, 200, { ok: true, data: svc.render() });
    }
    if (relativePath === '/onboarding/session/event' && method === 'POST') {
      const body = (await this.readBody(req)) as {
        event?: unknown;
        stepData?: Record<string, unknown>;
      };
      const ev = body.event as { kind?: unknown } | undefined;
      if (!ev || typeof ev.kind !== 'string') {
        return this.json(res, 400, { ok: false, error: 'onboarding_bad_event: event.kind 必填' });
      }
      try {
        const render = await svc.submit(
          ev as Parameters<OnboardingService['submit']>[0],
          (body.stepData ?? undefined) as Parameters<OnboardingService['submit']>[1],
        );
        return this.json(res, 200, { ok: true, data: render });
      } catch (e) {
        if (e instanceof OnboardingStepInvalidError) {
          const status = e.message.startsWith('wizard_closed') ? 403 : 400;
          return this.json(res, status, { ok: false, error: `onboarding_step_invalid: ${e.message}` });
        }
        throw e; // 落盘/探针故障走统一 500 面（fail-loud，不吞）
      }
    }
    return this.json(res, 404, { ok: false, error: 'not_found' });
  }

  /**
   * registry 路由（arch/multi-tenancy.md §5/§9）。
   *
   * 鉴权两层：/api/v1 整体随上游 apiKey 闸（宿主面）；/registry/* 再叠租户身份层
   * （Bearer token 会话，register/login 签发）。MVP 鉴权=token 会话+名称直登
   * （演练级；口令/SSO 属 P3 替换）。跨租户边界由 RegistryService fail-loud。
   */
  private async handleRegistry(
    req: IncomingMessage,
    res: ServerResponse,
    relativePath: string,
    method: string,
  ): Promise<boolean> {
    const registry = this.gateway.getRegistry();
    if (!registry) {
      return this.json(res, 503, { ok: false, error: 'registry_not_ready: RegistryService is not started' });
    }

    const sendError = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('_not_found')
        ? 404
        : msg.startsWith('registry_forbidden')
          ? 403
          : msg.startsWith('registry_cross_tenant') ||
              msg.startsWith('registry_invalid') ||
              msg.includes('_required') ||
              msg.startsWith('registry_empty')
            ? 400
            : msg.includes('UNIQUE constraint failed') || msg.includes('_exists')
              ? 409
              : 500;
      return this.json(res, status, { ok: false, error: msg });
    };

    // ── 公开端点：注册（一用户一租户）/ 登录 ──
    if (relativePath === '/registry/register' && method === 'POST') {
      const body = await this.readBody(req);
      if (typeof body?.name !== 'string') {
        return this.json(res, 400, { ok: false, error: 'name is a required string' });
      }
      try {
        const { tenant, user } = registry.registerUser({ name: body.name });
        const token = registry.issueToken(user.userId);
        return this.json(res, 201, { ok: true, data: { tenant, user, token } });
      } catch (err) {
        return sendError(err);
      }
    }
    if (relativePath === '/registry/login' && method === 'POST') {
      const body = await this.readBody(req);
      if (typeof body?.name !== 'string') {
        return this.json(res, 400, { ok: false, error: 'name is a required string' });
      }
      // 密码登录（product-onboarding.md §6）：(tenant, name) + password；失败一律 401
      // invalid_credentials 不区分原因（防枚举，评审 M4）+ 失败退避（M5 最小限流）
      if (typeof body?.password === 'string' && body.password) {
        const authed = await registry.authenticate({
          ...(typeof body?.tenant === 'string' && body.tenant ? { tenant: body.tenant } : {}),
          name: body.name,
          password: body.password,
        });
        if (!authed) {
          await new Promise((r) => setTimeout(r, 500)); // 简单退避；完整限流随安全面
          return this.json(res, 401, { ok: false, error: 'invalid_credentials' });
        }
        return this.json(res, 200, {
          ok: true,
          data: { user: authed, token: registry.issueToken(authed.userId, 30 * 24 * 3600 * 1000) },
        });
      }
      // 免密名登录：仅 loopback + 未设密码用户（M12：远程一律 401，不发「用户名存在」信号）
      const remote = req.socket?.remoteAddress ?? '';
      const isLoopback = remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      const user = isLoopback ? registry.getUserByName(body.name) : undefined;
      if (!user || registry.hasPassword(user.userId)) {
        await new Promise((r) => setTimeout(r, 500));
        return this.json(res, 401, { ok: false, error: 'invalid_credentials' });
      }
      return this.json(res, 200, {
        ok: true,
        data: { user, token: registry.issueToken(user.userId, 30 * 24 * 3600 * 1000) },
      });
    }

    // ── 租户身份层：以下端点要求 X-Registry-Token ──
    // （不复用 Authorization——那是宿主 apiKey 闸的凭证通道，两层各走各的头；
    //   protocols/http.ts checkAuth 用 Bearer <apiKey>，混用会撞车，2026-11-13 评审实证）
    const auth = req.headers['x-registry-token'];
    const token = typeof auth === 'string' ? auth.trim() : '';
    const user = token ? registry.resolveToken(token) : null;
    if (!user) {
      return this.json(res, 401, {
        ok: false,
        error: 'unauthorized: X-Registry-Token required (POST /registry/register or /registry/login)',
      });
    }

    if (relativePath === '/registry/me' && method === 'GET') {
      return this.json(res, 200, { ok: true, data: { user } });
    }
    if (relativePath === '/registry/logout' && method === 'POST') {
      registry.revokeToken(token);
      return this.json(res, 200, { ok: true, data: { revoked: true } });
    }

    if (relativePath === '/registry/agents' && method === 'GET') {
      return this.json(res, 200, {
        ok: true,
        data: registry.listAgents({ tenantId: user.tenantId, viewerUserId: user.userId }),
      });
    }
    if (relativePath === '/registry/agents' && method === 'POST') {
      const body = await this.readBody(req);
      if (typeof body?.name !== 'string') {
        return this.json(res, 400, { ok: false, error: 'name is a required string' });
      }
      try {
        const agent = registry.createAgent({
          tenantId: user.tenantId,
          ownerUserId: user.userId,
          name: body.name,
          ...(typeof body.definition === 'string' ? { definition: body.definition } : {}),
          ...(body.visibility === 'private' || body.visibility === 'tenant'
            ? { visibility: body.visibility }
            : {}),
          ...(typeof body.homeRef === 'string' ? { homeRef: body.homeRef } : {}),
        });
        // T2 运行时装配：物化 + 注册；定义不完整/非法时显式降级（数据面已建，PATCH/startup 重试）
        const attach = await this.attachWithDegrade(agent);
        return this.json(res, 201, {
          ok: true,
          data: {
            ...agent,
            runtimeAttached: attach.attached,
            ...(attach.error ? { runtimeAttachError: attach.error } : {}),
          },
        });
      } catch (err) {
        return sendError(err);
      }
    }
    if (relativePath.startsWith('/registry/agents/')) {
      const agentId = relativePath.slice('/registry/agents/'.length) as AgentId;
      if (!agentId) return this.json(res, 400, { ok: false, error: 'agent id is required' });
      try {
        if (method === 'PATCH') {
          const body = await this.readBody(req);
          const patch: {
            name?: string;
            definition?: string;
            visibility?: 'private' | 'tenant';
            homeRef?: string | null;
          } = {};
          if (typeof body.name === 'string') patch.name = body.name;
          if (typeof body.definition === 'string') patch.definition = body.definition;
          if (body.visibility === 'private' || body.visibility === 'tenant') patch.visibility = body.visibility;
          if (body.homeRef === null || typeof body.homeRef === 'string') patch.homeRef = body.homeRef;
          const updated = registry.updateAgent({ agentId, viewerUserId: user.userId, patch });
          // 定义变更才重物化 + 重注册（评审 MIN-5：name/visibility 更新不动运行时）
          if (patch.definition === undefined) {
            return this.json(res, 200, { ok: true, data: updated });
          }
          const attach = await this.attachWithDegrade(updated);
          return this.json(res, 200, {
            ok: true,
            data: {
              ...updated,
              runtimeAttached: attach.attached,
              ...(attach.error ? { runtimeAttachError: attach.error } : {}),
            },
          });
        }
        if (method === 'DELETE') {
          const deleted = registry.deleteAgent({ agentId, viewerUserId: user.userId });
          if (deleted) {
            this.gateway.detachRegistryAgent(agentId as string);
          }
          return this.json(res, 200, { ok: true, data: { deleted } });
        }
        return this.json(res, 405, { ok: false, error: `method ${method} not allowed` });
      } catch (err) {
        return sendError(err);
      }
    }

    if (relativePath === '/registry/bindings' && method === 'GET') {
      return this.json(res, 200, { ok: true, data: registry.listBindings({ tenantId: user.tenantId }) });
    }
    if (relativePath === '/registry/bindings' && method === 'POST') {
      const body = await this.readBody(req);
      if (typeof body?.platform !== 'string' || typeof body?.identity !== 'string' || typeof body?.agentId !== 'string') {
        return this.json(res, 400, {
          ok: false,
          error: 'platform, identity and agentId are required strings',
        });
      }
      // sessionPolicy 与 PATCH 同校验：非法值 400 明示，不静默落 per-user
      if (
        body.sessionPolicy !== undefined &&
        body.sessionPolicy !== 'per-user' &&
        body.sessionPolicy !== 'per-chat' &&
        body.sessionPolicy !== 'per-message'
      ) {
        return this.json(res, 400, {
          ok: false,
          error: `registry_invalid_session_policy: ${String(body.sessionPolicy)}`,
        });
      }
      try {
        const binding = registry.createBinding({
          tenantId: user.tenantId,
          platform: body.platform,
          identity: body.identity,
          agentId: body.agentId as AgentId,
          ...(body.sessionPolicy === 'per-user' || body.sessionPolicy === 'per-chat' || body.sessionPolicy === 'per-message'
            ? { sessionPolicy: body.sessionPolicy }
            : {}),
        });
        return this.json(res, 201, { ok: true, data: binding });
      } catch (err) {
        return sendError(err);
      }
    }

    // ── 知识面（T3b，arch/multi-tenancy.md §6）：platform|tenant 两级所有权 + 租户内挂载 ──
    // 物化纪律：registry=定义面，knowledge.db=执法面；写路径同步物化，
    // 补偿方向永远朝「少可见」（物化失败撤记录；卸载先撤执法再删记录）。
    const ownerTenantOf = (scope: 'platform' | 'tenant'): string =>
      scope === 'platform' ? 'platform' : user.tenantId;

    if (relativePath === '/registry/knowledge-sources' && method === 'GET') {
      return this.json(res, 200, {
        ok: true,
        data: registry.listKnowledgeSources({
          viewerTenantId: user.tenantId,
          isPlatformAdmin: user.isPlatformAdmin,
        }),
      });
    }

    if (relativePath === '/registry/knowledge-sources' && method === 'POST') {
      const body = await this.readBody(req);
      if (typeof body?.name !== 'string' || typeof body?.location !== 'string') {
        return this.json(res, 400, { ok: false, error: 'name and location are required strings' });
      }
      const scope: 'platform' | 'tenant' = body.scope === 'platform' ? 'platform' : 'tenant';
      if (scope === 'platform' && !user.isPlatformAdmin) {
        return this.json(res, 403, {
          ok: false,
          error: 'registry_forbidden: platform sources are managed by platform admin',
        });
      }
      const kind = typeof body.kind === 'string' && body.kind ? body.kind : 'directory';
      const ownerTenant = ownerTenantOf(scope);
      const client = await this.gateway.getKnowledgeClient();
      let knowledgeId: string;
      try {
        const created = await client.createSource(
          {
            kind,
            location: body.location,
            // 缺省 = 本租户公共（§6）；body 可给 project/session 级（挂载库语义）
            scopeRef:
              body.scopeRef?.level === 'project' || body.scopeRef?.level === 'session'
                ? { level: body.scopeRef.level, key: String(body.scopeRef.key ?? '') }
                : { level: 'global', key: 'global' },
            displayName: body.name,
            ...(typeof body.description === 'string' ? { description: body.description } : {}),
          },
          { tenantId: ownerTenant },
        );
        knowledgeId = String(created.id);
      } catch (err) {
        return sendError(err);
      }
      try {
        const source = registry.createKnowledgeSource({
          scope,
          ...(scope === 'tenant' ? { tenantId: user.tenantId } : {}),
          name: body.name,
          sourceId: knowledgeId,
        });
        return this.json(res, 201, { ok: true, data: source });
      } catch (err) {
        // 补偿：定义面拒绝则撤执法行（不孤儿）。补偿失败必须大声（评审 MIN：孤儿源
        // scopeRef=global 会立即对本租户全可见——静默吞错=扩大泄漏面）
        try {
          await client.deleteSource(knowledgeId, { tenantId: ownerTenant });
        } catch (compErr) {
          console.error(
            `[WebApi] knowledge-source compensation failed for ${knowledgeId}: ${compErr instanceof Error ? compErr.message : String(compErr)}; orphan source remains visible — remove manually`,
          );
        }
        return sendError(err);
      }
    }

    if (relativePath.startsWith('/registry/knowledge-sources/') && method === 'DELETE') {
      const sourceId = relativePath.slice('/registry/knowledge-sources/'.length);
      try {
        const source = registry.assertKnowledgeSourceAccess({
          sourceId,
          viewerTenantId: user.tenantId,
          isPlatformAdmin: user.isPlatformAdmin,
        });
        const ownerTenant = ownerTenantOf(source.scope);
        const client = await this.gateway.getKnowledgeClient();
        // 先撤执法行（少可见方向），再删定义记录。执法已删视作达成（幂等重试——
        // 评审 MIN：上次执法删成功而定义删失败时，重试不得永久卡在 source_not_found）
        try {
          await client.deleteSource(sourceId, { tenantId: ownerTenant });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/source_not_found|not found/i.test(message)) throw err;
        }
        const deleted = registry.deleteKnowledgeSource({
          sourceId,
          viewerTenantId: user.tenantId,
          isPlatformAdmin: user.isPlatformAdmin,
        });
        return this.json(res, 200, { ok: true, data: { deleted } });
      } catch (err) {
        return sendError(err);
      }
    }

    if (relativePath === '/registry/mounts' && method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://local');
      const consumerType = url.searchParams.get('consumerType');
      const consumerId = url.searchParams.get('consumerId');
      const sourceId = url.searchParams.get('sourceId');
      return this.json(res, 200, {
        ok: true,
        data: registry.listMounts({
          tenantId: user.tenantId,
          ...(consumerType === 'agent' || consumerType === 'project' || consumerType === 'session'
            ? { consumerType }
            : {}),
          ...(consumerId ? { consumerId } : {}),
          ...(sourceId ? { sourceId } : {}),
        }),
      });
    }

    if (relativePath === '/registry/mounts' && method === 'POST') {
      const body = await this.readBody(req);
      const consumerType = body?.consumerType;
      if (consumerType !== 'agent' && consumerType !== 'session' && consumerType !== 'project') {
        return this.json(res, 400, { ok: false, error: 'consumerType must be agent|session|project' });
      }
      if (consumerType === 'project') {
        // fail-loud（NIT-3 教训）：项目挂载的检索物化在知识面项目模型（scopeRef 1:1）下
        // 无诚实落点——记录面随项目模型演进后开放，不做假成功
        return this.json(res, 501, {
          ok: false,
          error: 'not_implemented: project mounts materialization lands with the project model (arch/multi-tenancy.md §10.3)',
        });
      }
      if (typeof body?.consumerId !== 'string' || typeof body?.sourceId !== 'string') {
        return this.json(res, 400, { ok: false, error: 'consumerId and sourceId are required strings' });
      }
      if (consumerType === 'session' && typeof body?.agentId !== 'string') {
        return this.json(res, 400, {
          ok: false,
          error: 'agentId is required for session mounts (materialization target)',
        });
      }
      try {
        const mount = registry.createMount({
          tenantId: user.tenantId,
          consumerType,
          consumerId: body.consumerId,
          sourceType: body.sourceType === 'project' ? 'project' : 'knowledge',
          sourceId: body.sourceId,
          // session 挂载的反物化锚（评审 MAJ-1：body.agentId 校验了却漏传 → 恒 400）
          ...(consumerType === 'session' ? { agentRef: String(body.agentId) } : {}),
        });
        try {
          const client = await this.gateway.getKnowledgeClient();
          if (consumerType === 'agent') {
            await client.setAgentVisibility(mount.consumerId, 'mount', mount.sourceId, {
              tenantId: user.tenantId,
            });
          } else {
            await client.setSessionVisibility(
              body.agentId as string,
              {
                sessionId: mount.consumerId,
                targetType: 'source',
                targetId: mount.sourceId,
                op: 'include',
              },
              { tenantId: user.tenantId },
            );
          }
        } catch (err) {
          // 补偿：物化失败撤定义记录（不留下无执法的挂载承诺）
          registry.deleteMount({ mountId: mount.mountId, tenantId: user.tenantId });
          return sendError(err);
        }
        return this.json(res, 201, { ok: true, data: mount });
      } catch (err) {
        return sendError(err);
      }
    }

    if (relativePath.startsWith('/registry/mounts/') && method === 'DELETE') {
      const mountId = relativePath.slice('/registry/mounts/'.length) as import('@octopi-agent/engine/harness/governance/registry/types.js').MountId;
      try {
        const mount = registry.getMount(mountId);
        if (!mount || mount.tenantId !== user.tenantId) {
          return this.json(res, 404, { ok: false, error: 'registry_mount_not_found' });
        }
        // 先撤执法（少可见方向）再删定义记录
        const client = await this.gateway.getKnowledgeClient();
        if (mount.consumerType === 'agent') {
          await client.setAgentVisibility(mount.consumerId, 'unmount', mount.sourceId, {
            tenantId: user.tenantId,
          });
        } else if (mount.consumerType === 'session') {
          if (!mount.agentRef) {
            // fail-loud（评审 MAJ-2）：无反物化锚就删定义会把 include 行永久留在知识面——
            // 宁可挡住删除，不制造不可撤的越权可见
            return this.json(res, 409, {
              ok: false,
              error: 'registry_mount_agent_ref_missing: cannot reverse materialization; fix the mount row first',
            });
          }
          await client.clearSessionVisibility(
            mount.agentRef,
            mount.consumerId,
            { targetType: 'source', targetId: mount.sourceId },
            { tenantId: user.tenantId },
            'include',
          );
        }
        const deleted = registry.deleteMount({ mountId, tenantId: user.tenantId });
        return this.json(res, 200, { ok: true, data: { deleted } });
      } catch (err) {
        return sendError(err);
      }
    }

    // ── 渠道绑定面（arch/multi-tenancy.md §9 + service-topology-p2 §2.3 ②）：
    // bindings 表 = 渠道路由真相源；(tenantId, platform, identity) → agentId + 会话策略 ──
    const bindingMatch = /^\/registry\/bindings\/([^/]+)$/.exec(relativePath);
    if (bindingMatch) {
      const bindingId = bindingMatch[1] as BindingId;
      try {
        if (method === 'GET') {
          const binding = registry.getBinding(bindingId);
          if (!binding || (binding.tenantId !== user.tenantId && !user.isPlatformAdmin)) {
            return this.json(res, 404, { ok: false, error: 'registry_binding_not_found' });
          }
          return this.json(res, 200, { ok: true, data: binding });
        }
        if (method === 'PATCH') {
          const body = await this.readBody(req);
          const patch: { agentId?: AgentId; sessionPolicy?: SessionPolicy } = {};
          if (typeof body?.agentId === 'string') patch.agentId = body.agentId as AgentId;
          if (body?.sessionPolicy !== undefined) {
            if (
              body.sessionPolicy !== 'per-user' &&
              body.sessionPolicy !== 'per-chat' &&
              body.sessionPolicy !== 'per-message'
            ) {
              return this.json(res, 400, {
                ok: false,
                error: `registry_invalid_session_policy: ${String(body.sessionPolicy)}`,
              });
            }
            patch.sessionPolicy = body.sessionPolicy;
          }
          if (patch.agentId === undefined && patch.sessionPolicy === undefined) {
            return this.json(res, 400, {
              ok: false,
              error: 'nothing to patch: provide agentId and/or sessionPolicy',
            });
          }
          // MIN-7：平台 admin 可跨租户管（对齐知识面口径）；binding 归属域用行内域
          const existing = registry.getBinding(bindingId);
          if (!existing || (existing.tenantId !== user.tenantId && !user.isPlatformAdmin)) {
            return this.json(res, 404, { ok: false, error: 'registry_binding_not_found' });
          }
          const updated = registry.updateBinding({ bindingId, tenantId: existing.tenantId, patch });
          return this.json(res, 200, { ok: true, data: updated });
        }
        if (method === 'DELETE') {
          const existing = registry.getBinding(bindingId);
          if (!existing || (existing.tenantId !== user.tenantId && !user.isPlatformAdmin)) {
            return this.json(res, 404, { ok: false, error: 'registry_binding_not_found' });
          }
          const deleted = registry.deleteBinding({ bindingId, tenantId: existing.tenantId });
          return this.json(res, 200, { ok: true, data: { deleted } });
        }
      } catch (err) {
        return sendError(err);
      }
    }

    return this.json(res, 404, { ok: false, error: `registry route not found: ${relativePath}` });
  }

  /**
   * registry agent 运行时挂载（显式降级：失败不吞，如实返回状态与原因供响应面携带）。
   *
   * @param agent - registry agent 记录
   * @returns 是否挂上；失败时附原因（响应面 `runtimeAttachError`）
   */
  private async attachWithDegrade(
    agent: import('@octopi-agent/engine/harness/governance/registry/types.js').AgentRecord,
  ): Promise<{ attached: boolean; error?: string }> {
    try {
      return { attached: await this.gateway.attachRegistryAgent(agent) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[WebApi] registry agent ${String(agent.agentId)} runtime attach failed: ${message}`,
      );
      return { attached: false, error: message };
    }
  }

  private json(res: ServerResponse, status: number, payload: unknown): boolean {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
    return true;
  }
}
