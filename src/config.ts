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
import { getOctopiHome } from './init.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';



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

  // 支持 ${ENV_VAR} 和 ${ENV_VAR:-default} 环境变量替换
  const expanded = fileContent.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_, key, defaultVal) => {
    const val = process.env[key];
    if (val !== undefined) return val;
    if (defaultVal !== undefined) return defaultVal;
    // 未设置且无默认值：返回空字符串（apiKey 等字段会在后续校验中报错）
    return '';
  });

  const raw = JSON.parse(expanded);

  // 旧字段静默失效会很难排查：显式告警（写回落盘见 octopi doctor --fix）
  if (raw && typeof raw === 'object') {
    for (const finding of detectConfigMigrations(raw)) {
      const hint = finding.hint ? ` ${finding.hint}` : '';
      console.warn(`[config] ${finding.message}.${hint}`);
    }
    // 运行时内存迁移：legacy budget → budgetPolicy（丢弃 spend/soft）
    applyLegacyBudget(raw as Record<string, unknown>);
    if (raw && typeof raw === 'object' && 'budget' in (raw as object)) {
      delete (raw as Record<string, unknown>).budget;
    }
  }

  // Zod schema 校验（结构化错误信息）
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
  }));

  const gatewayConfig: GatewayConfig = {
    agents: resolvedAgents,
    session: config.session ? { dmScope: config.session.dmScope } : undefined,
    toolIsolation: config.toolIsolation,
    sessionAcl: config.sessionAcl,
    budgetPolicy: config.budgetPolicy,
    contextAssembler: config.context?.contextAssembler ?? config.contextAssembler,
    context: config.context,
    constitution: config.context?.constitution ?? config.constitution,
    memory: config.memory,
    knowledge: config.knowledge,
    observer: config.observer,
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

  // 传递可观测性配置
  if (config.observability?.traceDir !== null && config.observability?.traceDir !== undefined) {
    const levelMap: Record<number, string> = { 1: 'ERROR', 2: 'WARN', 3: 'INFO', 4: 'DEBUG', 5: 'TRACE' };
    gatewayConfig.trace = {
      outputDir: config.observability.traceDir,
      level: levelMap[config.observability.level ?? 3] as any ?? 'INFO',
    };
  }

  return gatewayConfig;
}
