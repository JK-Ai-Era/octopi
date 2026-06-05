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

import type { HarnessConfig, ProviderConfig, AgentConfig } from '../config.js';
import { createProviderFromConfig, createStoreFromConfig } from '../config.js';
import type { ModelProvider } from '../core/interfaces/model-provider.js';
import type { SessionStore } from '../core/interfaces/session-store.js';
import type { IterationBudgetConfig } from '../core/budget.js';
import { AgentBuilder } from './builder.js';
import type { AgentEngine } from '../core/engine.js';
import type { SessionAwareRunner } from './runner.js';
import { SecurityPresets } from './security/policy.js';
import type { SecurityGuardConfig } from '../core/security-guard.js';

// ── 结果类型 ──

export interface BuiltAgent {
  engine: AgentEngine;
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
      const provider = await createProviderFromConfig(pc) as ModelProvider;
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
export async function resolveStore(config: HarnessConfig): Promise<SessionStore | undefined> {
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
  const budgetConfig = config.budget;

  // 2. 为每个 agent 构建
  const agents = new Map<string, BuiltAgent>();

  for (const agentConfig of config.agents) {
    try {
      const built = await buildAgent(agentConfig, {
        providers,
        store,
        securityConfig,
        budgetConfig,
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
    store?: SessionStore;
    securityConfig?: SecurityGuardConfig;
    budgetConfig?: Partial<IterationBudgetConfig>;
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

  // ── Budget ──
  if (shared.budgetConfig) {
    builder.budget(shared.budgetConfig);
  }

  // ── Build ──
  const { engine, runner } = await builder.build();

  return { engine, runner, agentConfig };
}

/**
 * 快捷函数：从配置文件路径构建
 */
export async function buildFromConfigFile(configPath?: string): Promise<Map<string, BuiltAgent>> {
  const { loadConfig } = await import('../config.js');
  const config = loadConfig(configPath);
  return buildFromConfig(config);
}
