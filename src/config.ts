/**
 * 配置系统 — 文件 IO + Gateway 映射（根入口）
 *
 * 类型与工厂在 `@octopi-agent/engine/config.js`；本文件保留 loadConfig / toGatewayConfig。
 * 配置文件查找：-c 指定路径 → ./octopi.json → ~/.octopi/octopi.json
 */
export * from '@octopi-agent/engine/config.js';

import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';
import type {
  NormalizedHarnessConfig,
  ModelsConfig,
} from '@octopi-agent/engine/config.js';
import { flattenModels, resolveModelConfig } from '@octopi-agent/engine/config.js';
import { validateConfigOrThrow } from './config-schema.js';
import { applyLegacyBudget, detectConfigMigrations } from './config-migrations.js';
import { detectUnknownConfigKeys } from './config-schema/unknown-keys.js';
import { expandEnvPlaceholders as expandEnvPlaceholdersShared } from '@octopi-agent/engine/config-admin/env.js';
import { getOctopiHome } from './init.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';



/**
 * `${ENV_VAR}` / `${ENV_VAR:-default}` 占位符展开（loadConfig 与 FileConfigService 共用）
 *
 * @param fileContent - 配置文件原始文本
 * @returns 展开后的文本
 */
export function expandEnvPlaceholders(fileContent: string): string {
  return expandEnvPlaceholdersShared(fileContent);
}

/**
 * 配置迁移（loadConfig 与 FileConfigService 共用）：旧字段显式告警 + 内存迁移
 *
 * @param raw - 已展开占位符的配置对象（就地迁移）
 */
export function applyConfigMigrations(raw: Record<string, unknown>): void {
  if (!raw || typeof raw !== 'object') return;
  for (const finding of detectConfigMigrations(raw)) {
    const hint = finding.hint ? ` ${finding.hint}` : '';
    console.warn(`[config] ${finding.message}.${hint}`);
  }
  // 运行时内存迁移：legacy budget → budgetPolicy（丢弃 spend/soft）。
  // 注意语义：loadConfig 是 warn-only（supervisor 等不重写内容，见 doctor 测试锚），
  // 与 config-migrations.applyConfigMigrations（doctor --fix 的全量 apply）不同。
  applyLegacyBudget(raw);
  if ('budget' in raw) {
    delete raw.budget;
  }
}

/**
 * 解析配置文件绝对路径（loadConfig 与 buildFromConfigFile 共用单一查找优先级）。
 *
 * 查找优先级：1. 明确指定的路径 2. 当前目录 ./octopi.json 3. OCTOPI_HOME/octopi.json。
 *
 * @param configPath - 显式路径（可空）
 * @returns 配置文件绝对路径
 * @throws 找不到配置文件
 */
export function resolveConfigFilePath(configPath?: string): string {
  if (configPath) {
    const explicit = resolve(configPath);
    if (!existsSync(explicit)) {
      throw new Error(`Config file not found: ${explicit}`);
    }
    return explicit;
  }
  if (existsSync(resolve('./octopi.json'))) return resolve('./octopi.json');
  const homeConfig = resolve(getOctopiHome(), 'octopi.json');
  if (existsSync(homeConfig)) return homeConfig;
  throw new Error(
    `Config file not found. Searched:\n` +
    `  1. ${resolve('./octopi.json')}\n` +
    `  2. ${homeConfig}\n\n` +
    `Run 'octopi init' to create a new configuration.`
  );
}

export function loadConfig(configPath?: string): NormalizedHarnessConfig {
  const filePath = resolveConfigFilePath(configPath);

  console.log(`[config] Loading config from ${filePath}`);

  const fileContent = readFileSync(filePath, 'utf-8');

  const expanded = expandEnvPlaceholders(fileContent);

  const raw = JSON.parse(expanded) as Record<string, unknown>;

  // 旧字段静默失效会很难排查：显式告警（写回落盘见 octopi doctor --fix）
  applyConfigMigrations(raw);
  // 未知键告警（P3）：启动不拒（存量兼容），写回路径另行 fail-loud（见 config-service）
  const unknownKeys = detectUnknownConfigKeys(raw);
  if (unknownKeys.length > 0) {
    console.warn(
      `[config] 未知配置键（将被忽略）：${unknownKeys.join(', ')} —— 建议修正；WebUI 保存路径会拒绝这类 typo`,
    );
  }

  // Zod schema 校验（结构化错误信息）；路径归一化（`~` 展开）已由校验出口后置完成
  const config = finalizeNormalizedConfig(validateConfigOrThrow(raw));

  return config;
}

/**
 * 校验输出 → 归一化配置（loadConfig 与 normalizeConfigRaw 共用收尾）
 *
 * @param validated - validateConfigOrThrow 的输出
 * @returns 补齐 flatModels / levelMap 的归一化配置
 */
function finalizeNormalizedConfig(validated: unknown): NormalizedHarnessConfig {
  const config = validated as NormalizedHarnessConfig;
  config.flatModels = flattenModels(config.models as ModelsConfig);

  // 提取 models.level 到顶层 levelMap（方便下游直接使用）
  const modelsConfig = config.models as ModelsConfig;
  if (modelsConfig.level) {
    config.levelMap = modelsConfig.level;
  }
  return config;
}

/**
 * 快捷函数：从配置文件路径构建 Agent（IO 在根包，见 arch/npm-package-split.md §10.3）
 *
 * @param configPath - 配置文件路径；未指定时按 cwd → OCTOPI_HOME 查找
 * @returns agentId → BuiltAgent
 */
export async function buildFromConfigFile(configPath?: string): Promise<Map<string, import('@octopi-agent/engine/harness/agent/config-bridge.js').BuiltAgent>> {
  const { buildFromConfig } = await import('@octopi-agent/engine/harness/agent/config-bridge.js');
  const {
    computeSecurityConfigFingerprint,
    extractSecurityConfigSlice,
    createFileSecurityIntegrity,
  } = await import('@octopi-agent/engine/harness/agent/config-integrity.js');
  const filePath = resolveConfigFilePath(configPath);
  const config = loadConfig(filePath);
  // ops P2 §4.3/§8.4：启动期锚定安全字段指纹（取 raw 文件切面，与复核同口径——
  // 展开 ${VAR} 后的值与文件字面不同，混用会永久误报漂移）。run 起点复核，漂移拒新 run。
  const anchor = computeSecurityConfigFingerprint(
    extractSecurityConfigSlice(readFileSync(filePath, 'utf8')),
  );
  return buildFromConfig(config, {
    runnerConfig: {
      securityIntegrity: {
        fingerprint: anchor.fingerprint,
        recheck: createFileSecurityIntegrity({ configPath: filePath, anchor }),
      },
    },
  });
}



/**
 * raw 配置对象（未展开 `${ENV}`）→ 归一化配置（与 loadConfig 同一管线：展开 → 迁移 → 校验）
 *
 * 供配置热更的 agentDefFactory 复用；保证热更解析与启动解析同规。
 *
 * @param raw - raw 配置对象（占位符未展开）
 * @returns 归一化配置（含 flatModels 等解析产物）
 * @throws 校验失败抛错（fail-loud）
 */
export function normalizeConfigRaw(raw: Record<string, unknown>): NormalizedHarnessConfig {
  const expanded = JSON.parse(expandEnvPlaceholders(JSON.stringify(raw))) as Record<string, unknown>;
  applyConfigMigrations(expanded);
  return finalizeNormalizedConfig(validateConfigOrThrow(expanded));
}

/**
 * 单 agent 配置项 → AgentDefinition（toGatewayConfig 与配置热更共用）
 *
 * @param ac - agents[] 原始条目（已过校验）
 * @param config - 归一化配置（提供 flatModels / defaults 解析 model 引用）
 * @returns AgentDefinition（注册表条目形态）
 */
export function resolveAgentDefinition(
  ac: NormalizedHarnessConfig['agents'][number],
  config: NormalizedHarnessConfig,
): AgentDefinition {
  return {
    id: ac.id,
    home: ac.home ?? (typeof ac.persona === 'string' ? ac.persona : ''),
    workspace: ac.workspace,
    persona: typeof ac.persona === 'object'
      ? { name: ac.persona.name ?? ac.id, description: ac.persona.description ?? '', systemPrompt: ac.persona.systemPrompt }
      : { name: ac.id, description: '', systemPrompt: '' },
    tools: ac.tools ? { allow: ac.tools.allow ?? [], deny: ac.tools.deny ?? [] } : { allow: [], deny: [] },
    model: resolveModelConfig(ac.model, config.flatModels, config.defaults, config.levelMap),
    skillDirectory: ac.skillDirectory,
    skills: ac.skills,
    channelBindings: ac.channelBindings,
    maxSessionRights: ac.maxSessionRights,
    knowledge: ac.knowledge,
    effectPolicy: ac.effectPolicy,
    // 委派（arch/delegation.md §9.2）：特质标签 + 委派策略。
    // 刻意显式列出——此对象字面量是 CLI→Gateway 的边界，漏字段即静默丢配置。
    traits: ac.traits,
    delegation: ac.delegation,
  };
}

export function toGatewayConfig(config: NormalizedHarnessConfig): GatewayConfig {
  // 解析 agent model 配置：string 引用 → ModelConfig 对象
  const resolvedAgents: AgentDefinition[] = config.agents.map(ac => resolveAgentDefinition(ac, config));
  // `gateway` 进程面覆盖段（OctopiConfigSchema.gateway；类型面在 gateway 包，此处按形状取用）
  const gatewayOverride = (
    config as {
      gateway?: { hitlWebhook?: GatewayConfig['hitlWebhook'] };
    }
  ).gateway;

  const gatewayConfig: GatewayConfig = {
    agents: resolvedAgents,
    delegation: config.delegation,
    session: config.session
      ? { dmScope: config.session.dmScope, idleExpiryMs: config.session.idleExpiryMs }
      : undefined,
    toolIsolation: config.toolIsolation,
    effectPolicy: config.effectPolicy,
    sessionAcl: config.sessionAcl,
    fileSend: config.fileSend,
    credentials: config.credentials,
    budgetPolicy: config.budgetPolicy,
    contextAssembler: config.context?.contextAssembler ?? config.contextAssembler,
    context: config.context,
    contextEngine: config.contextEngine,
    runGuard: config.runGuard,
    security: config.security,
    constitution: config.context?.constitution ?? config.constitution,
    memory: config.memory,
    subsystems: config.subsystems,
    cognition: config.cognition,
    wisdom: config.wisdom,
    documents: config.documents,
    schedules: config.schedules,
    concurrency: config.concurrency,
    plugins: config.plugins,
    knowledge: config.knowledge,
    observer: config.observer,
    observability: config.observability,
    modelCallIdleTimeoutMs: config.modelCall?.idleTimeoutMs,
    modelCallAbsoluteTimeoutMs: config.modelCall?.absoluteTimeoutMs,
    embedding: config.models?.embedding,
    modelProviders: config.models?.providers,
    levels: config.levelMap ?? (config.models as ModelsConfig | undefined)?.level,
    hitlWebhook: gatewayOverride?.hitlWebhook,
  };

  if (config.agentRuntime) {
    gatewayConfig.agentRuntime = {
      coalesceWindowMs: config.agentRuntime.coalesceWindowMs,
      coalesceBufferLimit: config.agentRuntime.coalesceBufferLimit,
      expectedMaxConcurrentRuns: config.agentRuntime.expectedMaxConcurrentRuns,
    };
  }

  return gatewayConfig;
}
