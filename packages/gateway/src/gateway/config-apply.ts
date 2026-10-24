/**
 * ConfigApplyService — 配置热应用编排（arch/config-hot-reload.md §2-3）
 *
 * 流程：写盘（ConfigAdminPort：乐观锁 + 全量校验 + 备份）→ 热应用（gateway
 * L0/L1/L2 注册表更新）。写失败不动运行时（fail-safe）。
 *
 * @module
 */
import type { Gateway } from './gateway.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { ConfigAdminPort } from '@octopi-agent/engine/config-admin/port.js';
import {
  deleteJsonPath,
  findProviderReferences,
  getJsonPath,
  setJsonPath,
} from '@octopi-agent/engine/config-admin/patch.js';
import { expandEnvPlaceholders } from '@octopi-agent/engine/config-admin/env.js';
import { redactProvider } from '@octopi-agent/engine/config-admin/redact.js';
import {
  discoverProviderModels,
  type DiscoverModelsResult,
} from '@octopi-agent/engine/config-admin/discover.js';

/** 统一热应用结果（WebUI 据 applied 展示生效状态） */
export interface ConfigApplyResult {
  /** 写后 hash（供后续编辑做乐观锁） */
  hash: string;
  /** 生效方式：hot=立即 / next-run=新 run 生效 */
  applied: 'hot' | 'next-run';
  /** 受影响 agent id（新 run 生效范围） */
  affectedAgents: string[];
  /** 备份文件路径 */
  backupPath: string;
}

/** ConfigApplyService 依赖（组合根注入） */
export interface ConfigApplyServiceDeps {
  gateway: Gateway;
  configAdmin: ConfigAdminPort;
  /** provider 工厂（daemon 注入，带 wireDump 装饰） */
  providerFactory: (
    name: string,
    providerConfig: Record<string, unknown>,
  ) => Promise<ModelProvider>;
}

/** 从 findProviderReferences 描述串提取 agent id（保守：同 agent 多引用只算一次） */
function extractAgentIds(refs: string[]): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    const m = /^agents\[([^\]]+)\]/.exec(ref);
    if (m) ids.add(m[1]!);
  }
  return [...ids];
}

export class ConfigApplyService {
  private readonly deps: ConfigApplyServiceDeps;

  /**
   * @param deps - gateway / configAdmin / providerFactory
   */
  constructor(deps: ConfigApplyServiceDeps) {
    this.deps = deps;
  }

  /**
   * 模型配置视图（apiKey 脱敏）+ 当前 hash
   *
   * @returns providers（脱敏）+ level + hash
   */
  getModelsView(): {
    providers: Array<ReturnType<typeof redactProvider>>;
    level: Record<string, unknown>;
    hash: string;
  } {
    const { raw, hash } = this.deps.configAdmin.read();
    const models = (raw.models ?? {}) as Record<string, unknown>;
    const providers = (models.providers ?? {}) as Record<string, Record<string, unknown>>;
    return {
      providers: Object.entries(providers).map(([name, pc]) => redactProvider(name, pc)),
      level: (models.level ?? {}) as Record<string, unknown>,
      hash,
    };
  }

  /**
   * upsert provider（L2）：写盘 → 热替换 → 失效引用 agent
   *
   * @param name - provider 名
   * @param providerConfig - provider 配置片段（含 apiKey；`${VAR}` 形态原样写）
   * @param expectedHash - 乐观锁
   * @returns 热应用结果
   * @throws {@link ConfigConflictError} 并发冲突；校验失败
   */
  async upsertProvider(
    name: string,
    providerConfig: Record<string, unknown>,
    expectedHash: string,
  ): Promise<ConfigApplyResult> {
    // 1) 预计算 merged（apiKey 未提供 = 保留现有值，UI「留空保留」语义，服务端单一处理点）
    //    + **先构造 provider**（工厂失败即中止，盘与运行时都不动——两侧永不分歧）
    const snapshot = this.deps.configAdmin.read();
    const existing = getJsonPath(snapshot.raw, ['models', 'providers', name]) as
      | Record<string, unknown>
      | undefined;
    const appliedConfig =
      providerConfig.apiKey === undefined && existing && typeof existing === 'object'
        ? { ...providerConfig, apiKey: existing.apiKey }
        : providerConfig;
    const provider = await this.deps.providerFactory(name, appliedConfig);

    // 2) 写盘（乐观锁 + 全量校验 + 备份）；失败 → 运行时未动
    let refsAfter: string[] = [];
    const written = await this.deps.configAdmin.write((raw) => {
      setJsonPath(raw, ['models', 'providers', name], appliedConfig);
      refsAfter = findProviderReferences(raw, name);
    }, expectedHash);

    // 3) 热应用
    const affected = extractAgentIds(refsAfter);
    await this.deps.gateway.replaceProvider(provider, appliedConfig, affected);
    return { hash: written.hash, applied: 'next-run', affectedAgents: affected, backupPath: written.backupPath };
  }

  /**
   * 删除 provider（L2）：引用完整性把关 → 写盘 → 热摘除
   *
   * @param name - provider 名
   * @param expectedHash - 乐观锁
   * @returns 热应用结果
   * @throws 有 agent 引用时拒绝（fail-loud）；{@link ConfigConflictError} 并发冲突
   */
  async deleteProvider(name: string, expectedHash: string): Promise<ConfigApplyResult> {
    const before = this.deps.configAdmin.read();
    const refs = findProviderReferences(before.raw, name);
    if (refs.length > 0) {
      throw new Error(`provider "${name}" is still referenced: ${refs.join(', ')}`);
    }
    const written = await this.deps.configAdmin.write((raw) => {
      deleteJsonPath(raw, ['models', 'providers', name]);
    }, expectedHash);
    await this.deps.gateway.removeProvider(name, []);
    return { hash: written.hash, applied: 'next-run', affectedAgents: [], backupPath: written.backupPath };
  }

  /**
   * 更新 level 路由：写盘 → 影子同步 → **全量重建 agent**（levelMap 被 builder 捕获，
   * 已建 agent 需重建才真正生效——不谎报 'hot'，如实返回 next-run）
   *
   * @param level - level 映射（primary/fallback），必须为对象（空体 400，防误清空）
   * @param expectedHash - 乐观锁
   * @returns 热应用结果
   */
  async updateLevels(
    level: Record<string, { primary: string; fallback?: string[] }>,
    expectedHash: string,
  ): Promise<ConfigApplyResult> {
    if (!level || typeof level !== 'object' || Array.isArray(level)) {
      throw new Error('level must be an object: level name → { primary, fallback? }');
    }
    const written = await this.deps.configAdmin.write((raw) => {
      setJsonPath(raw, ['models', 'level'], level);
    }, expectedHash);
    this.deps.gateway.setModelLevels(level);
    await this.deps.gateway.invalidateAllAgentBuilds();
    return { hash: written.hash, applied: 'next-run', affectedAgents: [], backupPath: written.backupPath };
  }

  /**
   * 连通测试 + 模型清单拉取（不落盘）
   *
   * 缺省字段（apiKey/baseUrl/api）回落到盘上已存 provider——编辑现有 provider
   * 测试时不必重填密钥（UI 回显脱敏拿不到明文）。
   *
   * @param name - provider 名（用于回落取已存配置）
   * @param providerConfig - 待测表单值（可未保存、可缺字段）
   * @returns 发现结果（ok=false 时含原因）
   */
  async testProvider(
    name: string,
    providerConfig: Record<string, unknown>,
  ): Promise<DiscoverModelsResult> {
    const stored = getJsonPath(this.deps.configAdmin.read().raw, ['models', 'providers', name]) as
      | Record<string, unknown>
      | undefined;
    const merged = { ...(stored ?? {}), ...providerConfig };
    const rawKey = typeof merged.apiKey === 'string' ? merged.apiKey : '';
    return discoverProviderModels({
      baseUrl: expandEnvPlaceholders(String(merged.baseUrl ?? '')),
      apiKey: expandEnvPlaceholders(rawKey),
      api: merged.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
    });
  }
}
