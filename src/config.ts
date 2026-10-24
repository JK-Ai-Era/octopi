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
  // 运行时内存迁移：legacy budget → budgetPolicy（丢弃 spend/soft）
  applyLegacyBudget(raw);
  if ('budget' in raw) {
    delete raw.budget;
  }
}

export function loadConfig(configPath?: string): NormalizedHarnessConfig {
  // 配置文件查找优先级：
  // 1. 明确指定的路径
  // 2. 当前目录 ./octopi.json
  // 3. OCTOPI_HOME/octopi.json（默认 ~/.octopi/octopi.json，与 getOctopiHome 一致）
  let filePath: string;
  if (configPath) {
    filePath = resolve(configPath);
  } else if (existsSync(resolve('./octopi.json'))) {
    filePath = resolve('./octopi.json');
  } else {
    const homeConfig = resolve(getOctopiHome(), 'octopi.json');
    if (existsSync(homeConfig)) {
      filePath = homeConfig;
    } else {
      throw new Error(
        `Config file not found. Searched:\n` +
        `  1. ${resolve('./octopi.json')}\n` +
        `  2. ${homeConfig}\n\n` +
        `Run 'octopi init' to create a new configuration.`
      );
    }
  }

  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  console.log(`[config] Loading config from ${filePath}`);

  const fileContent = readFileSync(filePath, 'utf-8');

  const expanded = expandEnvPlaceholders(fileContent);

  const raw = JSON.parse(expanded) as Record<string, unknown>;

  // 旧字段静默失效会很难排查：显式告警（写回落盘见 octopi doctor --fix）
  applyConfigMigrations(raw);

  // Zod schema 校验（结构化错误信息）；路径归一化（`~` 展开）已由校验出口后置完成
  const config = validateConfigOrThrow(raw) as unknown as NormalizedHarnessConfig;


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
  const config = loadConfig(configPath);
  return buildFromConfig(config);
}



export function toGatewayConfig(config: NormalizedHarnessConfig): GatewayConfig {
  // 解析 agent model 配置：string 引用 → ModelConfig 对象
  const resolvedAgents: AgentDefinition[] = config.agents.map(ac => ({
    id: ac.id,
    home: ac.home ?? (typeof ac.persona === 'string' ? ac.persona : ''),
    workspace: ac.workspace,
    persona: typeof ac.persona === 'object'
      ? { name: ac.persona.name ?? ac.id, description: ac.persona.description ?? '', systemPrompt: ac.persona.systemPrompt }
      : { name: ac.id, description: '', systemPrompt: '' },
    tools: ac.tools ? { allow: ac.tools.allow ?? [], deny: ac.tools.deny ?? [] } : { allow: [], deny: [] },
    model: resolveModelConfig(ac.model, config.flatModels, config.defaults),
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
  }));

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
