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

import type { HarnessConfig, AgentConfig, ContextEngineConfig, NormalizedModelInfo, ModelProviderConfig, NormalizedHarnessConfig } from '../../config.js';
import { createProviderFromConfig, resolveModelConfig } from '../../config.js';
import { SubsystemLoader } from '../autonomous-subsystem/loader.js';
import type { SubsystemSpec } from '../autonomous-subsystem/types.js';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { BudgetPolicyConfig } from '../budget/budget.js';
import type { ReliabilityConfig } from '../reliability/run-agent.js';
import { AgentBuilder } from './builder.js';
import type { SessionAwareRunner } from '../runner.js';
import { SecurityPresets } from '../security/policy.js';
import type { SecurityGuardConfig } from '../../core/security-guard.js';
import type { RunGuardJsonConfig } from '../../config.js';
import { DefaultRunGuard } from '../run-guard/default-run-guard.js';
import type { RunGuardConfig } from '../run-guard/default-run-guard.js';
import type { ContextEngine } from '../context/types.js';
import { DefaultContextEngine } from '../context/default-context-engine.js';
import { DefaultBudgetAllocator } from '../context/budget-allocator.js';
import { createProviderSummarize, pickSummarizeProvider } from '../context/summarize.js';

// ── 结果类型 ──

import type { Agent } from '../agent/index.js';

export interface BuiltAgent {
  agent: Agent;
  runner: SessionAwareRunner;
  agentConfig: AgentConfig;
  runtime?: import('../autonomous-subsystem/runtime.js').SubsystemRuntime;
}

// ── Provider 解析 ──

/**
 * 从配置中创建所有 Provider 实例
 *
 * 返回 provider name → ModelProvider 的映射。
 */
export async function resolveProviders(config: NormalizedHarnessConfig): Promise<Map<string, ModelProvider>> {
  const providers = new Map<string, ModelProvider>();

  for (const [name, pc] of Object.entries(config.models?.providers ?? {})) {
    try {
      const provider = await createProviderFromConfig(name, pc as ModelProviderConfig);
      providers.set(name, provider);
    } catch (err) {
      console.warn(`[ConfigBridge] Failed to create provider "${name}":`, err);
    }
  }

  return providers;
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
      proactiveCompactRatio: config?.proactiveCompactRatio ?? 0.6,
      proactiveCooldownMs: config?.proactiveCooldownMs ?? 30_000,
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

// ── RunGuard 解析 ──

/**
 * 从配置中解析 RunGuard
 *
 * 解析 llmModel 字段：
 * - "model" → 使用主 provider
 * - "provider/model" → 使用指定 provider
 */
export function resolveRunGuard(
  config: RunGuardJsonConfig | undefined,
  providers: Map<string, ModelProvider>,
): DefaultRunGuard | undefined {
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

  // 构建 RunGuardConfig
  const runGuardConfig: RunGuardConfig = {
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

  return new DefaultRunGuard(runGuardConfig, reviewModel);
}

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
export async function buildFromConfig(config: NormalizedHarnessConfig): Promise<Map<string, BuiltAgent>> {
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
        flatModels,
        levelMap: config.levelMap,
        modelsConfig: config.models,
        subsystemSpecs,
        subsystemAuditDir: config.subsystems?.auditDir,
        subsystemAllowlist: config.subsystems?.allowlist,
        subsystemDenylist: config.subsystems?.denylist,
        toolIsolation: config.toolIsolation,
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
    securityConfig?: SecurityGuardConfig;
    budgetConfig?: import('../../config.js').BudgetPolicyJsonConfig;
    runGuardConfig?: RunGuardJsonConfig;
    contextEngineConfig?: ContextEngineConfig;
    contextAssemblerConfig?: import('../../config.js').ContextAssemblerConfig;
    constitutionConfig?: import('../../config.js').ConstitutionConfig;
    memoryConfig?: import('../../config.js').HarnessConfig['memory'];
    flatModels: NormalizedModelInfo[];
    levelMap?: import('../../config.js').LevelMap;
    modelsConfig?: import('../../config.js').ModelsConfig;
    subsystemSpecs?: SubsystemSpec[];
    subsystemAuditDir?: string;
    subsystemAllowlist?: string[];
    subsystemDenylist?: string[];
    toolIsolation?: import('../../config.js').HarnessConfig['toolIsolation'];
  },
): Promise<BuiltAgent> {
  const builder = new AgentBuilder();

  // ── Model ──
  const resolvedModel = resolveModelConfig(agentConfig.model, shared.flatModels);
  const provider = shared.providers.get(resolvedModel.provider);
  if (!provider) {
    throw new Error(
      `Agent "${agentConfig.id}" references unknown provider "${resolvedModel.provider}". ` +
      `Available: ${Array.from(shared.providers.keys()).join(', ') || '(none)'}`
    );
  }
  builder.model(provider);

  // ── Model Levels ──
  if (shared.levelMap) {
    builder.withModelLevels(shared.levelMap);
  }

  // ── Workspace ──
  if (agentConfig.workspace) {
    builder.workspace(agentConfig.workspace);
  }

  // ── Tool isolation (I5) ──
  if (shared.toolIsolation) {
    builder.toolIsolation(shared.toolIsolation);
  }

  // ── Home / Persona ──
  // home 是 agent 文件态持久目录（persona/sessions/skills/extract）；
  // memory/wisdom 走 AgentDatabase SQLite，不在此目录树下。
  const agentHome = agentConfig.home ?? (typeof agentConfig.persona === 'string' ? agentConfig.persona : undefined);
  if (agentConfig.home) {
    builder.agentHome(agentConfig.home);
    builder.agentId(agentConfig.id);
  } else if (agentHome && typeof agentConfig.persona === 'string') {
    // 兼容旧 persona-as-home：extract 仍落在该目录
    builder.agentHome(agentConfig.persona);
    builder.agentId(agentConfig.id);
  }
  if (agentConfig.persona) {
    if (typeof agentConfig.persona === 'string') {
      // 文件式 persona：目录路径（已废弃，等价于 home）
      builder.persona(agentConfig.persona);
    }
    // 内联 persona 不需要 builder 处理——systemPrompt 会在 run() 时传入
  } else if (agentHome) {
    // 没有显式 persona，从 home 目录加载
    builder.persona(agentHome);
  }

  // ── Skills ──
  const skillDir =
    agentConfig.skillDirectory ??
    (agentHome ? join(agentHome, 'skills') : undefined);
  if (skillDir && existsSync(skillDir)) {
    builder.skillDirectory(skillDir);
  }

  // ── Memory / Wisdom / Cognition / Knowledge（system prompt 层） ──
  // 优先挂 agent home 下的 AgentDatabase；失败则跳过（不阻断 build）
  if (agentHome) {
    try {
      const { AgentDatabase } = await import('../memory/sqlite/agent-db.js');
      const { SqliteMemoryStore } = await import('../memory/sqlite/memory-store.js');
      const { SqliteWisdomStore } = await import('../memory/sqlite/wisdom-store.js');
      const { SqliteConceptGraph } = await import('../memory/sqlite/cognition-store.js');
      const { MemoryKnowledgeStore } = await import('../context/knowledge/memory-store.js');
      const { resolveEmbeddingRuntime } = await import('../memory/sqlite/embedding-from-models.js');

      const embRuntime = resolveEmbeddingRuntime(shared.modelsConfig);
      const useVec = embRuntime && embRuntime.vectorEngine !== 'js';
      const db = await AgentDatabase.create({
        dbPath: join(agentHome, 'agent.db'),
        sqliteVec: useVec
          ? { extensionPath: embRuntime?.sqliteVecExtensionPath }
          : false,
        vectorDimensions: useVec ? embRuntime?.dimensions : undefined,
      });
      builder.memoryStore(
        new SqliteMemoryStore(db, {
          embeddingProvider: embRuntime?.provider ?? null,
          vectorEngine: embRuntime?.vectorEngine ?? 'auto',
        }),
      );
      builder.wisdomStore(new SqliteWisdomStore(db));
      builder.cognitionStore(new SqliteConceptGraph(db, {
        embeddingProvider: embRuntime?.provider ?? null,
      }));
      // Knowledge 暂无 SQLite 实现，用进程内 store；后续可替换
      builder.knowledgeStore(new MemoryKnowledgeStore());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ConfigBridge] memory/wisdom/cognition/knowledge stores unavailable for agent home ${agentHome}: ${msg}`,
      );
      if (/node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE|ERR_DLOPEN|NODE_MODULE_VERSION/i.test(msg)) {
        console.warn(
          `[ConfigBridge] hint: SQLite backend requires Node.js >= 24 with built-in node:sqlite (process.version=${process.version})`,
        );
      }
    }
  }

  // ── Security ──
  if (shared.securityConfig) {
    builder.securityPolicy(shared.securityConfig);
    // 规则引擎：产生 tool_call.risk_unknown 后，由子系统目录加载的 safety-guard 兜底。
    // 子系统自身参数（model/maxDurationMs 等）只写在其 config.yaml，不在本文件配置。
    const { DefaultToolCallRiskPolicy } = await import('../security/default-risk-policy.js');
    builder.withRiskPolicy(new DefaultToolCallRiskPolicy({ cwd: agentConfig.workspace }));
  }

  // ── Budget + P2/P3 配置接线 ──
  if (shared.budgetConfig) {
    // 提取 BudgetPolicyEngine 配置（wall-clock / iteration / tool 上限）
    const engineConfig: Partial<BudgetPolicyConfig> = {
      maxWallClockMs: shared.budgetConfig.maxWallClockMs,
      maxIterations: shared.budgetConfig.maxIterations,
      maxToolCalls: shared.budgetConfig.maxToolCalls,
    };
    builder.budget(engineConfig);

    // P2: wrap-up 配置
    const wrapUpConfig: Record<string, unknown> = {};
    if (shared.budgetConfig.wrapUpTurns !== undefined) {
      wrapUpConfig.turns = shared.budgetConfig.wrapUpTurns;
    }
    if (shared.budgetConfig.onPolicyHit !== undefined) {
      wrapUpConfig.onPolicyHit = shared.budgetConfig.onPolicyHit;
    }
    if (shared.budgetConfig.contextWrapUpRatio !== undefined) {
      wrapUpConfig.contextRatio = shared.budgetConfig.contextWrapUpRatio;
    }

    // P3: policy 单位配置
    const policyUnits = shared.budgetConfig.units;
    const policyPricing = shared.budgetConfig.pricing;
    const advisory = shared.budgetConfig.advisory;

    // 如果有 P2/P3 配置，注入到 reliability
    if (Object.keys(wrapUpConfig).length > 0 || policyUnits || policyPricing || advisory) {
      builder.reliability({
        wrapUp: Object.keys(wrapUpConfig).length > 0 ? wrapUpConfig as ReliabilityConfig['wrapUp'] : undefined,
        policyUnits: policyUnits ? {
          maxCost: policyUnits.maxCost,
          maxUncachedInputTokens: policyUnits.maxUncachedInputTokens,
          maxOutputTokens: policyUnits.maxOutputTokens,
          maxLlmCalls: policyUnits.maxLlmCalls,
        } : undefined,
        policyPricing,
        advisory: advisory as ReliabilityConfig['advisory'],
      });
    }
  }

  // ── Context Engine ──
  const contextEngine = resolveContextEngine(shared.contextEngineConfig);
  builder.contextEngine(contextEngine);

  // ── Context Assembler（七层 system 装配） ──
  if (shared.contextAssemblerConfig) {
    builder.contextAssembler(shared.contextAssemblerConfig);
  }
  if (shared.constitutionConfig !== undefined) {
    builder.constitution(shared.constitutionConfig);
  }
  if (shared.memoryConfig) {
    builder.memoryConfig(shared.memoryConfig);
  }

  // ── 默认 summarize：capabilities 解析链（summary → mini → standard → 主模型）──
  // 与 harness/capabilities/summary/resolver.ts 口径一致；legacy contextEngine.summaryModel 由 pick 之外路径覆盖时优先
  if (provider) {
    const { provider: summarizeProvider, model: summarizeModel } = pickSummarizeProvider(
      shared.providers,
      shared.levelMap,
      provider,
    );
    builder.summarize(createProviderSummarize(summarizeProvider, { model: summarizeModel }));
  }

  // ── RunGuard ──
  if (shared.runGuardConfig?.enabled !== false) {
    const guard = resolveRunGuard(shared.runGuardConfig, shared.providers);
    if (guard) {
      builder.runGuard(guard);
    }
  }

  // checkpointInterval：从 runGuard JSON 配置打通到 reliability 初始间隔
  if (shared.runGuardConfig?.checkpointInterval !== undefined) {
    builder.reliability({
      checkpointInterval: shared.runGuardConfig.checkpointInterval,
    });
  }

  // ── Subsystems ──
  // 注册范围由 allow/deny 列表控制；builder.build 统一装配，此处只透传显式 specs / audit。
  if (shared.subsystemSpecs && shared.subsystemSpecs.length > 0) {
    for (const spec of shared.subsystemSpecs) {
      builder.withSubsystem(spec);
    }
  }
  if (shared.subsystemAuditDir) {
    builder.withSubsystemAuditDir(shared.subsystemAuditDir);
  }
  if (shared.subsystemAllowlist?.length) {
    builder.subsystemAllowlist(...shared.subsystemAllowlist);
  }
  if (shared.subsystemDenylist?.length) {
    builder.subsystemDenylist(...shared.subsystemDenylist);
  }

  // ── Build ──
  // 已有显式 specs 时不再重复自动发现，避免与 resolveSubsystemSpecs 双载
  const built = await builder.build({
    autoLoadSubsystems: (shared.subsystemSpecs?.length ?? 0) === 0,
  });

  // ── 注入子系统运行时依赖 ──
  if (built.runtime) {
    // 注入 modelProvider（取第一个可用的 provider）
    const firstProvider = shared.providers.values().next().value;
    if (firstProvider) {
      built.runtime.registerDependency('modelProvider', firstProvider);
    }
    // memoryStore 已在 AgentBuilder.build 内注入；此处不重复 register
  }
  const agent = built.agent;
  const runner = built.runner;

  return { agent, runner, agentConfig, runtime: built.runtime };
}

/**
 * 快捷函数：从配置文件路径构建
 */
export async function buildFromConfigFile(configPath?: string): Promise<Map<string, BuiltAgent>> {
  const { loadConfig } = await import('../../config.js');
  const config = loadConfig(configPath);
  return buildFromConfig(config);
}
