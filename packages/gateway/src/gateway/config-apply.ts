/**
 * ConfigApplyService — 配置热应用编排（arch/config-hot-reload.md §2-3）
 *
 * 流程：写盘（ConfigAdminPort：乐观锁 + 全量校验 + 备份）→ 热应用（gateway
 * L0/L1/L2 注册表更新）。写失败不动运行时（fail-safe）。
 *
 * @module
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Gateway } from './gateway.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import {
  ConfigConflictError,
  type ConfigAdminPort,
} from '@octopi-agent/engine/config-admin/port.js';
import {
  computeConfigHash,
  deleteJsonPath,
  findProviderReferences,
  getJsonPath,
  setJsonPath,
} from '@octopi-agent/engine/config-admin/patch.js';
import { expandEnvPlaceholders } from '@octopi-agent/engine/config-admin/env.js';
import { assertSafeConfigName } from '@octopi-agent/engine/config-admin/name-guard.js';
import { expandHomePath } from '@octopi-agent/engine/paths.js';
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

/** agent 文件态端口（daemon 注入 AgentFileAdmin；gateway 不做文件路径语义） */
export interface AgentFilesPort {
  /** agent 文件态标准路径（与 octopi init 同源：home / workspace / skills） */
  pathsOf(agentId: string): { home: string; workspace: string; skillDirectory: string };
  /** 建文件态（幂等）；agentsMd 仅在 AGENTS.md 不存在时写（不覆盖既有 persona） */
  scaffold(agentId: string, opts: { agentsMd?: string; workspace?: string }): Promise<void>;
  /** 读 AGENTS.md（home 指定时按 agent 配置的 home 解析）；不存在返回 null */
  readPersona(agentId: string, home?: string): string | null;
  /** 写 AGENTS.md（home 指定时按 agent 配置的 home 解析） */
  writePersona(agentId: string, content: string, home?: string): void;
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
  /** agent 文件态端口（scaffold / persona 读写） */
  agentFiles: AgentFilesPort;
  /**
   * raw agents[] 条目 → AgentDefinition（daemon 注入：包 normalize + resolveAgentDefinition）。
   * **写盘前预构造**（fail-safe：构造失败不动盘）；rawConfig 为 would-be 全量 raw。
   */
  agentDefFactory: (
    rawEntry: Record<string, unknown>,
    rawConfig: Record<string, unknown>,
  ) => AgentDefinition;
}

/** agent 创建请求 */
export interface CreateAgentRequest {
  /** agents[] 配置条目（与 octopi.json 同构） */
  agent: Record<string, unknown>;
  /** 初始 AGENTS.md 全文（角色模板渲染结果；缺省用脚手架默认模板） */
  agentsMd?: string;
  /** 乐观锁 hash */
  hash: string;
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

/**
 * agent id 合法化：实现见 engine config-admin/name-guard.ts（单一实现点）
 */

/** `~` 展开复用 engine/paths 的单一实现（#15） */

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

  /**
   * agent 列表视图（注册表唯一权威 + raw 条目补充）
   *
   * @returns 每个 agent 的 id / persona / model / effectMode / tools / traits + hash
   */
  getAgentsView(): {
    agents: Array<{
      id: string;
      persona: { name: string; description: string };
      model: unknown;
      effectMode: string;
      effectModeSource: 'agent' | 'global' | 'default';
      tools: { allow: string[]; deny: string[] };
      traits: string[];
    }>;
    hash: string;
  } {
    const { raw, hash } = this.deps.configAdmin.read();
    const rawAgents = Array.isArray(raw.agents) ? (raw.agents as Array<Record<string, unknown>>) : [];
    const registered = this.deps.gateway.getRegisteredAgents();
    const agents = registered.map((reg) => {
      const entry = rawAgents.find((a) => a.id === reg.id) ?? {};
      const persona = (entry.persona ?? {}) as { name?: string; description?: string };
      const tools = (entry.tools ?? {}) as { allow?: string[]; deny?: string[] };
      return {
        id: reg.id,
        persona: { name: persona.name ?? reg.id, description: persona.description ?? '' },
        model: reg.model,
        effectMode: reg.effectMode,
        effectModeSource: reg.effectModeSource,
        tools: { allow: tools.allow ?? [], deny: tools.deny ?? [] },
        traits: Array.isArray(entry.traits) ? (entry.traits as string[]) : [],
      };
    });
    return { agents, hash };
  }

  /**
   * 新增 agent（L1）：**预构造（fail-safe）→ 写盘 → scaffold → 注册 + 立即重建**
   *
   * 顺序保证：构造失败不动盘/文件；写盘失败不动文件态；scaffold 只在写盘成功后。
   * 条目自动补全 home/workspace/skillDirectory（与 octopi init 同源，persona 才会被加载）。
   *
   * @param req - 创建请求（agents[] 条目 + 可选渲染后 AGENTS.md + hash）
   * @returns 热应用结果（affectedAgents=[新 id]）
   * @throws id 缺失/非法/重名、model 无法解析、{@link ConfigConflictError} 并发冲突、校验失败
   */
  async createAgent(req: CreateAgentRequest): Promise<ConfigApplyResult> {
    const agentId = typeof req.agent.id === 'string' ? req.agent.id.trim() : '';
    assertSafeConfigName(agentId);
    const snapshot = this.deps.configAdmin.read();
    const rawAgents = Array.isArray(snapshot.raw.agents) ? (snapshot.raw.agents as Array<Record<string, unknown>>) : [];
    if (rawAgents.some((a) => a.id === agentId)) {
      throw new Error(`agent already exists: ${agentId}`);
    }

    // 条目归一化 + 三字段补全（#16 id 归一；#1 home/workspace/skillDirectory）
    const paths = this.deps.agentFiles.pathsOf(agentId);
    const entry: Record<string, unknown> = { ...req.agent, id: agentId };
    if (!entry.home) entry.home = paths.home;
    if (!entry.workspace) entry.workspace = paths.workspace;
    if (!entry.skillDirectory) entry.skillDirectory = paths.skillDirectory;

    // 预构造（失败即中止，盘与文件态都不动）
    const previewRaw = { ...snapshot.raw, agents: [...rawAgents, entry] };
    const def = this.deps.agentDefFactory(entry, previewRaw);

    // 写盘（乐观锁 + 全量校验）
    const written = await this.deps.configAdmin.write((raw) => {
      const agents = Array.isArray(raw.agents) ? (raw.agents as unknown[]) : [];
      agents.push(entry);
      raw.agents = agents;
    }, req.hash);

    // 文件态（写盘成功后；agentsMd 仅在 AGENTS.md 缺失时写，不覆盖既有 persona）
    await this.deps.agentFiles.scaffold(agentId, {
      agentsMd: req.agentsMd,
      workspace: typeof entry.workspace === 'string' ? expandHomePath(entry.workspace) : undefined,
    });

    // 热应用：注册 + 立即重建（触发路径零窗口）
    this.deps.gateway.registerAgent(def);
    await this.deps.gateway.invalidateAgentBuild(agentId);
    return {
      hash: written.hash,
      applied: 'next-run',
      affectedAgents: [agentId],
      backupPath: written.backupPath,
    };
  }

  /**
   * 更新 agent（L1）：**预构造 → 写盘（字段级合并）→ 注册 + 立即重建**
   *
   * 合并语义（UI 只发编辑字段，未展示字段如 home/skills/delegation 不丢）：
   * - `effectPolicy` **二级合并**（只改发来的旋钮，高级旋钮保留）
   * - 字段值 `null` = **删除该键**（如 `effectPolicy: null` 恢复继承全局）
   * - 其余顶层字段整体替换（persona/tools 等对象由调用方发全量）
   *
   * @param agentId - agent id
   * @param agentEntry - agents[] 条目变更字段（id 不可变）
   * @param expectedHash - 乐观锁
   * @returns 热应用结果
   * @throws agent 不存在、id 不符、model 无法解析、{@link ConfigConflictError} 并发冲突
   */
  async updateAgent(
    agentId: string,
    agentEntry: Record<string, unknown>,
    expectedHash: string,
  ): Promise<ConfigApplyResult> {
    assertSafeConfigName(agentId);
    if (agentEntry.id !== undefined && agentEntry.id !== agentId) {
      throw new Error(`agent id mismatch: ${agentId} != ${String(agentEntry.id)}`);
    }
    const snapshot = this.deps.configAdmin.read();
    const rawAgents = Array.isArray(snapshot.raw.agents) ? (snapshot.raw.agents as Array<Record<string, unknown>>) : [];
    const old = rawAgents.find((a) => a.id === agentId);
    if (!old) throw new Error(`agent not found: ${agentId}`);

    // 字段级合并（预计算一次；写入与构造用同一结果，两侧永不分歧）
    const mergedEntry: Record<string, unknown> = { ...old };
    for (const [key, value] of Object.entries(agentEntry)) {
      if (value === null) {
        delete mergedEntry[key];
      } else if (
        key === 'effectPolicy' &&
        value &&
        typeof value === 'object' &&
        mergedEntry.effectPolicy &&
        typeof mergedEntry.effectPolicy === 'object'
      ) {
        mergedEntry.effectPolicy = {
          ...(mergedEntry.effectPolicy as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      } else {
        mergedEntry[key] = value;
      }
    }
    mergedEntry.id = agentId;

    // 预构造（失败即中止，盘不动）
    const previewRaw = {
      ...snapshot.raw,
      agents: rawAgents.map((a) => (a.id === agentId ? mergedEntry : a)),
    };
    const def = this.deps.agentDefFactory(mergedEntry, previewRaw);

    const written = await this.deps.configAdmin.write((raw) => {
      const agents = Array.isArray(raw.agents) ? (raw.agents as Array<Record<string, unknown>>) : [];
      const idx = agents.findIndex((a) => a.id === agentId);
      if (idx < 0) throw new Error(`agent not found: ${agentId}`);
      agents[idx] = mergedEntry;
    }, expectedHash);

    this.deps.gateway.registerAgent(def);
    await this.deps.gateway.invalidateAgentBuild(agentId);
    return {
      hash: written.hash,
      applied: 'next-run',
      affectedAgents: [agentId],
      backupPath: written.backupPath,
    };
  }

  /**
   * 下线 agent（L1）：写盘移除 → 注册表摘除（home/persona 文件态保留）
   *
   * @param agentId - agent id
   * @param expectedHash - 乐观锁
   * @returns 热应用结果
   * @throws agent 不存在、{@link ConfigConflictError} 并发冲突
   */
  async deleteAgent(agentId: string, expectedHash: string): Promise<ConfigApplyResult> {
    const written = await this.deps.configAdmin.write((raw) => {
      const agents = Array.isArray(raw.agents) ? (raw.agents as Array<Record<string, unknown>>) : [];
      const idx = agents.findIndex((a) => a.id === agentId);
      if (idx < 0) throw new Error(`agent not found: ${agentId}`);
      agents.splice(idx, 1);
    }, expectedHash);
    this.deps.gateway.removeAgent(agentId);
    return {
      hash: written.hash,
      applied: 'next-run',
      affectedAgents: [],
      backupPath: written.backupPath,
    };
  }

  /**
   * 解析 persona 归属（#9）：注册表条目的 home 优先；inline persona（显式
   * systemPrompt）不挂 AGENTS.md resolver，编辑无意义 → 拒绝
   *
   * @param agentId - agent id
   * @returns persona 归属（home 路径或 inline 标记）
   * @throws agent 不在注册表 / inline persona
   */
  private resolvePersonaTarget(agentId: string): { home: string | undefined } {
    const def = this.deps.gateway.getAgentDefinition(agentId);
    if (!def) {
      throw new Error(`agent not found: ${agentId}`);
    }
    if (def.persona?.systemPrompt) {
      throw new Error(
        `agent "${agentId}" uses inline persona (persona.systemPrompt)：AGENTS.md 不生效，无法经此编辑`,
      );
    }
    return { home: def.home || undefined };
  }

  /**
   * 读 persona（AGENTS.md 全文）
   *
   * @param agentId - agent id
   * @returns 内容 + 内容 hash（乐观锁）；文件不存在 content=null
   * @throws agent 不在注册表 / inline persona
   */
  getPersona(agentId: string): { content: string | null; hash: string } {
    assertSafeConfigName(agentId);
    const { home } = this.resolvePersonaTarget(agentId);
    const content = this.deps.agentFiles.readPersona(agentId, home);
    return { content, hash: computeConfigHash(content ?? '') };
  }

  /**
   * 写 persona（AGENTS.md）：写文件 + 立即重建（builder 指纹缓存自动重读）
   *
   * @param agentId - agent id
   * @param content - AGENTS.md 全文
   * @param expectedHash - 内容 hash（乐观锁）
   * @returns 新内容 hash
   * @throws agent 不在注册表 / inline persona / {@link ConfigConflictError} 并发冲突
   */
  async updatePersona(
    agentId: string,
    content: string,
    expectedHash: string,
  ): Promise<{ hash: string }> {
    assertSafeConfigName(agentId);
    const { home } = this.resolvePersonaTarget(agentId);
    const current = this.deps.agentFiles.readPersona(agentId, home);
    const currentHash = computeConfigHash(current ?? '');
    if (currentHash !== expectedHash) {
      throw new ConfigConflictError(currentHash);
    }
    this.deps.agentFiles.writePersona(agentId, content, home);
    await this.deps.gateway.invalidateAgentBuild(agentId);
    return { hash: computeConfigHash(content) };
  }
}
