/**
 * Config Bridge — 配置文件到 AgentBuilder 的桥接
 *
 * 将 octopi.json 配置转换为 AgentBuilder 调用，
 * 实现配置文件驱动的新架构初始化。
 *
 * 使用方式：
 * ```ts
 * import { buildFromConfig } from 'octopi/harness/config-bridge';
 *
 * const config = loadConfig('./octopi.json');
 * const agents = await buildFromConfig(config);
 * // agents.get('assistant') → { engine, runner }
 * ```
 */

import type { HarnessConfig, ProviderConfig, AgentConfig, ContextEngineConfig } from '../../config.js';
import { createProviderFromConfig, createStoreFromConfig } from '../../config.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../session-types.js';
import type { IterationBudgetConfig } from '../budget/budget.js';
import { AgentBuilder } from './builder.js';
import type { SessionAwareRunner } from '../runner.js';
import { SecurityPresets } from '../security/policy.js';
import type { SecurityGuardConfig } from '../../core/security-guard.js';
import type { SupervisorConfig } from '../../config.js';
import { DefaultTaskSupervisor } from '../task-system/supervisor/task-supervisor.js';
import type { TaskSupervisorConfig } from '../task-system/supervisor/task-supervisor.js';
import type { ContextEngine } from '../../core/interfaces/context-engine.js';
import { DefaultContextEngine } from '../context/default-context-engine.js';
import { DefaultBudgetAllocator } from '../context/budget-allocator.js';

// ── 结果类型 ──

import type { Agent } from '../../loop/agent.js';

export interface BuiltAgent {
  agent: Agent;
  runner: SessionAwareRunner;
  agentConfig: AgentConfig;
}

// ── Provider 解析 ──

/**
 * 从配置中创建所有 Provider 实例
 *
 * 返回 provider name → ModelProvider 的映射。
 */
export async function resolveProviders(config: HarnessConfig): Promise<Map<string, ModelProvider>> {
  const providers = new Map<string, ModelProvider>();

  if (!config.providers) return providers;

  for (const pc of config.providers) {
    try {
      const provider = await createProviderFromConfig(pc);
      providers.set(pc.name, provider);
    } catch (err) {
      console.warn(`[ConfigBridge] Failed to create provider "${pc.name}":`, err);
    }
  }

  return providers;
}

// ── Store 解析 ──

/**
 * 从配置中创建 SessionStore 实例
 */
export async function resolveStore(config: HarnessConfig): Promise<SessionStore<SessionData> | undefined> {
  if (!config.store) return undefined;
  return createStoreFromConfig(config.store);
}

// ── 安全配置解析 ──

/**
 * 从配置中解析安全策略
 */
export function resolveSecurityConfig(config: HarnessConfig): SecurityGuardConfig | undefined {
  if (!config.security) return undefined;

  // 如果指定了 preset，直接使用预设
  if (config.security.preset) {
    return SecurityPresets[config.security.preset];
  }

  // 否则从细粒度配置构建
  if (config.security.injectionSensitivity) {
    return { injectionSensitivity: config.security.injectionSensitivity };
  }

  return undefined;
}

// ── 上下文引擎解析 ──

/**
 * 从配置中创建 ContextEngine 实例
 */
export function resolveContextEngine(config: ContextEngineConfig | undefined): ContextEngine {
  if (!config || config.type === 'default') {
    // 默认配置
    return new DefaultContextEngine({
      protectFirstN: config?.protectFirstN ?? 3,
      protectLastN: config?.protectLastN ?? 20,
      compactThreshold: config?.compactThreshold ?? 0.5,
      budgetAllocator: new DefaultBudgetAllocator({
        outputRatio: config?.outputRatio ?? 0.20,
        minOutputReserve: config?.minOutputReserve ?? 2000,
        maxOutputReserve: config?.maxOutputReserve ?? 8000,
      }),
    });
  }

  // 自定义类型（未来扩展）
  throw new Error(`Unknown context engine type: ${config.type}`);
}

// ── Supervisor 解析 ──

/**
 * 从配置中解析 TaskSupervisor
 *
 * 解析 llmModel 字段：
 * - "model" → 使用主 provider
 * - "provider/model" → 使用指定 provider
 */
export function resolveSupervisor(
  config: SupervisorConfig | undefined,
  providers: Map<string, ModelProvider>,
): DefaultTaskSupervisor | undefined {
  if (!config || config.enabled === false) return undefined;

  // 解析审查用模型
  let reviewModel: ModelProvider | undefined;
  if (config.llmModel) {
    const parts = config.llmModel.split('/');
    if (parts.length === 2) {
      // 格式: "provider/model"
      const providerName = parts[0];
      reviewModel = providers.get(providerName);
      // 将 llmModel 改为只保留 model 部分
      config = { ...config, llmModel: parts[1] };
    } else {
      // 格式: "model" → 使用第一个 provider
      reviewModel = providers.values().next().value;
    }
  }

  // 构建 TaskSupervisorConfig
  const supervisorConfig: TaskSupervisorConfig = {
    enabled: true,
    checkpointInterval: config.checkpointInterval,
    minCheckpointInterval: config.minCheckpointInterval,
    maxCheckpointInterval: config.maxCheckpointInterval,
    enableLLMReview: config.enableLLMReview,
    llmReviewInterval: config.llmReviewInterval,
    llmModel: config.llmModel,
    hardLimit: config.hardLimit,
    hardWallClockMs: config.hardWallClockMs,
  };

  return new DefaultTaskSupervisor(supervisorConfig, reviewModel);
}

// ── 核心桥接函数 ──

/**
 * 从配置构建所有 Agent
 *
 * 读取 HarnessConfig，为每个 agent 创建 AgentBuilder 并构建。
 * 共享的 Provider 和 Store 在 agent 之间复用。
 *
 * @param config - 完整配置
 * @returns agent id → BuiltAgent 的映射
 */
export async function buildFromConfig(config: HarnessConfig): Promise<Map<string, BuiltAgent>> {
  // 1. 解析共享资源
  const providers = await resolveProviders(config);
  const store = await resolveStore(config);
  const securityConfig = resolveSecurityConfig(config);
  const distributedConfig = config.distributedIntelligence;
  const budgetConfig = config.budget;
  const supervisorConfig = config.supervisor;
  const contextEngineConfig = config.contextEngine;

  // 2. 为每个 agent 构建
  const agents = new Map<string, BuiltAgent>();

  for (const agentConfig of config.agents) {
    try {
      const built = await buildAgent(agentConfig, {
        providers,
        store,
        securityConfig,
        distributedConfig,
        budgetConfig,
        supervisorConfig,
        contextEngineConfig,
      });
      agents.set(agentConfig.id, built);
    } catch (err) {
      console.error(`[ConfigBridge] Failed to build agent "${agentConfig.id}":`, err);
      throw err;
    }
  }

  return agents;
}

/**
 * 构建单个 Agent
 */
async function buildAgent(
  agentConfig: AgentConfig,
  shared: {
    providers: Map<string, ModelProvider>;
    store?: SessionStore<SessionData>;
    securityConfig?: SecurityGuardConfig;
    distributedConfig?: import('../../config.js').HarnessConfig['distributedIntelligence'];
    budgetConfig?: Partial<IterationBudgetConfig>;
    supervisorConfig?: SupervisorConfig;
    contextEngineConfig?: ContextEngineConfig;
  },
): Promise<BuiltAgent> {
  const builder = new AgentBuilder();

  // ── Model ──
  const provider = shared.providers.get(agentConfig.model.provider);
  if (!provider) {
    throw new Error(
      `Agent "${agentConfig.id}" references unknown provider "${agentConfig.model.provider}". ` +
      `Available: ${Array.from(shared.providers.keys()).join(', ') || '(none)'}`
    );
  }
  builder.model(provider);

  // ── Persona ──
  if (agentConfig.persona) {
    if (typeof agentConfig.persona === 'string') {
      // 文件式 persona：目录路径
      builder.persona(agentConfig.persona);
    }
    // 内联 persona 不需要 builder 处理——systemPrompt 会在 run() 时传入
  }

  // ── Workspace（作为 persona 目录的后备） ──
  if (agentConfig.workspace && !agentConfig.persona) {
    // 如果没有显式 persona，尝试从 workspace 加载
    builder.persona(agentConfig.workspace);
  }

  // ── Store ──
  if (shared.store) {
    builder.store(shared.store);
  }

  // ── Security ──
  if (shared.securityConfig) {
    builder.securityPolicy(shared.securityConfig);
  }

  // ── Safety Guard ──
  if (shared.securityConfig && shared.distributedConfig?.safetyGuard?.enabled) {
    builder.withSafetyGuard({
      cwd: agentConfig.workspace,
      model: shared.distributedConfig.safetyGuard.model,
      maxDurationMs: shared.distributedConfig.safetyGuard.maxDurationMs,
    });
  }

  // ── Budget ──
  if (shared.budgetConfig) {
    builder.budget(shared.budgetConfig);
  }

  // ── Context Engine ──
  const contextEngine = resolveContextEngine(shared.contextEngineConfig);
  builder.contextEngine(contextEngine);

  // ── Supervisor ──
  if (shared.supervisorConfig?.enabled !== false) {
    const supervisor = resolveSupervisor(shared.supervisorConfig, shared.providers);
    if (supervisor) {
      builder.taskSupervisor(supervisor);
    }
  }

  // ── Build ──
  const built = await builder.build();
  const agent = built.agent;
  const runner = built.runner;

  return { agent, runner, agentConfig };
}

/**
 * 快捷函数：从配置文件路径构建
 */
export async function buildFromConfigFile(configPath?: string): Promise<Map<string, BuiltAgent>> {
  const { loadConfig } = await import('../../config.js');
  const config = loadConfig(configPath);
  return buildFromConfig(config);
}
