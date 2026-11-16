/**
 * Onboarding 落盘/播种/探针 — engine 侧动作面（评审 M2 抽取）。
 *
 * CLI 与 Web 向导的动作完全同源：渲染器只采集 choices，落盘（.env + 配置）、
 * 部署模式播种、连接探针都从本模块走。整文件 schema 校验由调用方注入
 * （deps.validateConfig）——完整 octopi.json 的 compose schema 在套件层，
 * engine 不反向依赖 gateway/webui 片段。
 *
 * @module
 */

import { readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { apiKeyEnvVar, assembleOnboarding } from './onboarding.js';
import type { OnboardingChoices, OnboardingOutput } from './onboarding.js';
import { expandEnvValues } from './env.js';
import { classifyErrorKind } from './error-copy.js';
import { createProviderFromConfig } from '../config.js';

/**
 * 探针错误四类归并（§5 映射）。
 * 分类实现单源在 `error-copy.ts`（probe 语境无 'context'，出现时归 'server'）。
 */
export function classifyProbeError(err: Error): 'network' | 'auth' | 'model' | 'server' {
  const kind = classifyErrorKind(err.message);
  return kind === 'context' ? 'server' : kind;
}

/** 写一行 .env（0600；同名替换、异名追加） */
export function writeEnvLine(octopiHome: string, line: string): void {
  const envPath = join(octopiHome, '.env');
  // MINOR-3：容忍 `export KEY=…` 声明形；无 `=` fail-loud（此前静默截断成坏键）
  const normalized = line.trim().replace(/^export\s+/, '');
  const eq = normalized.indexOf('=');
  if (eq <= 0) throw new Error(`writeEnvLine_invalid: 需要 KEY=VALUE 形式（收到：${normalized.slice(0, 20)}…）`);
  const key = normalized.slice(0, eq);
  let content = '';
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    // 无 .env：新建（下方 mode 0600 生效）
  }
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  const idx = lines.findIndex((l) => l.trim().replace(/^export\s+/, '').startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = normalized;
  else lines.push(normalized);
  // 先写临时文件再 rename：避免半截 .env + 避免 umask 窗口暴露明文 key
  const tmp = `${envPath}.tmp`;
  writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  renameSync(tmp, envPath);
  // 同步进程 env（评审 B3）：热应用 applyFromDisk 经 expandEnvValues 读 process.env——
  // 只写盘不进进程会用空/旧 key 重建 provider。向导显式写入的值即用户意图，立即生效。
  process.env[key] = normalized.slice(eq + 1);
}

/**
 * 合入 octopi.json（B3 全接线 + M15 落盘前 schema 校验 + m6 entry 级合并）。
 *
 * @param configPath - 目标配置文件
 * @param output - 向导产出
 * @param validateConfig - 整文件 schema 校验器（fail-loud；套件层注入 compose schema）
 * @throws 合并结果未过校验（不写坏文件）
 */
export function mergeConfigFragment(
  configPath: string,
  output: OnboardingOutput,
  validateConfig: (raw: Record<string, unknown>) => void,
): void {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    // B-4：只吞「文件不存在」（首启由向导创建）；语法错/权限错必须抛——否则损坏配置会被空对象覆盖丢失
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const models = { ...((raw.models as Record<string, unknown>) ?? {}) } as Record<string, unknown>;
  const providers = { ...((models.providers as Record<string, unknown>) ?? {}) } as Record<string, unknown>;
  for (const [name, cfg] of Object.entries(output.configFragment.providers) as Array<[string, Record<string, unknown>]>) {
    // entry 级合并：向导拥有 baseUrl/apiKey/models，既有 timeoutSeconds/options 保留（m6）
    providers[name] = { ...((providers[name] as Record<string, unknown>) ?? {}), ...cfg };
  }
  models.providers = providers;
  // B3：档位与 agent model 接线到所选 provider/model
  // M-10：档位 entry 级合并（整档替换会丢 fallbacks 等既有字段）
  const levels = (models.level ?? {}) as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(output.configFragment.levels)) {
    levels[k] = { ...(levels[k] ?? {}), ...(v as Record<string, unknown>) };
  }
  models.level = levels;
  raw.models = models;
  // M-10：只给 default agent 指模型（此前打平全部 agent 的 model——多 agent 配置被静默改写）
  if (Array.isArray(raw.agents)) {
    raw.agents = (raw.agents as Array<Record<string, unknown>>).map((a) =>
      a && typeof a === 'object' && (a.id === 'default' || a.id === undefined)
        ? { ...a, model: output.configFragment.agentModel }
        : a,
    );
  }
  raw.language = output.configFragment.language;
  raw.deploymentMode = output.configFragment.deploymentMode;

  // M15：落盘前 schema 校验 fail-loud（坏配置留在盘上比不落盘更难查）
  validateConfig(raw);
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

/**
 * 部署模式播种（§4）：①default 自助面（tenant/user id = 'default'，DEFAULT_TENANT_ID 语义，M11）；
 * ②③组织 + admin（带密码）。幂等；撞名（他域已有同名 admin）fail-loud 且给出可执行出路（M10）。
 *
 * @param octopiHome - OCTOPI_HOME（registry.db 所在）
 * @param choices - 向导选择
 * @param opts - 播种选项（adminName 覆盖，默认 admin / OCTOPI_ADMIN_NAME）
 * @returns 播种归属（tenantId + ownerUserId——demo 任务包等下游复用，单源不另猜）
 * @throws 模式②③无密码、或 admin 名被其他组织占用
 */
export async function seedDeploymentRegistry(
  octopiHome: string,
  choices: OnboardingChoices,
  opts?: { adminName?: string },
): Promise<{ tenantId: string; ownerUserId: string }> {
  const { RegistryService } = await import('../harness/governance/registry/service.js');
  const registry = await RegistryService.create({ dbPath: join(octopiHome, 'registry.db') });
  try {
    const adminName = opts?.adminName ?? process.env.OCTOPI_ADMIN_NAME ?? 'admin';
    if (choices.deploymentMode === 'personal') {
      // M11：显式 'default' 租户/用户（与 core DEFAULT_TENANT_ID 同一 ID 空间）
      const tenant = registry.ensureTenant('default', 'default');
      const existing = registry.getUserInTenant(tenant.tenantId, 'default');
      const user = existing ?? (await registry.createUserInTenant({ tenantId: tenant.tenantId, name: 'default', isPlatformAdmin: true }));
      // M12：personal 远程绑定强制设密码（收进来的 adminPassword 即 default 用户密码）
      if (choices.adminPassword) await registry.setUserPassword((registry.getUserInTenant(tenant.tenantId, 'default'))!.userId, choices.adminPassword);
      return { tenantId: tenant.tenantId, ownerUserId: user.userId };
    }
    const tenantName = choices.deploymentMode === 'multi-organization' ? (choices.orgName ?? 'default') : 'default';
    const tenant = registry.ensureTenant(tenantName, tenantName === 'default' ? 'default' : undefined);
    if (!choices.adminPassword) throw new Error('onboarding_admin_password_required: ②③模式 admin 必须设密码');
    const existing = registry.getUserInTenant(tenant.tenantId, adminName);
    if (existing) {
      await registry.setUserPassword(existing.userId, choices.adminPassword);
      return { tenantId: tenant.tenantId, ownerUserId: existing.userId };
    }
    const elsewhere = registry.getUserByName(adminName);
    if (elsewhere && elsewhere.tenantId !== tenant.tenantId) {
      // M10：绝不跨租户覆写密码；给出可执行出路
      throw new Error(
        `registry_admin_name_taken: 用户名 ${adminName} 已被其他组织占用——重跑并指定 OCTOPI_ADMIN_NAME=<其他名字>`,
      );
    }
    const created = await registry.createUserInTenant({
      tenantId: tenant.tenantId,
      name: adminName,
      password: choices.adminPassword,
      isPlatformAdmin: true,
    });
    return { tenantId: tenant.tenantId, ownerUserId: created.userId };
  } finally {
    registry.close();
  }
}

/**
 * 探针（§5 测通内核）：expandEnvValues 展开后建 provider 做一次可用性检查（B1）。
 *
 * @param choices - 当前选择
 * @returns 'ok' 或错误四类归并
 */
export async function probeProvider(choices: OnboardingChoices): Promise<'ok' | 'network' | 'auth' | 'model' | 'server'> {
  const envVar = apiKeyEnvVar(choices.providerId);
  const prevEnv = envVar ? process.env[envVar] : undefined;
  try {
    if (envVar && choices.apiKey) process.env[envVar] = choices.apiKey.trim();
    const { configFragment } = assembleOnboarding(choices);
    // B1：createProviderFromConfig 不做 env 展开——必须先展开，否则 ${VAR} 字面量进 Authorization 头恒 401
    const providerCfg = expandEnvValues(Object.values(configFragment.providers)[0] as Record<string, unknown>);
    try {
      const provider = await createProviderFromConfig(choices.providerId, providerCfg as never, {});
      const ok = await provider.isAvailable();
      return ok ? 'ok' : 'server';
    } catch (err) {
      return classifyProbeError(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    // M-1：探针只借用 env——长驻 daemon 不得残留密钥（tool 子进程默认继承 process.env）
    if (envVar) {
      if (prevEnv === undefined) delete process.env[envVar];
      else process.env[envVar] = prevEnv;
    }
  }
}

/**
 * 配置里是否绑定非本机地址（M12：personal 远程绑定强制设密码的判定）
 *
 * @param configPath - 配置文件路径
 * @returns web/channels 任一 host 为 lan/0.0.0.0 时 true
 */
export function isRemoteBind(configPath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      web?: { host?: string };
      channels?: Array<{ type?: string; host?: string }>;
    };
    const hosts = [raw.web?.host, ...(raw.channels ?? []).map((c) => c.host)];
    return hosts.some((h) => h === 'lan' || h === '0.0.0.0');
  } catch {
    return false;
  }
}

/** applyOnboarding 依赖（渲染器/宿主注入；测试可替换） */
export interface ApplyOnboardingDeps {
  configPath: string;
  octopiHome: string;
  /** 管理员名（默认 admin；撞名时的可执行出路，M10） */
  adminName?: string;
  /** 整文件 schema 校验器（fail-loud；套件层注入 compose schema，engine 不反向依赖） */
  validateConfig: (raw: Record<string, unknown>) => void;
}

/**
 * 一次性落盘 + 播种（commit 点统一入口——B2 顺序：.env → 配置 → 播种）。
 *
 * @param choices - 完整选择（须先过 validateStep 全链）
 * @param deps - 动作依赖
 * @returns 播种附带的非致命警告（demo 任务包播种失败时给出；主配置与部署播种已落盘）
 * @throws 组装失败 / 校验失败 / 播种撞名（fail-loud，不产半截配置）
 */
export async function applyOnboarding(
  choices: OnboardingChoices,
  deps: ApplyOnboardingDeps,
): Promise<{ demoWarning?: string }> {
  // M-4：个人模式 + 远程绑定 = 裸奔，强制设密码（M12 服务端 enforce——CLI/Web 同受，此前只在 CLI 渲染层）
  if (
    choices.deploymentMode === 'personal' &&
    isRemoteBind(deps.configPath) &&
    !String(choices.adminPassword ?? '').trim()
  ) {
    throw new Error('onboarding_password_required: 远程可访问的个人部署必须设置密码（否则任何人可直接使用）');
  }
  const output = assembleOnboarding(choices);
  for (const line of output.envLines) writeEnvLine(deps.octopiHome, line);
  mergeConfigFragment(deps.configPath, output, deps.validateConfig);
  // registry 播种是主成果（fail-loud）；owner 归属复用其返回值（单源——不另猜）
  const owner = await seedDeploymentRegistry(deps.octopiHome, choices, deps);
  // 演示任务包（批 3-1）：demo agent + 样例资料。降级显式——失败不回滚主成果，
  // 但警告必须透出到完成页（fail-loud 的软形态：不静默吞）。
  try {
    const { seedDemoKit } = await import('./demo-kit.js');
    await seedDemoKit({
      octopiHome: deps.octopiHome,
      tenantId: owner.tenantId,
      ownerUserId: owner.ownerUserId,
      lang: choices.lang === 'en' ? 'en' : 'zh',
    });
    return {};
  } catch (err) {
    return { demoWarning: `demo_seed_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
