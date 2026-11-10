/**
 * RunAssembly — run 侧执行装配（buildAgent 内核，P0b 自 Gateway 迁出）。
 *
 * 职责：AgentDefinition → Agent + SessionAwareRunner + 执行腿缺省（RunBackendMountSpec）。
 * 这是 run 实例进程（run-serve-child）与 in-process 脚手架共用的**唯一**装配实现；
 * 两侧只差「宿主面」接线（deps 钩子：审批/命令注册/记忆/委派/任务事件）。
 *
 * 命名与归属：执行面（engine 内核 + 工具执行 + 装配）随 run 节点（arch/service-topology.md
 * §2.2/§10）；本文件暂居 gateway 包（其依赖面（PluginManager 贡献类型等）尚在收敛，
 * 依赖方向 gateway→engine 不变），拓扑成熟后可整体迁 engine。
 *
 * 命名前缀保留 `[Gateway]`：与旧版日志/运维 grep 兼容（搬迁不改文案，行为冻结）。
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import type { HitlDecision } from '@octopi-agent/core/types/tools.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { SessionStore } from '@octopi-agent/core/interfaces/session-store.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import type { SessionLease } from '@octopi-agent/engine/harness/run/concurrency/session-lease.js';
import type { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import type { ContextEngine } from '@octopi-agent/engine/harness/context/types.js';
import type { ContextLayerHealth } from '@octopi-agent/engine/harness/context/layer-health.js';
import type { RunBackendMountSpec } from '@octopi-agent/engine/harness/activation/run-backend.js';
import type { CircuitBreaker } from '@octopi-agent/engine/harness/run/reliability/circuit-breaker.js';
import {
  wrapProviderWithCircuitBreaker,
} from '@octopi-agent/engine/harness/run/reliability/provider-wrapper.js';
import { resolveModel, resolveModelRef } from '@octopi-agent/engine/harness/run/model/index.js';
import type {
  PluginToolRecord,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/contribution-registry.js';
import type {
  SkillManager,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/types.js';
import type {
  ExtensionHookPort,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/hooks/types.js';
import type { ObserverHub } from '@octopi-agent/engine/harness/observability/observer/hub.js';
import type { SessionAclService } from '@octopi-agent/engine/harness/governance/session-acl/service.js';
import type { SessionScheduleService } from '@octopi-agent/engine/harness/session/schedules/service.js';
import type { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { PendingApprovalRequest, Gateway } from './gateway.js';
import type { GatewayConfig } from '../types/gateway-config.js';
import type { RunApprovalRequestInput } from '@octopi-agent/engine/harness/activation/run-protocol.js';
import type { HitlAskResult } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';

/** builder.build() 的产物（Agent + Runner + 上下文面 + 动态工具注册口 + 事件面） */
export type BuiltAgent = Awaited<ReturnType<AgentBuilder['build']>>;

/** buildAgent 的收敛返回（gateway/脚手架消费面；事件面仅经 onBuilt 钩子可见） */
export interface RunAssemblyResult {
  agent: Agent;
  runner: SessionAwareRunner;
  contextEngine?: ContextEngine;
  contextHealth?: (agentId?: string) => Promise<ContextLayerHealth>;
  registerTools: (tools: RegisteredTool[]) => void;
}

/** requestApproval 的精确签名派生（与 Gateway 方法零发明对齐） */
type RequestApprovalInput = Parameters<Gateway['requestApproval']>[0];
type RequestApprovalResult = ReturnType<Gateway['requestApproval']>;

/** 面相关接线（gateway 与 run 实例各带一套；装配内核共用） */
export interface RunAssemblyHooks {
  /** HITL 审批（confirmEffect / confirmHighRisk / 插件审批共用出口） */
  requestApproval(input: RequestApprovalInput): RequestApprovalResult;
  /** skill 命令发现结果注册（gateway：命令路由；run 实例：notify('commands_registered')） */
  registerSkillCommands(agentId: string, skillManager: SkillManager): void;
  /** 用户命令文件注册 */
  registerUserCommands(agentId: string, commandsDir: string): void;
  /** 记忆恢复器登记（gateway.memoryRestorers 同义） */
  registerMemoryRestorer(agentId: string, restorer: unknown): void;
  /**
   * 构建完成的面接线（旧 buildAgent 尾部三件：任务事件转发 / 客户端工具可见性 /
   * 委派 attach）。S1 债务随 attach 注记保留（TODO(P0b)）。
   */
  onBuilt(input: { agent: AgentDefinition; built: BuiltAgent }): void | Promise<void>;
}

/** 装配所需运行时态（宿主注入；gateway 传自身字段，run 实例从 boot 装配） */
export interface RunAssemblyDeps extends RunAssemblyHooks {
  config: GatewayConfig;
  /** provider 注册表（活引用；热更 provider 可见） */
  providers: Map<string, ModelProvider>;
  getCircuitBreaker(providerName: string): CircuitBreaker;
  store: SessionStore<SessionData>;
  events: DefaultEventBus;
  /** 插件工具贡献（每次构建现取，与 PluginManager.getTools 同义） */
  getPluginTools(): PluginToolRecord[];
  /** 插件扩展钩子口（Runner extensionHooks） */
  getHookPort(): ExtensionHookPort;
  /** 全局工具面（活数组；客户端工具全局注册可见） */
  globalTools: RegisteredTool[];
  getObserverHub(): ObserverHub;
  getSessionLock(): SessionLease;
  getSessionAcl(): SessionAclService | undefined;
  getSessionSchedules(): SessionScheduleService | undefined;
  /** 活定义查找（模型解析闭包用；热更定义可见） */
  getCurrentAgentDefinition(agentId: string): AgentDefinition | undefined;
  getKnowledgeClient(): Promise<Awaited<ReturnType<Gateway['getKnowledgeClient']>>>;
  getKnowledgeRuntime(): Promise<{ state: string }>;
}

export class RunAssembly {
  private readonly deps: RunAssemblyDeps;

  constructor(deps: RunAssemblyDeps) {
    this.deps = deps;
  }

  /**
   * AgentDefinition → 执行体 + 执行腿缺省（RunBackendMountSpec，挂载动作归宿主）。
   *
   * @param agent - agent 定义
   * @returns 挂载 spec（runner 归属调用方回收）
   */
  async buildMountSpec(agent: AgentDefinition): Promise<RunBackendMountSpec> {
    const built = await this.buildAgent(agent);
    return this.buildMountSpecFor(agent, built);
  }

  /**
   * 构建产物 → 挂载 spec（组装单一来源；宿主自行 build 后复用此组装）。
   *
   * @param agent - agent 定义
   * @param built - 构建产物
   * @returns 挂载 spec
   */
  buildMountSpecFor(agent: AgentDefinition, built: RunAssemblyResult): RunBackendMountSpec {
    const runSystemPrompt =
      typeof agent.persona === 'object' ? agent.persona?.systemPrompt ?? '' : '';
    let contextWindow = agent.model.contextWindow;
    if (!contextWindow) {
      const provider = this.deps.providers.get(agent.model.provider);
      contextWindow = provider?.getModelInfo(agent.model.model)?.contextWindow;
    }
    return {
      agentId: agent.id,
      agent: built.agent,
      runner: built.runner,
      ...(built.contextEngine === undefined ? {} : { contextEngine: built.contextEngine }),
      ...(built.contextHealth === undefined ? {} : { contextHealth: built.contextHealth }),
      registerTools: built.registerTools,
      // 不要把 agent 默认 model 写入 defaults：
      // RunConfig.model 只表示**消息级**覆盖；会话覆盖在 session.metadata.model
      runConfigDefaults: {
        agentId: agent.id,
        contextWindow,
        systemPrompt: runSystemPrompt,
      },
    };
  }

  /**
   * 为 Agent 构建 Agent + SessionAwareRunner（新架构；P0b 自 Gateway.buildAgent 迁入，
   * 行为冻结——仅 this.X → deps.X 的显式化改写）。
   */
  async buildAgent(agent: AgentDefinition): Promise<RunAssemblyResult> {
    const cfg = this.deps.config;
    // 获取主 provider，并解析 agent 默认模型快照（含熔断包装）
    const rawProvider = this.deps.providers.get(agent.model.provider);
    if (!rawProvider) {
      throw new Error(`LLM provider "${agent.model.provider}" not found.`);
    }
    const defaultSnapshot = resolveModel({
      providerName: agent.model.provider,
      modelName: agent.model.model,
      providers: this.deps.providers,
      explicit: {
        contextWindow: agent.model.contextWindow,
        maxOutputTokens: agent.model.maxTokens,
      },
      isOverride: false,
      wrapProvider: (p, name) => wrapProviderWithCircuitBreaker(p, this.deps.getCircuitBreaker(name)),
    });
    if (!defaultSnapshot) {
      throw new Error(`LLM provider "${agent.model.provider}" not found.`);
    }
    const wrappedProvider: ModelProvider = defaultSnapshot.provider;

    // 命名 provider 同样包 circuit breaker：wire 的 providers 映射喂 ProviderPool 与
    // 子系统 provider/model 解析，必须与主 provider 同等待遇，不得绕过熔断
    const wrappedProviders = new Map<string, ModelProvider>();
    for (const [name, p] of this.deps.providers) {
      wrappedProviders.set(name, wrapProviderWithCircuitBreaker(p, this.deps.getCircuitBreaker(name)));
    }

    // 如果配置了 fallbackModels，构建 FallbackProvider（回退 provider 也包装 circuit breaker）
    let finalProvider: ModelProvider = wrappedProvider;
    if (agent.model.fallbackModels && agent.model.fallbackModels.length > 0) {
      const { FallbackProvider } = await import('@octopi-agent/engine/harness/run/reliability/fallback-provider.js');
      finalProvider = new FallbackProvider(
        wrappedProvider,
        agent.model.model,
        agent.model.fallbackModels,
        wrappedProviders,
        {
          attemptTtftTimeoutMs: cfg.modelCallFallbackAttemptTtftMs,
          attemptChatTimeoutMs: cfg.modelCallFallbackChatAttemptMs,
          degradeTtlMs: cfg.modelCallFallbackDegradeTtlMs,
        },
      );
      console.log(`[Gateway] Agent "${agent.id}" fallback chain: ${[agent.model.model, ...agent.model.fallbackModels.map(f => f.model)].join(' ?')}`);
    }

    // ── 标准组装（与 config-bridge 同源）+ 宿主适配 ──
    const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
    const {
      wireAgentBuilder,
      resolveSecurityConfig,
    } = await import('@octopi-agent/engine/harness/agent/wire-agent-builder.js');

    const builder = new AgentBuilder()
      .store(this.deps.store)
      .events(this.deps.events)
      .pluginTools(this.deps.getPluginTools());

    // F3/D5：observability 配置 → 观测装配（trace 落盘 + 采集意图）
    const { wireObservability } = await import('@octopi-agent/engine/config.js');
    await wireObservability(builder, cfg.observability, { filePrefix: agent.id });

    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
    const pathJoinForAttachments = join;

    const wired = await wireAgentBuilder(builder, {
      model: finalProvider,
      agentId: agent.id,
      workspace: agent.workspace,
      home: agent.home,
      persona:
        typeof agent.persona === 'object' && agent.persona?.systemPrompt
          ? { systemPrompt: agent.persona.systemPrompt }
          : typeof agent.persona === 'string'
            ? agent.persona
            : undefined,
      skillDirectory: agent.skillDirectory,
      skills: agent.skills,
      tools: agent.tools,
      maxSessionRights: agent.maxSessionRights,
      effectPolicy:
        (agent as { effectPolicy?: import('@octopi-agent/engine').EffectPolicyConfig }).effectPolicy ??
        cfg.effectPolicy,
      toolIsolation: cfg.toolIsolation,
      sessionIdleExpiryMs: cfg.session?.idleExpiryMs,
      modelCallTimeouts:
        cfg.modelCallIdleTimeoutMs !== undefined ||
        cfg.modelCallAbsoluteTimeoutMs !== undefined
          ? {
              idleTimeoutMs: cfg.modelCallIdleTimeoutMs,
              absoluteTimeoutMs: cfg.modelCallAbsoluteTimeoutMs,
            }
          : undefined,
      providers: wrappedProviders,
      levelMap: cfg.levels,
      modelsConfig: {
        providers: cfg.modelProviders,
        embedding: cfg.embedding,
      },
      contextEngineConfig: cfg.contextEngine,
      contextAssemblerConfig:
        cfg.context?.contextAssembler,
      constitutionConfig:
        cfg.context?.constitution,
      memoryConfig: cfg.memory,
      cognitionConfig: cfg.cognition,
      wisdomConfig: cfg.wisdom,
      securityConfig: resolveSecurityConfig({ security: cfg.security }),
      budgetConfig: cfg.budgetPolicy,
      runGuardConfig: cfg.runGuard,
      subsystemAuditDir: cfg.subsystems?.auditDir,
      subsystemAllowlist: cfg.subsystems?.allowlist,
      subsystemDenylist: cfg.subsystems?.denylist,
      concurrencyConfig: cfg.concurrency,
      extraRunnerConfig: {
        // ops P2：安全配置漂移守卫（daemon 锚定；漂移拒新 run）
        securityIntegrity: cfg.securityIntegrity,
        sessionLease: this.deps.getSessionLock(),
        sessionAcl: this.deps.getSessionAcl(),
        sessionScheduleService: this.deps.getSessionSchedules(),
        requireCredentialBindings: cfg.credentials?.requireBindings === true,
        observerHub: this.deps.getObserverHub().isEnabled() ? this.deps.getObserverHub() : undefined,
        sessionsDir: pathJoinForAttachments(getOctopiHome(), 'sessions'),
        extensionHooks: this.deps.getHookPort(),
        sessionAttachmentInject: {
          fullTextMaxChars: cfg.knowledge?.attachments?.inject?.fullTextMaxChars,
          recallTopK: cfg.knowledge?.attachments?.inject?.recallTopK,
          intent: cfg.knowledge?.attachments?.inject?.intent,
          intentTimeoutMs: cfg.knowledge?.attachments?.inject?.intentTimeoutMs,
          emptyMessagePrompt: cfg.knowledge?.attachments?.inject?.emptyMessagePrompt,
        },
      },
      errorStrategy: {
        onModelError: (error: { reason: string; message: string }, attempt: number) => {
          const retryable = ['rate_limit', 'timeout', 'network', 'server'];
          if (retryable.includes(error.reason) && attempt < 3) {
            const delayMs = (attempt + 1) * (error.reason === 'rate_limit' ? 1000 : 2000);
            return { action: 'retry' as const, delayMs };
          }
          return { action: 'abort' as const, reason: error.message };
        },
        onToolError: () => ({ action: 'skip' as const, reason: 'Tool failed' }),
        onContextOverflow: () => ({ action: 'compact' as const }),
        onSecurityViolation: (v: { description: string }) => ({
          action: 'block' as const,
          reason: v.description,
        }),
      },
    });

    // ── 宿主适配：user commands / knowledge / tools / approval ──
    // skill 发现已由 wireAgentBuilder 完成（唯一 discover 出口）
    if (wired.skillManager) {
      this.deps.registerSkillCommands(agent.id, wired.skillManager as SkillManager);
    }
    if (agent.home) {
      try {
        this.deps.registerUserCommands(agent.id, join(agent.home, 'commands'));
      } catch (err) {
        console.warn(`[Gateway] user command load failed for agent "${agent.id}": ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const { resolveEmbeddingRuntime } = await import('@octopi-agent/engine/harness/memory/sqlite/embedding-from-models.js');
        const embRuntime = resolveEmbeddingRuntime({
          providers: cfg.modelProviders ?? {},
          embedding: cfg.embedding,
        });
        if (wired.memoryStore) {
          const { createMemoryRestorer } = await import('@octopi-agent/engine');
          this.deps.registerMemoryRestorer(
            agent.id,
            createMemoryRestorer(wired.memoryStore as never),
          );
        }
        try {
          const agentIdForCatalog = agent.id;
          const kn = cfg.knowledge;
          builder.knowledgeCatalog(
            async () => {
              try {
                const client = await this.deps.getKnowledgeClient();
                const items = await client.catalog(agentIdForCatalog);
                return items as import('@octopi-agent/engine/harness/knowledge/catalog-types.js').KnowledgeCatalogItem[];
              } catch {
                return [];
              }
            },
            {
              maxEntries: kn?.catalog?.maxEntries,
              groupByScope: kn?.catalog?.groupByScope,
              showProgress: kn?.catalog?.showProgress,
            },
          );
        } catch (kErr) {
          console.warn(
            `[Gateway] knowledge catalog unavailable: ${kErr instanceof Error ? kErr.message : String(kErr)}`,
          );
        }
        if (embRuntime?.provider) {
          console.log(
            `[Gateway] memory embedding enabled: model=${embRuntime.model} vectorEngine=${embRuntime.vectorEngine}`,
          );
        } else {
          console.log('[Gateway] memory embedding not configured → keyword retrieval');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Gateway] context stores unavailable for agent "${agent.id}": ${msg}`);
      }
    }

    console.log(`[Gateway] Building agent "${agent.id}" with ${this.deps.globalTools.length} global tools: ${this.deps.globalTools.map(t => t.definition.name).join(', ')}`);
    for (const tool of this.deps.globalTools) {
      const name = tool.definition.name;
      if (name === 'memory_store' || name === 'memory_search') continue;
      try {
        builder.tool(tool);
      } catch (err) {
        console.warn(
          `[Gateway] tool register failed (${name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      const rt = await this.deps.getKnowledgeRuntime();
      if (rt.state === 'disabled') {
        console.log('[Gateway] knowledge tools skipped: knowledge.service disabled');
      } else {
        const kclient = await this.deps.getKnowledgeClient();
        const { createKnowledgeClientTools } = await import(
          '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/knowledge.js'
        );
        for (const tool of createKnowledgeClientTools({ client: kclient })) {
          builder.tool(tool);
        }
        console.log('[Gateway] knowledge tools via service: knowledge_search, knowledge_read');

        const recall =
          (agent as { knowledge?: { recall?: string } }).knowledge?.recall ??
          cfg.knowledge?.recall ??
          'hybrid';
        if (recall !== 'off') {
          const { ClientKnowledgeGrounding } = await import(
            '@octopi-agent/engine/harness/knowledge/client.js'
          );
          const g = cfg.knowledge?.autoInject;
          const q = cfg.knowledge?.query;
          builder.knowledgeGrounding(
            new ClientKnowledgeGrounding(
              kclient,
              recall as 'hint' | 'hybrid' | 'inject',
            ),
            {
              ...(g?.budgetTokens != null ? { budgetTokens: g.budgetTokens } : {}),
              ...(g?.budgetRatio != null ? { budgetRatio: g.budgetRatio } : {}),
              ...(g?.maxBudgetTokens != null ? { maxBudgetTokens: g.maxBudgetTokens } : {}),
              ...(g?.maxChunks != null ? { maxChunks: g.maxChunks } : {}),
              ...(q?.skipIfUserTokensBelow != null
                ? { skipIfUserTokensBelow: q.skipIfUserTokensBelow }
                : {}),
              ...(q?.includePriorUserTurns != null
                ? { includePriorUserTurns: q.includePriorUserTurns }
                : {}),
            },
          );
          console.log(`[Gateway] knowledge grounding via service (recall=${recall})`);
        }
      }
    } catch (kToolErr) {
      console.warn(
        `[Gateway] knowledge tools skipped: ${kToolErr instanceof Error ? kToolErr.message : String(kToolErr)}`,
      );
    }

    builder.confirmEffect(async (intent) => {
      const { getRunScope } = await import('@octopi-agent/engine/harness');
      const scope = getRunScope();
      // 无 run scope ≠ 人工拒绝：带来源标注回给引擎（错误面不得冒充人工拒绝）
      if (!scope?.sessionId) return { decision: 'deny', reason: 'no_session_scope' };
      const sessionId = scope.sessionId;
      const agentId = scope.agentId ?? 'default';
      const desc =
        intent.kind === 'shell'
          ? `shell: ${String(intent.command ?? '').slice(0, 120)}`
          : intent.kind === 'file.write'
            ? `write ${intent.path} (${intent.mode ?? 'overwrite'})`
            : (intent.description ?? intent.kind);
      return this.deps.requestApproval({
        sessionId,
        agentId,
        request: {
          kind: 'effect',
          toolName: intent.kind,
          arguments: {
            path: intent.path,
            command: intent.command,
            mode: intent.mode,
            cwd: intent.cwd,
            domain: intent.domain,
            description: intent.description,
          },
          riskLevel: intent.kind === 'shell' ? 'high' : 'medium',
          riskDescription: desc,
          actionDescription: desc,
        },
        // 引擎确认窗原样作为卡片决策截止（deadlineAt）与 settle 时刻——引擎 askWithTimeout
        // 先注册必先定案，超时标签如实是 confirm_timeout；窗口后的点击只得 rejected/late
        ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
      });
    });

    builder.confirmHighRisk(async (req) => {
      if (!req.sessionId) return 'deny';
      const sessionId = req.sessionId;
      const agentId = req.agentId ?? 'default';
      const toolName = req.toolCall?.name ?? 'tool';
      const args = (req.toolCall?.arguments ?? {}) as Record<string, unknown>;
      const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
      const outcome = await this.deps.requestApproval({
        sessionId,
        agentId,
        request: {
          kind: 'high_risk',
          toolName,
          arguments: args,
          riskLevel: normalizeRiskLevel(req.severity),
          riskDescription: req.reason,
          actionDescription: purpose ? `${toolName}: ${purpose}` : toolName,
        },
      });
      // high_risk 契约只认决策；确认人归因随审批记录走（PendingApprovalView）
      return typeof outcome === 'string' ? outcome : outcome.decision;
    });

    const observerHub = this.deps.getObserverHub();
    builder.observerHub(observerHub.isEnabled() ? observerHub : undefined);
    const built = await builder.build();
    built.runner.setObserverHub(observerHub.isEnabled() ? observerHub : undefined);
    const agentToolNames = built.agent.context.tools
      ?.map((t: any) => t?.definition?.name ?? t?.name)
      .filter(Boolean) ?? [];
    const hasMemoryTools = agentToolNames.includes('memory_store') && agentToolNames.includes('memory_search');
    console.log(
      `[Gateway] Agent "${agent.id}" tools: ${agentToolNames.join(', ') || '(none)'}` +
        (hasMemoryTools ? ' [memory_store/search OK]' : ' [memory_store/search MISSING]'),
    );

    // ── Run 级模型快照解析（方案 B 唯一入口）──
    // 每 run 调一次；provider 缺失返回 null，Runner 回退 Agent 实例默认
    const wrap = (p: ModelProvider, providerName: string) =>
      wrapProviderWithCircuitBreaker(p, this.deps.getCircuitBreaker(providerName));

    built.runner.setModelResolver(({ modelRef, defaultProvider }) => {
      const agentDef = this.deps.getCurrentAgentDefinition(agent.id) ?? agent;
      if (!modelRef) {
        return resolveModel({
          providerName: agentDef.model.provider,
          modelName: agentDef.model.model,
          providers: this.deps.providers,
          explicit: {
            contextWindow: agentDef.model.contextWindow,
            maxOutputTokens: agentDef.model.maxTokens,
          },
          isOverride: false,
          wrapProvider: wrap,
        });
      }
      return resolveModelRef(modelRef, {
        providers: this.deps.providers,
        defaultProvider: defaultProvider ?? agentDef.model.provider,
        isOverride: true,
        wrapProvider: wrap,
      });
    });

    // 面接线（任务事件转发 / 客户端工具可见性 / 委派 attach）：gateway 与 run 实例各带一套
    await this.deps.onBuilt({ agent, built });

    return {
      agent: built.agent,
      runner: built.runner,
      contextEngine: built.contextEngine,
      contextHealth: built.contextHealth,
      registerTools: built.registerTools,
    };
  }
}

/** Normalized risk level for approval display (unknown severity → high, fail-safe) */
export function normalizeRiskLevel(
  severity: string | undefined,
): PendingApprovalRequest['riskLevel'] {
  switch (severity) {
    case 'low':
    case 'medium':
    case 'high':
    case 'critical':
    case 'unknown':
      return severity;
    default:
      return 'high';
  }
}

/** 参照 HitlDecision 的审批结果形状（confirmHighRisk 契约只认决策） */
export type { HitlDecision };

/**
 * 插件工具审批 → requestApproval 载荷（gateway sink 与 run 实例审批桥共用；单一来源）。
 *
 * @param event - 工具事件（HookToolEvent 消费面）
 * @param request - 审批描述（HookToolApproval 消费面）
 * @returns 审批请求载荷
 */
export function toolApprovalToRequestInput(
  event: { sessionId: string; agentId: string; toolName: string; params: Record<string, unknown> },
  request: { severity?: string; description: string; title: string; timeoutMs?: number },
): RunApprovalRequestInput {
  return {
    sessionId: event.sessionId,
    agentId: event.agentId,
    request: {
      kind: 'high_risk',
      toolName: event.toolName,
      arguments: event.params,
      riskLevel: request.severity === 'critical' ? 'critical' : request.severity === 'info' ? 'low' : 'high',
      riskDescription: request.description,
      actionDescription: request.title,
    },
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  };
}

/**
 * 审批结果 → HitlAskResult（保留 scope 语义与 deny 真源；gateway sink 与 run 实例审批桥共用）。
 *
 * @param outcome - requestApproval 的原始结果
 * @returns 引擎缓存可识别的 HitlAskResult
 */
export function approvalOutcomeToHitlAskResult(
  outcome: Awaited<ReturnType<Gateway['requestApproval']>>,
): HitlAskResult {
  // Express the raw HitlDecision (scopes included) so the engine cache can honor
  // approve_session / approve_always; the Host never caches (SEC-7 single model).
  const decision = typeof outcome === 'string' ? outcome : outcome.decision;
  const attribution = typeof outcome === 'object'
    ? {
        ...(outcome.approver === undefined ? {} : { approver: outcome.approver }),
        ...(outcome.channel === undefined ? {} : { channel: outcome.channel }),
      }
    : {};
  if (decision !== 'deny') return { decision, ...attribution };
  // deny: preserve the real source — timeout / cancelled / late ≠ human rejection.
  const source = typeof outcome === 'object' ? outcome.reason : 'late';
  return {
    decision: 'deny',
    ...(source === 'timeout' || source === 'late' ? { timedOut: true } : {}),
    ...(source === 'cancelled' ? { denyReason: 'cancelled' as const } : {}),
    denyDetail: `Host approval was not granted: ${source ?? decision}`,
    ...attribution,
  };
}
