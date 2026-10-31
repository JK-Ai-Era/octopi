/**
 * wireAgentBuilder — 配置 → AgentBuilder 的唯一组装入口
 *
 * 设计约定：
 * - 产品（Gateway）与库嵌入（config-bridge）**都只调用本函数**，禁止各自维护第二套接线清单。
 * - 本函数覆盖「标准配置」：模型档 / summarize / contextEngine / security / budget /
 *   runGuard / persona / skills / memory stores / subsystems / toolIsolation / effectPolicy。
 * - 宿主适配（circuit breaker、WS、approval 门禁、Knowledge Service、委派…）在 wire **之后**
 *   由宿主自己叠加，不进本文件。
 * - 不做双轨/兼容层：漏接线即 bug，由契约测试锁两路径能力一致。
 *
 * @module harness/agent/wire-agent-builder
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandHomePath } from '../../paths.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { SecurityGuardConfig } from '@octopi-agent/core/security-guard.js';
import type { ErrorStrategy } from '@octopi-agent/core/interfaces/error-strategy.js';
import type {
  ContextEngineConfig,
  BudgetPolicyJsonConfig,
  RunGuardJsonConfig,
  ModelCallConfig,
  LevelMap,
  ModelsConfig,
  HarnessConfig,
} from '../../config.js';
import type { SubsystemSpec } from '../collaboration/autonomous-subsystem/types.js';
import type { BudgetPolicyConfig } from '../run/budget/budget.js';
import type { ReliabilityConfig } from '../run/reliability/run-agent.js';
import type { SessionAwareRunnerConfig } from '../run/runner.js';
import type { EffectPolicyConfig } from '../extension/execution-environment/effect-policy.js';
import { getOctopiHome } from '../../paths.js';
import {
  DefaultRunGuard,
  type RunGuardConfig,
} from '../run/run-guard/default-run-guard.js';
import type { ContextEngine } from '../context/types.js';
import { DefaultContextEngine } from '../context/default-context-engine.js';
import { DefaultBudgetAllocator } from '../context/budget-allocator.js';
import type { AgentBuilder } from './builder.js';

// ── 配置解析（唯一实现；供 wire 与公开导出共用） ──

/**
 * 解析子系统审计目录（docs/autonomous-subsystem.md §10）
 *
 * - `false` → 关闭审计（返回 undefined，不接 AuditWriter）
 * - 字符串 → 显式目录
 * - 缺省 → `<OCTOPI_HOME>/audit`（`OCTOPI_HOME` env 可重定向，测试可隔离）
 *
 * @param configured - 配置值（`subsystems.auditDir`）
 * @returns 审计目录；undefined = 显式关闭
 */
export function resolveSubsystemAuditDir(configured: string | false | undefined): string | undefined {
  if (configured === false) return undefined;
  return configured ?? join(getOctopiHome(), 'audit');
}

/**
 * 从配置中解析安全策略（始终返回；无总开关）
 *
 * 硬边界与 ToolCallRiskPolicy 由 Guard/Builder 保证接线，
 * 这里只归一化处置、范围与灵敏度。
 *
 * @param config - Harness 配置
 * @returns 安全策略
 */
export function resolveSecurityConfig(config: {
  security?: HarnessConfig['security'];
}): SecurityGuardConfig {
  const security = config.security ?? {};
  return {
    enforce: security.enforce ?? 'block',
    injectionSensitivity: security.injectionSensitivity ?? 'medium',
    allowedPaths: security.allowedPaths ?? [],
  };
}

/**
 * 从配置中创建 ContextEngine 实例
 *
 * @param config - contextEngine 配置（可空）
 * @returns ContextEngine
 */
export function resolveContextEngine(config: ContextEngineConfig | undefined): ContextEngine {
  // 缺省 type = default：只给旋钮（如 proactiveCompactRatio）也必须落到默认引擎
  if (!config || config.type == null || config.type === 'default') {
    return new DefaultContextEngine({
      protectFirstN: config?.protectFirstN ?? 5,
      protectLastN: config?.protectLastN ?? 20,
      summaryBudget: config?.summaryBudget,
      proactiveCompactRatio: config?.proactiveCompactRatio ?? 0.6,
      proactiveCooldownMs: config?.proactiveCooldownMs ?? 30_000,
      historyAging: config?.historyAging,
      targetTokens: config?.targetTokens,
      compactFallbackRatio: config?.compactFallbackRatio,
      budgetAllocator: new DefaultBudgetAllocator({
        outputRatio: config?.outputRatio ?? 0.20,
        minOutputReserve: config?.minOutputReserve ?? 2000,
        maxOutputReserve: config?.maxOutputReserve ?? 8000,
      }),
    });
  }
  throw new Error(`Unknown context engine type: ${config.type}`);
}

/**
 * 从配置中解析 RunGuard
 *
 * 解析 llmModel 字段：
 * - "model" → 使用主 provider
 * - "provider/model" → 使用指定 provider
 *
 * @param config - runGuard JSON 配置
 * @param providers - 可用 provider 映射
 * @returns RunGuard 或 undefined（禁用时）
 */
export function resolveRunGuard(
  config: RunGuardJsonConfig | undefined,
  providers: Map<string, ModelProvider>,
): DefaultRunGuard | undefined {
  if (!config || config.enabled === false) return undefined;

  let reviewModel: ModelProvider | undefined;
  if (config.llmModel) {
    const parts = config.llmModel.split('/');
    if (parts.length === 2) {
      reviewModel = providers.get(parts[0]);
      config = { ...config, llmModel: parts[1] };
    } else {
      reviewModel = providers.values().next().value;
    }
  }

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

// ── Wire 输入 ──

/**
 * 标准组装输入。宿主先解析好 model provider（可包 circuit breaker / fallback），
 * 再把其余配置块交给本函数。
 */
export interface AgentWireSpec {
  /** 已解析/已包装的主模型 provider */
  model: ModelProvider;
  agentId: string;
  workspace?: string;
  /** agent 文件态持久目录（persona/skills） */
  home?: string;
  /** 文件式 persona 目录，或内联 systemPrompt */
  persona?: string | { systemPrompt?: string };
  skillDirectory?: string;
  /** SEC-2 / E6 工具策略与会话权利天花板 */
  tools?: import('@octopi-agent/core/types.js').ToolPolicy;
  maxSessionRights?: SessionAwareRunnerConfig['agentMaxSessionRights'];
  effectPolicy?: EffectPolicyConfig;
  toolIsolation?: HarnessConfig['toolIsolation'];
  sessionIdleExpiryMs?: number;
  modelCallTimeouts?: ModelCallConfig;

  /** 可用 provider 映射（summarize / runGuard / subsystems） */
  providers: Map<string, ModelProvider>;
  levelMap?: LevelMap;
  modelsConfig?: {
    providers?: ModelsConfig['providers'];
    embedding?: ModelsConfig['embedding'];
  };

  contextEngineConfig?: ContextEngineConfig;
  contextAssemblerConfig?: HarnessConfig['contextAssembler'];
  constitutionConfig?: HarnessConfig['constitution'];
  memoryConfig?: HarnessConfig['memory'];
  cognitionConfig?: HarnessConfig['cognition'];
  wisdomConfig?: HarnessConfig['wisdom'];
  securityConfig?: SecurityGuardConfig;
  /** budget 旋钮（JSON 面或 Builder BudgetPolicyConfig 局部） */
  budgetConfig?: BudgetPolicyJsonConfig | Partial<BudgetPolicyConfig>;
  runGuardConfig?: RunGuardJsonConfig;

  /** 并发控制（ProviderPool / SessionGate）；与 config-bridge 同源 */
  concurrencyConfig?: HarnessConfig['concurrency'];

  subsystemSpecs?: SubsystemSpec[];
  /** 审计目录；缺省 `<OCTOPI_HOME>/audit`，`false` 显式关闭 */
  subsystemAuditDir?: string | false;
  subsystemAllowlist?: string[];
  subsystemDenylist?: string[];

  /**
   * 宿主 runner 附加项（session lease / ACL / attachment 等）。
   * 与标准字段合并；冲突时宿主值覆盖标准值。
   */
  extraRunnerConfig?: Partial<SessionAwareRunnerConfig>;
  /** 覆盖默认错误策略（缺省不设，用 Builder 内建） */
  errorStrategy?: ErrorStrategy;
}

/**
 * 将标准配置接到 AgentBuilder 上。不调用 `build()`——由宿主在叠加完适配层后 build。
 *
 * @param builder - 目标 builder（宿主可已注入 store/events/model）
 * @param spec - 标准组装输入
 */
export async function wireAgentBuilder(
  builder: AgentBuilder,
  spec: AgentWireSpec,
): Promise<{ memoryStore?: unknown; skillManager?: unknown }> {
  // ── Model ──
  builder.model(spec.model);

  // ── Model call watchdog ──
  if (spec.modelCallTimeouts) {
    builder.modelCallTimeouts(spec.modelCallTimeouts);
  }

  // ── Model Levels（子系统 think.model / 摘要选型共用） ──
  if (spec.levelMap) {
    builder.withModelLevels(spec.levelMap);
  }

  // ── Providers 映射（子系统 provider/model 解析用；缺 provider 回退主模型） ──
  builder.providers(spec.providers);

  // ── 并发控制（ProviderPool / SessionGate） ──
  if (spec.concurrencyConfig) {
    builder.concurrency(spec.concurrencyConfig);
  }

  // ── Workspace ──
  if (spec.workspace) {
    builder.workspace(spec.workspace);
  }

  // ── Tool isolation (I5) ──
  if (spec.toolIsolation) {
    builder.toolIsolation(spec.toolIsolation);
  }

  // ── EffectPolicy (P3) ──
  if (spec.effectPolicy) {
    builder.effectPolicy(spec.effectPolicy);
  }

  // ── Runner：标准字段 + 宿主附加 ──
  const runnerConfig: Partial<SessionAwareRunnerConfig> = {
    ...(spec.sessionIdleExpiryMs && spec.sessionIdleExpiryMs > 0
      ? { idleExpiryMs: spec.sessionIdleExpiryMs }
      : {}),
    ...(spec.tools ? { agentToolPolicy: spec.tools } : {}),
    ...(spec.maxSessionRights !== undefined
      ? { agentMaxSessionRights: spec.maxSessionRights }
      : {}),
    ...(spec.extraRunnerConfig ?? {}),
  };
  if (Object.keys(runnerConfig).length > 0) {
    builder.runnerConfig(runnerConfig);
  }

  // ── Home / Persona / Skills ──
  // stores 只跟显式 home 走；string persona 只作 prompt 目录，不隐式开 agent.db
  //（config-bridge 需要 legacy persona-as-home 时应显式传 home）。
  // home/skillDirectory 在库边界展开 `~`（幂等）：`join()` 与 agent.db 路径都以它为基，
  // 留一个未展开的 `~` 就会在进程 cwd 下建出字面 `~/…` 目录。
  const agentHome = spec.home ? expandHomePath(spec.home.trim()) : undefined;
  // agentId 无条件接线（审计分区 / 工具域对称）；home 只决定 agent 文件态目录
  builder.agentId(spec.agentId);
  if (spec.home) {
    builder.agentHome(spec.home);
  }
  if (typeof spec.persona === 'string') {
    builder.persona(spec.persona);
  } else if (spec.persona?.systemPrompt) {
    builder.systemPrompt(spec.persona.systemPrompt);
  } else if (agentHome) {
    builder.persona(agentHome);
  }

  const skillDir = spec.skillDirectory
    ? expandHomePath(spec.skillDirectory.trim())
    : agentHome
      ? join(agentHome, 'skills')
      : undefined;
  let skillManager: unknown;
  if (skillDir && existsSync(skillDir)) {
    try {
      const { DefaultSkillManager } = await import(
        '../extension/plugin-ecosystem/skills/manager.js'
      );
      skillManager = new DefaultSkillManager();
      await (skillManager as { discover: (d: string) => Promise<void> }).discover(skillDir);
      builder.skills(
        skillManager as import('../extension/plugin-ecosystem/skills/types.js').SkillManager,
      );
    } catch (err) {
      console.warn(
        `[AgentWire] skill discover failed for ${skillDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      skillManager = undefined;
    }
    // 无 manager 时 builder 仍可用目录兜底
    builder.skillDirectory(skillDir);
  }

  // ── Memory / Wisdom / Cognition（agent home 下 AgentDatabase） ──
  let memoryStore: unknown;
  if (agentHome) {
    const stores = await wireContextStores(builder, {
      agentHome,
      modelsConfig: spec.modelsConfig,
      memoryConfig: spec.memoryConfig,
      wisdomConfig: spec.wisdomConfig,
      cognitionConfig: spec.cognitionConfig,
    });
    memoryStore = stores.memoryStore;
  }

  // ── Security（策略与 RiskPolicy 始终接线） ──
  builder.securityPolicy(spec.securityConfig ?? {});
  const { DefaultToolCallRiskPolicy } = await import(
    '../governance/security/default-risk-policy.js'
  );
  builder.withRiskPolicy(new DefaultToolCallRiskPolicy({ cwd: spec.workspace }));

  // ── Budget + wrap-up / policy units ──
  if (spec.budgetConfig) {
    wireBudget(builder, spec.budgetConfig);
  }

  // ── Context Engine（缺省也接线：配置面必须有唯一出口） ──
  builder.contextEngine(resolveContextEngine(spec.contextEngineConfig));

  // ── Context Assembler / Constitution / Memory policy ──
  if (spec.contextAssemblerConfig) {
    builder.contextAssembler(spec.contextAssemblerConfig);
  }
  if (spec.constitutionConfig !== undefined) {
    builder.constitution(spec.constitutionConfig);
  }
  if (spec.memoryConfig) {
    builder.memoryConfig(spec.memoryConfig);
  }

  // ── summarize：与会话同模型（前缀缓存同域）──
  // 不自动切 summary/mini：换 provider/model = 换缓存域，全量历史冷 prefill。
  // 显式 builder.summarize() 仍可覆盖；缺省走 AgentBuilder 的 session 模型路径。

  // ── RunGuard ──
  if (spec.runGuardConfig?.enabled !== false) {
    const guard = resolveRunGuard(spec.runGuardConfig, spec.providers);
    if (guard) {
      builder.runGuard(guard);
    }
    if (spec.runGuardConfig?.checkpointInterval !== undefined) {
      builder.reliability({
        checkpointInterval: spec.runGuardConfig.checkpointInterval,
      });
    }
  }

  // ── Subsystems ──
  if (spec.subsystemSpecs && spec.subsystemSpecs.length > 0) {
    for (const s of spec.subsystemSpecs) {
      builder.withSubsystem(s);
    }
  }
  const auditDir = resolveSubsystemAuditDir(spec.subsystemAuditDir);
  if (auditDir) {
    builder.withSubsystemAuditDir(auditDir);
  }
  if (spec.subsystemAllowlist?.length) {
    builder.subsystemAllowlist(...spec.subsystemAllowlist);
  }
  if (spec.subsystemDenylist?.length) {
    builder.subsystemDenylist(...spec.subsystemDenylist);
  }

  if (spec.errorStrategy) {
    builder.errorStrategy(spec.errorStrategy);
  }

  return { memoryStore, skillManager };
}

/** 显式 specs 时是否仍允许 builder 自动发现（防双载） */
export function shouldAutoLoadSubsystems(spec: Pick<AgentWireSpec, 'subsystemSpecs'>): boolean {
  return (spec.subsystemSpecs?.length ?? 0) === 0;
}

// ── 内部 ──

function wireBudget(
  builder: AgentBuilder,
  budgetConfig: BudgetPolicyJsonConfig | Partial<BudgetPolicyConfig>,
): void {
  const engineConfig: Partial<BudgetPolicyConfig> = {
    maxWallClockMs: budgetConfig.maxWallClockMs,
    maxIterations: budgetConfig.maxIterations,
    maxToolCalls: budgetConfig.maxToolCalls,
  };
  builder.budget(engineConfig);

  const wrapUpConfig: Record<string, unknown> = {};
  if ('wrapUpTurns' in budgetConfig && budgetConfig.wrapUpTurns !== undefined) {
    wrapUpConfig.turns = budgetConfig.wrapUpTurns;
  }
  if ('onPolicyHit' in budgetConfig && budgetConfig.onPolicyHit !== undefined) {
    wrapUpConfig.onPolicyHit = budgetConfig.onPolicyHit;
  }
  if ('contextWrapUpRatio' in budgetConfig && budgetConfig.contextWrapUpRatio !== undefined) {
    wrapUpConfig.contextRatio = budgetConfig.contextWrapUpRatio;
  }

  const policyUnits = 'units' in budgetConfig ? budgetConfig.units : undefined;
  const policyPricing = 'pricing' in budgetConfig ? budgetConfig.pricing : undefined;
  const advisory = 'advisory' in budgetConfig ? budgetConfig.advisory : undefined;

  if (Object.keys(wrapUpConfig).length > 0 || policyUnits || policyPricing || advisory) {
    builder.reliability({
      wrapUp:
        Object.keys(wrapUpConfig).length > 0
          ? (wrapUpConfig as ReliabilityConfig['wrapUp'])
          : undefined,
      policyUnits: policyUnits
        ? {
            maxCost: policyUnits.maxCost,
            maxUncachedInputTokens: policyUnits.maxUncachedInputTokens,
            maxOutputTokens: policyUnits.maxOutputTokens,
            maxLlmCalls: policyUnits.maxLlmCalls,
          }
        : undefined,
      policyPricing,
      advisory: advisory as ReliabilityConfig['advisory'],
    });
  }
}

async function wireContextStores(
  builder: AgentBuilder,
  input: {
    agentHome: string;
    modelsConfig?: {
      providers?: ModelsConfig['providers'];
      embedding?: ModelsConfig['embedding'];
    };
    memoryConfig?: HarnessConfig['memory'];
    wisdomConfig?: HarnessConfig['wisdom'];
    cognitionConfig?: HarnessConfig['cognition'];
  },
): Promise<{ memoryStore?: unknown }> {
  try {
    const { AgentDatabase } = await import('../memory/sqlite/agent-db.js');
    const { SqliteMemoryStore } = await import('../memory/sqlite/memory-store.js');
    const { SqliteWisdomStore } = await import('../memory/sqlite/wisdom-store.js');
    const { SqliteConceptGraph } = await import('../memory/sqlite/cognition-store.js');
    const { resolveEmbeddingRuntime } = await import(
      '../memory/sqlite/embedding-from-models.js'
    );

    const embRuntime = resolveEmbeddingRuntime({
      providers: input.modelsConfig?.providers ?? {},
      embedding: input.modelsConfig?.embedding,
    });
    const useVec = embRuntime && embRuntime.vectorEngine !== 'js';
    const db = await AgentDatabase.create({
      dbPath: join(input.agentHome, 'agent.db'),
      sqliteVec: useVec
        ? { extensionPath: embRuntime?.sqliteVecExtensionPath }
        : false,
      vectorDimensions: useVec ? embRuntime?.dimensions : undefined,
    });

    const memoryStore = new SqliteMemoryStore(db, {
      embeddingProvider: embRuntime?.provider ?? null,
      vectorEngine: embRuntime?.vectorEngine ?? 'auto',
      minSimilarity: input.memoryConfig?.retrieval?.minSimilarity,
      similarityWeight: input.memoryConfig?.retrieval?.similarityWeight,
      minKeywordScore: input.memoryConfig?.retrieval?.minKeywordScore,
    });
    builder.memoryStore(memoryStore);

    const wis = input.wisdomConfig;
    if (wis?.enabled !== false) {
      builder.wisdomStore(new SqliteWisdomStore(db, { hardCap: wis?.capacity?.hardCap }));
      if (wis?.injection) builder.wisdomInjection(wis.injection);
    }

    const cog = input.cognitionConfig;
    if (cog?.enabled !== false) {
      builder.cognitionStore(
        new SqliteConceptGraph(db, {
          embeddingProvider: embRuntime?.provider ?? null,
          mergeThreshold: cog?.identity?.mergeThreshold,
          candidateBandHi: cog?.identity?.candidateBandHi,
          stopNodes: cog?.capacity?.stopNodes,
          stopEdges: cog?.capacity?.stopEdges,
          causesMinIndependentMemories: cog?.relations?.causesMinIndependentMemories,
        }),
      );
    }

    return { memoryStore };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[AgentWire] memory/wisdom/cognition stores unavailable for agent home ${input.agentHome}: ${msg}`,
    );
    if (/node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE|ERR_DLOPEN|NODE_MODULE_VERSION/i.test(msg)) {
      console.warn(
        `[AgentWire] hint: SQLite backend requires Node.js >= 24 with built-in node:sqlite (process.version=${process.version})`,
      );
    }
    return {};
  }
}
