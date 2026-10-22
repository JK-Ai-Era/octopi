/**
 * Config Bridge — 配置文件到 AgentBuilder 的桥接
 *
 * 将 octopi.json 配置转换为 AgentBuilder 调用，
 * 实现配置文件驱动的新架构初始化。
 *
 * 使用方式：
 * ```ts
 * import { buildFromConfig } from 'octopi-agent';
 *
 * const config = loadConfig('./octopi.json');
 * const agents = await buildFromConfig(config);
 * // agents.get('assistant') → { engine, runner }
 * ```
 */

import type { HarnessConfig, AgentConfig, ContextEngineConfig, NormalizedModelInfo, ModelProviderConfig, NormalizedHarnessConfig } from '../../config.js';
import { createProviderFromConfig, createWireDumpSinkFromConfig, resolveModelConfig } from '../../config.js';
import { SubsystemLoader } from '../collaboration/autonomous-subsystem/loader.js';
import type { SubsystemSpec } from '../collaboration/autonomous-subsystem/types.js';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import { AgentBuilder } from './builder.js';
import type { SessionAwareRunner } from '../run/runner.js';
import {
  resolveSecurityConfig,
  shouldAutoLoadSubsystems,
  wireAgentBuilder,
} from './wire-agent-builder.js';

// ── 结果类型 ──

import type { Agent } from '../run/agent/index.js';
import { wireDelegation } from '../collaboration/delegation/wiring.js';

export interface BuiltAgent {
  agent: Agent;
  runner: SessionAwareRunner;
  agentConfig: AgentConfig;
  runtime?: import('../collaboration/autonomous-subsystem/runtime.js').SubsystemRuntime;
  /**
   * 该 Agent 的事件总线。
   *
   * 跨 agent 的 notify（`arch/delegation.md` §7.1）必须落在**同一条**总线上，
   * 否则 `AgentSignalSource` 收不到；跨 agent 场景请用 `buildFromConfig` 的
   * `options.events` 提供共享总线，或自行 `builder.events(bus)` 注入。
   */
  events: import('@octopi-agent/core/primitives/event-bus.js').EventBus;
  /** SessionStore（委派子 Run 预创建 child session 用；`arch/delegation.md` D7） */
  store: import('@octopi-agent/core/interfaces/session-store.js').SessionStore<
    import('../session/types.js').SessionData
  >;
  /** 后置注册工具（`delegate_*` 等运行期才可构造的工具） */
  registerTools: (tools: import('@octopi-agent/core/types.js').RegisteredTool[]) => void;
}

// ── Provider 解析 ──

/**
 * 从配置中创建所有 Provider 实例
 *
 * 返回 provider name → ModelProvider 的映射。
 */
export async function resolveProviders(config: NormalizedHarnessConfig): Promise<Map<string, ModelProvider>> {
  const providers = new Map<string, ModelProvider>();
  // wire dump 是纯观测：未启用时 undefined，启用后 sink 在该层共享（单一写队列 + 单一环形计数）
  const wireDump = await createWireDumpSinkFromConfig(config.observability?.llmRequestDump);

  for (const [name, pc] of Object.entries(config.models?.providers ?? {})) {
    try {
      const provider = await createProviderFromConfig(name, pc as ModelProviderConfig, { wireDump });
      providers.set(name, provider);
    } catch (err) {
      console.warn(`[ConfigBridge] Failed to create provider "${name}":`, err);
    }
  }

  return providers;
}


// ── 安全配置解析 ──

// ── 子系统加载 ──

/**
 * 按架构文档 4.9 的三级搜索路径加载子系统
 *
 * 搜索顺序（同名覆盖：后加载的覆盖先加载的）：
 * 1. 框架内置: <octopi-bundle>/subsystems/
 * 2. 用户级:   ~/.octopi/subsystems/
 * 3. 项目级:   <project>/.octopi/subsystems/
 */
export async function resolveSubsystemSpecs(projectRoot?: string): Promise<SubsystemSpec[]> {
  const cwd = projectRoot ?? process.cwd();
  const home = homedir();

  // 框架内置：从当前包的 src/subsystems/ 目录加载
  // 在开发环境中是项目根下的 src/subsystems/，发布后是 dist/subsystems/
  const builtinCandidates = [
    resolve(cwd, 'src', 'subsystems'),
    resolve(cwd, 'dist', 'subsystems'),
  ];
  let builtinDir: string | undefined;
  for (const candidate of builtinCandidates) {
    try {
      const { existsSync } = await import('node:fs');
      if (existsSync(candidate)) { builtinDir = candidate; break; }
    } catch { /* ignore */ }
  }

  const userDir = resolve(home, '.octopi', 'subsystems');
  const projectDir = resolve(cwd, '.octopi', 'subsystems');

  const loader = new SubsystemLoader({ builtinDir, userDir, projectDir, npmDir: join(cwd, 'node_modules') });
  const result = await loader.loadAll();

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.warn(`[ConfigBridge] Subsystem load error at ${err.path}: ${err.error}`);
    }
  }

  return result.specs;
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
export async function buildFromConfig(
  config: NormalizedHarnessConfig,
  options?: BuildFromConfigOptions,
): Promise<Map<string, BuiltAgent>> {
  const flatModels: NormalizedModelInfo[] = config.flatModels ?? [];
  // 1. 解析共享资源
  const providers = await resolveProviders(config);
  const securityConfig = resolveSecurityConfig(config);
  const budgetConfig = config.budgetPolicy;
  const runGuardConfig = config.runGuard;
  const contextEngineConfig = config.contextEngine;
  const contextAssemblerConfig = config.context?.contextAssembler ?? config.contextAssembler;
  const constitutionConfig = config.context?.constitution ?? config.constitution;

  // 2. 加载子系统（三级搜索路径）
  const subsystemSpecs = await resolveSubsystemSpecs();

  // 3. 为每个 agent 构建
  const agents = new Map<string, BuiltAgent>();

  for (const agentConfig of config.agents) {
    try {
      const built = await buildAgent(agentConfig, {
        providers,
        securityConfig,
        budgetConfig,
        runGuardConfig,
        contextEngineConfig,
        contextAssemblerConfig,
        constitutionConfig,
        memoryConfig: config.memory,
        cognitionConfig: config.cognition,
        wisdomConfig: config.wisdom,
        flatModels,
        levelMap: config.levelMap,
        modelsConfig: config.models,
        subsystemSpecs,
        subsystemAuditDir: config.subsystems?.auditDir,
        subsystemAllowlist: config.subsystems?.allowlist,
        subsystemDenylist: config.subsystems?.denylist,
        toolIsolation: config.toolIsolation,
        sessionIdleExpiryMs: config.session?.idleExpiryMs,
        modelCallConfig: config.modelCall,
        concurrencyConfig: config.concurrency,
      });
      agents.set(agentConfig.id, built);
    } catch (err) {
      console.error(`[ConfigBridge] Failed to build agent "${agentConfig.id}":`, err);
      throw err;
    }
  }

  // 4. 委派编排（arch/delegation.md §7/§14）
  //    只有存在 agent 声明 delegation 策略时才接线；接线失败不阻断 agent 构建。
  if (options?.delegation !== false) {
    try {
      wireDelegation(
        config.agents.map((agentConfig) => {
          const built = agents.get(agentConfig.id)!;
          return {
            agentId: agentConfig.id,
            agent: built.agent,
            runner: built.runner,
            store: built.store,
            traits: agentConfig.traits,
            delegation: agentConfig.delegation as never,
            persona:
              typeof agentConfig.persona === 'string' ? agentConfig.persona : undefined,
            registerTools: built.registerTools,
          };
        }),
        {
          events: options?.events,
          maxActiveDelegationsPerSession: config.delegation?.maxActiveDelegationsPerSession,
        },
      );
    } catch (err) {
      console.warn('[ConfigBridge] delegation wiring skipped:', err);
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
    securityConfig?: import('@octopi-agent/core/security-guard.js').SecurityGuardConfig;
    budgetConfig?: import('../../config.js').BudgetPolicyJsonConfig;
    runGuardConfig?: import('../../config.js').RunGuardJsonConfig;
    contextEngineConfig?: ContextEngineConfig;
    contextAssemblerConfig?: import('../../config.js').ContextAssemblerConfig;
    constitutionConfig?: import('../../config.js').ConstitutionConfig;
    memoryConfig?: import('../../config.js').HarnessConfig['memory'];
    cognitionConfig?: import('../../config.js').HarnessConfig['cognition'];
    wisdomConfig?: import('../../config.js').HarnessConfig['wisdom'];
    flatModels: NormalizedModelInfo[];
    levelMap?: import('../../config.js').LevelMap;
    modelsConfig?: import('../../config.js').ModelsConfig;
    subsystemSpecs?: SubsystemSpec[];
    subsystemAuditDir?: string | false;
    subsystemAllowlist?: string[];
    subsystemDenylist?: string[];
    toolIsolation?: import('../../config.js').HarnessConfig['toolIsolation'];
    effectPolicy?: import('../../config.js').HarnessConfig['effectPolicy'];
    sessionIdleExpiryMs?: number;
    modelCallConfig?: import('../../config.js').ModelCallConfig;
    concurrencyConfig?: import('../../config.js').HarnessConfig['concurrency'];
  },
): Promise<BuiltAgent> {
  const builder = new AgentBuilder();

  // 解析主模型 provider（宿主可在此包装 circuit breaker；config-bridge 用原始 provider）
  const resolvedModel = resolveModelConfig(agentConfig.model, shared.flatModels);
  const provider = shared.providers.get(resolvedModel.provider);
  if (!provider) {
    throw new Error(
      `Agent "${agentConfig.id}" references unknown provider "${resolvedModel.provider}". ` +
      `Available: ${Array.from(shared.providers.keys()).join(', ') || '(none)'}`
    );
  }

  await wireAgentBuilder(builder, {
    model: provider,
    agentId: agentConfig.id,
    workspace: agentConfig.workspace,
    // legacy：string persona 等价 home（config-bridge 显式决定，不进 wire 隐式规则）
    home:
      agentConfig.home ??
      (typeof agentConfig.persona === 'string' ? agentConfig.persona : undefined),
    persona: agentConfig.persona,
    skillDirectory: agentConfig.skillDirectory,
    tools: agentConfig.tools,
    maxSessionRights: agentConfig.maxSessionRights,
    effectPolicy: agentConfig.effectPolicy ?? shared.effectPolicy,
    toolIsolation: shared.toolIsolation,
    sessionIdleExpiryMs: shared.sessionIdleExpiryMs,
    modelCallTimeouts: shared.modelCallConfig,
    providers: shared.providers,
    levelMap: shared.levelMap,
    modelsConfig: shared.modelsConfig,
    contextEngineConfig: shared.contextEngineConfig,
    contextAssemblerConfig: shared.contextAssemblerConfig,
    constitutionConfig: shared.constitutionConfig,
    memoryConfig: shared.memoryConfig,
    cognitionConfig: shared.cognitionConfig,
    wisdomConfig: shared.wisdomConfig,
    securityConfig: shared.securityConfig,
    budgetConfig: shared.budgetConfig,
    runGuardConfig: shared.runGuardConfig,
    subsystemSpecs: shared.subsystemSpecs,
    subsystemAuditDir: shared.subsystemAuditDir,
    subsystemAllowlist: shared.subsystemAllowlist,
    subsystemDenylist: shared.subsystemDenylist,
    concurrencyConfig: shared.concurrencyConfig,
  });

  // ── Build ──
  const built = await builder.build({
    autoLoadSubsystems: shouldAutoLoadSubsystems(shared),
  });

  // 子系统运行时依赖（modelProvider / memoryStore / …）统一在 AgentBuilder.build 内注入；
  // 此处不重复 register，避免两路径出现第二套接线清单。
  const agent = built.agent;
  const runner = built.runner;

  return {
    agent,
    runner,
    agentConfig,
    runtime: built.runtime,
    events: built.events,
    store: built.store,
    registerTools: built.registerTools,
  };
}

/**
 * 快捷函数：从配置文件路径构建
 *
 * @remarks 文件 IO / `loadConfig` 属于套件侧（arch/npm-package-split.md §10.3）。
 * 根包 `octopi` 提供 `buildFromConfigFile`；库嵌入请用 {@link buildFromConfig}。
 */

/**
 * `buildFromConfig` 可选项
 *
 * @remarks 定义置于文件尾亦生效（TS interface 提升）；保持单点定义。
 */
export interface BuildFromConfigOptions {
  /**
   * 跨 agent **共享**的事件总线。
   *
   * 委派 notify（`arch/delegation.md` §7.1）必须落在 `AgentSignalSource`
   * 所监听的同一条总线上；多 agent 场景请传入共享总线。
   * 缺省 = 各用自己 builder 建的总线，此时 **notify 不接线**（poll 通道仍可用）。
   */
  events?: import('@octopi-agent/core/primitives/event-bus.js').EventBus;
  /**
   * 委派编排开关。缺省 = 只要有 agent 声明 `delegation` 策略就接线。
   */
  delegation?: boolean;
}
